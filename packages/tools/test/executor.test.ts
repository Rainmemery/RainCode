/**
 * 沙箱执行域单测（M3 T3.1 / 02-module-design §5.3 Executor 扩展点）。
 * 覆盖：工厂解析（未配置 local / docker+wsl 不可用回退告警 / 可用生效）、DockerExecutor
 * argv 策略断言（仅挂载 workspace = 越界拦截语义、--network 隔离、workdir 映射、env 注入、
 * 退出后 rm -f 清理）、WslExecutor 命令翻译（--cd / 发行版 / env 前缀）、bash 工具执行域接线
 * （sandbox 标记 / 后台任务同域投递 / 路径守卫不变）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import { z } from "zod";
import {
  createBashTool,
  BackgroundTaskRegistry,
  DockerExecutor,
  LocalExecutor,
  SshExecutor,
  ToolExecutor,
  ToolRegistry,
  WslExecutor,
  resolveSandboxExecutor,
  type ExecRequest,
  type ExecutorTransport,
  type SpawnHandle,
  type Tool,
  type ToolRunContext,
  type SshTarget,
} from "../src/index.js";
import { ToolExecutionError } from "../src/executor.js";
import { TOOL_ERROR_CODES } from "@raincode/shared";
import type { ToolExecutionContext } from "../src/tool.js";

/** 记录型替身 transport：spawn/exec 请求全量留存供 argv 断言；立即收敛。 */
function recordingTransport(): { transport: ExecutorTransport; spawned: ExecRequest[]; execed: ExecRequest[] } {
  const spawned: ExecRequest[] = [];
  const execed: ExecRequest[] = [];
  const transport: ExecutorTransport = {
    spawn(req) {
      spawned.push(req);
      const handle: SpawnHandle = {
        pid: 4242,
        exit: Promise.resolve({ exitCode: 0, timedOut: false, killed: false, durationMs: 1 }),
        stdout: () => "",
        stderr: () => "",
        truncated: () => false,
      };
      return handle;
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
  return { transport, spawned, execed };
}

const WORKSPACE = resolve("D:/proj/ws");
const inside = (rel: string): string => resolve(WORKSPACE, rel);

describe("resolveSandboxExecutor（02 §5.4 工厂）", () => {
  it("未配置：local、零探测、无告警", async () => {
    let probed = false;
    const resolved = await resolveSandboxExecutor(undefined, {
      docker: async () => { probed = true; return true; },
      wsl: async () => { probed = true; return true; },
      ssh: async () => { probed = true; return true; },
    });
    assert.equal(resolved.executor.kind, "local");
    assert.equal(resolved.requested, "local");
    assert.deepEqual(resolved.warnings, []);
    assert.equal(probed, false);
  });

  it("docker 不可用：回退 local + 告警（kind 标记真实执行环境）", async () => {
    const resolved = await resolveSandboxExecutor({ executor: "docker" }, {
      docker: async () => false,
      wsl: async () => true,
      ssh: async () => false,
    });
    assert.equal(resolved.executor.kind, "local");
    assert.equal(resolved.requested, "docker");
    assert.equal(resolved.warnings.length, 1);
    assert.ok(resolved.warnings[0]!.includes("docker"), "告警应指明不可用的执行域");
  });

  it("wsl 不可用：回退 local + 告警", async () => {
    const resolved = await resolveSandboxExecutor({ executor: "wsl" }, {
      docker: async () => true,
      wsl: async () => false,
      ssh: async () => false,
    });
    assert.equal(resolved.executor.kind, "local");
    assert.ok(resolved.warnings[0]!.includes("wsl"));
  });

  it("docker 可用：DockerExecutor 生效且配置透传", async () => {
    const resolved = await resolveSandboxExecutor(
      { executor: "docker", image: "ubuntu:24.04", network: "bridge" },
      { docker: async () => true, wsl: async () => false, ssh: async () => false },
    );
    assert.ok(resolved.executor instanceof DockerExecutor);
    assert.deepEqual(resolved.warnings, []);
    const { transport } = recordingTransport();
    const docker = resolved.executor as DockerExecutor;
    const { args } = docker.buildArgv({ command: "ls", cwd: WORKSPACE }, "raincode-x");
    void transport;
    assert.ok(args.includes("ubuntu:24.04"));
    assert.ok(args.includes("--network=bridge"));
  });
});

describe("DockerExecutor（ES-3 隔离策略）", () => {
  it("仅挂载 workspace（越界拦截语义）：-v 单条 + workdir 相对映射", () => {
    const docker = new DockerExecutor();
    const { file, args } = docker.buildArgv(
      { command: "cat notes.md", cwd: inside("docs"), workspaceRoot: WORKSPACE },
      "raincode-x",
    );
    assert.equal(file, "docker");
    const mounts: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === "-v") mounts.push(args[i + 1]!);
    }
    assert.equal(mounts.length, 1, "mount 仅 workspace 一条");
    assert.equal(mounts[0]!.slice(mounts[0]!.lastIndexOf(":") + 1), "/workspace");
    const wIndex = args.indexOf("-w");
    assert.equal(args[wIndex + 1], "/workspace/docs");
  });

  it("缺省 --network=none（断网隔离）+ 缺省镜像 + /bin/sh -c 收尾", () => {
    const docker = new DockerExecutor();
    const { args } = docker.buildArgv({ command: "echo hi", cwd: WORKSPACE }, "raincode-x");
    assert.ok(args.includes("--network=none"));
    assert.ok(args.includes("--rm"));
    assert.ok(args.some((a) => a.startsWith("--name=raincode-x")));
    assert.equal(args.at(-4), "node:20-bookworm-slim");
    assert.deepEqual(args.slice(-3), ["/bin/sh", "-c", "echo hi"]);
  });

  it("env 注入 -e 参数", () => {
    const docker = new DockerExecutor();
    const { args } = docker.buildArgv(
      { command: "env", cwd: WORKSPACE, env: { FOO: "bar", BAZ: "qux" } },
      "raincode-x",
    );
    assert.ok(args.includes("-e"));
    assert.ok(args.includes("FOO=bar"));
    assert.ok(args.includes("BAZ=qux"));
  });

  it("run 经替身 transport 投递 docker 命令；退出后 rm -f 清理容器", async () => {
    const { transport, spawned, execed } = recordingTransport();
    const docker = new DockerExecutor({}, transport);
    const result = await docker.run({ command: "ls -la", cwd: WORKSPACE, workspaceRoot: WORKSPACE });
    assert.equal(result.exitCode, 0);
    assert.equal(spawned.length, 1);
    assert.ok(spawned[0]!.command.startsWith("docker run --rm --name="));
    await new Promise((r) => setTimeout(r, 10)); // exit 回调异步触发清理
    assert.equal(execed.length, 1);
    assert.ok(execed[0]!.command.startsWith("docker rm -f raincode-"));
  });

  it("display：模型可见的容器 argv 形态", () => {
    const docker = new DockerExecutor();
    const text = docker.display({ command: "echo hi", cwd: WORKSPACE });
    assert.ok(text.startsWith("docker run"));
    assert.ok(text.includes("echo hi"));
  });
});

