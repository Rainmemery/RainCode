/**
 * SSH 执行域端到端冒烟（T4.8 / L-02：SshExecutor 此前仅有探针/argv/路径映射用例，从未真正连过 SSH 服务端）。
 * 运行：tsx scripts/smoke-ssh.mts（或 pnpm run smoke:ssh；已并入 smoke:p0 回归链）
 *
 * 形态：loopback 真 SSH2 协议服务端（ssh2 npm——密钥交换 / 公钥认证 / exec 通道均走真实线上协议）
 *   + 一次性 ssh-keygen 密钥对（临时目录，不触碰用户 ~/.ssh）
 *   + SshExecutor 经真实 ssh.exe（OpenSSH 客户端）发起连接——客户端与协议层全真；
 *   仅「远端主机」由本进程内 ssh2 服务端扮演：收到的远端命令（`cd <path> && env … sh -c <cmd>`）
 *   经解析后由本机 POSIX shell（sh）执行，与 SshExecutor 的远端命令契约同构。
 *   真 OpenSSH 服务端 / 真 Linux 远端主机仍是环境门控（legacy-items L-02 注记保留）。
 *
 * 断言：
 *   A 探针：resolveSandboxExecutor(ssh 配置) → kind=ssh 且无告警（`exit 0` 探测走真实协议）
 *   B 回合端到端：mock LLM 脚本化 bash 工具调用 → 命令经 SSH 执行域执行 → 输出与落盘文件
 *     在映射的远端根（N-3 验证世界）；cwd 映射经服务端线上收到的 cd 路径核对
 *   C env 注入：SshExecutor.run 显式 env → 远端 shell 可见，服务端线上核对 env 前缀
 *   D 失败收敛：错误密钥 → 探测失败 → 回退 local + 告警（02 §5.4 fail-closed）
 *   E 本地审计：会话事件 JSONL 落本地数据根（T3.2 口径），bash 工具调用在案
 *   F 诊断面：display() 以 "ssh " 开头（模型/UI 可见的真实命令形态）
 *
 * 全程仅本机回环与临时目录；密钥对一次性生成即弃，无任何真实凭据。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext } from "ssh2";
// ssh2 为 CJS 且具名导出未被 cjs-module-lexer 识别（ESM named import 报错），经 require 桥接
const require = createRequire(import.meta.url);
const { Server: SshServer } = require("ssh2") as typeof import("ssh2");
import { createInMemoryTransportPair, createRpcClient } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import { SshExecutor, resolveSandboxExecutor } from "../packages/tools/src/index.ts";
import type { SandboxConfig } from "../packages/shared/src/index.ts";
import type { ToolCallCompletedEventPayload } from "../packages/shared/src/index.ts";

const withTimeout = async <T,>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时（${String(ms)}ms）`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// SSH2 loopback 服务端（「远端主机」扮演：公钥认证 + exec 通道 + POSIX sh 执行）
// ---------------------------------------------------------------------------

/** 服务端收到的远端命令记录（线上核对面：cwd 映射 / env 注入 / 命令体）。 */
interface ExecRecord {
  cwd: string;
  env: Record<string, string>;
  command: string;
}

/** 解析 SshExecutor 远端命令契约：`cd "<path>" && [env K="V" …] sh -c "<cmd>"`；探测命令（exit 0）返回 null。
 * 注意：本地 shell 传递会消耗一层转义（JSON.stringify 的 \\ → \、\" → "），服务端按线上实收形态解析。 */
function parseRemoteCommand(raw: string): ExecRecord | null {
  const trimmed = raw.trim();
  if (trimmed === "exit 0") {
    return null;
  }
  const head = /^cd\s+"([^"]*)"\s+&&\s+([\s\S]*)$/.exec(trimmed);
  assert.ok(head !== null, `远端命令形态不符合 SshExecutor 契约: ${JSON.stringify(raw)}`);
  const cwd = head[1];
  const rest = head[2];
  const shIdx = rest.indexOf("sh -c ");
  assert.ok(shIdx >= 0, `远端命令缺少 sh -c 段: ${JSON.stringify(raw)}`);
  const env: Record<string, string> = {};
  const envPart = rest.slice(0, shIdx).trim();
  if (envPart.length > 0) {
    assert.ok(envPart.startsWith("env "), `env 段形态异常: ${JSON.stringify(envPart)}`);
    const pairs = envPart.slice(4).trim();
    if (pairs.length > 0) {
      for (const pair of pairs.split(/\s+(?=[A-Za-z_][A-Za-z0-9_]*=)/)) {
        const eq = pair.indexOf("=");
        const key = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        env[key] = /^".*"$/.test(value) ? value.slice(1, -1) : value;
      }
    }
  }
  const inner = /^sh\s+-c\s+"([^"]*)"\s*$/.exec(rest.slice(shIdx));
  assert.ok(inner !== null, `sh -c 段形态异常: ${JSON.stringify(rest.slice(shIdx))}`);
  return { cwd, env, command: inner[1] };
}

