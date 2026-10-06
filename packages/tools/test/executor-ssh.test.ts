/**
 * SshExecutor 单测（T3.2 / ES-5 远程工作区执行域；自 executor.test.ts 抽出——T5.7 base64
 * 加固用例加入后超出 500 行门禁，按域拆分）。
 * 覆盖：base64 远端命令契约（路径映射解码核对 / 连接参数 / env 注入 / 内嵌双引号逐字保真
 * —— T4.8 双引号残差核销）、工厂探针与回退、bash 工具接线（sandbox/enforcement 标注）。
 * 线上端到端（真 SSH2 协议 + 真 OpenSSH 客户端）见 scripts/smoke-ssh.mts。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import {
  createBashTool,
  BackgroundTaskRegistry,
  SshExecutor,
  resolveSandboxExecutor,
  type ExecutorTransport,
  type ExecRequest,
} from "../src/index.js";

/** 记录型替身 transport：exec 请求全量留存供命令串断言；立即收敛。 */
function recordingTransport(): { transport: ExecutorTransport; execed: ExecRequest[] } {
  const execed: ExecRequest[] = [];
  const transport: ExecutorTransport = {
    spawn() {
      throw new Error("smoke-ssh 单测不应走 spawn");
    },
    async exec(req) {
      execed.push(req);
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        truncated: false,
        durationMs: 1,
        killed: false,
      };
    },
  };
  return { transport, execed };
}

const WORKSPACE = resolve("D:/proj/ws");
const inside = (rel: string): string => resolve(WORKSPACE, rel);

/** SshExecutor base64 契约解码（T5.7）：`echo <b64> | base64 -d | sh` → 远端脚本明文。 */
function decodeRemoteCommand(wire: string): string {
  const m = /^echo\s+([A-Za-z0-9+/=]+)\s+\|\s+base64\s+-d\s+\|\s+sh$/.exec(wire.trim());
  assert.ok(m !== null, `远端命令应为 base64 包装契约: ${JSON.stringify(wire)}`);
  return Buffer.from(m[1]!, "base64").toString("utf8");
}

