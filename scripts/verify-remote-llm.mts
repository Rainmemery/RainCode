/**
 * 可选真实连通性验证（wave2）：读取 config/test-provider.local.json（已被 .gitignore 隔离，
 * 不入库），发起一次真实 OpenAI 兼容流式调用。
 * 仅打印 delta 文本与 usage；apiKey 与请求头绝不打印。
 * 运行：tsx scripts/verify-remote-llm.mts
 * 说明：网络不通 / 服务端错误时以非零码退出并如实报告，不影响 verify-wave2 的本地结论。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LlmClient } from "../packages/llm/src/index.ts";

interface RemoteProviderConfig {
  name?: string;
  baseURL: string;
  apiKey: string;
  model: string;
  protocol?: string;
  prompt?: string;
  maxContextTokens?: number;
  timeoutMs?: number;
}

const configPath = join(fileURLToPath(new URL("../config/test-provider.local.json", import.meta.url)));

async function main(): Promise<void> {
  const config = JSON.parse(readFileSync(configPath, "utf8")) as RemoteProviderConfig;
  if (
    typeof config.baseURL !== "string" ||
    typeof config.model !== "string" ||
    typeof config.apiKey !== "string" ||
    config.baseURL.length === 0 ||
    config.model.length === 0
  ) {
    throw new Error("config/test-provider.local.json 缺少 baseURL / model / apiKey 字段");
  }
  console.log(
    `remote provider: ${config.name ?? "unnamed"}  model: ${config.model}  protocol: ${config.protocol ?? "openai-compatible"}`,
  );
  console.log("（apiKey 已加载，不打印）");

  const client = new LlmClient({
    provider: {
      name: config.name ?? "remote",
      baseURL: config.baseURL,
      model: config.model,
      maxContextTokens: config.maxContextTokens ?? 8192,
      apiKeyRef: null,
    },
    apiKey: config.apiKey,
  });

  const timeoutMs = config.timeoutMs ?? 30_000;
  const startedAt = Date.now();
  let printedText = false;
  const result = await client.streamChat({
    messages: [{ role: "user", content: config.prompt ?? "用一句话介绍你自己。" }],
    includeUsage: true,
    signal: AbortSignal.timeout(timeoutMs),
    onEvent: (event) => {
      if (event.type === "stream.opened") {
        console.log("[stream.opened]");
      } else if (event.type === "delta.text") {
        process.stdout.write(event.text);
        printedText = true;
      } else if (event.type === "finish") {
        if (printedText) {
          process.stdout.write("\n");
        }
        console.log(`[finish: ${event.finishReason}]`);
      } else if (event.type === "usage") {
        const cached = event.usage.cachedTokens !== undefined ? ` cached=${event.usage.cachedTokens}` : "";
        console.log(`[usage] input=${event.usage.inputTokens} output=${event.usage.outputTokens}${cached}`);
      } else if (event.type === "done") {
        console.log("[DONE]");
      }
    },
  });
  const usageText = result.usage
    ? `in=${result.usage.inputTokens}/out=${result.usage.outputTokens}`
    : "n/a";
  console.log(`finishReason=${result.finishReason} usage=${usageText} 耗时=${Date.now() - startedAt}ms`);
  console.log("OK — 远端流式调用成功");
}

main().catch((reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  console.error(`FAILED（网络不通或服务端错误，均属如实报告，不影响本地 wave2 结论）: ${message}`);
  process.exitCode = 1;
});