function resolveSh(): string {
  const probed = spawnSync("where", ["sh"], { encoding: "utf8" });
  const first = probed.status === 0 ? probed.stdout.trim().split(/\r?\n/)[0] : undefined;
  assert.ok(first !== undefined && first.length > 0, "未找到 POSIX sh（Git Bash/MSYS），SSH 冒烟无法扮演远端 shell");
  return first;
}

interface SshServerHandle {
  port: number;
  records: ExecRecord[];
  close: () => Promise<void>;
}

function startSshServer(keyPath: string, pubKeyData: Buffer): Promise<SshServerHandle> {
  const records: ExecRecord[] = [];
  const shPath = resolveSh();
  const server = new SshServer({ hostKeys: [readFileSync(keyPath, "utf8")] }, (client) => {
    // 负例（错误密钥）/中途断连会在协议层抛 client error——不吞会以未捕获异常击穿进程
    client.on("error", () => undefined);
    client.on("authentication", (ctx: AuthContext) => {
      if (ctx.method === "publickey" && ctx.key.algo === "ssh-ed25519" && ctx.key.data.equals(pubKeyData)) {
        ctx.accept();
      } else {
        ctx.reject();
      }
    });
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("exec", (accept, _reject, info) => {
          const stream = accept();
          const parsed = parseRemoteCommand(info.command);
          if (parsed === null) {
            stream.exit(0);
            stream.end();
            return;
          }
          records.push(parsed);
          const child = spawnSync(shPath, ["-c", parsed.command], {
            cwd: parsed.cwd,
            env: {
              SystemRoot: process.env["SystemRoot"] ?? "",
              PATH: process.env["PATH"] ?? "",
              ...parsed.env,
            },
            encoding: "buffer",
            timeout: 15_000,
          });
          if (child.stdout.byteLength > 0) {
            stream.write(child.stdout);
          }
          if (child.stderr.byteLength > 0) {
            stream.stderr.write(child.stderr);
          }
          stream.exit(child.status ?? (child.error !== undefined ? 127 : 0));
          stream.end();
        });
      });
    });
  });
  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({
        port,
        records,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// mock OpenAI SSE 服务器（脚本化 bash 工具调用 → 收束文本）
// ---------------------------------------------------------------------------

const BASH_CALL_1 = "echo RAINCODE_SSH_E2E > ssh-e2e-out.txt && cat ssh-e2e-out.txt";
const BASH_CALL_2 = "pwd";

function startMockLlmServer(): Promise<{ url: string; close: () => Promise<void> }> {
  let toolRounds = 0;
  const sse = (res: ServerResponse, body: unknown): void => {
    res.write(`data: ${JSON.stringify(body)}\n\n`);
  };
  const server = createServer((req, res) => {
    void Promise.resolve(req).then(() => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages: Array<{ role: string }> };
        const last = body.messages.at(-1);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        sse(res, { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] });
        if (last?.role !== "tool") {
          // 首轮：bash 工具调用（call 1）
          sse(res, {
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: 0, id: `call_ssh_${String(toolRounds)}`, type: "function", function: { name: "bash", arguments: "" } }] },
            }],
          });
          const args = JSON.stringify({ command: BASH_CALL_1, timeoutMs: 15000 });
          sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] });
          sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          toolRounds += 1;
        } else if (toolRounds === 1) {
          // 第二轮：pwd 核对 cwd 映射
          sse(res, {
            choices: [{
              index: 0,
              delta: { tool_calls: [{ index: 0, id: `call_ssh_${String(toolRounds)}`, type: "function", function: { name: "bash", arguments: "" } }] },
            }],
          });
          const args = JSON.stringify({ command: BASH_CALL_2, timeoutMs: 15000 });
          sse(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] });
          sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
          toolRounds += 1;
        } else {
          // 收束
          for (const delta of ["SSH_", "E2E_", "DONE"]) {
            sse(res, { choices: [{ index: 0, delta: { content: delta } }] });
          }
          sse(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          sse(res, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 5 } });
        }
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({
        url: `http://127.0.0.1:${String(port)}/v1`,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const DUMMY_KEY = "smoke-ssh-dummy-key-DO-NOT-PRINT";

async function main(): Promise<void> {
  // 一次性密钥对（ssh-keygen，临时目录即弃）
  const keyDir = mkdtempSync(join(tmpdir(), "raincode-smoke-ssh-key-"));
  const keyPath = join(keyDir, "id_ed25519");
  const wrongKeyPath = join(keyDir, "id_wrong");
  const gen = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "raincode-smoke-ssh"], { stdio: "ignore" });
  assert.equal(gen.status, 0, "ssh-keygen 生成密钥对失败（OpenSSH 客户端组件缺失？）");
  assert.ok(existsSync(keyPath), "私钥文件应存在");
  const genWrong = spawnSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", wrongKeyPath, "-C", "raincode-smoke-wrong"], { stdio: "ignore" });
  assert.equal(genWrong.status, 0, "ssh-keygen 生成干扰密钥对失败");
  const pubLine = readFileSync(`${keyPath}.pub`, "utf8").trim();
  const pubKeyData = Buffer.from(pubLine.split(" ")[1] ?? "", "base64");
  assert.ok(pubKeyData.byteLength > 0, "公钥解析失败");

  const server = await startSshServer(keyPath, pubKeyData);
  const home = mkdtempSync(join(tmpdir(), "raincode-smoke-ssh-home-"));
  const workspace = join(home, "ws");
  const remoteRoot = join(home, "remote");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(remoteRoot, { recursive: true });

  const sshConfig: SandboxConfig = {
    executor: "ssh",
    ssh: { host: "127.0.0.1", port: server.port, user: "raincode-smoke", identityFile: keyPath, remoteWorkspaceRoot: remoteRoot },
  };

  let mock: { url: string; close: () => Promise<void> } | undefined;
  let client: RpcClient | undefined;
  let node: Awaited<ReturnType<typeof createAgentServiceNode>> | undefined;
  try {
    // A：探针（`exit 0` 走真实 SSH 协议）→ kind=ssh 且无告警
    const resolved = await resolveSandboxExecutor(sshConfig);
    assert.equal(resolved.executor.kind, "ssh", "探针通过后应为 ssh 执行域");
    assert.equal(resolved.warnings.length, 0, "探针通过不应有回退告警");
    console.log(`A 探针：ssh://127.0.0.1:${String(server.port)} 探测通过，kind=ssh ✓`);

    // F：诊断面（display 前置验证，失败时输出可诊断）
    const probeExecutor = resolved.executor;
    assert.ok(
      probeExecutor.display({ command: "echo hi", cwd: workspace, workspaceRoot: workspace }).startsWith("ssh "),
      "display() 应以 ssh 开头",
    );

    // B：回合端到端（mock LLM 脚本化两次 bash 工具调用 → SSH 执行域 → 收束）
    mock = await startMockLlmServer();
    const transports = createInMemoryTransportPair();
    node = await createAgentServiceNode(transports[1], {
      env: { RAINCODE_HOME: home },
      provider: { name: "mock-ssh", baseURL: mock.url, model: "mock-model", apiKey: DUMMY_KEY, maxContextTokens: 8192 },
      tools: { approval: "always-allow" },
      permission: { policy: "default-allow" },
      sandboxConfig: sshConfig,
    });
    client = createRpcClient({ transport: transports[0] });
    await client.call("system.ping", {});
    const toolCompleted: ToolCallCompletedEventPayload[] = [];
    client.onEvent("tool_call.completed", (payload) => toolCompleted.push(payload as ToolCallCompletedEventPayload));
    const created = (await client.call("session.create", {
      workspaceRoot: workspace,
      title: "smoke-ssh",
    })) as { sessionId: string };
    const donePromise = new Promise<string>((resolveDone) => {
      client!.onEvent("done", (payload) => resolveDone((payload as { sessionId?: string }).sessionId ?? created.sessionId));
    });
    await client.call("session.send", { sessionId: created.sessionId, input: { text: "在远端执行验证命令" } });
    const doneSessionId = await withTimeout(donePromise, 30_000, "ssh 执行域回合收束");
    assert.equal(doneSessionId, created.sessionId, "done 事件应属本会话");
    assert.ok(toolCompleted.length >= 2, `应至少两次工具调用完成（实际 ${String(toolCompleted.length)}）`);
    assert.ok(toolCompleted.every((e) => e.isError === false), "两次 bash 调用应均成功完成");
    assert.equal(server.records.length, 2, `服务端应记录两次 exec（实际 ${String(server.records.length)}）`);

    // cwd 映射线上核对：会话 cwd（workspace 根）→ remoteWorkspaceRoot（两次调用逐条核对）
    const normalized = (p: string): string => p.replaceAll("\\", "/").replace(/\/+$/, "");
    for (const record of server.records) {
      assert.equal(
        normalized(record.cwd),
        normalized(remoteRoot),
        "workspace 根应映射到 remoteWorkspaceRoot（线上核对）",
      );
    }
    // 落盘验证（N-3）：completed 载荷仅 contentPreview（首行），回传正文的决定性证据在映射根的落盘文件
    const outFile = join(remoteRoot, "ssh-e2e-out.txt");
    assert.ok(existsSync(outFile), "远端落盘文件应存在于映射根");
    assert.ok(readFileSync(outFile, "utf8").includes("RAINCODE_SSH_E2E"), "远端落盘文件内容应一致");
    console.log("B 回合端到端：两次 bash 经 SSH 执行域执行，cwd 映射与远端落盘核对一致 ✓");

    // C：env 注入（直接 SshExecutor，线上核对 env 前缀 + 远端可见性）
    const executor = new SshExecutor(sshConfig.ssh);
    const envResult = await withTimeout(
      executor.run({
        command: "echo $SMOKE_SSH_PROBE",
        cwd: workspace,
        workspaceRoot: workspace,
        env: { SMOKE_SSH_PROBE: "env-ok" },
        timeoutMs: 20_000,
      }),
      30_000,
      "env 注入执行",
    );
    assert.ok(envResult.stdout.includes("env-ok"), `远端 shell 应看到注入 env: ${JSON.stringify(envResult.stdout.slice(0, 100))}`);
    assert.equal(server.records.at(-1)?.env["SMOKE_SSH_PROBE"], "env-ok", "服务端线上应收到的 env 前缀");
    console.log("C env 注入：SMOKE_SSH_PROBE 经远端命令前缀注入并可见 ✓");

    // E：本地审计（T3.2：SSH 执行域审计记录保留本地）
    const { Storage } = await import("../packages/storage/src/index.ts");
    const storage = await Storage.open({ env: { RAINCODE_HOME: home } });
    const sessions = await storage.sessions.list({});
    assert.equal(sessions.length, 1, "storage 应恰好 1 条会话");
    const eventsFile = await storage.sessionEventsFile(sessions[0].id);
    const raw = readFileSync(eventsFile, "utf8");
    assert.ok(raw.includes('"name":"tool_call.completed"'), "事件流应含 tool_call.completed");
    assert.ok(raw.includes('"name":"bash"'), "事件流应含 bash 工具调用记录");
    await storage.close();
    console.log("E 本地审计：SSH 执行域工具调用事件落本地数据根 ✓");

    // D：失败收敛（错误密钥 → 探测失败 → local 回退 + 告警）
    const badConfig: SandboxConfig = {
      executor: "ssh",
      ssh: { host: "127.0.0.1", port: server.port, user: "raincode-smoke", identityFile: wrongKeyPath, remoteWorkspaceRoot: remoteRoot },
    };
    const fallback = await withTimeout(resolveSandboxExecutor(badConfig), 20_000, "错误密钥探测收敛");
    assert.equal(fallback.executor.kind, "local", "密钥不通应回退 local");
    assert.ok(fallback.warnings.length > 0 && fallback.warnings[0].includes("不可达"), "应产出回退告警");
    console.log("D 失败收敛：错误密钥 → 探测失败 → local 回退 + 告警（fail-closed）✓");

    console.log("");
    console.log("SMOKE SSH OK");
  } finally {
    client?.close();
    if (node !== undefined) {
      await node.close();
    }
    await mock?.close();
    await server.close();
    rmSync(keyDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

main().catch((reason: unknown) => {
  console.error("SMOKE SSH FAILED:", reason instanceof Error ? reason.message : String(reason));
  process.exitCode = 1;
});
