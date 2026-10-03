import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { useWeb } from "./state.js";
import "./index.css";

// 走查 aid（与桌面端 renderer main.tsx 同口径）：CDP 驱动的端到端走查读取 store 真实状态
(window as unknown as Record<string, unknown>)["__raincodeStore"] = useWeb;

void ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
