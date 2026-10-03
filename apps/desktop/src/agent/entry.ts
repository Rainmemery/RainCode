/**
 * 打包形态 agent 子进程入口（04 §3.2 泳道 3）：esbuild bundle 后经
 * electron.exe + ELECTRON_RUN_AS_NODE 运行，stdin/stdout 承载 JSONL 协议帧。
 * 与 CLI `raincode serve` 完全同一组装点（createAgentServiceNode，零第二引擎）。
 */
import { StdioTransport } from "@raincode/rpc";
import { createAgentServiceNode, resolveProviderConfig } from "@raincode/server";

const SYSTEM_PROMPT =
  "You are RainCode, a coding agent working inside the user's workspace. Answer concisely.";

// CJS bundle 不支持 top-level await，装配收拢进异步 IIFE
void (async (): Promise<void> => {
  const resolved = resolveProviderConfig({
    args: { baseUrl: undefined, model: undefined, apiKey: undefined, name: undefined },
    env: process.env,
    configPath: process.env["RAINCODE_PROVIDER_CONFIG"],
  });
  const transport = new StdioTransport({ input: process.stdin, output: process.stdout });
  const node = await createAgentServiceNode(transport, {
    provider: resolved
      ? {
          name: resolved.name,
          baseURL: resolved.baseURL,
          model: resolved.model,
          apiKey: resolved.apiKey,
          maxContextTokens: resolved.maxContextTokens,
        }
      : null,
    systemPrompt: SYSTEM_PROMPT,
    // 域装配与 CLI host.ts 同构（apps 互不依赖，改此处时同步 host.ts；T3.9 对齐补齐 skills/plugins/mcp）
    skills: {},
    plugins: {},
    mcp: {}, // 无装配期工作区，全局层 mcp.json 生效（06 §2.5）
    memory: {}, // memory 域启用（B2 缺陷修复：与 host.ts 同构；无装配期工作区，MEMORY.md 按会话工作区逐会话解析）（06 §2.6）
  });
  process.stdin.on("end", () => {
    void node.close().then(() => process.exit(0));
  });
})();
