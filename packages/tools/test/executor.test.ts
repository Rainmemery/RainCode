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
import {
  createBashTool,
  BackgroundTaskRegistry,
  DockerExecutor,
  LocalExecutor,
  WslExecutor,
  resolveSandboxExecutor,
  type ExecRequest,
  type ExecutorTransport,
  type SpawnHandle,
} from "../src/index.js";
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
    });
    assert.equal(resolved.executor.kind, "local");
    assert.ok(resolved.warnings[0]!.includes("wsl"));
  });

  it("docker 可用：DockerExecutor 生效且配置透传", async () => {
    const resolved = await resolveSandboxExecutor(
      { executor: "docker", image: "ubuntu:24.04", network: "bridge" },
      { docker: async () => true, wsl: async () => false },
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
    assert.ok(out.content!.startsWith("sandbox: docker\nexit code: 0"));
    assert.ok(spawned[0]!.command.startsWith("docker run"));
    assert.equal(spawned[0]!.workspaceRoot, WORKSPACE, "挂载基准随请求传递");
  });

  it("local 缺省：输出无 sandbox 头行（P0 字节兼容）", async () => {
    const { transport, execed } = recordingTransport();
    const tool = createBashTool({ executor: new LocalExecutor(transport) });
    const out = await tool.execute({ command: "echo hi" }, ctx(WORKSPACE, WORKSPACE, new BackgroundTaskRegistry()));
    assert.equal(out.data.sandbox, "local");
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
    assert.ok(spawned[0]!.command.startsWith("docker run"));
  });
});
