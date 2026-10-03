/**
 * T3.9 桌面端 GUI 走查（CDP 驱动 renderer，延续 M2 场景 5 口径）：
 * 种子临时 RAINCODE_HOME（mcp.json 指向 stdio fixture / 示例插件 hello / 官方示例技能 ×3）
 * + mock LLM env → 构建产物 electron 直启 + --remote-debugging-port → CDP Runtime.evaluate
 * （DOM 语义点击）与 Input.insertText / dispatchKeyEvent（真实键盘流）驱动：
 *   A 扩展面板：MCP server Connected 投影 / 健康检查 RTT / 插件与 server 启停双向 /
 *     状态事件活更（停用→未连接→启用→已连接）
 *   B 斜杠命令面板："/" 唤起 / ↑↓+Tab 键盘补全 / Enter 调用 skills.invoke 端到端回合
 *   C 用量统计：回合收束后侧栏 ↑/↓ token 行（done → refreshUsage）
 *   D 记忆管理器：视图可达与三栏渲染（MR-4 人工走查项自动化替代）
 * 运行：先 pnpm --filter @raincode/desktop build，再 tsx scripts/walkthrough-desktop.mts。
 * 安装产物冒烟（T4.7 L-04）：设 RAINCODE_WALKTHROUGH_APP_PATH 指向安装后的 RainCode.exe
 * （静默安装：installer /S /D=<dir>），即对 nsis 产物跑同一套断言。
 */
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bodyContains, Cdp, clickButtonExpr, clickInSection, sleep } from "./cdp-lib.mts";
import { startMockLlmServer, textScript } from "./p0-lib.mts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DESKTOP = join(REPO_ROOT, "apps", "desktop");
const ELECTRON = join(DESKTOP, "node_modules", "electron", "dist", "electron.exe");
const CDP_PORT = 9223;
/** 安装产物冒烟目标（T4.7）：指向安装后的 RainCode.exe 时对 dist 产物跑同套断言。 */
const INSTALLED_EXE = process.env["RAINCODE_WALKTHROUGH_APP_PATH"];

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

