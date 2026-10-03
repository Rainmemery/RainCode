/**
 * T4.7 Web 工作台真浏览器走查（CDP 驱动；L-05 核销 + L-21 确定性复核）：
 * 真实入口链路 = `raincode web` CLI 命令（与 serve 同装配面）--static 服务 apps/web 构建产物
 * + Edge/Chrome headless 直启 + --remote-debugging-port → CDP Runtime.evaluate（DOM 语义断言）
 * 与 Input.insertText / dispatchKeyEvent（真实键盘流）驱动：
 *   A 连接与鉴权：错误 token → fatal「连接被拒绝」+ UNAUTHORIZED（onFatal 停止重连语义）；
 *     正确 token → 侧栏「已连接」徽章
 *   B 会话回合：DOM 输入工作区 → 新建会话 → 键盘发送 → mock 回复实时流渲染 → 用量统计行
 *   C 审批闭环：write 工具回合 → 审批弹窗 → 放行后文件真实落盘（验证世界 N-3）→
 *     再一回合拒绝后目标文件不存在
 *   D 重连恢复：杀宿主进程 → 徽章进入重连态 → 重启宿主（同 home/port）→ 自动重连 +
 *     活跃会话快照补偿（history 冷重建零交互恢复）+ B9 无滞留错误横幅
 *   E L-21 多标签扇出确定性复核：第二标签同 URL 接入（首会话冷重建可见）→
 *     E1 标签离线（Network.emulateNetworkConditions，模拟 Edge 后台标签冻结的 JS 挂起）→
 *     主标签完成回合 → 标签恢复在线 → 零交互 resume 补偿拉平；
 *     E2 双标签在线 → 主标签回合实时扇出到达（无冻结路径）
 * 运行：先 pnpm --filter @raincode/web build，再 pnpm walkthrough:web。全程本机回环 +
 * 临时目录 + 占位假 key（绝不打印，04 §5.3）。
 */
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bodyContains, Cdp, clickButtonExpr, sleep } from "./cdp-lib.mts";
import { startMockLlmServer, textScript, writeCallScript } from "./p0-lib.mts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIST = join(REPO_ROOT, "apps", "web", "dist");
const CDP_PORT = 9233;
const TOKEN = "walkthrough-web-token";
let mockUrl = "";
const BROWSER_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  process.env["RAINCODE_WALKTHROUGH_BROWSER"] ?? "",
].filter((p) => p.length > 0);

let passCount = 0;
let failCount = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    passCount += 1;
    console.log(`  ✔ ${name}`);
  } else {
    failCount += 1;
    console.log(`  ✖ ${name}${detail !== "" ? ` —— ${detail}` : ""}`);
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolvePromise(port));
    });
  });
}

/** 真实入口：`raincode web` CLI 命令（apps/cli 经 tsx 直跑，B11 根目录直跑形态）。 */
function startWebHost(home: string, port: number): ReturnType<typeof spawn> {
  const child = spawn(
    "node",
    [
      "--import", "tsx",
      "apps/cli/src/index.ts",
      "web",
      "--port", String(port),
      "--token", TOKEN,
      "--static", WEB_DIST,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        RAINCODE_HOME: home,
        RAINCODE_PROVIDER_BASE_URL: mockUrl,
        RAINCODE_PROVIDER_MODEL: "mock-model",
        RAINCODE_PROVIDER_API_KEY: "walkthrough-dummy-key",
        RAINCODE_PROVIDER_NAME: "walkthrough-mock",
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[web] ${chunk.toString()}`));
  return child;
}

/** 等宿主静态端点就绪（页面由宿主自身服务，先就绪再开标签，避免 Chrome 错误页）。 */
async function waitWebHost(port: number, label: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${String(port)}/`);
      if (res.ok) return;
    } catch {
      // 未就绪，轮询
    }
    if (Date.now() - started > 30_000) throw new Error(`等待超时: ${label}`);
    await sleep(300);
  }
}

