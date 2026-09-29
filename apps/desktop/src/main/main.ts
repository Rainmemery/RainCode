/**
 * Electron main（04-architecture §3.2 泳道 1）：窗口与原生能力、agent 子进程守护、帧转发。
 * 铁律：main 不承载业务状态——不解析业务帧、不保存会话/审批事实，只做字符串级转发。
 */
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { AgentHost } from "./agent-host.js";

type AgentMode = "dev" | "packaged";

function repoRoot(): string {
  // dist-electron/main/main.js → 仓库根（dev）；打包形态不使用该路径
  return join(__dirname, "..", "..");
}

function agentSpawnPlan(): { mode: AgentMode; command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (app.isPackaged) {
    // 打包形态：electron.exe 以 ELECTRON_RUN_AS_NODE 运行 bundle 后的 headless 入口；
    // 迁移脚本与版本号随包注入（bundle 内 import.meta.url shim 不可用，storage/server 约定 env 口径）
    return {
      mode: "packaged",
      command: process.execPath,
      args: [join(__dirname, "..", "agent", "entry.cjs")],
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        RAINCODE_MIGRATIONS_DIR: join(__dirname, "..", "agent", "migrations"),
        RAINCODE_APP_VERSION: app.getVersion(),
      },
      cwd: join(__dirname, "..", ".."),
    };
  }
  // dev 形态：与 CLI 完全同一入口（raincode serve），tsx 直跑
  const node = process.env["RAINCODE_DESKTOP_NODE"] ?? "node";
  return {
    mode: "dev",
    command: node,
    args: ["--import", "tsx", join(repoRoot(), "apps", "cli", "src", "index.ts"), "serve"],
    env,
    cwd: repoRoot(),
  };
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#0D1219",
    title: "RainCode",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  const devUrl = process.env["RAINCODE_DESKTOP_VITE_URL"];
  if (devUrl !== undefined && devUrl.length > 0) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, "..", "..", "dist", "renderer", "index.html"));
  }
  return win;
}

async function main(): Promise<void> {
  await app.whenReady();
  const win = createWindow();
  const plan = agentSpawnPlan();
  const host = new AgentHost({
    command: plan.command,
    args: plan.args,
    env: plan.env,
    cwd: plan.cwd,
    onDiagnostic: (message, err) => console.error(`[raincode/desktop] ${message}`, err ?? ""),
  });

  // 帧转发（main 只做字节级转发，04 §3.2）：renderer → agent stdin；agent stdout → renderer
  ipcMain.on("agent:frame:send", (_event, line: unknown) => {
    if (typeof line !== "string") return;
    try {
      host.sendLine(line);
    } catch (err) {
      console.error("[raincode/desktop] frame dropped (agent not running)", err);
    }
  });
  host.onFrameLine((line) => {
    if (!win.isDestroyed()) win.webContents.send("agent:frame", line);
  });
  host.onExit((info) => {
    if (!win.isDestroyed()) {
      win.webContents.send("agent:exit", { code: info.code, signal: info.signal, intentional: info.intentional });
    }
  });

  // 原生能力：工作区目录选择（03 §6.1 左侧栏工作区切换器）
  ipcMain.handle("agent:pick-workspace", async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory", "createDirectory"],
      title: "选择工作区目录",
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
  });
  ipcMain.handle("agent:meta", () => ({ mode: plan.mode }));

  win.on("closed", () => {
    void host.stop();
  });
  host.start();
}

void app.whenReady().then(() => main());
app.on("window-all-closed", () => {
  app.quit();
});
