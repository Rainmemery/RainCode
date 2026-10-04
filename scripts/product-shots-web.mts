/**
 * 产品介绍截图 · Web 端（README picture/ 素材再生工具）：真实入口链路 = `raincode web`
 * （walkthrough-web 同形态）+ mock LLM（p0-lib SSE 脚本回放）+ 种子临时 RAINCODE_HOME
 * （MCP stdio fixture / 示例插件 hello / 官方技能 / 示例工作区与 MEMORY.md）。
 * 内容驱动：node「ws」RPC 客户端起会话与回合（推理流 + markdown + 并行只读工具 + MCP 审批
 * + write 审批），CDP 只负责语义导航与 Page.captureScreenshot——截图即产品真实渲染。
 * 运行：pnpm --filter @raincode/web build && pnpm shots:web（输出 picture/*.png）。
 * 全程本机回环 + 临时目录 + 占位假 key（绝不打印，04 §5.3）。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createRpcClient, WebSocketTransport } from "../packages/rpc/src/index.js";
import type { RpcClient } from "../packages/rpc/src/index.js";
import type { WsSocketLike } from "../packages/rpc/src/websocket.js";
import { Cdp, bodyContains, clickButtonExpr, sleep } from "./cdp-lib.mts";
import { beginTurn, startMockLlmServer, textFrame, textScript, toolCallFrame, waitFor, withTimeout, writeCallScript } from "./p0-lib.mts";
import type { SseScript } from "./p0-lib.mts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIST = join(REPO_ROOT, "apps", "web", "dist");
const PICTURE_DIR = join(REPO_ROOT, "picture");
const TOKEN = "product-shots-token";
const VIEW_W = 1440;
const VIEW_H = 900;
const BROWSER_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  process.env["RAINCODE_WALKTHROUGH_BROWSER"] ?? "",
].filter((p) => p.length > 0);

// ---------------------------------------------------------------------------
// 回合脚本素材（真实感中文示例项目「notes-cli」）
// ---------------------------------------------------------------------------

const REASONING =
  "用户想把备注卡片改成流式布局。先回顾现有实现：store.ts 里 NoteStore 用的是固定两列网格，" +
  "卡片宽度写死在 CSS 变量里。改成流式要把 grid 换成 flex wrap，同时保留排序逻辑；风险点是" +
  "拖拽定位依赖网格坐标，需要改成按 DOM 顺序计算。先给方案对比再动手。";

const ANSWER_1 =
  "看完了 `src/store.ts` 的实现，当前是**固定两列网格**，卡片宽度写死在 CSS 变量里，这就是窄窗口下溢出的根因。\n\n" +
  "### 实施步骤\n\n" +
  "- 把网格容器改为 `flex-wrap` 流式布局\n" +
  "- 卡片宽度改用 `min-width: 280px` + 弹性伸展\n" +
  "- 拖拽排序改按 DOM 顺序计算，不依赖网格坐标\n\n" +
  "两种方案的对比如下：\n\n" +
  "| 方案 | 优点 | 代价 |\n| --- | --- | --- |\n| flex-wrap | 改动最小，兼容现有样式 | 换行间隙需手动处理 |\n| CSS columns | 列间距自动均衡 | 阅读顺序按列，拖拽体验差 |\n\n" +
  "推荐 flex-wrap。核心改动大概是：\n\n" +
  "```ts\nexport function layoutNotes(container: HTMLElement): void {\n" +
  "  container.classList.add(\"note-flow\");\n" +
  "  for (const card of container.querySelectorAll<HTMLElement>(\".note-card\")) {\n" +
  "    card.style.minWidth = \"280px\";\n  }\n}\n```\n\n" +
  "确认方案的话我就直接动手改。";

const ANSWER_2 =
  "扫描完成。`src/` 下共 3 个文件引用渲染逻辑，`render.ts` 的 `renderNoteList` 是入口，排序逻辑在 `store.ts`。\n\n" +
  "任务清单已建好，建议从 `src/store.ts` 开始改，最后统一跑 `node --test` 回归。";

const ANSWER_3 = "自检通过：`echo(fixture): ping`，MCP 通道往返正常，扩展面板里也能看到 fixture 的连接状态。";

/** 推理流 + 正文脚本项（reasoning_content 双帧模拟真实思考节奏）。 */
function reasoningScript(reasoning: string, text: string): SseScript {
  const mid = Math.floor(reasoning.length / 2);
  return {
    frames: [
      { choices: [{ index: 0, delta: { role: "assistant" } }] },
      { choices: [{ index: 0, delta: { reasoning_content: reasoning.slice(0, mid) } }] },
      { choices: [{ index: 0, delta: { reasoning_content: reasoning.slice(mid) } }] },
      textFrame(text),
      { choices: [], usage: { prompt_tokens: 32, completion_tokens: 160 } },
    ],
    finish: "stop",
  };
}

