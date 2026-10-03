import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Web 会话工作台构建（T3.8）：src → dist（raincode web --static 服务）。
 * dev 直连宿主 WS（跨端口无 CORS 限制）：?ws=ws://127.0.0.1:8787/ws&token=… 或运行时提示输入。
 */
export default defineConfig({
  root: "src",
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
