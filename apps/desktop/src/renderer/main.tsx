/**
 * Renderer 入口：挂载根组件，并启动 store bootstrap（连接 agent、拉取会话与 Provider 列表）。
 */
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { useDesktop } from "./store.js";
import { applyTheme } from "./theme.js";
import "./global.css";

// 主题初始化（03 §3.2）：渲染前落 <html data-theme> 防闪色；「跟随系统」下监听系统切换实时重映射
applyTheme(useDesktop.getState().theme);
window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
  applyTheme(useDesktop.getState().theme);
});

const container = document.getElementById("root");
if (container === null) throw new Error("#root 容器不存在");
createRoot(container).render(<App />);
void useDesktop.getState().bootstrap();
// 走查/调试 aid（CDP 可达；原生目录对话框路径已由 M2 场景 5 人工闭环，
// 回归走查经 store 直设工作区避免 SendKeys 时序脆弱——scripts/walkthrough-desktop.mts）
(window as unknown as Record<string, unknown>)["__raincodeStore"] = useDesktop;
