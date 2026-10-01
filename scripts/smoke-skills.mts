/**
 * skills 域接入 smoke（T3.4，06-api-spec §2.9）。
 * 运行：tsx scripts/smoke-skills.mts（或 pnpm run smoke:skills）
 *
 * 链路：node:http mock OpenAI SSE + 临时 RAINCODE_HOME 双层技能目录
 * （global <home>/skills 装入 examples/skills/ 三个官方示例 + workspace <ws>/.raincode/skills
 * 自定义技能）→ createAgentServiceNode（skills 域装配）→ 断言：
 * 用例 A 官方示例加载：skills.list（无 sessionId）= global 层三示例在列（bad.md 解析失败跳过不阻塞面板）。
 * 用例 B 双源优先级：建会话后带 sessionId 清单 → 同名技能 workspace 层胜出（source 投影）。
 * 用例 C 示例技能端到端：skills.invoke(review, "src/a.ts") → 受理即返 → turn 收束 → mock 请求体
 *   末条 user 消息含 $ARGUMENTS 替换后的展开文本（展开在 server 侧的真实证据）。
 * 用例 D 自定义技能加载 + 展开语义：无占位符技能带参 → 参数追加末尾；同名 workspace 技能展开
 *   内容胜出；无参调用 $ARGUMENTS 技能 → 占位替换为空串。
 * 用例 E 错误族：SKILL_NOT_FOUND（未知名/路径逃逸形态）/ SKILL_INVALID（坏文件按名调用）/
 *   SESSION_NOT_FOUND（未知会话）/ INVALID_PARAMS（strict 多余字段）。
 * 全程仅本机回环与临时目录：无外呼、无真实密钥。
 */
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInMemoryTransportPair, createRpcClient, RpcCallError } from "../packages/rpc/src/index.ts";
import type { RpcClient } from "../packages/rpc/src/index.ts";
import { createAgentServiceNode } from "../packages/server/src/index.ts";
import type { AgentServiceNode } from "../packages/server/src/index.ts";
import type {
  DoneEventPayload,
  SessionCreateResult,
  SkillsInvokeResult,
  SkillsListResult,
} from "../packages/shared/src/index.ts";
import { startMockLlmServer, textScript, withTimeout } from "./p0-lib.mts";
import type { MockLlmServer, SseScript } from "./p0-lib.mts";

// ---------------------------------------------------------------------------
// 场景装配：临时 RAINCODE_HOME + 双层技能目录 + in-memory 服务节点 + RPC 客户端
// ---------------------------------------------------------------------------

interface Scenario {
  home: string;
  workspace: string;
  client: RpcClient;
  node: AgentServiceNode;
  mock: MockLlmServer;
  setScript: (script: SseScript[]) => void;
  close: () => Promise<void>;
}

/** 同名技能双源（优先级断言数据源）：workspace 层模板带 WS 标记，global 层带 GLOBAL 标记。 */
const SHADOW_WS = "---\nname: shadow\ndescription: 工作区同名技能（应胜出）\n---\n\nWS-MARKER 技能正文。";
const SHADOW_GLOBAL = "---\nname: shadow\ndescription: 全局同名技能\n---\n\nGLOBAL-MARKER 技能正文。";
/** 无占位符自定义技能（参数追加语义断言数据源）。 */
const DEPLOY_WS = "---\nname: deploy\ndescription: 部署前检查清单\n---\n\n执行部署前检查：";