describe("WslExecutor（ES-4）", () => {
  it("wsl --cd 自动翻译路径 + /bin/sh -c", () => {
    const wsl = new WslExecutor();
    assert.equal(
      wsl.buildCommand({ command: "make test", cwd: inside("app"), workspaceRoot: WORKSPACE }),
      `wsl --cd ${JSON.stringify(inside("app"))} -e /bin/sh -c ${JSON.stringify("make test")}`,
    );
  });

  it("指定发行版 -d + env 注入 env K=V 前缀", () => {
    const wsl = new WslExecutor({ wslDistro: "Ubuntu-22.04" });
    const cmd = wsl.buildCommand({ command: "npm i", cwd: WORKSPACE, env: { CI: "1" } });
    assert.ok(cmd.startsWith("wsl -d Ubuntu-22.04 --cd"));
    assert.ok(cmd.includes(`env CI=${JSON.stringify("1")} /bin/sh -c`));
  });

  it("run 透传底层 ExecRequest（cwd/timeout 保留，仅命令改写）", async () => {
    const { transport, execed } = recordingTransport();
    const wsl = new WslExecutor({}, transport);
    await wsl.run({ command: "ls", cwd: WORKSPACE, workspaceRoot: WORKSPACE, timeoutMs: 5_000 });
    assert.equal(execed.length, 1);
    assert.equal(execed[0]!.cwd, WORKSPACE);
    assert.equal(execed[0]!.timeoutMs, 5_000);
    assert.ok(execed[0]!.command.includes("/bin/sh -c"));
  });
});

