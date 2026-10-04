/**
 * 产品介绍截图 · 桌面端（README picture/ 素材再生工具）：walkthrough-desktop 同形态——
 * 构建产物 electron 直启 + --remote-debugging-port → CDP 语义导航与 Page.captureScreenshot。
 * 内容驱动走 DOM 真实输入路径（textarea + Enter），mock LLM 脚本回放推理流 / markdown /
 * 并行只读工具 / write 审批；种子临时 RAINCODE_HOME（MCP fixture / hello 插件 / 示例工作区）。
 * 运行：pnpm --filter @raincode/desktop build && pnpm shots:desktop（输出 picture/*.png）。
 * 全程临时目录 + 占位假 key（绝不打印，04 §5.3）；窗口会真实弹出数十秒。
 */
import { spawn } from "node:child_process";
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

    // 回合 3：write 审批弹窗（kbd 芯片素材）
    mock.setScript([writeCallScript("t-write", "docs/api.md", "# notes-cli API\n\n- NoteStore：速记存储\n- renderNoteList：列表渲染\n"), textScript(ANSWER_3)]);
    await sendTurn(cdp, "把导出函数补进 docs/api.md");
    await cdp.waitFor(bodyContains("仅本次允许"), "审批弹窗出现", 30_000);
    await sleep(400);
    await shot(cdp, "desktop-approval");
    await cdp.eval<boolean>(clickButtonExpr("仅本次允许"));
    await cdp.waitFor(bodyContains("附了最小示例"), "回合 3 完成", 30_000);

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
  }
}

main().then((code) => process.exit(code));