async function startScenario(): Promise<Scenario> {
  const home = await mkdtemp(join(tmpdir(), "raincode-smoke-skills-"));
  const workspace = join(home, "ws");
  await mkdir(join(home, "skills"), { recursive: true }); // global 层
  await mkdir(join(workspace, ".raincode", "skills"), { recursive: true }); // workspace 层
  // 官方示例技能装入 global 层（验收「示例技能端到端执行」用仓库真身，非测试内联副本）
  const examplesDir = fileURLToPath(new URL("../examples/skills/", import.meta.url));
  for (const name of ["review", "test-gen", "docs"]) {
    await copyFile(join(examplesDir, `${name}.md`), join(home, "skills", `${name}.md`));
  }
  await writeFile(join(home, "skills", "shadow.md"), SHADOW_GLOBAL, "utf8");
  await writeFile(join(home, "skills", "bad.md"), "没有 frontmatter 的坏文件", "utf8"); // 清单跳过 / 按名调用 INVALID
  await writeFile(join(workspace, ".raincode", "skills", "shadow.md"), SHADOW_WS, "utf8");
  await writeFile(join(workspace, ".raincode", "skills", "deploy.md"), DEPLOY_WS, "utf8");
  const mock = await startMockLlmServer();
  const transports = createInMemoryTransportPair();
  const node = await createAgentServiceNode(transports[1], {
    env: { RAINCODE_HOME: home },
    provider: {
      name: "mock-skills",
      baseURL: mock.url,
      model: "mock-model",
      apiKey: "smoke-dummy-key",
      maxContextTokens: 8192,
    },
    tools: { approval: "always-allow" },
    permission: { policy: "default-allow" },
    skills: {},
  });
  const client = createRpcClient({ transport: transports[0] });
  await client.call("system.ping", {});
  return {
    home,
    workspace,
    client,
    node,
    mock,
    setScript: mock.setScript,
    close: async () => {
      client.close();
      await node.close();
      await transports[0].close();
      await transports[1].close();
      await mock.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** 技能受理 turn（订阅先于提交，形态同 p0-lib beginTurn；提交点为 skills.invoke）。 */
function beginSkillTurn(
  client: RpcClient,
  sessionId: string,
  name: string,
  args: string | undefined,
): { admission: Promise<SkillsInvokeResult>; done: Promise<DoneEventPayload>; stop: () => void } {
  let resolveDone!: (payload: DoneEventPayload) => void;
  let rejectDone!: (reason: unknown) => void;
  const done = new Promise<DoneEventPayload>((resolvePromise, rejectPromise) => {
    resolveDone = resolvePromise;
    rejectDone = rejectPromise;
  });
  const offDone = client.onEvent("done", (payload) => resolveDone(payload as DoneEventPayload));
  const admission = client.call<SkillsInvokeResult>("skills.invoke", {
    sessionId,
    name,
    ...(args !== undefined && { arguments: args }),
  });
  admission.catch((reason: unknown) => rejectDone(reason));
  return {
    admission,
    done,
    stop: () => {
      offDone();
    },
  };
}

/** mock 请求体末条 user 消息文本（展开落点的断言入口）。 */
function lastUserText(mock: MockLlmServer): string {
  const body = mock.bodies[mock.bodies.length - 1];
  assert.ok(body !== undefined, "mock 至少收到一次请求");
  const userMessages = body.messages.filter((message) => message.role === "user");
  const last = userMessages[userMessages.length - 1];
  assert.ok(last !== undefined, "请求体含 user 消息");
  return typeof last.content === "string" ? last.content : JSON.stringify(last.content);
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/** A：官方示例加载（global 层清单；坏文件跳过不阻塞面板）。 */
async function caseExamplesListed(scenario: Scenario): Promise<void> {
  const result = (await scenario.client.call("skills.list", {})) as SkillsListResult;
  const names = result.items.map((item) => item.name);
  for (const name of ["review", "test-gen", "docs"]) {
    assert.ok(names.includes(name), `示例技能 ${name} 在列（实际 ${JSON.stringify(names)}）`);
  }
  assert.ok(!names.includes("bad"), "坏文件不入清单");
  const review = result.items.find((item) => item.name === "review");
  assert.equal(review?.source, "global");
  assert.ok(review?.argumentHint !== undefined, "argumentHint 投影在位");
  console.log("case A: 官方示例加载（examples/skills 三技能 global 层在列，坏文件跳过）OK");
}

/** B：双源优先级（建会话后带 sessionId，同名技能 workspace 胜出）。 */
async function caseDualSourcePrecedence(scenario: Scenario): Promise<void> {
  const sessionId = ((await scenario.client.call("session.create", {
    workspaceRoot: scenario.workspace,
    title: "skills-smoke",
  })) as SessionCreateResult).sessionId;
  const result = (await scenario.client.call("skills.list", { sessionId })) as SkillsListResult;
  const shadow = result.items.find((item) => item.name === "shadow");
  assert.ok(shadow !== undefined, "shadow 在列");
  assert.equal(shadow.source, "workspace", "同名技能 workspace 层胜出");
  const deploy = result.items.find((item) => item.name === "deploy");
  assert.equal(deploy?.source, "workspace");
  console.log("case B: 双源优先级（带 sessionId 清单 workspace 胜出）OK");
}

/** C：示例技能端到端（$ARGUMENTS 替换 + 展开文本真实到达 LLM）。 */
async function caseExampleInvoke(scenario: Scenario): Promise<void> {
  const sessionId = ((await scenario.client.call("session.create", {
    workspaceRoot: scenario.workspace,
    title: "skills-invoke",
  })) as SessionCreateResult).sessionId;
  scenario.setScript([textScript("审查完成：未发现阻塞项。")]);
  const run = beginSkillTurn(scenario.client, sessionId, "review", "src/a.ts");
  const admission = await run.admission;
  assert.equal(admission.admission, "started");
  const done = (await withTimeout(run.done, 20000, "skill turn done")) as DoneEventPayload;
  run.stop();
  assert.equal(done.outcome, "completed");
  const prompt = lastUserText(scenario.mock);
  assert.ok(
    prompt.includes("请对 src/a.ts 执行代码审查"),
    `示例技能模板 $ARGUMENTS 已替换（实际末条 user：${prompt.slice(0, 200)}）`,
  );
  assert.ok(!prompt.includes("$ARGUMENTS"), "占位符不残留");
  console.log("case C: 示例技能端到端（skills.invoke → server 展开 → turn → LLM 收到替换后提示词）OK");
}

/** D：自定义技能加载 + 展开语义（无占位符追加 / workspace 胜出 / 无参替换空串）。 */
async function caseCustomSkillAndExpansion(scenario: Scenario): Promise<void> {
  const { client, mock } = scenario;
  const sessionId = ((await client.call("session.create", {
    workspaceRoot: scenario.workspace,
    title: "skills-custom",
  })) as SessionCreateResult).sessionId;

  // 无占位符技能带参：参数追加模板末尾
  mock.setScript([textScript("检查完毕。")]);
  const run1 = beginSkillTurn(client, sessionId, "deploy", "staging 环境");
  await run1.admission;
  await withTimeout(run1.done, 20000, "deploy turn done");
  run1.stop();
  const deployPrompt = lastUserText(mock);
  assert.ok(deployPrompt.trimEnd().endsWith("staging 环境"), "无占位符技能参数追加末尾");

  // 同名技能：workspace 模板胜出（WS-MARKER 而非 GLOBAL-MARKER 到达 LLM）
  mock.setScript([textScript("完成。")]);
  const run2 = beginSkillTurn(client, sessionId, "shadow", undefined);
  await run2.admission;
  await withTimeout(run2.done, 20000, "shadow turn done");
  run2.stop();
  const shadowPrompt = lastUserText(mock);
  assert.ok(shadowPrompt.includes("WS-MARKER"), "展开用 workspace 层模板");
  assert.ok(!shadowPrompt.includes("GLOBAL-MARKER"), "global 层模板未生效");

  // 无参调用 $ARGUMENTS 技能：占位替换为空串
  mock.setScript([textScript("文档要点如下。")]);
  const run3 = beginSkillTurn(client, sessionId, "docs", undefined);
  await run3.admission;
  await withTimeout(run3.done, 20000, "docs turn done");
  run3.stop();
  const docsPrompt = lastUserText(mock);
  assert.ok(!docsPrompt.includes("$ARGUMENTS"), "无参调用占位符替换为空串");
  console.log("case D: 自定义技能 + 展开语义（追加/双源胜出/无参替换）OK");
}

/** E：错误族（域码 + 协议边界校验）。 */
async function caseErrorFamily(scenario: Scenario): Promise<void> {
  const { client } = scenario;
  const sessionId = ((await client.call("session.create", {
    workspaceRoot: scenario.workspace,
  })) as SessionCreateResult).sessionId;
  const rejects = async (method: string, params: unknown, code: string): Promise<void> => {
    await assert.rejects(client.call(method, params), (err: unknown) => {
      assert.ok(err instanceof RpcCallError, `${method} 应抛 RpcCallError`);
      assert.equal(err.code, code);
      return true;
    });
  };
  await rejects("skills.invoke", { sessionId, name: "no-such" }, "SKILL_NOT_FOUND");
  await rejects("skills.invoke", { sessionId, name: "../escape" }, "SKILL_NOT_FOUND");
  await rejects("skills.invoke", { sessionId, name: "bad" }, "SKILL_INVALID");
  await rejects("skills.invoke", { sessionId: "session_missing", name: "review" }, "SESSION_NOT_FOUND");
  await rejects("skills.invoke", { sessionId, name: "review", extra: 1 }, "INVALID_PARAMS"); // strict 拒绝多余字段
  console.log("case E: 错误族（NOT_FOUND/INVALID/SESSION_NOT_FOUND/INVALID_PARAMS）OK");
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const scenario = await startScenario();
  try {
    await caseExamplesListed(scenario);
    await caseDualSourcePrecedence(scenario);
    await caseExampleInvoke(scenario);
    await caseCustomSkillAndExpansion(scenario);
    await caseErrorFamily(scenario);
  } finally {
    await scenario.close();
  }
  console.log("");
  console.log("SMOKE OK");
}

main().catch((err: unknown) => {
  console.error("SMOKE FAILED:", err);
  process.exit(1);
});
