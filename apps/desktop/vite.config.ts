import { join } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** renderer 构建配置：src/renderer → dist/renderer（打包形态由 main loadFile 加载）。 */
export default defineConfig({
  root: join(__dirname, "src", "renderer"),
  plugins: [react()],
  base: "./",
  build: {
    outDir: join(__dirname, "dist", "renderer"),
    emptyOutDir: true,
    target: "chrome120",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
