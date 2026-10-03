/**
 * T4.4 技能模型侧可发现性单测（07-dev-plan §10.2 验收：mock 端到端）：
 *   a) 自主发现并调用收束：系统提示注入技能目录（name/description/source）→ 模型经 `skill` 工具
 *      调用（skills.invoke 同链路展开）→ 展开模板作为工具结果回传 → 同 turn 续答收束；
 *   b) 目录热变更重发布：会话运行中新增技能文件 → 下一 turn 系统提示含新技能（digest 变化重发布）；
 *   c) 开关关闭时模型调用被拒：frontmatter modelInvocable: false → 不进模型目录 + skill 调用
 *      以 TOOL_PERMISSION_DENIED 收敛（斜杠命令不受限）。
 * 与 smoke:skills / compact-nonblocking 同装配口径（in-memory 节点 + mock LLM + 临时双源目录）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInMemoryTransportPair, createRpcClient } from "@raincode/rpc";
import type { RpcClient } from "@raincode/rpc";
import { createAgentServiceNode } from "../src/index.js";

interface ScriptItem {
  frames: unknown[];
  finish: string;
}

interface CapturedRequest {
  messages: Array<{ role: string; content: unknown }>;
}

interface MockLlm {
  url: string;
  setScript(script: ScriptItem[]): void;
  bodies(): CapturedRequest[];
  close(): Promise<void>;
}

/** 极简 mock OpenAI SSE 服务器：按请求序回放脚本项并捕获请求体（系统提示/工具消息断言数据源）。 */
async function startMock(): Promise<MockLlm> {
  let script: ScriptItem[] = [];
  const captured: CapturedRequest[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as CapturedRequest;
        captured.push({ messages: body.messages });
      } catch {
        captured.push({ messages: [] });
      }
      const item = script.shift() ?? { frames: [], finish: "stop" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const frame of item.frames) {
        res.write(`data: ${JSON.stringify(frame)}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/v1`,
    setScript: (s) => {
      script = s;
    },
    bodies: () => captured,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function textReply(text: string): ScriptItem {
  return {
    frames: [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      { choices: [{ index: 0, delta: { content: text } }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ],
    finish: "stop",
  };
}

function toolCallReply(callId: string, name: string, args: unknown): ScriptItem {
  return {
    frames: [
      { choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: JSON.stringify(args) } }] } },
        ],
      },
    ],
    finish: "tool_calls",
  };
}

