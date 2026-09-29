/**
 * raincode chat：readline 交互 REPL（最小命令集 /exit /sessions /resume <id> /mode /archive /providers）。
 * 首条输入自动创建会话；/resume 切换活动会话后续输入续接该会话历史（session.resume 幂等）。
 * 审批：permission.requested 交互四级决策（[1]仅本次 [2]本会话始终 [3]项目始终 [4]拒绝），
 * 选项[2]写 session 规则、[3]写 project 规则、[4]respond deny（02 §6.2 审批闭环）。
 * TUI 演进点：本波按 04 ADR-02 不引入 Ink，流式打印即最小渲染形态。
 */
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { RpcCallError } from "@raincode/rpc";
import type { RpcClient } from "@raincode/rpc";
import type {
  CollaborationMode,
  ConfigProvidersListResult,
  SessionCompactResult,
  SessionCreateResult,
  SessionListResult,
  SessionResumeResult,
} from "@raincode/shared";
import { parseCliArgs, startServiceNode, teardown } from "../context.js";
import { sendAndStream } from "../stream.js";
import type { ApprovalChoice } from "../stream.js";

const MODES: readonly CollaborationMode[] = ["normal", "plan", "auto-accept"];

export async function chatCommand(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  const workspaceRoot = resolve(parsed.workspace ?? process.cwd());
  const context = await startServiceNode(parsed);
  // 同一 stdin 只允许挂一个 terminal=true 的 readline：interface 构造时常驻监听 keypress，
  // 双 interface 会导致每个按键被消费两次（双回显 eexxiitt）。
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let currentSessionId: string | null = null;

  const promptApproval = async (): Promise<ApprovalChoice> => {
    for (;;) {
      // 复用主 rl：审批发生在 sendAndStream 期间，主 question 已 resolve，不存在并发挂起。
      const answer = (await rl.question("choice> ")).trim();
      if (answer === "1") return "allow";
      if (answer === "2") return "allow-session";
      if (answer === "3") return "allow-project";
      if (answer === "4") return "deny";
      process.stdout.write("无效选项；请输入 1/2/3/4\n");
    }
  };

  try {
    await context.client.call("system.ping", {});
    process.stdout.write(
      `RainCode chat · workspace ${workspaceRoot}\n` +
        "命令: /exit /sessions /resume <id> /mode <normal|plan|auto-accept> /archive [--force] /compact /providers\n" +
        "其余输入直接发送\n",
    );

    for (;;) {
      // 显式注解：打断「question 模板引用 currentSessionId ↔ 循环内回填 currentSessionId」的推断环
      const line: string = await rl.question(currentSessionId === null ? "you> " : `you·${currentSessionId.slice(-6)}> `);
      const trimmed: string = line.trim();
      if (trimmed.length === 0) continue;

      if (trimmed === "/exit" || trimmed === "/quit") {
        break;
      }
      if (trimmed === "/sessions") {
        await printSessions(context.client);
        continue;
      }
      if (trimmed.startsWith("/resume")) {
        const id: string | undefined = trimmed.split(/\s+/)[1];
        if (id === undefined || id.length === 0) {
          process.stdout.write("usage: /resume <sessionId>\n");
          continue;
        }
        try {
          const result = await context.client.call<SessionResumeResult>("session.resume", { sessionId: id });
          currentSessionId = result.sessionId;
          process.stdout.write(
            `resumed ${result.sessionId} · phase ${result.snapshot.phase} · lastSeq ${result.snapshot.lastSeq}\n`,
          );
        } catch (reason: unknown) {
          printRpcError(reason);
        }
        continue;
      }
      if (trimmed.startsWith("/mode")) {
        const arg = trimmed.slice("/mode".length).trim();
        if (currentSessionId === null) {
          process.stdout.write("no active session\n");
          continue;
        }
        if (!MODES.includes(arg as CollaborationMode)) {
          process.stdout.write(`usage: /mode <${MODES.join("|")}>\n`);
          continue;
        }
        try {
          await context.client.call("session.setMode", { sessionId: currentSessionId, mode: arg });
          process.stdout.write(`mode → ${arg}\n`);
        } catch (reason: unknown) {
          printRpcError(reason);
        }
        continue;
      }
      if (trimmed.startsWith("/archive")) {
        if (currentSessionId === null) {
          process.stdout.write("no active session\n");
          continue;
        }
        const force = /(--force|\bforce\b)/.test(trimmed);
        try {
          await context.client.call("session.archive", {
            sessionId: currentSessionId,
            ...(force && { force: true }),
          });
          process.stdout.write(`archived ${currentSessionId}\n`);
          currentSessionId = null;
        } catch (reason: unknown) {
          printRpcError(reason);
        }
        continue;
      }
      if (trimmed.startsWith("/compact")) {
        if (currentSessionId === null) {
          process.stdout.write("no active session\n");
          continue;
        }
        try {
          const result = await context.client.call<SessionCompactResult>("session.compact", {
            sessionId: currentSessionId,
          });
          process.stdout.write(
            `compaction ${result.compactionId} → ${result.alreadyRunning ? "already running" : "scheduled"} · epoch ${String(result.epoch)}\n`,
          );
        } catch (reason: unknown) {
          printRpcError(reason);
        }
        continue;
      }
      if (trimmed === "/providers") {
        try {
          const result = await context.client.call<ConfigProvidersListResult>("config.providers.list", {});
          if (result.providers.length === 0) {
            process.stdout.write("(no providers; use config.providers.add)\n");
          }
          for (const p of result.providers) {
            const active = p.id === result.activeProviderId ? "*" : " ";
            const key = p.apiKeyConfigured ? "key:configured" : "key:missing";
            process.stdout.write(`${active} ${p.id}  ${p.name}  ${p.model}  ${key}\n`);
          }
        } catch (reason: unknown) {
          printRpcError(reason);
        }
        continue;
      }
      if (trimmed.startsWith("/")) {
        process.stdout.write(
          "unknown command; available: /exit /sessions /resume <id> /mode <mode> /archive [--force] /compact /providers\n",
        );
        continue;
      }

      try {
        if (currentSessionId === null) {
          const created = await context.client.call<SessionCreateResult>("session.create", {
            workspaceRoot,
            title: trimmed.slice(0, 60),
          });
          currentSessionId = created.sessionId;
          process.stdout.write(`[session ${created.sessionId}]\n`);
        }
        await sendAndStream(context.client, currentSessionId, trimmed, {
          approval: { kind: "interactive", prompt: promptApproval },
        });
      } catch (reason: unknown) {
        printRpcError(reason);
      }
    }
    return 0;
  } finally {
    rl.close();
    await teardown(context);
  }
}

async function printSessions(client: RpcClient): Promise<void> {
  const result = await client.call<SessionListResult>("session.list", {});
  if (result.items.length === 0) {
    process.stdout.write("(no sessions)\n");
    return;
  }
  for (const item of result.items) {
    const title = item.title.length > 0 ? item.title : "(untitled)";
    const time = new Date(item.lastActiveAt).toISOString().replace("T", " ").slice(0, 19);
    process.stdout.write(`${item.id}  ${item.state.padEnd(9)} ${time}  ${title}\n`);
  }
}

function printRpcError(reason: unknown): void {
  if (reason instanceof RpcCallError) {
    process.stdout.write(`[error:${reason.code}] ${reason.message}\n`);
    return;
  }
  process.stdout.write(`[error] ${reason instanceof Error ? reason.message : String(reason)}\n`);
}