describe("SshExecutor（T3.2 / ES-5 远程工作区）", () => {
  const target = {
    host: "build.example.com",
    user: "deploy",
    port: 2222,
    identityFile: "C:/keys/id_ed25519",
    remoteWorkspaceRoot: "/srv/work/ws",
  };

  it("远端路径映射：workspace 内 cwd → remoteWorkspaceRoot 相对展开（base64 契约解码核对）", () => {
    const executor = new SshExecutor(target);
    const { file, args } = executor.buildArgv({ command: "make", cwd: inside("src"), workspaceRoot: WORKSPACE });
    assert.equal(file, "ssh");
    const remote = args.at(-1)!;
    // 线上可见面 = `echo <b64> | base64 -d | sh`：无引号无空格元字符（免疫本地 shell/argv 逐层解析）
    assert.match(remote, /^echo [A-Za-z0-9+/=]+ \| base64 -d \| sh$/, remote);
    assert.equal(decodeRemoteCommand(remote), `cd '/srv/work/ws/src' && sh -c 'make'`);
  });

  it("连接参数：user@host + -p 端口 + -i 密钥 + BatchMode（禁交互提示）", () => {
    const executor = new SshExecutor(target);
    const { args } = executor.buildArgv({ command: "ls", cwd: WORKSPACE, workspaceRoot: WORKSPACE });
    assert.ok(args.includes("-o"));
    assert.ok(args.includes("BatchMode=yes"));
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("2222"));
    assert.ok(args.includes("-i"));
    assert.ok(args.includes("C:/keys/id_ed25519"));
    assert.ok(args.includes("deploy@build.example.com"));
  });

  it("env 注入：远端 env K=V 前缀（ssh 不转发本地环境）", () => {
    const executor = new SshExecutor(target);
    const remote = executor.buildRemoteCommand({ command: "npm test", cwd: WORKSPACE, env: { CI: "1" } });
    assert.equal(
      decodeRemoteCommand(remote),
      `cd '/srv/work/ws' && env CI='1' sh -c 'npm test'`,
    );
  });

  it("T5.7 base64 加固：内嵌双引号/单引号/CJK/&& 远端命令逐字保真（T4.8 双引号残差核销）", () => {
    const executor = new SshExecutor(target);
    const tricky = `echo "a \\"b\\" && not-truncated" 'sq'"'"'ok' 中文`;
    const decoded = decodeRemoteCommand(
      executor.buildRemoteCommand({ command: tricky, cwd: WORKSPACE, workspaceRoot: WORKSPACE }),
    );
    assert.equal(decoded, `cd '/srv/work/ws' && sh -c '${tricky.replaceAll("'", `'\\''`)}'`);
    // 线上命令行零双引号：本地 argv/shell 任何一层都不可能消耗转义
    const { args } = executor.buildArgv({ command: tricky, cwd: WORKSPACE, workspaceRoot: WORKSPACE });
    assert.ok(!args.at(-1)!.includes('"'), "远端命令串不应含双引号");
  });

  it("无 user/无端口：destination 仅 host", () => {
    const executor = new SshExecutor({ host: "h1", remoteWorkspaceRoot: "/w" });
    const { args } = executor.buildArgv({ command: "ls", cwd: WORKSPACE, workspaceRoot: WORKSPACE });
    assert.ok(args.includes("h1"));
    assert.ok(!args.includes("-p"));
  });

  it("工厂：探针通过生效 / 未配置 ssh 节或不可达回退告警", async () => {
    const ok = await resolveSandboxExecutor(
      { executor: "ssh", ssh: target },
      { docker: async () => false, wsl: async () => false, ssh: async () => true },
    );
    assert.equal(ok.executor.kind, "ssh");
    assert.ok(ok.executor instanceof SshExecutor);
    assert.deepEqual(ok.warnings, []);

    const noCfg = await resolveSandboxExecutor(
      { executor: "ssh" },
      { docker: async () => false, wsl: async () => false, ssh: async () => false },
    );
    assert.equal(noCfg.executor.kind, "local");
    assert.ok(noCfg.warnings[0]!.includes("ssh 连接配置"));

    const unreachable = await resolveSandboxExecutor(
      { executor: "ssh", ssh: target },
      { docker: async () => false, wsl: async () => false, ssh: async () => false },
    );
    assert.equal(unreachable.executor.kind, "local");
    assert.ok(unreachable.warnings[0]!.includes("连通性探测失败"));
  });

  it("bash 接线：data.sandbox=ssh 且内容头行标注", async () => {
    const { transport, execed } = recordingTransport();
    const tool = createBashTool({ executor: new SshExecutor(target, transport) });
    const background = new BackgroundTaskRegistry();
    const out = await tool.execute(
      { command: "make all" },
      {
        signal: new AbortController().signal,
        workspaceRoot: WORKSPACE,
        cwd: WORKSPACE,
        sessionKey: "test",
        background,
      },
    );
    assert.equal(out.data.sandbox, "ssh");
    assert.equal(out.data.enforcement, "partial", "ssh 探针不可得时工厂缺省 partial");
    assert.ok(out.content!.startsWith("sandbox: ssh (enforcement: partial)\nexit code: 0"));
    assert.ok(execed[0]!.command.startsWith("ssh '"), 'run/spawn 命令串应经 shell 单引号包装（argv 世界 → shell 字符串世界）');
    // T5.7 base64 契约：本地命令串不再含远端命令明文，解码后核对 sh -c 载荷
    const local = execed[0]!.command;
    const payload = /echo ([A-Za-z0-9+/=]+) \| base64/.exec(local)?.[1];
    assert.ok(payload !== undefined, `本地命令串应含 base64 载荷: ${JSON.stringify(local)}`);
    assert.ok(Buffer.from(payload, "base64").toString("utf8").includes("sh -c 'make all'"));
  });
});
