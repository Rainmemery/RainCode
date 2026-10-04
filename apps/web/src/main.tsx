import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { useWeb } from "./state.js";
import { applyTheme } from "./theme.js";
import "./index.css";

// 主题初始化（03 §3.2）：渲染前落 <html data-theme> 防闪色；「跟随系统」下监听系统切换实时重映射
applyTheme(useWeb.getState().theme);
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  applyTheme(useWeb.getState().theme);
});

// 走查 aid（与桌面端 renderer main.tsx 同口径）：CDP 驱动的端到端走查读取 store 真实状态
(window as unknown as Record<string, unknown>)["__raincodeStore"] = useWeb;

void ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