/** 并行只读工具轮脚本项（read / grep / glob / todo_write）。 */
function toolsRound(): SseScript {
  return {
    frames: [
      { choices: [{ index: 0, delta: { role: "assistant" } }] },
      toolCallFrame("t-read", "read", { path: "src/store.ts" }, 0),
      toolCallFrame("t-grep", "grep", { pattern: "render", path: "src" }, 1),
      toolCallFrame("t-glob", "glob", { pattern: "src/**/*.ts" }, 2),
      toolCallFrame("t-todo", "todo_write", { todos: [
        { content: "网格容器改 flex-wrap 流式布局", status: "in_progress" },
        { content: "卡片宽度改弹性伸展", status: "pending" },
        { content: "拖拽排序按 DOM 顺序计算", status: "pending" },
        { content: "node --test 全量回归", status: "pending" },
      ] }, 3),
    ],
    finish: "tool_calls",
  };
}

// ---------------------------------------------------------------------------
// 种子与宿主
// ---------------------------------------------------------------------------

function seedHome(home: string, workspace: string, mockUrl: string): void {
  mkdirSync(join(home, "plugins"), { recursive: true });
  mkdirSync(join(home, "skills"), { recursive: true });
  writeFileSync(join(home, "mcp.json"), JSON.stringify({
    mcpServers: { fixture: { transport: "stdio", command: "node", args: [join(REPO_ROOT, "scripts", "mcp-fixture-stdio.mjs")], enabled: true } },
  }));
  writeFileSync(join(home, "config.json"), JSON.stringify({
    configVersion: 1,
    providers: [{ id: "demo", name: "walkthrough-mock", baseURL: mockUrl, model: "mock-model",
      maxContextTokens: 8192, apiKeyRef: null, inputPricePerMtok: 0.14, outputPricePerMtok: 0.28 }],
    activeProviderId: "demo",
  }));
  const hello = join(home, "plugins", "hello");
  mkdirSync(hello, { recursive: true });
  writeFileSync(join(hello, "plugin.json"), JSON.stringify({ name: "hello", description: "示例插件", version: "0.1.0", entry: "index.mjs" }));
  writeFileSync(join(hello, "index.mjs"),
    "export function activate() { return [{ name: \"greet\", description: \"问候语生成\", parametersJsonSchema: { type: \"object\" }, metadata: { readOnly: true, needsApproval: false, riskLevel: \"low\" }, async execute() { return \"Hello!\"; } }]; }");
  for (const skill of ["docs.md", "review.md", "test-gen.md"]) {
    writeFileSync(join(home, "skills", skill),
      `---\nname: ${skill.replace(".md", "")}\ndescription: 官方示例技能（演示清单）\nargumentHint: "<输入>"\n---\n示例技能模板。`);
  }
  // 示例工作区：notes-cli 迷你项目 + 项目记忆
  mkdirSync(join(workspace, "src"), { recursive: true });
  mkdirSync(join(workspace, ".raincode"), { recursive: true });
  writeFileSync(join(workspace, "src", "store.ts"),
    "export interface Note { id: string; text: string; createdAt: number }\n\n" +
    "export class NoteStore {\n  private notes: Note[] = [];\n\n  add(text: string): Note {\n" +
    "    const note = { id: crypto.randomUUID(), text, createdAt: Date.now() };\n    this.notes.push(note);\n    return note;\n  }\n}\n");
  writeFileSync(join(workspace, "src", "render.ts"),
    "import type { Note } from \"./store.js\";\n\n" +
    "export function renderNoteList(container: HTMLElement, notes: Note[]): void {\n" +
    "  container.replaceChildren(...notes.map((n) => renderNote(n)));\n}\n");
  writeFileSync(join(workspace, "src", "index.ts"), "import { NoteStore } from \"./store.js\";\nimport { renderNoteList } from \"./render.js\";\n\nexport { NoteStore, renderNoteList };\n");
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "notes-cli", version: "0.2.0", type: "module" }, null, 2));
  writeFileSync(join(workspace, "README.md"), "# notes-cli\n\n本地速记命令行工具（演示工作区）。\n");
  writeFileSync(join(workspace, ".raincode", "MEMORY.md"),
    "# 项目记忆\n\n<!-- agent: 项目概览 -->\n" +
    "- notes-cli：本地速记命令行工具，TypeScript + Node 20，无运行时依赖\n" +
    "- 渲染入口在 src/render.ts（renderNoteList），存储在 src/store.ts（NoteStore）\n\n" +
    "<!-- agent: 约定 -->\n- 命名：文件用 kebab-case，符号用 camelCase\n" +
    "- 测试：node:test，与仓库主工程一致\n\n<!-- user -->\n（用户章节，仅手动修改）\n");
}

