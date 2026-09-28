/**
 * AuditLogger：三态判定审计（05-database §3.8 permission_decisions）。
 * 每次终判写一条：时间、sessionId、toolName、归一化输入摘要（脱敏）、decision、matchedBy、
 * grantId、respondLatencyMs（02 §6.3 decisions 记录清单）。
 * 写入失败不阻塞判定（02 §6.4）：仅诊断告警；本地重试队列随后续波次补齐。
 */
import type { CollaborationMode, MatchedBy, PermissionDecision } from "@novacode/shared";
import type { DecisionsRepo } from "@novacode/storage";

/** 输入摘要截断上限（脱敏 + 截断，任务交付「参数截断+apiKey 模式抹除」）。 */
const INPUT_DIGEST_MAX_CHARS = 512;

/** 秘密字段名（JSON key / KEY=value 两种形态）。 */
const SECRET_FIELD = /(api[_-]?key|apikey|authorization|token|secret|password|credential)/i;

/** 通用密钥字面量形态（sk- 开头的 OpenAI 风格 key 等）。 */
const SECRET_LITERAL = /\b(sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})/g;

export interface AuditRecordInput {
  ts?: number;
  sessionId: string;
  workspaceId: string;
  toolName: string;
  mode: CollaborationMode;
  decision: PermissionDecision;
  matchedBy: MatchedBy;
  ruleId?: string | null;
  grantId?: string | null;
  reason?: string;
  /** 原始归一化输入（本层负责脱敏与截断）。 */
  input?: unknown;
  respondLatencyMs?: number | null;
  detailJson?: string | null;
}

export class AuditLogger {
  constructor(
    private readonly repo: DecisionsRepo,
    private readonly onDiagnostic?: (message: string, err?: unknown) => void,
  ) {}

  /** 追加一条审计；失败仅告警（判定照常生效，02 §6.4）。 */
  async record(input: AuditRecordInput): Promise<void> {
    try {
      await this.repo.append({
        ...(input.ts !== undefined && { ts: input.ts }),
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        toolName: input.toolName,
        mode: input.mode,
        decision: input.decision,
        matchedBy: input.matchedBy,
        ruleId: input.ruleId ?? null,
        grantId: input.grantId ?? null,
        reason: input.reason ?? "",
        inputDigest: digestOf(input.input),
        respondLatencyMs: input.respondLatencyMs ?? null,
        detailJson: input.detailJson ?? null,
      });
    } catch (err: unknown) {
      this.onDiagnostic?.("permission audit write failed (decision unaffected)", err);
    }
  }

  /** 审批单 inputSnapshot 用（approvals 表；同一脱敏管线）。 */
  static snapshot(input: unknown): string {
    return digestOf(input);
  }
}

/** 序列化 → 秘密抹除 → 截断。 */
function digestOf(input: unknown): string {
  if (input === undefined || input === null) return "";
  let text: string;
  try {
    text = typeof input === "string" ? input : JSON.stringify(input);
  } catch {
    text = String(input);
  }
  text = redact(text);
  if (text.length > INPUT_DIGEST_MAX_CHARS) {
    text = `${text.slice(0, INPUT_DIGEST_MAX_CHARS)}…(truncated)`;
  }
  return text;
}

/** 事件 payload 的 normalizedInput 脱敏（保持 JSON 结构可解析，失败回退脱敏字符串）。 */
export function sanitizeValue(input: unknown): unknown {
  if (input === undefined || input === null) return input;
  const text = redact(JSON.stringify(input) ?? String(input));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function redact(text: string): string {
  let result = text.replace(SECRET_LITERAL, "[REDACTED]");
  // JSON 形态："apiKey": "value" / "apiKey":"value"
  result = result.replace(
    /("[^"]*"[ ]*:[ ]*)("[^"]*"|[^,}\]]+)/g,
    (match, prefix: string, value: string) => {
      const keyMatch = /"([^"]+)"/.exec(prefix);
      if (keyMatch !== null && SECRET_FIELD.test(keyMatch[1]!)) {
        return `${prefix}"[REDACTED]"`;
      }
      void value;
      return match;
    },
  );
  // KEY=value 形态（bash 命令串内 export API_KEY=xxx 等）
  result = result.replace(
    /([A-Za-z0-9_-]*(?:api[_-]?key|apikey|token|secret|password|credential)[A-Za-z0-9_-]*)\s*=\s*("[^"]*"|'[^']*'|[^\s&"'']+)/gi,
    (match, key: string) => {
      return SECRET_FIELD.test(key) ? `${key}=[REDACTED]` : match;
    },
  );
  return result;
}