/** 等宿主端口真正释放（杀进程是异步的：端口未释放即重启会 EADDRINUSE）。 */
async function waitHostClosed(port: number): Promise<void> {
  const started = Date.now();
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${String(port)}/`);
    } catch {
      return; // 连接失败 = 端口已释放
    }
    if (Date.now() - started > 15_000) throw new Error("等待超时: 宿主端口释放");
    await sleep(200);
  }
}

/** 浏览器进程树终止（taskkill /T；electron 走 child.kill，浏览器子进程树需系统调用）。 */
function killTree(pid: number): void {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
}

/** 经 /json/new?about:blank 建标签（按 targetId 连 CDP）→ Page.navigate 导航完整 URL。
 * 不能把带 & 的工作台 URL 直接拼进 /json/new：Edge 解析 query 后在第一个 & 处截断，
 * ws/token 参数会被剥掉（实测），页面回退默认端点导致「永远重连」假象。 */
async function openTab(browserPort: number, url: string): Promise<Cdp> {
  const created = (await (
    await fetch(`http://127.0.0.1:${String(browserPort)}/json/new?about:blank`, { method: "PUT" })
  ).json()) as { id: string };
  const cdp = await Cdp.connect(browserPort, (target) => target.id === created.id);
  await cdp.send("Page.navigate", { url });
  return cdp;
}

