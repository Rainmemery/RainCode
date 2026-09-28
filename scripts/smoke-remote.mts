/**
 * 可选真实冒烟（walking skeleton 第三波）：走完整 CLI run 路径调用真实 Provider。
 * 运行：tsx scripts/smoke-remote.mts（或 pnpm run smoke:remote）
 *
 * 读取 config/test-provider.local.json（已被 .gitignore 隔离，不入库；OpenAI 兼容，
 * baseURL https://llm-afjocnwxv51vfnrj.cn-beijing.maas.aliyuncs.com/compatible-mode/v1，
 * model qwen3.7-flash）→ 临时 NOVACODE_HOME → 进程内调用 apps/cli main(["run", ...])。
 *
 * 安全约束（04-architecture §5.3）：apiKey 只存在于内存与本地配置文件，
 * 绝不出现在任何输出/日志/被跟踪文件中——本脚本对 stdout/stderr 全量捕获并断言无密钥泄露。
 * 30s 超时；网络不通/服务端错误如实报告（FAILED），不影响本地 smoke-e2e 的结论。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main as cliMain } from "../apps/cli/src/index.ts";

interface RemoteProviderConfig {
  name?: string;
  baseURL: string;
  apiKey: string;
  model: string;
  protocol?: string;
  prompt?: string;
  maxContextTokens?: number;
  timeoutMs?: number;
}

const REMOTE_TIMEOUT_MS = 30_000;
const configPath = join(fileURLToPath(new URL("../config/test-provider.local.json", import.meta.url)));

type WriteFn = typeof process.stdout.write;

function captureStreams(): { restore: () => void; getOut: () => string; getErr: () => string } {
  let out = "";
  let err = "";
  const originalOut = process.stdout.write;
  const originalErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    out += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as WriteFn;
  process.stderr.write = ((chunk: unknown) => {
    err += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  }) as WriteFn;
  return {
    restore: () => {
      process.stdout.write = originalOut;
      process.stderr.write = originalErr;
    },
    getOut: () => out,
    getErr: () => err,
  };
}

async function main(): Promise<void> {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as RemoteProviderConfig;
  if (
    typeof config.baseURL !== "string" ||
    typeof config.model !== "string" ||
    typeof config.apiKey !== "string" ||
    config.baseURL.length === 0 ||
    config.model.length === 0 ||
    config.apiKey.length === 0
  ) {
    throw new Error("config/test-provider.local.json 缺少 baseURL / model / apiKey 字段");
  }
  console.log(
    `remote provider: ${config.name ?? "unnamed"} · model: ${config.model} · protocol: ${config.protocol ?? "openai-compatible"}`,
  );
  console.log("（apiKey 已加载，不打印）");

  const home = await mkdtemp(join(tmpdir(), "novacode-smoke-remote-"));
  const savedEnv: Array<[string, string | undefined]> = [
    ["NOVACODE_HOME", process.env["NOVACODE_HOME"]],
    ["NOVACODE_PROVIDER_BASE_URL", process.env["NOVACODE_PROVIDER_BASE_URL"]],
    ["NOVACODE_PROVIDER_MODEL", process.env["NOVACODE_PROVIDER_MODEL"]],
    ["NOVACODE_PROVIDER_API_KEY", process.env["NOVACODE_PROVIDER_API_KEY"]],
  ];
  const setEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  setEnv("NOVACODE_HOME", home);
  setEnv("NOVACODE_PROVIDER_BASE_URL", config.baseURL);
  setEnv("NOVACODE_PROVIDER_MODEL", config.model);
  setEnv("NOVACODE_PROVIDER_API_KEY", config.apiKey);

  const captured = captureStreams();
  try {
    const timeoutMs = config.timeoutMs ?? REMOTE_TIMEOUT_MS;
    const exitCode = await Promise.race([
      cliMain(["run", config.prompt ?? "用一句话介绍你自己。"]),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`remote smoke timeout after ${String(timeoutMs)}ms`)), timeoutMs);
      }),
    ]);
    captured.restore();
    const stdoutText = captured.getOut();
    const stderrText = captured.getErr();

    assert.equal(exitCode, 0, `run 应以 0 退出（stderr: ${stderrText.slice(0, 500)}）`);
    assert.ok(
      !stdoutText.includes(config.apiKey) && !stderrText.includes(config.apiKey),
      "apiKey 泄露到输出（安全断言失败）",
    );
    assert.ok(stdoutText.trim().length > 0, "stdout 应包含流式回答文本");

    // 输出捕获期间的内容（回答正文）；确保不含密钥后再打印
    process.stdout.write("\n--- 模型回答（stdout 捕获回放）---\n");
    process.stdout.write(stdoutText);
    process.stdout.write("\n--- 会话事实已落临时 NOVACODE_HOME，resume 历史与本地 smoke 同链路 ---\n");
    console.log("");
    console.log("SMOKE REMOTE OK");
  } catch (reason: unknown) {
    captured.restore();
    // 双保险：失败路径输出也过密钥过滤
    const message = (reason instanceof Error ? reason.message : String(reason)).replaceAll(config.apiKey, "***");
    const errText = captured.getErr().replaceAll(config.apiKey, "***");
    console.error("");
    console.error(`SMOKE REMOTE FAILED（网络不通或服务端错误属如实报告，不影响本地结论）: ${message}`);
    if (errText.length > 0) {
      console.error(`stderr 摘要: ${errText.slice(0, 800)}`);
    }
    process.exitCode = 1;
  } finally {
    captured.restore();
    for (const [key, value] of savedEnv) {
      setEnv(key, value);
    }
  }
}

main().catch((reason: unknown) => {
  console.error("SMOKE REMOTE FAILED:", reason);
  process.exitCode = 1;
});
