/**
 * CLI 事件消费（06-api-spec §3 数据面）：订阅先于 send（事件与 response 共用通道，
 * 06 §1.2「串行不阻塞」），text delta → stdout，reasoning delta → stderr（stdout 保持答案正文纯净）。
 * 供 run / chat 两个命令复用；Ink TUI 化时迁移为渲染组件（演进点见 index.ts）。
 */
import type { RpcClient } from "@novacode/rpc";
import type { DoneEventPayload, ErrorEventPayload, MessageDeltaEventPayload } from "@novacode/shared";

export interface StreamOutcome {
  done: DoneEventPayload;
}

/** 发送一条输入并等待 turn 终态（done 事件）；流式 delta 实时打印。 */
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
    // delta.type === "tool_call"：工具卡片占位随工具系统波次实现
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
    offError();
  }
}
