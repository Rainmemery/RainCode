/**
 * novacode chat：readline 交互 REPL（最小命令集 /exit /sessions /resume <id>）。
 * 首条输入自动创建会话；/resume 切换活动会话后续输入续接该会话历史（session.resume 幂等）。
 * 审批：permission.requested 交互四级决策（[1]仅本次 [2]本会话始终 [3]项目始终 [4]拒绝），
 * 选项[2]写 session 规则、[3]写 project 规则、[4]respond deny（02 §6.2 审批闭环）。
 * TUI 演进点：本波按 04 ADR-02 不引入 Ink，流式打印即最小渲染形态。
 */
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { RpcCallError } from "@novacode/rpc";
import type { RpcClient } from "@novacode/rpc";
import type { SessionCreateResult, SessionListResult, SessionResumeResult } from "@novacode/shared";
import { parseCliArgs, startServiceNode, teardown } from "../context.js";
import { sendAndStream } from "../stream.js";
import type { ApprovalChoice } from "../stream.js";

export async function chatCommand(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  const workspaceRoot = resolve(parsed.workspace ?? process.cwd());
  const context = await startServiceNode(parsed);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // 审批专用 readline（与主 REPL 的 question 不同时挂起；审批发生在 sendAndStream 期间）
  const approvalRl = createInterface({ input: process.stdin, output: process.stdout });
  let currentSessionId: string | null = null;

  const promptApproval = async (): Promise<ApprovalChoice> => {
    for (;;) {
      const answer = (await approvalRl.question("choice> ")).trim();
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
      `NovaCode chat · workspace ${workspaceRoot}\n命令: /exit /sessions /resume <id>；其余输入直接发送\n`,
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
      if (trimmed.startsWith("/")) {
        process.stdout.write("unknown command; available: /exit /sessions /resume <id>\n");
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
    approvalRl.close();
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
