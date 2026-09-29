/**
 * Renderer 入口：挂载根组件，并启动 store bootstrap（连接 agent、拉取会话与 Provider 列表）。
 */
import { createRoot } from "react-dom/client";
import App from "./App.js";
import { useDesktop } from "./store.js";
import "./global.css";

const container = document.getElementById("root");
if (container === null) throw new Error("#root 容器不存在");
createRoot(container).render(<App />);
void useDesktop.getState().bootstrap();
