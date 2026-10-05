/**
 * T5.5 config dump 单测（07-dev-plan §11.2 验收：dump 输出与实际生效一致（env 覆盖用例）/
 * 损坏 config 下 --default-only 仍可打印；外加明文密钥不入输出的安全断言）。
 * env/cwd 全部注入临时目录，不触真实用户目录；密钥用占位假值且断言绝不回现在输出中。
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigStore, resolveProviderConfig } from "@raincode/server";
import { parseCliArgs } from "../src/context.js";
import { dumpConfigText } from "../src/commands/config.js";
import type { DumpConfigOptions } from "../src/commands/config.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "raincode-dump-"));
}

/** 无 CLI 参数层的干净入参（workspace/title 等与 dump 无关）。 */
function emptyArgs() {
  return parseCliArgs([]);
}

function dump(home: string, env: NodeJS.ProcessEnv = {}, overrides: Partial<DumpConfigOptions> = {}) {
  return dumpConfigText({
    env: { RAINCODE_HOME: home, ...env },
    cwd: home,
    args: emptyArgs(),
    defaultOnly: false,
    ...overrides,
  });
}

test("dump: env 覆盖 providers 配置文件——输出值与 resolveProviderConfig 实际生效一致且来源标 env", () => {
  const home = tempHome();
  try {
    const providersPath = join(home, "config", "providers.local.json");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      providersPath,
      JSON.stringify({ name: "file-provider", baseURL: "https://file.example.com/v1", model: "file-model" }),
      "utf8",
    );
    const env = {
      RAINCODE_PROVIDER_BASE_URL: "https://env.example.com/v1",
      RAINCODE_PROVIDER_MODEL: "env-model",
    };
    const result = dump(home, env);
    // 与实际生效一致：dump 的 provider 节值 === resolveProviderConfig 同输入的解析值
    const resolved = resolveProviderConfig({
      args: {},
      env: { RAINCODE_HOME: home, ...env },
      configPath: providersPath,
    });
    assert.ok(resolved !== null);
    assert.equal(resolved.baseURL, "https://env.example.com/v1");
    assert.equal(resolved.fieldSources.baseURL, "env");
    assert.ok(result.text.includes(resolved.baseURL));
    assert.ok(result.text.includes(resolved.model));
    assert.ok(result.text.includes("| baseURL | https://env.example.com/v1 | env |"));
    // env 覆盖了配置文件值
    assert.ok(!result.text.includes("https://file.example.com"));
    assert.equal(result.exitCode, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dump: CLI 参数为最高层——来源标 CLI 参数并覆盖 env", () => {
  const home = tempHome();
  try {
    const args = parseCliArgs(["--base-url", "https://cli.example.com/v1", "--model", "cli-model"]);
    const result = dumpConfigText({ env: { RAINCODE_HOME: home }, cwd: home, args, defaultOnly: false });
    assert.ok(result.text.includes("| baseURL | https://cli.example.com/v1 | CLI 参数 |"));
    assert.ok(result.text.includes("| model | cli-model | CLI 参数 |"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dump: config.json 层逐字段投影 + 来源标签；permissions/compaction 如实标注未接线", () => {
  const home = tempHome();
  try {
    new ConfigStore({ dataRoot: home }).write({
      configVersion: 1,
      activeProviderId: "local",
      providers: [
        { id: "local", name: "Local", baseURL: "https://cfg.example.com/v1", model: "cfg-model", maxContextTokens: 8192 },
      ],
      sandbox: { executor: "docker" },
    });
    const result = dump(home);
    assert.ok(result.text.includes("| activeProviderId | local | config.json |"));
    assert.ok(result.text.includes("id=local model=cfg-model"));
    assert.ok(result.text.includes("| sandbox.executor | docker | config.json（node.ts 读取，缺省 local） |"));
    // 未设置字段标内置默认 + schema 已声明未接线的诚实注记
    assert.ok(result.text.includes("| permissions.defaultBehavior | （未设置） | 内置默认（schema 已声明，运行时消费方未接线） |"));
    assert.ok(result.text.includes("| compaction | （未设置） | 内置默认（schema 已声明，运行时消费方未接线） |"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dump: 损坏 config.json → 诊断行 + 退出码 1，其余层仍打印；--default-only 仍可打印内置默认（退出码 0）", () => {
  const home = tempHome();
  try {
    writeFileSync(join(home, "config.json"), "{ not json", "utf8");
    const broken = dump(home);
    assert.equal(broken.exitCode, 1);
    assert.ok(broken.text.includes("⚠ config.json 读取失败"));
    assert.ok(broken.text.includes("--default-only"));
    // 其余层（Provider/env）照常输出
    assert.ok(broken.text.includes("## Provider 启动配置"));

    const recovered = dump(home, {}, { defaultOnly: true });
    assert.equal(recovered.exitCode, 0);
    assert.ok(recovered.text.includes("--default-only"));
    assert.ok(recovered.text.includes("## 内置默认层"));
    assert.ok(recovered.text.includes("| sandbox.executor | local"));
    // default-only 跳过文件读取：无 config.json 节
    assert.ok(!recovered.text.includes("## 全局 config.json"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dump: 明文密钥绝不入输出（env 注入与配置文件明文 apiKey 两路）", () => {
  const home = tempHome();
  try {
    const providersPath = join(home, "config", "providers.local.json");
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(
      providersPath,
      JSON.stringify({ name: "f", baseURL: "https://f.example.com/v1", model: "fm", apiKey: "sk-file-secret-456" }),
      "utf8",
    );
    const result = dump(home, {
      RAINCODE_PROVIDER_API_KEY: "sk-env-secret-123",
      RAINCODE_WEB_TOKEN: "web-token-789",
    });
    assert.ok(!result.text.includes("sk-env-secret-123"));
    assert.ok(!result.text.includes("sk-file-secret-456"));
    assert.ok(!result.text.includes("web-token-789"));
    assert.ok(result.text.includes("（已配置，值不打印）"));
    assert.ok(result.text.includes("（已设置，值不打印）"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dump: 未配置 Provider → 明确占位说明；default-only 含 providers 缺省路径与 maxContextTokens 默认", () => {
  const home = tempHome();
  try {
    const empty = dump(home);
    assert.equal(empty.exitCode, 0);
    assert.ok(empty.text.includes("未配置任何 Provider"));
    const defaults = dump(home, {}, { defaultOnly: true });
    assert.ok(defaults.text.includes(`| Provider maxContextTokens | 32768 |`));
    assert.ok(defaults.text.includes(join(home, "config", "providers.local.json")));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dump: 数据根来源标注（env 覆盖 vs 内置默认）", () => {
  const home = tempHome();
  try {
    const withEnv = dump(home);
    assert.ok(withEnv.text.includes(`- dataRoot: ${home}（来源 env）`));
    const withoutEnv = dumpConfigText({ env: {}, cwd: home, args: emptyArgs(), defaultOnly: false });
    assert.ok(withoutEnv.text.includes("（来源 内置默认 ~/.raincode）"));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