interface Harness {
  client: RpcClient;
  mock: MockLlm;
  home: string;
  workspace: string;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "raincode-skill-tool-"));
  const workspace = join(home, "ws");
  await mkdir(join(workspace, ".raincode", "skills"), { recursive: true }); // workspace 层
  await mkdir(join(home, "skills"), { recursive: true }); // global 层
  const mock = await startMock();
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: { name: "mock-skill", baseURL: mock.url, model: "mock-model", apiKey: "test-dummy-key", maxContextTokens: 32768 },
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
    skills: {}, // T4.4 显式装配技能域（缺省不启用）
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {});
  return {
    client,
    mock,
    home,
    workspace,
    close: async () => {
      client.close();
      await new Promise((r) => setTimeout(r, 30));
      await node.close();
      await transports[0].close();
      await transports[1].close();
      await mock.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

async function writeSkill(dir: string, name: string, frontmatter: string, body: string): Promise<void> {
  await writeFile(join(dir, `${name}.md`), `---\n${frontmatter}---\n\n${body}`, "utf8");
}

/** 等待下一个 done 事件（turn 收束）；须在 send 之前登记。 */
function nextDone(client: RpcClient): Promise<unknown> {
  return new Promise((resolve) => {
    client.onEvent("done", (payload) => resolve(payload));
  });
}

test("skill 模型侧端到端：系统提示目录 → skill 工具调用 → 模板展开回传 → 续答收束", async () => {
  const harness = await startHarness();
  try {
    const { client, mock, workspace } = harness;
    await writeSkill(
      join(workspace, ".raincode", "skills"),
      "code-review",
      'name: code-review\ndescription: 对指定路径做代码审查\nargumentHint: "<file>"\n',
      "请审查 $ARGUMENTS 的代码质量，输出问题清单。",
    );
    mock.setScript([toolCallReply("call_1", "skill", { name: "code-review", arguments: "src/a.ts" }), textReply("已按技能完成审查。")]);
    const created = await client.call<{ sessionId: string }>("session.create", { workspaceRoot: workspace, title: "skill-e2e" });

    // a1) 首个模型请求的系统提示已注入技能目录（name/description/source 可发现）
    const done = nextDone(client);
    await client.call("session.send", { sessionId: created.sessionId, input: { text: "帮我审查 src/a.ts" } });
    await done;
    const bodies = mock.bodies();
    assert.ok(bodies.length >= 1);
    const system = bodies[0]?.messages.find((m) => m.role === "system");
    assert.ok(typeof system?.content === "string");
    assert.ok(system.content.includes("code-review"), "系统提示应含技能名");
    assert.ok(system.content.includes("对指定路径做代码审查"), "系统提示应含描述");
    assert.ok(system.content.includes("source: workspace"), "系统提示应含双源来源");

    // a2) skill 工具结果 = 展开模板（$ARGUMENTS 已替换），模型据此续答收束
    const toolMessage = bodies[1]?.messages.find((m) => m.role === "tool");
    assert.ok(toolMessage, "第二轮请求应含工具结果消息");
    assert.ok(
      typeof toolMessage.content === "string" && toolMessage.content.includes("请审查 src/a.ts 的代码质量"),
      `工具结果应为展开模板，实际：${String(toolMessage.content).slice(0, 80)}`,
    );
  } finally {
    await harness.close();
  }
});

test("技能目录热变更：会话运行中新增技能文件 → 下一 turn 系统提示重发布", async () => {
  const harness = await startHarness();
  try {
    const { client, mock, workspace } = harness;
    const skillDir = join(workspace, ".raincode", "skills");
    await writeSkill(skillDir, "alpha", "description: 技能甲\n", "alpha 模板");
    mock.setScript([textReply("第一轮"), textReply("第二轮")]);
    const created = await client.call<{ sessionId: string }>("session.create", { workspaceRoot: workspace, title: "hot" });

    let done = nextDone(client);
    await client.call("session.send", { sessionId: created.sessionId, input: { text: "一" } });
    await done;
    const firstSystem = mock.bodies()[0]?.messages.find((m) => m.role === "system");
    assert.ok(typeof firstSystem?.content === "string" && firstSystem.content.includes("alpha"));
    assert.ok(!firstSystem.content.includes("beta"), "首轮系统提示不应含未创建技能");

    // 会话运行中写入新技能 → digest 变化 → 下一 turn 系统提示重发布
    await writeSkill(skillDir, "beta", "description: 技能乙\n", "beta 模板");
    done = nextDone(client);
    await client.call("session.send", { sessionId: created.sessionId, input: { text: "二" } });
    await done;
    const secondSystem = mock.bodies()[1]?.messages.find((m) => m.role === "system");
    assert.ok(typeof secondSystem?.content === "string");
    assert.ok(secondSystem.content.includes("alpha"), "已发布技能保持在目录");
    assert.ok(secondSystem.content.includes("beta"), "新增技能应被重发布进系统提示");
  } finally {
    await harness.close();
  }
});

test("modelInvocable: false：不进模型目录 + skill 工具调用被拒（斜杠命令不受限）", async () => {
  const harness = await startHarness();
  try {
    const { client, mock, workspace } = harness;
    const skillDir = join(workspace, ".raincode", "skills");
    await writeSkill(skillDir, "open-skill", "description: 开放技能\n", "open 模板");
    await writeSkill(skillDir, "secret", "description: 面板专属技能\nmodelInvocable: false\n", "secret 模板");

    // skills.list 投影开关（面板可见性不受影响）
    mock.setScript([toolCallReply("call_1", "skill", { name: "secret" }), textReply("已拒绝。")]);
    const created = await client.call<{ sessionId: string }>("session.create", { workspaceRoot: workspace, title: "gate" });
    const listed = await client.call<{ items: Array<{ name: string; modelInvocable: boolean }> }>("skills.list", { sessionId: created.sessionId });
    const secretRow = listed.items.find((item) => item.name === "secret");
    assert.ok(secretRow !== undefined && secretRow.modelInvocable === false, "skills.list 应投影 modelInvocable=false（面板仍可见）");
    const openRow = listed.items.find((item) => item.name === "open-skill");
    assert.ok(openRow !== undefined && openRow.modelInvocable === true, "缺省开关投影为 true");

    const done = nextDone(client);
    await client.call("session.send", { sessionId: created.sessionId, input: { text: "调用 secret" } });
    await done;

    const bodies = mock.bodies();
    const system = bodies[0]?.messages.find((m) => m.role === "system");
    assert.ok(typeof system?.content === "string");
    assert.ok(system.content.includes("open-skill"), "开放技能进目录");
    assert.ok(!system.content.includes("secret"), "关闭开关的技能不进模型目录");
    const toolMessage = bodies[1]?.messages.find((m) => m.role === "tool");
    assert.ok(typeof toolMessage?.content === "string" && toolMessage.content.includes("未开放模型调用"), `开关拒绝应作为工具错误回传，实际：${String(toolMessage?.content).slice(0, 80)}`);
  } finally {
    await harness.close();
  }
});