describe("LocalExecutor", () => {
  it("命令原样透传", async () => {
    const { transport, execed } = recordingTransport();
    const local = new LocalExecutor(transport);
    const result = await local.run({ command: "git status", cwd: WORKSPACE });
    assert.equal(result.exitCode, 0);
    assert.equal(execed[0]!.command, "git status");
  });
});

describe("SshExecutor（T3.2 / ES-5 远程工作区）", () => {
  const target = {
    host: "build.example.com",
    user: "deploy",
    port: 2222,
    identityFile: "C:/keys/id_ed25519",
    remoteWorkspaceRoot: "/srv/work/ws",
  };

  it("远端路径映射：workspace 内 cwd → remoteWorkspaceRoot 相对展开", () => {
    const wsl = new SshExecutor(target);
    const { file, args } = wsl.buildArgv({ command: "make", cwd: inside("src"), workspaceRoot: WORKSPACE });
    assert.equal(file, "ssh");
    const remote = args.at(-1)!;
    assert.ok(remote.startsWith(`cd "/srv/work/ws/src" && `), remote);
    assert.ok(remote.includes("sh -c"));
  });

  it("连接参数：user@host + -p 端口 + -i 密钥 + BatchMode（禁交互提示）", () => {
    const wsl = new SshExecutor(target);
    const { args } = wsl.buildArgv({ command: "ls", cwd: WORKSPACE, workspaceRoot: WORKSPACE });
    assert.ok(args.includes("-o"));
    assert.ok(args.includes("BatchMode=yes"));
    assert.ok(args.includes("-p"));
    assert.ok(args.includes("2222"));
    assert.ok(args.includes("-i"));
    assert.ok(args.includes("C:/keys/id_ed25519"));
    assert.ok(args.includes("deploy@build.example.com"));
  });

  it("env 注入：远端 env K=V 前缀（ssh 不转发本地环境）", () => {
    const wsl = new SshExecutor(target);
    const remote = wsl.buildRemoteCommand({ command: "npm test", cwd: WORKSPACE, env: { CI: "1" } });
    assert.ok(remote.includes(`env CI=${JSON.stringify("1")} sh -c`));
  });

  it("无 user/无端口：destination 仅 host", () => {
    const wsl = new SshExecutor({ host: "h1", remoteWorkspaceRoot: "/w" });
    const { args } = wsl.buildArgv({ command: "ls", cwd: WORKSPACE, workspaceRoot: WORKSPACE });
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
    assert.ok(execed[0]!.command.includes("make all"));
  });
});

