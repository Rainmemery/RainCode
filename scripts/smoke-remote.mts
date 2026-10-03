/**
 * 可选真实冒烟·Provider 连通矩阵（T4.8 / L-14：smoke:remote 矩阵化）。
 * 运行：tsx scripts/smoke-remote.mts（或 pnpm run smoke:remote）
 *
 * 读取 config/remote-providers.local.json（已被 .gitignore 隔离，不入库）：
 *   { "providers": [ { name, baseURL, model, apiKey, maxContextTokens?, prompt?, timeoutMs?, disabled? }, ... ] }
 * 对每个未 disabled 条目：临时 RAINCODE_HOME → 环境变量注入 → 进程内调用 apps/cli main(["run", prompt])
 * → 断言 exit 0 + 非空回答 + apiKey 不泄露 → 逐条 PASS/FAILED 矩阵汇报。
 *
 * 兼容旧单条形态：矩阵文件缺失时回退 config/test-provider.local.json（单 Provider）。
 * 五 Provider 矩阵口径（07 §2.4 场景 1 = OpenAI/DeepSeek/Kimi/GLM/Ollama）：无密钥的条目不进
 * 配置文件即不参与，属环境门控（legacy-items L-14 保留口径）；本地 Ollama（OpenAI 兼容端点
 * http://127.0.0.1:11434/v1）无需密钥即可入阵。
 *
 * 安全约束（04-architecture §5.3）：apiKey 只存在于内存与本地配置文件，绝不出现在任何
 * 输出/日志/被跟踪文件中——本脚本对 stdout/stderr 全量捕获并断言无密钥泄露（失败路径双保险替换）。
 * 网络不通/服务端错误如实报告（FAILED），不影响本地冒烟结论。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main as cliMain } from "../apps/cli/src/index.ts";

interface MatrixProviderConfig {
  name?: string;
  baseURL: string;
  apiKey: string;
  model: string;
  protocol?: string;
  prompt?: string;
  maxContextTokens?: number;
  timeoutMs?: number;
  /** 显式停用（保留条目做申报记录，不参与连通）。 */
  disabled?: boolean;
}

interface MatrixConfigFile {
  providers: MatrixProviderConfig[];
}

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

const CONFIG_DIR = join(fileURLToPath(new URL("../config/", import.meta.url)));
const MATRIX_PATH = join(CONFIG_DIR, "remote-providers.local.json");
const LEGACY_PATH = join(CONFIG_DIR, "test-provider.local.json");

function loadMatrix(): MatrixProviderConfig[] {
  if (existsSync(MATRIX_PATH)) {
    const parsed = JSON.parse(readFileSync(MATRIX_PATH, "utf8")) as MatrixConfigFile;
    assert.ok(Array.isArray(parsed.providers) && parsed.providers.length > 0, "矩阵文件 providers 应为非空数组");
    return parsed.providers;
  }
  if (existsSync(LEGACY_PATH)) {
    console.log("（未找到矩阵文件，回退单条 legacy 形态 config/test-provider.local.json）");
    return [JSON.parse(readFileSync(LEGACY_PATH, "utf8")) as MatrixProviderConfig];
  }
  throw new Error(
    "未找到 config/remote-providers.local.json（矩阵形态）或 config/test-provider.local.json（单条形态）——真实 Provider 冒烟需要本地配置（.gitignore 隔离，不入库）",
  );
}

function validateEntry(entry: MatrixProviderConfig, index: number): void {
  const label = entry.name ?? `#${String(index)}`;
  assert.equal(typeof entry.baseURL, "string", `${label}: baseURL 缺失`);
  assert.equal(typeof entry.model, "string", `${label}: model 缺失`);
  assert.equal(typeof entry.apiKey, "string", `${label}: apiKey 缺失`);
  assert.ok(entry.baseURL.length > 0 && entry.model.length > 0 && entry.apiKey.length > 0, `${label}: 字段不能为空`);
}

const DEFAULT_TIMEOUT_MS = 30_000;

