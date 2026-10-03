/**
 * raincode web：Web 会话工作台宿主（T3.8 / 06-api-spec §6.3 / UI-5）。
 *
 * - createAgentServiceNode(undefined, …) 延迟 attach → WebHost 逐连接绑定（authGate ws.auth）；
 * - 服务装配口径与 `raincode serve` 完全一致（DEFAULT_SYSTEM_PROMPT + skills/plugins 域）；
 * - token 解析：--token > RAINCODE_WEB_TOKEN > 自动生成（crypto 随机，打印到 stderr 一次——
 *   stderr 为诊断通道，stdout 不承载）；token 绝不落盘（04 §5.3）；
 * - delta 批量窗口可经 RAINCODE_WS_DELTA_WINDOW_MS 调大（广域网，06 §6.3 第 5 条）。
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createAgentServiceNode, resolveProviderConfig, WebHost } from "@raincode/server";
import type { ProviderCliArgs } from "@raincode/server";
import { DEFAULT_SYSTEM_PROMPT } from "../context.js";

export async function webCommand(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      // Provider 旗标与 serve/chat 同集（resolveProviderConfig 三来源之一）
      "base-url": { type: "string" },
      model: { type: "string" },
      "api-key": { type: "string" },
      name: { type: "string" },
      "provider-config": { type: "string" },
      // Web 宿主旗标
      port: { type: "string" },
      host: { type: "string" },
      token: { type: "string" },
      static: { type: "string" },
    },
  });
  const stringOrUndefined = (value: string | undefined): string | undefined =>
    value !== undefined && value.length > 0 ? value : undefined;
  const provider: ProviderCliArgs = {
    baseUrl: stringOrUndefined(values["base-url"]),
    model: stringOrUndefined(values.model),
    apiKey: stringOrUndefined(values["api-key"]),
    name: stringOrUndefined(values.name),
  };
  const resolved = resolveProviderConfig({
    args: provider,
    env: process.env,
    configPath: stringOrUndefined(values["provider-config"]),
  });
  const node = await createAgentServiceNode(undefined, {
    provider: resolved
      ? {
          name: resolved.name,
          baseURL: resolved.baseURL,
          model: resolved.model,
          apiKey: resolved.apiKey,
          maxContextTokens: resolved.maxContextTokens,
        }
      : null,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    skills: {}, // skills 域启用（T3.4）：与 CLI in-process 同语义（06 §2.9）
    plugins: {}, // plugins 域启用（T3.5）：与 CLI in-process 同语义（06 §2.10）
    mcp: {}, // mcp 域启用（T3.9 全量对齐补装配）：Web 宿主无装配期工作区，全局层 mcp.json 生效（06 §2.5）
    memory: {}, // memory 域启用（B2 缺陷修复：Web 宿主无装配期工作区，MEMORY.md 按会话工作区逐会话解析）（06 §2.6）
  });
  const tokenArg = stringOrUndefined(values.token);
  const token = tokenArg ?? process.env["RAINCODE_WEB_TOKEN"] ?? randomBytes(24).toString("hex");
  if (tokenArg === undefined && process.env["RAINCODE_WEB_TOKEN"] === undefined) {
    process.stderr.write(`[raincode/web] auth token (auto-generated): ${token}\n`);
  }
  const staticArg = stringOrUndefined(values.static) ?? process.env["RAINCODE_WEB_STATIC"];
  const staticDir =
    staticArg === undefined && existsSync(resolve("apps/web/dist")) ? resolve("apps/web/dist") : staticArg;
  const portArg = stringOrUndefined(values.port);
  const hostname = stringOrUndefined(values.host);
  const host = new WebHost({
    node,
    ...(portArg !== undefined && { port: Number(portArg) }),
    ...(hostname !== undefined && { hostname }),
    token,
    ...(staticDir !== undefined && { staticDir }),
    ...(process.env["RAINCODE_WS_DELTA_WINDOW_MS"] !== undefined && {
      deltaWindowMs: Number(process.env["RAINCODE_WS_DELTA_WINDOW_MS"]),
    }),
  });
  await host.start();
  process.stderr.write(
    `[raincode/web] rpc endpoint: ${host.url}/ws\n` +
      (staticDir !== undefined
        ? `[raincode/web] workbench: http://${hostname ?? "127.0.0.1"}:${host.port}/?token=<TOKEN>&ws=${host.url}/ws\n`
        : ""),
  );
  await new Promise<void>((resolvePromise) => {
    const done = (): void => {
      process.removeListener("SIGINT", done);
      process.removeListener("SIGTERM", done);
      resolvePromise();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
  process.stderr.write("[raincode/web] shutting down\n");
  await host.stop();
  await node.close();
  return 0;
}
