/**
 * novacode run "<prompt>"：非交互模式（06 §2.10 典型时序）。
 * create session → send（受理即返）→ 订阅事件流式打印 delta 到 stdout → done 后退出。
 * 审批：permission.requested 默认 deny 并打印说明；--yes 自动 allow（等价临时 session 规则）。
 * 退出码：0 = completed/cancelled；1 = failed；2 = 用法/配置错误。
 */
import { resolve } from "node:path";
import type { SessionCreateResult } from "@novacode/shared";
import { resolveProviderConfig } from "@novacode/server";
import { missingProviderError, parseCliArgs, startServiceNode, teardown } from "../context.js";
import { sendAndStream } from "../stream.js";

export async function runCommand(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  const prompt = parsed.positionals.join(" ").trim();
  if (prompt.length === 0) {
    process.stderr.write(
      'usage: novacode run "<prompt>" [--base-url <url>] [--model <model>] [--yes]\n',
    );
    return 2;
  }
  const provider = resolveProviderConfig({
    args: parsed.provider,
    env: process.env,
    configPath: parsed.providerConfig,
  });
  if (!provider) {
    return missingProviderError();
  }

  const workspaceRoot = resolve(parsed.workspace ?? process.cwd());
  const context = await startServiceNode(parsed);
  try {
    await context.client.call("system.ping", {});
    const created = await context.client.call<SessionCreateResult>("session.create", {
      workspaceRoot,
      title: parsed.title ?? prompt.slice(0, 60),
    });
    process.stderr.write(
      `session ${created.sessionId} · model ${provider.model} · provider source: ${provider.source}\n`,
    );
    const { done } = await sendAndStream(context.client, created.sessionId, prompt, {
      approval: parsed.yes === true ? { kind: "auto-session" } : { kind: "deny" },
    });
    return done.outcome === "failed" ? 1 : 0;
  } finally {
    await teardown(context);
  }
}