describe("bash 工具执行域接线（T3.1）", () => {
  const ctx = (workspaceRoot: string, cwd: string, background: BackgroundTaskRegistry): ToolExecutionContext => ({
    signal: new AbortController().signal,
    workspaceRoot,
    cwd,
    sessionKey: "test",
    background,
  });

  it("非 local 执行域：内容头行带 sandbox 标记 + data.sandbox", async () => {
    const { transport, spawned } = recordingTransport();
    const docker = new DockerExecutor({}, transport);
    const tool = createBashTool({ executor: docker });
    const out = await tool.execute(
      { command: "echo hello" },
      ctx(WORKSPACE, WORKSPACE, new BackgroundTaskRegistry()),
    );
    assert.equal(out.data.sandbox, "docker");
    assert.equal(out.data.enforcement, "full");
    assert.ok(out.content!.startsWith("sandbox: docker (enforcement: full)\nexit code: 0"));
    assert.ok(spawned[0]!.command.startsWith("docker run"));
    assert.equal(spawned[0]!.workspaceRoot, WORKSPACE, "挂载基准随请求传递");
  });

  it("local 缺省：输出无 sandbox 头行（P0 字节兼容）", async () => {
    const { transport, execed } = recordingTransport();
    const tool = createBashTool({ executor: new LocalExecutor(transport) });
    const out = await tool.execute({ command: "echo hi" }, ctx(WORKSPACE, WORKSPACE, new BackgroundTaskRegistry()));
    assert.equal(out.data.sandbox, "local");
    assert.equal(out.data.enforcement, "partial", "local 约束非隔离，如实自报 partial");
    assert.ok(out.content!.startsWith("exit code: 0"));
    assert.equal(execed.length, 1);
  });

  it("cwd 越界守卫不变（docker 执行域同样拦截）", async () => {
    const { transport } = recordingTransport();
    const tool = createBashTool({ executor: new DockerExecutor({}, transport) });
    await assert.rejects(
      tool.execute({ command: "ls /" }, ctx(WORKSPACE, resolve(WORKSPACE, ".."), new BackgroundTaskRegistry())),
      (err: unknown) =>
        err instanceof Error && (err as { code?: string }).code === "TOOL_PATH_ESCAPED",
    );
  });


  it("后台任务同域投递：registry 绑定 docker 时经 executor.spawn", async () => {
    const { transport, spawned } = recordingTransport();
    const background = new BackgroundTaskRegistry({ executor: new DockerExecutor({}, transport) });
    const tool = createBashTool({ executor: new DockerExecutor({}, transport) });
    const out = await tool.execute(
      { command: "npm run build", runInBackground: true },
      ctx(WORKSPACE, WORKSPACE, background),
    );
    assert.ok(out.data.taskId !== undefined);
    assert.equal(out.data.sandbox, "docker");
    assert.equal(out.data.enforcement, "full", "后台路径同样持续携带 enforcement");
    assert.ok(spawned[0]!.command.startsWith("docker run"));
  });
});