function startWebHost(home: string, port: number): ReturnType<typeof spawn> {
  return spawn("node", ["--import", "tsx", "apps/cli/src/index.ts", "web", "--port", String(port), "--token", TOKEN, "--static", WEB_DIST], {
    cwd: REPO_ROOT,
    env: { ...process.env, RAINCODE_HOME: home, RAINCODE_PROVIDER_BASE_URL: mockUrl,
      RAINCODE_PROVIDER_MODEL: "mock-model", RAINCODE_PROVIDER_API_KEY: "shots-dummy-key", RAINCODE_PROVIDER_NAME: "walkthrough-mock" },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
}

let mockUrl = "";

async function connectClient(url: string): Promise<{ client: RpcClient; close: () => Promise<void> }> {
  const ws = new WebSocket(`${url}/ws`);
  await new Promise<void>((res, rej) => { ws.once("open", res); ws.once("error", rej); });
  const transport = new WebSocketTransport({ socket: ws as unknown as WsSocketLike, role: "client" });
  const client = createRpcClient({ transport, defaultTimeoutMs: 15_000 });
  await client.call("ws.auth", { token: TOKEN });
  await client.call("system.ping", {});
  return { client, close: async () => { client.close(); await transport.close(); } };
}

async function waitHost(port: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    try { if ((await fetch(`http://127.0.0.1:${String(port)}/`)).ok) return; } catch { /* 轮询 */ }
    if (Date.now() - started > 30_000) throw new Error("等待超时: web host");
    await sleep(300);
  }
}

async function shot(cdp: Cdp, name: string): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 2, mobile: false });
  await sleep(250);
  const data = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(PICTURE_DIR, `${name}.png`), Buffer.from(data.data, "base64"));
  console.log(`  ✔ picture/${name}.png`);
}

const scrollTop = (): string =>
  `(() => { const el = [...document.querySelectorAll("div")].find(d => d.className.includes("overflow-y-auto") && d.querySelector(".corner-ticks")); if (!el) return false; el.scrollTop = 0; return true; })()`;