// ---------------------------------------------------------------------------
// CDP 最小客户端（Runtime.evaluate / Input.*）：共享实现见 scripts/cdp-lib.mts
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  console.log(`T3.9 桌面端 GUI 走查启动（CDP；目标=${INSTALLED_EXE ?? "dev electron"}，窗口将弹出）`);
  const mock = await startMockLlmServer();
  const home = await mkdtemp(join(tmpdir(), "raincode-walkthrough-"));
  const workspace = join(home, "ws");
  mkdirSync(workspace, { recursive: true });
  // 种子：mcp.json（stdio fixture）+ 示例插件 + 官方示例技能 ×3 + config.json Provider（UI 门要求
  // providers 列表非空；apiKeyRef null = 本地 Provider 无凭据，mock 不校验 auth——假 key 不落任何文件）
  writeFileSync(
    join(home, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: { transport: "stdio", command: "node", args: [join(REPO_ROOT, "scripts", "mcp-fixture-stdio.mjs")], enabled: true },
      },
    }),
    "utf8",
  );
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      configVersion: 1,
      providers: [
        { id: "walkthrough", name: "walkthrough-mock", baseURL: mock.url, model: "mock-model", maxContextTokens: 8192, apiKeyRef: null },
      ],
      activeProviderId: "walkthrough",
    }),
    "utf8",
  );
  mkdirSync(join(home, "plugins"), { recursive: true });
  cpSync(join(REPO_ROOT, "examples", "plugins", "hello"), join(home, "plugins", "hello"), { recursive: true });
  mkdirSync(join(home, "skills"), { recursive: true });
  for (const skill of ["docs.md", "review.md", "test-gen.md"]) {
    cpSync(join(REPO_ROOT, "examples", "skills", skill), join(home, "skills", skill));
  }

  const appDir = INSTALLED_EXE !== undefined ? dirname(INSTALLED_EXE) : DESKTOP;
  // dev electron 需要显式 app 路径参数；安装产物 exe 自带 app（同 --remote-debugging-port 透传）
  const spawnArgs =
    INSTALLED_EXE !== undefined
      ? [`--remote-debugging-port=${String(CDP_PORT)}`]
      : [DESKTOP, `--remote-debugging-port=${String(CDP_PORT)}`];
  const electron = spawn(INSTALLED_EXE ?? ELECTRON, spawnArgs, {
    cwd: appDir,
    env: {
      ...process.env,
      RAINCODE_HOME: home,
      RAINCODE_PROVIDER_BASE_URL: mock.url,
      RAINCODE_PROVIDER_MODEL: "mock-model",
      RAINCODE_PROVIDER_API_KEY: "walkthrough-dummy-key",
      RAINCODE_PROVIDER_NAME: "walkthrough-mock",
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: false,
  });
  electron.stderr.on("data", (chunk: Buffer) => process.stderr.write(`[electron] ${chunk.toString()}`));
  let cdp: Cdp | null = null;
  try {
    cdp = await Cdp.connect(CDP_PORT);
    await cdp.waitFor(
      `${bodyContains("扩展面板")} && ${bodyContains("新建会话")}`,
      "renderer 引导完成（bootstrap + 侧栏就绪）",
      30_000,
    );
    console.log("[引导] renderer 就绪（agent 子进程 spawn + ping + 会话列表）");

    // ---- A 扩展面板 ----
    console.log("A 扩展面板（MCP / 插件）");
    check("入口按钮存在并进入视图", (await cdp.eval<boolean>(clickButtonExpr("扩展面板"))) === true);
    await cdp.waitFor(`${bodyContains("MCP 服务器")} && ${bodyContains("fixture")}`, "MCP server 行渲染");
    await cdp.waitFor(bodyContains("已连接"), "fixture Connected 投影");
    await cdp.waitFor(`${bodyContains("hello")} && ${bodyContains("已激活")}`, "插件 active 投影");
    check("MCP/插件状态投影齐全", true);
    check("健康检查 RTT 实测呈现", await cdp.eval<boolean>(
      `${clickButtonExpr("健康检查")} && new Promise(r => { let n = 0; const t = setInterval(() => { n++; if (document.body.innerText.match(/\\d+ms/) !== null || n > 30) { clearInterval(t); r(document.body.innerText.match(/\\d+ms/) !== null); } }, 300); })`,
    ));
    check("插件停用 → 已停用", await cdp.eval<boolean>(clickInSection("hello", "停用")));
    await cdp.waitFor(bodyContains("已停用"), "插件停用生效");
    check("插件再启用 → 已激活（plugins.json 落盘域）", await cdp.eval<boolean>(clickInSection("hello", "启用")));
    await cdp.waitFor(bodyContains("已激活"), "插件重新激活");
    check("MCP server 停用 → 未连接（断连 + 工具注销）", await cdp.eval<boolean>(clickInSection("fixture", "停用")));
    await cdp.waitFor(bodyContains("未连接"), "server 停用生效");
    check("MCP server 再启用 → 已连接（受理即返 + 事件活更）", await cdp.eval<boolean>(clickInSection("fixture", "启用")));
    await cdp.waitFor(bodyContains("已连接"), "server 重新连接", 20_000);
    check("返回主工作区", (await cdp.eval<boolean>(clickButtonExpr("← 返回"))) === true);

    // ---- B/C 会话 + 斜杠面板 + 用量 ----
    console.log("B 斜杠命令面板（skills.list/invoke 端到端）");
    check("新建会话（store 直设工作区）", await createSession(cdp, workspace));
    mock.setScript([textScript("走查回合：技能调用成功回复")]);
    await cdp.eval(`document.querySelector("textarea").focus()`);
    await cdp.insertText("/");
    await cdp.waitFor(`${bodyContains("/review")} && ${bodyContains("/test-gen")}`, "技能面板唤起（workspace 层清单）");
    await cdp.key("ArrowDown", "ArrowDown", 40);
    await cdp.key("Tab", "Tab", 9);
    const value = await cdp.eval<string>(`document.querySelector("textarea").value`);
    check("↑↓ + Tab 键盘补全（技能名补全带参数位）", value.startsWith("/review ") || value.startsWith("/test-gen ") || value.startsWith("/docs "), `实得 "${value}"`);
    await cdp.insertText("补充一条走查说明");
    await cdp.key("Enter", "Enter", 13);
    await cdp.waitFor(bodyContains("走查回合：技能调用成功回复"), "skills.invoke 端到端回合应答", 30_000);
    check("技能调用回合完成（展开在 server 侧的 turn 流）", true);
    await sleep(1000); // done → refreshUsage
    check("用量统计行（session.usage 投影）", await cdp.eval<boolean>(
      `(() => { const up = document.body.innerText.match(/↑[\\d.]+k?/); const down = document.body.innerText.match(/↓[\\d.]+k?/); return up !== null && down !== null; })()`,
    ));

    // ---- D 记忆管理器 ----
    console.log("D 记忆管理器（MR-4 走查项）");
    check("记忆管理器视图可达", (await cdp.eval<boolean>(clickButtonExpr("记忆管理器"))) === true);
    await cdp.waitFor(bodyContains("MEMORY.md"), "三栏视图渲染（记忆源 / 预览 / 草案与条目）");
    check("返回主工作区", (await cdp.eval<boolean>(clickButtonExpr("← 返回"))) === true);

    console.log(`—— 走查汇总：${String(passCount)} 过 / ${String(failCount)} 败 ——`);
    return failCount === 0 ? 0 : 1;
  } catch (err) {
    console.error("[walkthrough] 异常终止:", err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    cdp?.close();
    electron.kill();
    await sleep(800);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
    mock.close();
  }
}

async function createSession(cdp: Cdp, workspace: string): Promise<boolean> {
  // 直设工作区（store 走查 aid）：原生目录对话框路径已由 M2 场景 5 人工闭环，此处免 SendKeys 脆弱时序
  await cdp.eval(`window.__raincodeStore.getState().setWorkspace(${JSON.stringify(workspace)})`);
  const clicked = await cdp.eval<boolean>(
    `(() => { const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim() === "+ 新建会话"); if (!b) return false; b.click(); return true; })()`,
  );
  if (!clicked) return false;
  await sleep(1000);
  // 会话创建成功的旁证：发送区 textarea 可用（有活跃会话 + Provider 已配置）；失败时 dump store 状态
  const ok = await cdp.eval<boolean>(
    `(() => { const ta = document.querySelector("textarea"); return ta !== null && ta.disabled === false; })()`,
  );
  if (!ok) {
    const dump = await cdp.eval<string>(
      `JSON.stringify(window.__raincodeStore.getState(), (k, v) => k === "views" || k === "sessions" ? undefined : v)`,
    );
    console.log("[createSession 失败现场]", dump.slice(0, 800));
    const errStrip = await cdp.eval<string | null>(
      `(() => { const el = [...document.querySelectorAll("div")].find(d => d.className.includes("border-danger")); return el ? el.innerText.slice(0, 300) : null; })()`,
    );
    if (errStrip !== null) console.log("[错误横条]", errStrip);
  }
  return ok;
}

main().then((code) => process.exit(code));