async function runEntry(entry: MatrixProviderConfig): Promise<{ ok: boolean; detail: string; durationMs: number }> {
  const started = Date.now();
  const home = await mkdtemp(join(tmpdir(), "raincode-smoke-remote-"));
  const savedEnv: Array<[string, string | undefined]> = [
    ["RAINCODE_HOME", process.env["RAINCODE_HOME"]],
    ["RAINCODE_PROVIDER_BASE_URL", process.env["RAINCODE_PROVIDER_BASE_URL"]],
    ["RAINCODE_PROVIDER_MODEL", process.env["RAINCODE_PROVIDER_MODEL"]],
    ["RAINCODE_PROVIDER_API_KEY", process.env["RAINCODE_PROVIDER_API_KEY"]],
  ];
  const setEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  setEnv("RAINCODE_HOME", home);
  setEnv("RAINCODE_PROVIDER_BASE_URL", entry.baseURL);
  setEnv("RAINCODE_PROVIDER_MODEL", entry.model);
  setEnv("RAINCODE_PROVIDER_API_KEY", entry.apiKey);

  const captured = captureStreams();
  try {
    const timeoutMs = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const exitCode = await Promise.race([
      cliMain(["run", entry.prompt ?? "用一句话介绍你自己。"]),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`timeout after ${String(timeoutMs)}ms`)), timeoutMs);
      }),
    ]);
    captured.restore();
    const stdoutText = captured.getOut();
    const stderrText = captured.getErr();
    assert.equal(exitCode, 0, `run 应以 0 退出（stderr: ${stderrText.slice(0, 300)}）`);
    assert.ok(
      !stdoutText.includes(entry.apiKey) && !stderrText.includes(entry.apiKey),
      "apiKey 泄露到输出（安全断言失败）",
    );
    assert.ok(stdoutText.trim().length > 0, "stdout 应包含流式回答文本");
    return { ok: true, detail: stdoutText.trim().replaceAll("\n", " ").slice(0, 60), durationMs: Date.now() - started };
  } catch (reason: unknown) {
    captured.restore();
    const message = (reason instanceof Error ? reason.message : String(reason)).replaceAll(entry.apiKey, "***");
    return { ok: false, detail: message.replaceAll("\n", " ").slice(0, 160), durationMs: Date.now() - started };
  } finally {
    captured.restore();
    for (const [key, value] of savedEnv) {
      setEnv(key, value);
    }
  }
}

async function main(): Promise<void> {
  const entries = loadMatrix();
  const results: Array<{ name: string; model: string; ok: boolean; detail: string; durationMs: number }> = [];
  for (const [index, entry] of entries.entries()) {
    const name = entry.name ?? `provider-${String(index)}`;
    if (entry.disabled === true) {
      console.log(`- ${name} · ${entry.model}: SKIPPED（disabled）`);
      results.push({ name, model: entry.model, ok: true, detail: "disabled", durationMs: 0 });
      continue;
    }
    validateEntry(entry, index);
    console.log(`→ ${name} · ${entry.model} · ${entry.protocol ?? "openai-compatible"}（apiKey 已加载，不打印）`);
    const result = await runEntry(entry);
    console.log(`  ${result.ok ? "PASS" : "FAILED"}（${String(result.durationMs)}ms）${result.detail}`);
    results.push({ ...result, name, model: entry.model });
  }

  const active = results.filter((r) => r.detail !== "disabled");
  const passed = active.filter((r) => r.ok);
  console.log("");
  console.log(
    `矩阵汇总：${String(passed.length)}/${String(active.length)} 连通（另 SKIPPED ${String(results.length - active.length)} 条）`,
  );
  if (active.length === 0) {
    console.error("SMOKE REMOTE FAILED: 无参与连通的条目");
    process.exitCode = 1;
    return;
  }
  if (passed.length < active.length) {
    console.error("SMOKE REMOTE FAILED（存在连通失败条目；网络不通/服务端错误属如实报告，不影响本地冒烟结论）");
    process.exitCode = 1;
    return;
  }
  console.log("SMOKE REMOTE OK");
}

main().catch((reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error("SMOKE REMOTE FAILED:", message);
  process.exitCode = 1;
});