describe("T5.2 enforcement 自报矩阵与拒绝标记", () => {
  it("四执行域自报矩阵：local=partial / docker=full / wsl=partial（偏差申报）/ ssh 缺省 partial", () => {
    const target: SshTarget = { host: "example.test", remoteWorkspaceRoot: "/srv/ws" };
    assert.equal(new LocalExecutor().enforcement, "partial", "02 §5.1 约束非隔离（Windows ACL 档同构）");
    assert.equal(new DockerExecutor().enforcement, "full", "workspace 独挂 + 缺省断网 = 绝对边界");
    assert.equal(
      new WslExecutor().enforcement,
      "partial",
      "wsl 非安全边界（/mnt/* 主机盘可达 + 网络开放），「绝对边界不得当作 full」",
    );
    assert.equal(new SshExecutor(target).enforcement, "partial", "探针不可得报 partial（缺省）");
  });

  it("工厂 ssh 分支：远端 enforcement 探针可得 → 注入 full；不可得/抛错 → partial", async () => {
    const config = { executor: "ssh" as const, ssh: { host: "example.test", remoteWorkspaceRoot: "/srv/ws" } };
    const base = { docker: async () => false, wsl: async () => false, ssh: async () => true };

    const probedFull = await resolveSandboxExecutor(config, {
      ...base,
      sshEnforcement: async () => "full",
    });
    assert.equal(probedFull.executor.kind, "ssh");
    assert.equal(probedFull.executor.enforcement, "full", "探针结果经工厂注入执行域自报");

    const probeMissing = await resolveSandboxExecutor(config, base);
    assert.equal(probeMissing.executor.enforcement, "partial", "探针未实现 = 不可得 → partial");

    const probeThrows = await resolveSandboxExecutor(config, {
      ...base,
      sshEnforcement: async () => {
        throw new Error("probe failed");
      },
    });
    assert.equal(probeThrows.executor.enforcement, "partial", "探针抛错 = 不可得 → partial");
  });

  it("工厂回退路径：docker/wsl/ssh 不可用回退 local（enforcement=partial）", async () => {
    const base = { docker: async () => false, wsl: async () => false, ssh: async () => false };
    for (const requested of ["docker", "wsl", "ssh"] as const) {
      const resolved = await resolveSandboxExecutor(
        requested === "ssh" ? { executor: requested, ssh: { host: "h", remoteWorkspaceRoot: "/w" } } : { executor: requested },
        base,
      );
      assert.equal(resolved.executor.kind, "local");
      assert.equal(resolved.executor.enforcement, "partial");
      assert.ok(resolved.warnings.length > 0);
    }
  });

  it("拒绝标记：PATH_ESCAPED 经 ToolExecutor 中央追加 partial 标记 + 重试提示，且不重复追加", async () => {
    const registry = new ToolRegistry();
    registry.register(
      makeDeniedTool("denied_once", TOOL_ERROR_CODES.PATH_ESCAPED, "path escapes workspace: /etc/passwd"),
    );
    registry.register(
      makeDeniedTool(
        "denied_prefixed",
        TOOL_ERROR_CODES.PATH_ESCAPED,
        "path escapes workspace: /etc [sandbox: path access denied under partial mode]",
      ),
    );
    const executor = new ToolExecutor({ registry });
    const result = await executor.execute(
      { toolCallId: "t1", toolName: "denied_once", args: {} },
      runT5Ctx(),
    );
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "TOOL_PATH_ESCAPED");
    assert.equal(
      (result.error?.message.match(/\[sandbox: path access denied under partial mode\]/g) ?? []).length,
      1,
      "标记恰好一次",
    );
    assert.ok(result.error?.message.includes("retry with a workspace-relative path"));
    assert.ok(result.content!.includes("[sandbox: path access denied under partial mode]"));

    const prefixed = await executor.execute(
      { toolCallId: "t2", toolName: "denied_prefixed", args: {} },
      runT5Ctx(),
    );
    assert.equal(
      (prefixed.error?.message.match(/\[sandbox:/g) ?? []).length,
      1,
      "工具自带标记时中央不再追加",
    );
  });

  it("非路径类错误不携带拒绝标记", async () => {
    const registry = new ToolRegistry();
    registry.register(makeDeniedTool("boom", TOOL_ERROR_CODES.EXEC_FAILED, "io went wrong"));
    const result = await new ToolExecutor({ registry }).execute(
      { toolCallId: "t3", toolName: "boom", args: {} },
      runT5Ctx(),
    );
    assert.equal(result.error?.code, "TOOL_EXEC_FAILED");
    assert.ok(!result.error!.message.includes("[sandbox:"));
  });
});

/** 错误桩工具：以指定错误码/消息收敛（验证中央拒绝标记接线与不重复追加）。 */
function makeDeniedTool(name: string, code: string, message: string): Tool<Record<string, never>> {
  return {
    name,
    description: "error stub",
    parametersSchema: z.object({}),
    metadata: {
      readOnly: false,
      destructive: false,
      sideEffectScope: "workspace",
      riskLevel: "low",
      needsApproval: false,
    },
    async execute() {
      throw new ToolExecutionError(code, message);
    },
  };
}

function runT5Ctx(): ToolRunContext {
  return {
    signal: new AbortController().signal,
    workspaceRoot: WORKSPACE,
    cwd: WORKSPACE,
    sessionKey: "test",
    background: new BackgroundTaskRegistry(),
  };
}
