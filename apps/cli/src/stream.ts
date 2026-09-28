/**
 * CLI 事件消费（06-api-spec §3 数据面）：订阅先于 send（事件与 response 共用通道，
 * 06 §1.2「串行不阻塞」），text delta → stdout，reasoning delta → stderr（stdout 保持答案正文纯净）。
 * 工具过程人类可读输出：▸ 调用行（参数摘要）+ ✓/✗ 收束行（结果摘要，多行截断）。
 * 供 run / chat 两个命令复用；Ink TUI 化时迁移为渲染组件（演进点见 index.ts）。
 */
import type { RpcClient } from "@novacode/rpc";
import type {
  DoneEventPayload,
  ErrorEventPayload,
  MessageDeltaEventPayload,
  ToolCallCompletedEventPayload,
  ToolCallStartedEventPayload,
} from "@novacode/shared";

export interface StreamOutcome {
  done: DoneEventPayload;
}

/** 单行摘要上限（多行内容折叠 + 截断）。 */
const SUMMARY_MAX_CHARS = 120;

/** 发送一条输入并等待 turn 终态（done 事件）；流式 delta 与工具过程实时打印。 */
export async function sendAndStream(client: RpcClient, sessionId: string, text: string): Promise<StreamOutcome> {
  let resolveOutcome!: (done: DoneEventPayload) => void;
  const donePromise = new Promise<DoneEventPayload>((resolvePromise) => {
    resolveOutcome = resolvePromise;
  });

  const offDone = client.onEvent("done", (payload) => resolveOutcome(payload as DoneEventPayload));
  const offDelta = client.onEvent("message.delta", (payload) => {
    const event = payload as MessageDeltaEventPayload;
    if (event.delta.type === "text") {
      process.stdout.write(event.delta.text);
    } else if (event.delta.type === "reasoning") {
      process.stderr.write(event.delta.text);
    }
    // delta.type === "tool_call"：流式占位片段已由 tool_call.started 表达，不重复打印
  });
  const offToolStarted = client.onEvent("tool_call.started", (payload) => {
    const event = payload as ToolCallStartedEventPayload;
    process.stdout.write(`\n▸ ${event.toolName} ${singleLine(JSON.stringify(event.input))}\n`);
  });
  const offToolCompleted = client.onEvent("tool_call.completed", (payload) => {
    const event = payload as ToolCallCompletedEventPayload;
    const seconds = `${(event.durationMs / 1000).toFixed(1)}s`;
    if (event.isError) {
      const reason = event.error !== undefined ? `${event.error.code} ${event.error.message}` : "failed";
      process.stdout.write(`  ✗ ${reason} · ${seconds}\n`);
    } else {
      const preview = event.contentPreview ?? "";
      process.stdout.write(`  ✓ ${preview.length > 0 ? `${singleLine(preview)} · ` : ""}${seconds}\n`);
    }
  });
  const offError = client.onEvent("error", (payload) => {
    const event = payload as ErrorEventPayload;
    process.stderr.write(`\n[${event.code}] ${event.message}\n`);
  });

  try {
    await client.call("session.send", { sessionId, input: { text } });
    const done = await donePromise;
    process.stdout.write("\n");
    if (done.outcome === "failed") {
      process.stderr.write(`turn failed${done.at !== undefined ? ` at ${done.at}` : ""}\n`);
    }
    return { done };
  } finally {
    offDone();
    offDelta();
    offToolStarted();
    offToolCompleted();
    offError();
  }
}

/** 多行内容折叠为单行并截断（工具卡片摘要，03 UI 规范的最小终端形态）。 */
function singleLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > SUMMARY_MAX_CHARS ? `${collapsed.slice(0, SUMMARY_MAX_CHARS)}…` : collapsed;
}
