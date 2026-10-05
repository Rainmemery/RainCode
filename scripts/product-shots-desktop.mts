/**
 * 产品介绍截图 · 桌面端（README picture/ 素材再生工具）：walkthrough-desktop 同形态——
 * 构建产物 electron 直启 + --remote-debugging-port → CDP 语义导航与 Page.captureScreenshot。
 * 内容驱动走 DOM 真实输入路径（textarea + Enter），mock LLM 脚本回放推理流 / markdown /
 * 并行只读工具 / write 审批；种子临时 RAINCODE_HOME（MCP fixture / hello 插件 / 示例工作区）。
 * 运行：pnpm --filter @raincode/desktop build && pnpm shots:desktop（输出 picture/*.png）。
 * 全程临时目录 + 占位假 key（绝不打印，04 §5.3）；窗口会真实弹出数十秒。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Cdp, bodyContains, clickButtonExpr, sleep } from "./cdp-lib.mts";
import { startMockLlmServer, textFrame, textScript, toolCallFrame, writeCallScript } from "./p0-lib.mts";
import type { SseScript } from "./p0-lib.mts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(REPO_ROOT, "apps", "desktop");
const ELECTRON = join(DESKTOP, "node_modules", "electron", "dist", "electron.exe");
const PICTURE_DIR = join(REPO_ROOT, "picture");
const CDP_PORT = 9244;

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

const ANSWER_3 = "已把两个导出 API 写入 `docs/api.md`，附了最小示例。";

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

/**
 * 后台任务素材脚本：bash + runInBackground（真实启动一个持续输出日志的进程）。
 * 命令限时自退（120×500ms≈60s），避免残留进程；输出行供 tool.background.output 展开投影。
 */
function bashBackgroundRound(): SseScript {
  return {
    frames: [
      { choices: [{ index: 0, delta: { role: "assistant" } }] },
      toolCallFrame(
        "t-bg",
        "bash",
        { command: `node -e "let i=0;setInterval(function(){i=i+1;console.log('bg tick '+i);if(i>120){process.exit(0)}},500)"`, runInBackground: true },
        0,
      ),
    ],
    finish: "tool_calls",
  };
}

/**
 * 确定性回合失败素材：本地 Provider 一律回 500。
 * session.create 绑定该 Provider → llm.streamChat 抛 LlmHttpError(LLM_HTTP_ERROR)
 * → settle.failed 发 error{scope:"turn", recoverable:true} → ChatFlow 失败卡「重试」。
 */
function startErrorLlmServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((_req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "shots: deterministic upstream failure", type: "server_error" } }));
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({
        url: `http://127.0.0.1:${String(port)}/v1`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

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
  mkdirSync(join(home, "plugins", "hello"), { recursive: true });
  for (const skill of ["docs.md", "review.md", "test-gen.md"]) {
    writeFileSync(join(home, "skills", skill),
      `---\nname: ${skill.replace(".md", "")}\ndescription: 官方示例技能（演示清单）\nargumentHint: "<输入>"\n---\n示例技能模板。`);
  }
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
  // hooks 双源种子（Hooks 分区素材；matcher __never__ 不命中任何工具——零真实执行）
  const hookFile = JSON.stringify({ hooks: { PreToolUse: [
    { matcher: "__never__", hooks: [{ type: "command", command: "node -e \"\"", timeoutMs: 5000 }] },
  ] } });
  writeFileSync(join(home, "hooks.json"), hookFile);
  writeFileSync(join(workspace, ".raincode", "hooks.json"), hookFile);
}

async function shot(cdp: Cdp, name: string): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await sleep(250);
  const data = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(PICTURE_DIR, `${name}.png`), Buffer.from(data.data, "base64"));
  console.log(`  ✔ picture/${name}.png`);
}

const scrollTop = (): string =>
  `(() => { const el = [...document.querySelectorAll("div")].find(d => d.className.includes("overflow-y-auto") && d.querySelector(".corner-ticks")); if (!el) return false; el.scrollTop = 0; return true; })()`;

/** DOM 真实输入路径发送一回合（textarea 聚焦 → insertText → Enter）。 */
async function sendTurn(cdp: Cdp, text: string): Promise<void> {
  await cdp.eval(`document.querySelector("textarea").focus()`);
  await cdp.insertText(text);
  await sleep(150);
  await cdp.key("Enter", "Enter", 13);
}

