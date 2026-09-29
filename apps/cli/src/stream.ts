/**
 * CLI 事件消费（06-api-spec §3 数据面）：订阅先于 send（事件与 response 共用通道，
 * 06 §1.2「串行不阻塞」），text delta → stdout，reasoning delta → stderr（stdout 保持答案正文纯净）。
 * 工具过程人类可读输出：▸ 调用行（参数摘要）+ ✓/✗ 收束行（结果摘要，多行截断）。
 * 审批闭环（06 §3.2 B 组）：permission.requested → respond（auto-session / deny / interactive）
 * → permission.resolved 单行结果。供 run / chat 两个命令复用；Ink TUI 化时迁移为渲染组件。
 */
import type { RpcClient } from "@raincode/rpc";
import type {
  DoneEventPayload,
  ErrorEventPayload,
  MessageDeltaEventPayload,
  PermissionRequestedPayload,
  PermissionResolvedEventPayload,
  ToolCallCompletedEventPayload,
  ToolCallStartedEventPayload,
} from "@raincode/shared";

export interface StreamOutcome {
  done: DoneEventPayload;
}

/** 审批应答选择（chat 交互四级决策的最小终端形态，03 §5.2）。 */
export type ApprovalChoice = "allow" | "allow-session" | "allow-project" | "deny";

export type ApprovalMode =
  | { kind: "auto-session" }
  | { kind: "deny" }
  | { kind: "interactive"; prompt: (payload: PermissionRequestedPayload) => Promise<ApprovalChoice> };

/** 单行摘要上限（多行内容折叠 + 截断）。 */
const SUMMARY_MAX_CHARS = 120;

/**
 * 发送一条输入并等待 turn 终态（done 事件）；流式 delta、工具过程与审批闭环实时打印。
 * approval 缺省 = deny（非交互 fail-safe，02 §2.4：客户端不可达的 ask 按 deny 收敛）。
 */
export async function sendAndStream(
  client: RpcClient,
  sessionId: string,
  text: string,
  options: { approval?: ApprovalMode } = {},
): Promise<StreamOutcome> {
  const approval: ApprovalMode = options.approval ?? { kind: "deny" };
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
  const offRequested = client.onEvent("permission.requested", (payload) => {
    void handleApprovalRequest(client, payload as PermissionRequestedPayload, approval);
  });
  const offResolved = client.onEvent("permission.resolved", (payload) => {
    const event = payload as PermissionResolvedEventPayload;
    const mark = event.decision === "allow" ? "✓" : "✗";
    const seconds = `${(event.respondLatencyMs / 1000).toFixed(1)}s`;
    process.stdout.write(`  ${mark} 审批${event.decision === "allow" ? "通过" : "拒绝"}（${event.by}）· ${seconds}\n`);
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
    offRequested();
    offResolved();
    offError();
  }
}

/** permission.requested → permission.respond（fire-and-forget；错误仅告警，turn 侧按 deny 兜底）。 */
async function handleApprovalRequest(
  client: RpcClient,
  payload: PermissionRequestedPayload,
  mode: ApprovalMode,
): Promise<void> {
  try {
    if (mode.kind === "auto-session") {
      // --yes：自动 allow，等价临时 session 规则（不落库，本会话内同调用免审批）
      await client.call("permission.respond", {
        grantId: payload.grantId,
        decision: "allow",
        always: true,
        scope: "session",
      });
      return;
    }
    if (mode.kind === "deny") {
      process.stderr.write(
        `\n[permission] 请求执行 ${payload.toolName}（${payload.reason}）\n` +
          "[permission] 非交互模式已拒绝；使用 --yes 自动允许，或使用 chat 命令交互审批\n",
      );
      await client.call("permission.respond", { grantId: payload.grantId, decision: "deny" });
      return;
    }
    // interactive：展示审批单（工具、归一化输入、风险摘要），回调取得四级决策
    process.stdout.write(
      `\n⚠ 权限审批 ${payload.toolName} ${singleLine(JSON.stringify(payload.normalizedInput))}\n` +
        `  风险：${payload.metadata.riskLevel} · scope=${payload.metadata.sideEffectScope} · ${payload.reason}\n` +
        "  [1] 仅本次 [2] 本会话始终 [3] 项目始终 [4] 拒绝\n",
    );
    const choice = await mode.prompt(payload);
    const respond =
      choice === "allow"
        ? { grantId: payload.grantId, decision: "allow" as const }
        : choice === "allow-session"
          ? { grantId: payload.grantId, decision: "allow" as const, always: true, scope: "session" as const }
          : choice === "allow-project"
            ? { grantId: payload.grantId, decision: "allow" as const, always: true, scope: "project" as const }
            : { grantId: payload.grantId, decision: "deny" as const };
    await client.call("permission.respond", respond);
  } catch (reason: unknown) {
    const code = reason instanceof Error && "code" in reason ? String((reason as { code: unknown }).code) : "";
    process.stderr.write(`[permission] respond failed${code.length > 0 ? ` (${code})` : ""}\n`);
  }
}

/** 多行内容折叠为单行并截断（工具卡片摘要，03 UI 规范的最小终端形态）。 */
function singleLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > SUMMARY_MAX_CHARS ? `${collapsed.slice(0, SUMMARY_MAX_CHARS)}…` : collapsed;
}
