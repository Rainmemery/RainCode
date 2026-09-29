/**
 * CLI 事件消费（06-api-spec §3 数据面）：订阅先于 send（事件与 response 共用通道，
 * 06 §1.2「串行不阻塞」），text delta → markdown 流式渲染后 stdout，reasoning delta → stderr
 * dim+斜体（stdout 保持答案正文纯净）。工具过程 ANSI 富文本（ADR-02 中间形态渲染层）：
 * ▸ glyph 调用行（参数摘要）+ ✓/✗ 收束行（结果摘要，多行截断）；三态着色（MiMo print 模式
 * 调研结论）：运行中正常色 / 完成 dim / 待审批 warn；被拒或取消的收束行用删除线表达
 * 「已作废」而非红色报警（判别字段 tool_call.completed.error.code = TOOL_PERMISSION_DENIED /
 * TOOL_CANCELLED）。审批闭环（06 §3.2 B 组）：permission.requested → respond
 * （auto-session / deny / interactive）→ permission.resolved 单行结果。
 * 供 run / chat 两个命令复用；Ink TUI 化时迁移为渲染组件。
 */
import { TOOL_ERROR_CODES } from "@raincode/shared";
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
import { formatDuration } from "./ui/format.js";
import { StreamMarkdownRenderer } from "./ui/markdown.js";
import { err, glyphFor, out, toolStyleKeyFor } from "./ui/theme.js";

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
  const md = new StreamMarkdownRenderer(process.stdout, out);
  let resolveOutcome!: (done: DoneEventPayload) => void;
  const donePromise = new Promise<DoneEventPayload>((resolvePromise) => {
    resolveOutcome = resolvePromise;
  });

  const offDone = client.onEvent("done", (payload) => resolveOutcome(payload as DoneEventPayload));
  const offDelta = client.onEvent("message.delta", (payload) => {
    const event = payload as MessageDeltaEventPayload;
    if (event.delta.type === "text") {
      md.feed(event.delta.text);
    } else if (event.delta.type === "reasoning") {
      // 思考块：stderr 通道 dim+斜体（stdout 纯净原则不动）；逐 delta 包裹，SGR 跨换行持续
      process.stderr.write(err.italic(err.dim(event.delta.text)));
    }
    // delta.type === "tool_call"：流式占位片段已由 tool_call.started 表达，不重复打印
  });
  const offToolStarted = client.onEvent("tool_call.started", (payload) => {
    const event = payload as ToolCallStartedEventPayload;
    md.end(); // 消息正文 → 工具行边界：冲刷 markdown 半行缓冲并复位围栏
    const style = out[toolStyleKeyFor(event.toolName)];
    process.stdout.write(
      `\n${style(`▸ ${glyphFor(event.toolName)} ${event.toolName}`)} ${out.dim(singleLine(JSON.stringify(event.input)))}\n`,
    );
  });
  const offToolCompleted = client.onEvent("tool_call.completed", (payload) => {
    const event = payload as ToolCallCompletedEventPayload;
    const duration = out.dim(` · ${formatDuration(event.durationMs)}`);
    if (!event.isError) {
      const preview = event.contentPreview ?? "";
      const body = preview.length > 0 ? ` ${out.dim(singleLine(preview))}` : "";
      process.stdout.write(`  ${out.ok("✓")}${body}${duration}\n`);
      return;
    }
    const reason = event.error !== undefined ? `${event.error.code} ${event.error.message}` : "failed";
    // 拒绝/取消 → 删除线表达「已作废」（非红色报警）；其余执行层错误 → danger
    const isVoid =
      event.error?.code === TOOL_ERROR_CODES.PERMISSION_DENIED ||
      event.error?.code === TOOL_ERROR_CODES.CANCELLED;
    if (isVoid) {
      process.stdout.write(`  ${out.strike(out.dim(`✗ ${reason}${duration}`))}\n`);
    } else {
      process.stdout.write(`  ${out.danger(`✗ ${reason}`)}${duration}\n`);
    }
  });
  const offRequested = client.onEvent("permission.requested", (payload) => {
    md.end(); // 审批单插在流式正文中间：先冲刷半行
    void handleApprovalRequest(client, payload as PermissionRequestedPayload, approval);
  });
  const offResolved = client.onEvent("permission.resolved", (payload) => {
    const event = payload as PermissionResolvedEventPayload;
    const allowed = event.decision === "allow";
    const mark = allowed ? out.ok("✓") : out.danger("✗");
    const text = out.dim(`审批${allowed ? "通过" : "拒绝"}（${event.by}）· ${formatDuration(event.respondLatencyMs)}`);
    process.stdout.write(`  ${mark} ${text}\n`);
  });
  const offError = client.onEvent("error", (payload) => {
    const event = payload as ErrorEventPayload;
    md.end(); // 错误行走 stderr：先冲刷 stdout 半行，避免终端上拼接在未收口正文后
    process.stderr.write(`\n${err.danger(`[${event.code}] ${event.message}`)}\n`);
  });

  try {
    await client.call("session.send", { sessionId, input: { text } });
    const done = await donePromise;
    md.end();
    process.stdout.write("\n");
    if (done.outcome === "failed") {
      const at = done.at !== undefined ? ` at ${done.at}` : "";
      process.stderr.write(`${err.danger("turn failed")}${err.dim(at)}\n`);
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
      // 非交互拒绝：⚠ warn 标记 + dim 说明（fail-safe 语义不变）
      process.stderr.write(
        `\n${err.warn("⚠ 权限审批")} ${payload.toolName}（${payload.reason}）\n` +
          `${err.dim("[permission] 非交互模式已拒绝；使用 --yes 自动允许，或使用 chat 命令交互审批")}\n`,
      );
      await client.call("permission.respond", { grantId: payload.grantId, decision: "deny" });
      return;
    }
    // interactive：展示审批单（工具、归一化输入、风险摘要），回调取得四级决策
    process.stdout.write(
      `\n${out.warn(`⚠ 权限审批 ${payload.toolName}`)} ${out.dim(singleLine(JSON.stringify(payload.normalizedInput)))}\n` +
        `  ${out.dim(`风险：${payload.metadata.riskLevel} · scope=${payload.metadata.sideEffectScope} · ${payload.reason}`)}\n` +
        `${out.warn("  [1] 仅本次 [2] 本会话始终 [3] 项目始终 [4] 拒绝")}\n`,
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