async function main(): Promise<number> {
  console.log("T4.7 Web 工作台真浏览器走查启动（CDP；headless 浏览器）");
  if (!existsSync(join(WEB_DIST, "index.html"))) {
    console.error("apps/web/dist 缺失——先执行 pnpm --filter @raincode/web build");
    return 1;
  }
  const browserExe = BROWSER_CANDIDATES.find((p) => existsSync(p));
  if (browserExe === undefined) {
    console.error("未找到 Edge/Chrome——可设 RAINCODE_WALKTHROUGH_BROWSER 指定浏览器路径");
    return 1;
  }
  const mock = await startMockLlmServer();
  mockUrl = mock.url;
  const home = await mkdtemp(join(tmpdir(), "raincode-walkthrough-web-"));
  const workspace = join(home, "ws");
  mkdirSync(workspace, { recursive: true });
  // 种子：mcp.json（stdio fixture）+ 示例插件 + 官方示例技能（扩展面板/斜杠面板服务面数据）+
  // Provider 经 env 注入（resolveProviderConfig 三来源；config.json 不落盘，假 key 只在 env）
  writeFileSync(
    join(home, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { transport: "stdio", command: "node", args: [join(REPO_ROOT, "scripts", "mcp-fixture-stdio.mjs")], enabled: true },
      },
    }),
    "utf8",
  );
  mkdirSync(join(home, "plugins"), { recursive: true });
  cpSync(join(REPO_ROOT, "examples", "plugins", "hello"), join(home, "plugins", "hello"), { recursive: true });
  mkdirSync(join(home, "skills"), { recursive: true });
  for (const skill of ["docs.md", "review.md", "test-gen.md"]) {
    cpSync(join(REPO_ROOT, "examples", "skills", skill), join(home, "skills", skill));
  }

  const port = await freePort();
  const browserProfile = join(home, "browser-profile");
  let host: ReturnType<typeof spawn> | null = null;
  let browser: ReturnType<typeof spawn> | null = null;
  try {
    host = startWebHost(home, port);
    await waitWebHost(port, "raincode web 宿主就绪");
    const workbenchUrl = `http://127.0.0.1:${String(port)}/?token=${TOKEN}&ws=ws://127.0.0.1:${String(port)}/ws`;
    browser = spawn(
      browserExe,
      [
        "--headless=new",
        `--remote-debugging-port=${String(CDP_PORT)}`,
        `--user-data-dir=${browserProfile}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--window-size=1400,900",
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    browser.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[browser] ${chunk.toString()}`));

    // ---- A 连接与鉴权 ----
    console.log("A 连接与鉴权（onFatal 停止重连 + 正确 token 就绪）");
    const wrongUrl = `http://127.0.0.1:${String(port)}/?token=wrongwrong&ws=ws://127.0.0.1:${String(port)}/ws`;
    const cdpWrong = await openTab(CDP_PORT, wrongUrl);
    await cdpWrong.waitFor(`${bodyContains("连接被拒绝")} && ${bodyContains("UNAUTHORIZED")}`, "错误 token → fatal UI", 30_000);
    check("错误 token → 连接被拒绝 + UNAUTHORIZED（重试停止）", true);
    cdpWrong.close();

    const cdp1 = await openTab(CDP_PORT, workbenchUrl);
    await cdp1.waitFor(bodyContains("已连接"), "主标签 ws.auth 握手就绪", 30_000);
    check("正确 token → 侧栏「已连接」徽章", true);
    await cdp1.eval(`(() => { window.__errs = []; window.addEventListener("unhandledrejection", (e) => window.__errs.push(String(e.reason?.message ?? e.reason))); window.addEventListener("error", (e) => window.__errs.push(String(e.message))); return true; })()`);

    // ---- B 会话回合 ----
    console.log("B 会话回合（DOM 工作区 + 键盘发送 + 实时流渲染）");
    // React 受控 input：以原生 setter 写值 + input 事件同步（CDP insertText 对受控 input 时序不稳）
    const setWorkspaceExpr = `(() => { const el = document.querySelector("aside input"); if (!el) return false; const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set; set.call(el, ${JSON.stringify(workspace)}); el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
    check("工作区目录写入并设定", (await cdp1.eval<boolean>(`${setWorkspaceExpr} && ${clickButtonExpr("设定")}`)) === true);
    const createdOk = await cdp1.eval<boolean>(
      `${clickButtonExpr("+ 新会话")} && new Promise(r => { let n = 0; const t = setInterval(() => { n++; const ta = document.querySelector("textarea"); if (ta !== null || n > 40) { clearInterval(t); r(ta !== null); } }, 300); })`,
    );
    if (!createdOk) {
      const dump = await cdp1.eval<string>(
        `JSON.stringify((() => { const s = window.__raincodeStore?.getState?.() ?? {}; return { workspace: s.workspace, activeId: s.activeId, error: s.error, connection: s.connection, errWindow: (window.__errs ?? []).slice(0, 3) }; })())`,
      );
      console.log("[createSession 失败现场]", dump);
    }
    check("新建会话（发送区出现）", createdOk);
    mock.setScript([textScript("Web 走查回合回复正常")]);
    await cdp1.eval(`document.querySelector("textarea").focus()`);
    await cdp1.insertText("你好，请回复");
    await cdp1.key("Enter", "Enter", 13);
    await cdp1.waitFor(bodyContains("Web 走查回合回复正常"), "mock 回复实时流渲染", 30_000);
    check("键盘发送 → 回复实时渲染（message.delta 流）", true);
    await sleep(1000); // done → refreshUsage
    check("用量统计行（session.usage 投影）", await cdp1.eval<boolean>(
      `(() => { const up = document.body.innerText.match(/↑[\\d.]+k?/); const down = document.body.innerText.match(/↓[\\d.]+k?/); return up !== null && down !== null; })()`,
    ));

    // ---- C 审批闭环（放行落盘 / 拒绝无文件）----
    console.log("C 审批闭环（write 工具 + 文件落盘验证）");
    mock.setScript([writeCallScript("wa1", "out/walkthrough-allow.txt", "approved-content"), textScript("写入完成，文件已落盘")]);
    await cdp1.eval(`document.querySelector("textarea").focus()`);
    await cdp1.insertText("请写入 out/walkthrough-allow.txt");
    await cdp1.key("Enter", "Enter", 13);
    await cdp1.waitFor(`${bodyContains("仅本次允许")} && ${bodyContains("write")}`, "审批弹窗（风险徽章 + 参数预览）", 30_000);
    check("write 回合触发审批弹窗", true);
    check("放行 → 工具执行 + 回合收束", await cdp1.eval<boolean>(`${clickButtonExpr("仅本次允许")} && true`));
    await cdp1.waitFor(bodyContains("写入完成，文件已落盘"), "放行后回合完成", 30_000);
    check("文件真实落盘（验证世界而非自述）", existsSync(join(workspace, "out", "walkthrough-allow.txt")));

    mock.setScript([writeCallScript("wd1", "out/walkthrough-deny.txt", "denied-content"), textScript("已按拒绝处理")]);
    await cdp1.eval(`document.querySelector("textarea").focus()`);
    await cdp1.insertText("请写入 out/walkthrough-deny.txt");
    await cdp1.key("Enter", "Enter", 13);
    await cdp1.waitFor(bodyContains("仅本次允许"), "第二个审批弹窗", 30_000);
    check("拒绝 → 工具不执行 + 回合收束", await cdp1.eval<boolean>(`${clickButtonExpr("4 拒绝")} && true`));
    await cdp1.waitFor(bodyContains("已按拒绝处理"), "拒绝后回合完成", 30_000);
    check("被拒文件不存在", !existsSync(join(workspace, "out", "walkthrough-deny.txt")));

    // ---- D 重连恢复（宿主进程重启 + 快照补偿）----
    console.log("D 重连恢复（杀宿主 → 重启 → 自动重连 + 冷重建）");
    host.kill();
    await cdp1.waitFor(`${bodyContains("重连中")} || ${bodyContains("已断开")}`, "断线徽章（重连态可视化）", 20_000);
    check("宿主终止 → 重连态徽章", true);
    await waitHostClosed(port);
    host = startWebHost(home, port);
    await waitWebHost(port, "宿主重启就绪");
    await cdp1.waitFor(bodyContains("已连接"), "自动重连回 ready", 40_000);
    check("宿主重启 → 自动重连（退避重试）", true);
    await cdp1.waitFor(bodyContains("写入完成，文件已落盘"), "活跃会话快照补偿（history 冷重建）", 20_000);
    check("零交互恢复历史视图（resume 补推）", true);
    check("无滞留错误横幅（B9 回归）", !(await cdp1.eval<boolean>(bodyContains("TRANSPORT_CLOSED"))));

    // ---- E L-21 多标签扇出确定性复核 ----
    console.log("E L-21 复核（第二标签接入 + 离线补偿 + 在线实时扇出）");
    const cdp2 = await openTab(CDP_PORT, `${workbenchUrl}&probe=b`);
    await cdp2.waitFor(bodyContains("已连接"), "第二标签握手就绪", 30_000);
    await cdp2.waitFor(bodyContains("Web 走查回合回复正常"), "第二标签首会话冷重建", 20_000);
    check("第二标签接入并恢复当前会话视图", true);

    mock.setScript([textScript("扇出回合甲"), textScript("扇出回合乙")]);
    // 冻结第二标签（Page.setWebLifecycleState = Edge 后台标签冻结的确定性模拟，L-21 假说机制注入；
    // emulateNetworkConditions(offline) 只拦新请求不掐既有 ws，实测无效）
    await cdp2.send("Page.setWebLifecycleState", { state: "frozen" });
    await cdp1.eval(`document.querySelector("textarea").focus()`);
    await cdp1.insertText("冻结窗口回合");
    await cdp1.key("Enter", "Enter", 13);
    await cdp1.waitFor(bodyContains("扇出回合甲"), "主标签冻结窗口回合完成", 30_000);
    check("冻结期内第二标签未实时收到回合（冻结真实生效）", !(await cdp2.eval<boolean>(bodyContains("扇出回合甲"))));
    await cdp2.send("Page.setWebLifecycleState", { state: "active" });
    await cdp2.waitFor(bodyContains("扇出回合甲"), "冻结标签恢复后零交互补偿拉平", 40_000);
    check("L-21 E1：错失回合的标签恢复后补偿拉平（冻结假说机制确定性复现）", true);
    await cdp1.eval(`document.querySelector("textarea").focus()`);
    await cdp1.insertText("在线扇出回合");
    await cdp1.key("Enter", "Enter", 13);
    await cdp2.waitFor(bodyContains("扇出回合乙"), "双标签在线实时扇出", 20_000);
    check("L-21 E2：双标签在线实时扇出零缺口（协议层用例 E 的真浏览器等价）", true);

    console.log(`—— 走查汇总：${String(passCount)} 过 / ${String(failCount)} 败 ——`);
    return failCount === 0 ? 0 : 1;
  } catch (err) {
    console.error("[walkthrough-web] 异常终止:", err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    if (browser !== null && browser.pid !== undefined) killTree(browser.pid);
    if (host !== null && host.pid !== undefined) killTree(host.pid);
    await sleep(800);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
    mock.close();
  }
}

main().then((code) => process.exit(code));