async function main(): Promise<number> {
  console.log("产品截图 · Web 端（真实 raincode web 入口 + mock LLM + CDP）");
  if (!existsSync(join(WEB_DIST, "index.html"))) { console.error("apps/web/dist 缺失——先 pnpm --filter @raincode/web build"); return 1; }
  mkdirSync(PICTURE_DIR, { recursive: true });
  const browserExe = BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (browserExe === undefined) { console.error("未找到 Edge/Chrome"); return 1; }
  const mock = await startMockLlmServer();
  mockUrl = mock.url;
  const home = await mkdtemp(join(tmpdir(), "raincode-shots-web-"));
  const workspace = join(home, "ws");
  seedHome(home, workspace, mock.url);
  const CDP_PORT = 9243;
  let client: RpcClient | null = null;
  let clientClose: (() => Promise<void>) | null = null;
  let browserPid = 0;
  const host = startWebHost(home, 8791);
  try {
    await waitHost(8791);
    const conn = await connectClient("http://127.0.0.1:8791");
    client = conn.client;
    clientClose = conn.close;
    // MCP 工具与 todo_write / agent 审批自动放行（后台事件守卫；write 审批保留 pending 供截图）
    client.onEvent("permission.requested", (payload) => {
      const record = payload as { grantId?: string; toolName?: string };
      if (record.grantId !== undefined && (record.toolName === "todo_write" || record.toolName === "agent" || record.toolName?.startsWith("mcp__") === true)) {
        void client!.call("permission.respond", { grantId: record.grantId, decision: "allow" }).catch(() => undefined);
      }
    });
    client.onEvent("error", (payload) => console.log("[error-event]", JSON.stringify(payload)?.slice(0, 300)));

    // ---- 会话 1：推理流 + markdown + 并行工具 + MCP 自检（截图主素材）----
    const s1 = (await client.call("session.create", { workspaceRoot: workspace, title: "备注卡片流式布局重构" })) as { sessionId: string };
    mock.setScript([reasoningScript(REASONING, ANSWER_1)]);
    const t1 = beginTurn(client, s1.sessionId, "把备注卡片改成流式布局，先看看现有实现给个方案");
    await withTimeout(t1.done, 20_000, "turn 1");
    mock.setScript([toolsRound(), textScript(ANSWER_2)]);
    const t2 = beginTurn(client, s1.sessionId, "先扫一遍相关代码，列个任务清单");
    await withTimeout(t2.done, 20_000, "turn 2");
    mock.setScript([{
      frames: [{ choices: [{ index: 0, delta: { role: "assistant" } }] },
        toolCallFrame("t-mcp", "mcp__fixture__echo", { text: "ping" }, 0)],
      finish: "tool_calls",
    }, textScript(ANSWER_3)]);
    const t3 = beginTurn(client, s1.sessionId, "用 MCP 的 echo 工具做个连通性自检");
    await withTimeout(t3.done, 20_000, "turn 3");
    await sleep(1200);

    // ---- 浏览器接入（bootstrap 自动选最近活跃会话 = 会话 1）----
    const browser = spawn(browserExe, [
      "--headless=new", `--remote-debugging-port=${String(CDP_PORT)}`, "--window-size=1460,960",
      "--user-data-dir=" + join(home, "browser-profile"), "--no-first-run", "about:blank",
    ], { stdio: "ignore", windowsHide: true });
    browserPid = browser.pid ?? 0;
    // 等 CDP 端口就绪（headless 启动数百 ms；/json/new 早于监听会 fetch failed）
    const startedCdp = Date.now();
    for (;;) {
      try { await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/version`); break; } catch { /* 轮询 */ }
      if (Date.now() - startedCdp > 20_000) throw new Error("等待超时: 浏览器 CDP 端口");
      await sleep(300);
    }
    const created = (await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/new?about:blank`, { method: "PUT" })).json()) as { id: string };
    const cdp = await Cdp.connect(CDP_PORT, (t) => t.id === created.id);
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:8791/?token=${TOKEN}&ws=ws://127.0.0.1:8791/ws` });
    await cdp.waitFor(`${bodyContains("已连接")} && ${bodyContains("备注卡片流式布局重构")}`, "会话视图就绪", 30_000);
    await sleep(800);
    // UI 侧工作区设定（记忆管理器等面板消费 UI workspace 状态，非会话级）
    await cdp.eval<boolean>(`(() => { const input = document.querySelector("aside input"); if (!input) return false; const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; set.call(input, ${JSON.stringify(workspace)}); input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
    await cdp.eval<boolean>(clickButtonExpr("设定"));
    await sleep(300);

    // 回合 4（页面在线跑，refine-ui-context-panel 轮）：agent 工具派发子代理——subagent.* 为
    // 瞬态全局事件，页面后开将错过（web-context-subagent 假空态教训）；右栏 Tab 与进度卡素材
    mock.setScript([
      { frames: [{ choices: [{ index: 0, delta: { role: "assistant" } }] },
          toolCallFrame("t-agent", "agent", { profile: "researcher", task: "调研 flex-wrap 布局下拖拽排序的边界情况" }, 0)],
        finish: "tool_calls" },
      textScript("调研结论：flex-wrap 下按 DOM 顺序计算插入位置可行，需注意换行行的插入点归属。"),
      textScript("子代理调研完成：拖拽按 DOM 顺序计算可行，边界情况与结论已同步。"),
    ]);
    const t4 = beginTurn(client, s1.sessionId, "派个子代理调研拖拽排序的边界情况");
    await cdp.waitFor(bodyContains("子代理调研完成"), "回合 4（agent 子代理）完成", 40_000);
    await withTimeout(t4.done, 20_000, "turn 4");
    await sleep(1000);

    await cdp.eval<boolean>(clickButtonExpr("思考过程")); // 展开思考块
    await sleep(300);
    await cdp.eval<boolean>(scrollTop());
    await sleep(300);
    await shot(cdp, "web-chat");
    // 浅色主题对照（03 §3.2 落地：token 重映射，组件零改动；截后还原深色继续）
    await cdp.eval(`document.documentElement.dataset.theme = "light"`);
    await sleep(250);
    await shot(cdp, "web-chat-light");
    await cdp.eval(`document.documentElement.dataset.theme = "dark"`);
    await sleep(250);
    // 右侧上下文面板（refine-ui-context-panel 轮）：MCP Tab 与子代理 Tab（记忆 Tab 已入 web-chat 全景）
    await cdp.eval<boolean>(`(() => { const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === "MCP"); if (!b) return false; b.click(); return true; })()`);
    await cdp.waitFor(bodyContains("fixture"), "右栏 MCP Tab 投影", 15_000);
    await sleep(300);
    await shot(cdp, "web-context-mcp");
    await cdp.eval<boolean>(`(() => { const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === "子代理"); if (!b) return false; b.click(); return true; })()`);
    await cdp.waitFor(bodyContains("researcher"), "右栏子代理 Tab 投影", 15_000);
    await sleep(300);
    await shot(cdp, "web-context-subagent");
    // 侧栏折叠图标态（56px）
    await cdp.eval<boolean>(`(() => { const b = [...document.querySelectorAll("button")].find(x => x.getAttribute("title") === "折叠侧栏"); if (!b) return false; b.click(); return true; })()`);
    await sleep(350);
    await shot(cdp, "web-sidebar-collapsed");
    await cdp.eval<boolean>(`(() => { const b = [...document.querySelectorAll("button")].find(x => x.getAttribute("title") === "展开侧栏"); if (!b) return false; b.click(); return true; })()`);
    await sleep(300);
    // 工具卡：展开 read 卡并居中
    await cdp.eval<boolean>(`(() => { const b = [...document.querySelectorAll("button")].find(x => x.textContent.includes("src/store.ts")); if (!b) return false; b.click(); b.closest(".rounded-lg")?.scrollIntoView({ block: "center" }); return true; })()`);
    await sleep(400);
    await shot(cdp, "web-tools");
    // 斜杠面板
    await cdp.eval(`document.querySelector("textarea").focus()`);
    await cdp.insertText("/");
    await cdp.waitFor(bodyContains("/review"), "斜杠面板唤起");
    await sleep(250);
    await shot(cdp, "web-slash");
    await cdp.key("Escape", "Escape", 27);
    // 管理面板三件套
    await cdp.eval<boolean>(clickButtonExpr("记忆管理器"));
    await cdp.waitFor(bodyContains("MEMORY.md"), "记忆管理器渲染");
    await sleep(250);
    await shot(cdp, "web-memory");
    await cdp.eval<boolean>(clickButtonExpr("← 返回"));
    await cdp.eval<boolean>(clickButtonExpr("扩展面板"));
    await cdp.waitFor(`${bodyContains("fixture")} && ${bodyContains("已连接")}`, "扩展面板 MCP 投影", 20_000);
    await sleep(250);
    await shot(cdp, "web-extensions");
    await cdp.eval<boolean>(clickButtonExpr("← 返回"));
    await cdp.eval<boolean>(clickButtonExpr("Provider 设置"));
    await cdp.waitFor(bodyContains("walkthrough-mock"), "Provider 设置渲染");
    await sleep(250);
    await shot(cdp, "web-settings");
    await cdp.eval<boolean>(clickButtonExpr("← 返回"));

    // ---- 会话 2：write 审批弹窗（kbd 芯片素材）----
    // web 端不监听 session.created（他连接建会话不进侧栏）：RPC 建会话后 reload 让 bootstrap 重拉清单
    const s2 = (await client.call("session.create", { workspaceRoot: workspace, title: "导出 API 文档" })) as { sessionId: string };
    await cdp.send("Page.reload", {});
    await cdp.waitFor(`${bodyContains("已连接")} && ${bodyContains("导出 API 文档")}`, "reload 后侧栏含会话 2", 30_000);
    await cdp.eval<boolean>(clickButtonExpr("导出 API 文档"));
    await sleep(600);
    mock.setScript([writeCallScript("t-write", "docs/api.md", "# notes-cli API\n\n- NoteStore：速记存储\n- renderNoteList：列表渲染\n"), textScript("已把两个导出 API 写入 `docs/api.md`。")]);
    const tw = beginTurn(client, s2.sessionId, "把导出函数补进 docs/api.md");
    await cdp.waitFor(bodyContains("仅本次允许"), "审批弹窗出现");
    await sleep(400);
    await shot(cdp, "web-approval");
    // 截图后应答审批（beginTurn 已捕获 grantId），回合正常收束
    await waitFor(() => tw.requested.length > 0, 10_000, "write grantId");
    await client.call("permission.respond", { grantId: (tw.requested[0] as { grantId: string }).grantId, decision: "allow" });
    await withTimeout(tw.done, 20_000, "write turn");
    cdp.close();
    browser?.kill();
    spawnSync("taskkill", ["/PID", String(browserPid), "/T", "/F"], { stdio: "ignore" });
    console.log("Web 端截图完成");
    return 0;
  } catch (err) {
    console.error("[shots-web] 异常终止:", err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    if (clientClose !== null) await clientClose();
    host.kill();
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
    await mock.close();
  }
}

main().then((code) => process.exit(code));