async function main(): Promise<number> {
  console.log("产品截图 · 桌面端（构建产物 electron + mock LLM + CDP；窗口将弹出）");
  const rendererIndex = join(DESKTOP, "dist", "renderer", "index.html");
  if (!existsSync(rendererIndex)) { console.error("dist/renderer 缺失——先 pnpm --filter @raincode/desktop build"); return 1; }
  mkdirSync(PICTURE_DIR, { recursive: true });
  const mock = await startMockLlmServer();
  const errLlm = await startErrorLlmServer();
  const home = await mkdtemp(join(tmpdir(), "raincode-shots-desktop-"));
  const workspace = join(home, "ws");
  seedHome(home, workspace, mock.url);
  const electron = spawn(ELECTRON, [DESKTOP, `--remote-debugging-port=${String(CDP_PORT)}`], {
    cwd: DESKTOP,
    env: { ...process.env, RAINCODE_HOME: home, RAINCODE_PROVIDER_BASE_URL: mock.url,
      RAINCODE_PROVIDER_MODEL: "mock-model", RAINCODE_PROVIDER_API_KEY: "shots-dummy-key", RAINCODE_PROVIDER_NAME: "walkthrough-mock" },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: false,
  });
  electron.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[electron] ${chunk.toString()}`));
  let cdp: Cdp | null = null;
  try {
    cdp = await Cdp.connect(CDP_PORT);
    await cdp.waitFor(`${bodyContains("扩展面板")} && ${bodyContains("新建会话")}`, "renderer 引导完成", 30_000);
    await cdp.waitFor(`window.__raincodeStore.getState().connection === "ready"`, "bootstrap 握手完成", 20_000);
    // 建会话（store 直设工作区，走查同款 aid）
    await cdp.eval(`window.__raincodeStore.getState().setWorkspace(${JSON.stringify(workspace)})`);
    await cdp.eval<boolean>(clickButtonExpr("新建会话"));
    await cdp.waitFor(`window.__raincodeStore.getState().activeId !== null`, "会话创建", 20_000);
    await cdp.waitFor(`!document.querySelector("textarea").disabled`, "发送区就绪", 20_000);

    // 回合 1：推理流 + markdown
    mock.setScript([reasoningScript(REASONING, ANSWER_1)]);
    await sendTurn(cdp, "把备注卡片改成流式布局，先看看现有实现给个方案");
    try {
      await cdp.waitFor(bodyContains("确认方案的话我就直接动手改"), "回合 1 完成", 30_000);
    } catch (err) {
      console.log("[turn1 诊断] textarea =", JSON.stringify(await cdp.eval<string | null>(`document.querySelector("textarea")?.value ?? null`)));
      console.log("[turn1 诊断] mock.served =", String(mock.served()));
      console.log("[turn1 诊断] store =", (await cdp.eval<string>(`JSON.stringify(window.__raincodeStore.getState(), (k, v) => ["views", "sessions", "approvals"].includes(k) ? undefined : v)`)).slice(0, 500));
      const banner = await cdp.eval<string | null>(`(() => { const el = [...document.querySelectorAll("div")].find(d => String(d.className).includes("border-danger")); return el ? el.innerText.slice(0, 300) : null; })()`);
      console.log("[turn1 诊断] 错误横幅 =", banner);
      throw err;
    }
    await cdp.eval<boolean>(clickButtonExpr("思考过程")); // 展开思考块
    await sleep(300);
    await cdp.eval<boolean>(scrollTop());
    await sleep(300);
    await shot(cdp, "desktop-chat");
    // 浅色主题对照（03 §3.2 落地：token 重映射，组件零改动；截后还原深色继续）
    await cdp.eval(`document.documentElement.dataset.theme = "light"`);
    await sleep(250);
    await shot(cdp, "desktop-chat-light");
    await cdp.eval(`document.documentElement.dataset.theme = "dark"`);
    await sleep(250);

    // 回合 2：并行只读工具（todo_write 需审批：弹窗出现即「仅本次允许」，非截图素材）
    mock.setScript([toolsRound(), textScript(ANSWER_2)]);
    await sendTurn(cdp, "先扫一遍相关代码，列个任务清单");
    try {
      await cdp.waitFor(bodyContains("仅本次允许"), "todo_write 审批弹窗", 10_000);
      await sleep(200);
      await cdp.eval<boolean>(clickButtonExpr("仅本次允许"));
    } catch { /* 未弹审批（todo_write 若免审批则直行） */ }
    await cdp.waitFor(bodyContains("node --test 回归"), "回合 2 完成", 30_000);
    await cdp.eval<boolean>(`(() => { const b = [...document.querySelectorAll("button")].find(x => x.textContent.includes("src/store.ts")); if (!b) return false; b.click(); b.closest(".rounded-lg")?.scrollIntoView({ block: "center" }); return true; })()`);
    await sleep(400);
    await shot(cdp, "desktop-tools");

    // 回合 2.5：agent 工具派发子代理（builtin researcher）——右栏子代理 Tab 与进度卡素材；
    // 脚本队列 = 主回合 tool_calls 帧 → 子代理子 turn 文本 → 主回合收束文本
    mock.setScript([
      { frames: [{ choices: [{ index: 0, delta: { role: "assistant" } }] },
          toolCallFrame("t-agent", "agent", { profile: "researcher", task: "调研 flex-wrap 布局下拖拽排序的边界情况" }, 0)],
        finish: "tool_calls" },
      textScript("调研结论：flex-wrap 下按 DOM 顺序计算插入位置可行，需注意换行行的插入点归属。"),
      textScript("子代理调研完成：拖拽按 DOM 顺序计算可行，边界情况与结论已同步。"),
    ]);
    await sendTurn(cdp, "派个子代理调研拖拽排序的边界情况");
    try {
      await cdp.waitFor(bodyContains("仅本次允许"), "agent 审批弹窗", 20_000);
      await sleep(200);
      await cdp.eval<boolean>(clickButtonExpr("仅本次允许"));
    } catch { /* agent 免审批则直行 */ }
    try {
      await cdp.waitFor(bodyContains("子代理调研完成"), "回合 2.5 完成", 40_000);
    } catch (err) {
      console.log("[t2.5 诊断] 错误横幅 =", await cdp.eval<string | null>(`(() => { const el = [...document.querySelectorAll("div")].find(d => String(d.className).includes("border-danger")); return el ? el.innerText.slice(0, 300) : null; })()`));
      console.log("[t2.5 诊断] store =", (await cdp.eval<string>(`JSON.stringify(window.__raincodeStore.getState(), (k, v) => (k === "views" || k === "sessions" || k === "providers") ? undefined : v)`)));
      console.log("[t2.5 诊断] mock.served =", String(mock.served()));
      throw err;
    }

    // 右侧上下文面板（refine-ui-context-panel 轮）：MCP Tab 与子代理 Tab（记忆 Tab 已入 desktop-chat 全景）
    await cdp.eval<boolean>(`(() => { const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === "MCP"); if (!b) return false; b.click(); return true; })()`);
    await cdp.waitFor(bodyContains("fixture"), "右栏 MCP Tab 投影", 15_000);
    await sleep(300);
    await shot(cdp, "desktop-context-mcp");
    await cdp.eval<boolean>(`(() => { const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === "子代理"); if (!b) return false; b.click(); return true; })()`);
    await cdp.waitFor(bodyContains("researcher"), "右栏子代理 Tab 投影", 15_000);
    await sleep(300);
    await shot(cdp, "desktop-context-subagent");
    // 侧栏折叠图标态（56px）
    await cdp.eval<boolean>(`(() => { const b = [...document.querySelectorAll("button")].find(x => x.getAttribute("title") === "折叠侧栏"); if (!b) return false; b.click(); return true; })()`);
    await sleep(350);
    await shot(cdp, "desktop-sidebar-collapsed");
    await cdp.eval<boolean>(`(() => { const b = [...document.querySelectorAll("button")].find(x => x.getAttribute("title") === "展开侧栏"); if (!b) return false; b.click(); return true; })()`);
    await sleep(300);

    // 回合 3：write 审批弹窗（kbd 芯片素材）
    mock.setScript([writeCallScript("t-write", "docs/api.md", "# notes-cli API\n\n- NoteStore：速记存储\n- renderNoteList：列表渲染\n"), textScript(ANSWER_3)]);
    await sendTurn(cdp, "把导出函数补进 docs/api.md");
    await cdp.waitFor(bodyContains("仅本次允许"), "审批弹窗出现", 30_000);
    await sleep(400);
    await shot(cdp, "desktop-approval");
    await cdp.eval<boolean>(clickButtonExpr("仅本次允许"));
    await cdp.waitFor(bodyContains("附了最小示例"), "回合 3 完成", 30_000);

    // 压缩可视化（本轮）：先补足会话历史（cutIndex = length − keepRecent(20)，历史未超出保留区
    // 时 session.compact 无前缀可摘要不产生事件），再 DOM 真实点击「压缩」走 session.compact 全链路
    for (const line of ["补录记录甲", "补录记录乙", "补录记录丙", "补录记录丁"]) {
      mock.setScript([textScript(`收到（${line}）`)]);
      await sendTurn(cdp, line);
      await cdp.waitFor(bodyContains(`收到（${line}）`), `补录 ${line} 完成`, 20_000);
    }
    await cdp.eval<boolean>(clickButtonExpr("压缩"));
    await cdp.waitFor(bodyContains("上下文已压缩"), "压缩提示条（manual 完成态）", 30_000);
    await cdp.eval<boolean>(scrollTop());
    await sleep(400);
    await shot(cdp, "desktop-compaction");

    // 设置页六组导航（ui-panel-deepening 轮）：命令权限（真实表单加规则）/ MCP / Provider / 关于
    await cdp.eval<boolean>(clickButtonExpr("设置"));
    await cdp.waitFor(bodyContains("设定"), "设置页渲染", 15_000);
    await cdp.eval<boolean>(clickButtonExpr("命令权限"));
    await cdp.waitFor(bodyContains("高危命令"), "命令权限组渲染", 15_000);
    await cdp.eval<boolean>(clickButtonExpr("新建规则"));
    await cdp.eval<boolean>(`(() => {
      const setVal = (ctor, el, v, ev) => { Object.getOwnPropertyDescriptor(ctor.prototype, "value").set.call(el, v); el.dispatchEvent(new Event(ev, { bubbles: true })); };
      const tool = [...document.querySelectorAll("input")].find(i => i.placeholder === "例如 bash");
      const pattern = [...document.querySelectorAll("input")].find(i => i.placeholder === "例如 rm -rf *");
      if (!tool || !pattern) return false;
      setVal(window.HTMLInputElement, tool, "bash", "input");
      setVal(window.HTMLInputElement, pattern, "rm -rf*", "input");
      const selects = [...document.querySelectorAll("select")];
      const scope = selects.find(s => [...s.options].some(o => o.value === "global"));
      const behavior = selects.find(s => [...s.options].some(o => o.value === "deny"));
      if (scope !== undefined) setVal(window.HTMLSelectElement, scope, "global", "change");
      if (behavior !== undefined) setVal(window.HTMLSelectElement, behavior, "deny", "change");
      return true;
    })()`);
    await sleep(200);
    await cdp.eval<boolean>(clickButtonExpr("创建规则"));
    await cdp.waitFor(bodyContains("bash:rm -rf*"), "权限规则新建投影", 15_000);
    await sleep(300);
    await shot(cdp, "desktop-settings-permissions");
    await cdp.eval<boolean>(clickButtonExpr("MCP 服务器"));
    await cdp.waitFor(bodyContains("fixture"), "MCP 服务器组渲染", 15_000);
    await sleep(300);
    await shot(cdp, "desktop-settings-mcp");
    await cdp.eval<boolean>(clickButtonExpr("Provider 与模型"));
    await cdp.waitFor(bodyContains("walkthrough-mock"), "Provider 设置渲染", 15_000);
    await sleep(250);
    await shot(cdp, "desktop-settings");
    await cdp.eval<boolean>(clickButtonExpr("关于"));
    await cdp.waitFor(bodyContains("协议版本"), "关于组渲染", 15_000);
    await sleep(250);
    await shot(cdp, "desktop-settings-about");
    await cdp.eval<boolean>(clickButtonExpr("← 返回"));

    // 记忆管理器 + 扩展面板
    await cdp.eval<boolean>(clickButtonExpr("记忆管理器"));
    await cdp.waitFor(bodyContains("MEMORY.md"), "记忆管理器渲染");
    await sleep(250);
    await shot(cdp, "desktop-memory");
    await cdp.eval<boolean>(clickButtonExpr("← 返回"));
    await cdp.eval<boolean>(clickButtonExpr("扩展面板"));
    await cdp.waitFor(`${bodyContains("fixture")} && ${bodyContains("已连接")}`, "扩展面板 MCP 投影", 20_000);
    await sleep(250);
    await shot(cdp, "desktop-extensions");
    // Hooks 分区（T5.1 UI 缺口收口）：project 源未授信 + user 源已授信对照
    await cdp.waitFor(bodyContains("未授信"), "Hooks 分区投影（project 未授信）", 15_000);
    await cdp.eval(`(() => { const el = [...document.querySelectorAll("h3,span,div")].find(d => d.textContent === "Hooks"); if (el) el.scrollIntoView({ block: "start" }); return true; })()`);
    await sleep(400);
    await shot(cdp, "desktop-extensions-hooks");

    // ===== polish-ui-states-and-runtime 本轮新增素材（全部真实渲染数据） =====
    const clickSettingsNav = (label: string): string =>
      `(() => { const b = [...document.querySelectorAll("nav button")].find(x => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; b.click(); return true; })()`;
    const clickModelCtx = `(() => { const b = [...document.querySelectorAll("button")].find(x => x.getAttribute("title") === "活跃 Provider 模型（点击快切，仅影响后续请求）"); if (!b) return false; b.click(); return true; })()`;
    const scrollSection = (title: string): string =>
      `(() => { const el = [...document.querySelectorAll("div")].find(d => d.textContent === ${JSON.stringify(title)}); el?.closest("section")?.scrollIntoView({ block: "start" }); return true; })()`;
    await cdp.eval<boolean>(clickButtonExpr("← 返回")); // 扩展面板 → chat

    // 3. 模型快切弹层（config.providers.list → switch）：先补第二 Provider（error-mock，亦服务第 6 张）
    await cdp.eval(`window.__raincodeStore.getState().addProvider({ name: "error-mock", baseURL: ${JSON.stringify(errLlm.url)}, model: "error-model", maxContextTokens: 8192 })`);
    await cdp.waitFor(`window.__raincodeStore.getState().providers.length === 2`, "第二 Provider 投影", 15_000);
    await cdp.eval<boolean>(clickModelCtx);
    await cdp.waitFor(`${bodyContains("切换 Provider")} && ${bodyContains("error-mock")} && ${bodyContains("活跃")}`, "模型快切弹层渲染", 15_000);
    await sleep(250);
    await shot(cdp, "desktop-model-switch");
    await cdp.eval<boolean>(clickModelCtx); // 关闭弹层

    // 1. 设置「工具」目录（tool.tools.list）：展开一行显示 JSON-Schema 参数块
    await cdp.eval<boolean>(clickButtonExpr("设置"));
    await cdp.waitFor(bodyContains("设定"), "设置页渲染", 15_000);
    await cdp.eval<boolean>(clickSettingsNav("工具"));
    await cdp.waitFor(`${bodyContains("工具目录")} && ${bodyContains("内置")}`, "工具组渲染", 15_000);
    await cdp.eval<boolean>(`(() => { const b = document.querySelector("[data-nav-primary]"); if (!b) return false; b.click(); return true; })()`);
    await cdp.waitFor(bodyContains("参数 schema"), "工具 schema 展开", 15_000);
    await cdp.eval<boolean>(scrollSection("工具目录"));
    await sleep(300);
    await shot(cdp, "desktop-tools-catalog");

    // 2. 决策审计（permission.decisions.list）：命令权限组内子区，真实审批决策记录
    await cdp.eval<boolean>(clickSettingsNav("命令权限"));
    await cdp.waitFor(bodyContains("决策审计"), "决策审计子区渲染", 15_000);
    const auditHasRow = await cdp.eval<boolean>(bodyContains("耗时"));
    console.log(`  [audit] 真实决策记录存在：${String(auditHasRow)}${auditHasRow ? "" : "（空态：暂无决策记录）"}`);
    await cdp.eval<boolean>(scrollSection("决策审计"));
    await sleep(300);
    await shot(cdp, "desktop-audit");
    await cdp.eval<boolean>(clickButtonExpr("← 返回"));

    // 5. 会话列表键盘导航高亮（A5）：补足具名会话 → 聚焦列表容器 + ↑↓ 移动到非活跃行
    await cdp.waitFor(`!document.querySelector("textarea").disabled`, "会话发送区就绪", 15_000);
    for (const title of ["布局重构方案", "流式布局验证", "回归测试清单"]) {
      await cdp.eval(`window.__raincodeStore.getState().createSession(${JSON.stringify(title)})`);
    }
    await cdp.waitFor(`document.querySelectorAll('[data-nav-row]').length >= 4`, "会话列表多行", 15_000);
    await cdp.eval(`document.querySelector('nav[aria-label="会话列表"]').focus()`);
    await cdp.waitFor(`document.activeElement?.getAttribute("aria-label") === "会话列表"`, "会话列表容器聚焦", 10_000);
    for (let i = 0; i < 3; i += 1) {
      await cdp.key("ArrowDown", "ArrowDown", 40);
    }
    // 断言：存在「非活跃」行带键盘高亮底色（活跃行另有左侧 accent 指示条，故用其区分）
    try {
      await cdp.waitFor(
        `[...document.querySelectorAll('[data-nav-row]')].some(r => String(r.className).includes('bg-selected') && r.querySelector('.bg-accent') === null)`,
        "键盘高亮非活跃行",
        10_000,
      );
      console.log("  [keyboard] 键盘高亮非活跃会话行：true");
    } catch {
      console.log("  [keyboard] 键盘高亮非活跃会话行：false（↑↓ 未生效）");
    }
    await sleep(300);
    await shot(cdp, "desktop-session-keyboard");

    // 4. 后台 Tab（tool.background.list/output）：真实 bash runInBackground 任务行
    mock.setScript([bashBackgroundRound(), textScript("已在后台启动日志进程，右侧「后台」Tab 可见任务行与产出。")]);
    await sendTurn(cdp, "在后台启动一个持续输出日志的进程");
    try {
      await cdp.waitFor(bodyContains("仅本次允许"), "bash 审批弹窗", 15_000);
      await sleep(200);
      await cdp.eval<boolean>(clickButtonExpr("仅本次允许"));
    } catch { /* bash 若免审批则直行 */ }
    await cdp.waitFor(bodyContains("右侧「后台」Tab 可见"), "后台回合完成", 30_000);
    await cdp.eval<boolean>(`(() => { const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === "后台"); if (!b) return false; b.click(); return true; })()`);
    await cdp.waitFor(`${bodyContains("终止")} || ${bodyContains("bg tick")}`, "后台 Tab 任务行", 15_000);
    await sleep(1_500);
    await cdp.eval<boolean>(`(() => { const b = [...document.querySelectorAll("button")].find(x => x.getAttribute("title") === "展开产出"); if (!b) return false; b.click(); return true; })()`);
    await cdp.waitFor(`/bg tick \\d/.test(document.body.innerText)`, "后台产出 tail 投影", 15_000);
    await sleep(300);
    await shot(cdp, "desktop-background");

    // 6. 回合失败卡「重试」：切换活跃 Provider → 新建会话（create 时绑定 error-mock）→ 发回合 → LLM_HTTP_ERROR
    await cdp.eval(`window.__raincodeStore.getState().switchProvider(window.__raincodeStore.getState().providers.find(p => p.name === "error-mock").id)`);
    await cdp.waitFor(`window.__raincodeStore.getState().activeProviderId !== null && window.__raincodeStore.getState().providers.find(p => p.id === window.__raincodeStore.getState().activeProviderId)?.name === "error-mock"`, "活跃 Provider 切换", 15_000);
    await cdp.eval(`window.__raincodeStore.getState().createSession()`);
    await cdp.waitFor(`!document.querySelector("textarea").disabled`, "错误 Provider 会话就绪", 15_000);
    await sendTurn(cdp, "触发一次可重试的回合失败");
    await cdp.waitFor(`${bodyContains("回合失败")} && ${bodyContains("重试")}`, "回合失败卡（recoverable）", 30_000);
    await sleep(300);
    await shot(cdp, "desktop-turn-failed");

    console.log("桌面端截图完成");
    return 0;
  } catch (err) {
    console.error("[shots-desktop] 异常终止:", err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    cdp?.close();
    electron.kill();
    await sleep(800);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
    await mock.close();
    await errLlm.close();
  }
}

main().then((code) => process.exit(code));
