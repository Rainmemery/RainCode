/**
 * 会话记忆抽取编排（02 §7.2 第二层；05 §5.4 末行幂等约定）。
 * 模型调用经 MemoryExtractPort 端口注入（04 §2.2：memory 不可直接依赖 llm），
 * server 下阶段以 LLM 实现；null = 抽取失败，跳过不落盘（02 §7.4）。
 *
 * 去重/矛盾规则（02 §7.4）：
 * - 归一化（trim + 空白折叠）后与已有 active 条目完全相等 → touch 旧条目，不新插；
 * - 同 workspace 同 kind 的 active 条目归一化后互含（一方含另一方）：
 *   新条目 confidence ≥ 全部相关旧者 → 插入新条目并 supersede 全部旧者（superseded_by=新 id）；
 *   存在 confidence 更高的旧者 → 丢弃新条目、touch 最高置信旧者。
 */
import { memoryKindSchema } from "@raincode/shared";
import type { MemoryEntry, MemoryKind } from "@raincode/shared";
import type { MemoryRepo, SettingsRepo } from "@raincode/storage";
import type { MessageRecord } from "@raincode/shared";

/** 抽取幂等键前缀（settings 键 `memory.extracted.<sessionId>`，05 §5.4 末行）。 */
export const MEMORY_EXTRACT_IDEMPOTENCY_PREFIX = "memory.extracted.";

/** content 上限（02 §7.3 单句要点 ≤200 字；05 §3.9 CHECK 兜底）。 */
const MAX_CONTENT_LENGTH = 200;

/** 素材文本化尾部截断上限（字符，任务约定最近 8000 字符）。 */
const MAX_TRANSCRIPT_CHARS = 8000;

/** confidence 抽取缺省（任务约定 0.8；<0.6 仍落盘但召回默认集不含，02 §7.4）。 */
const DEFAULT_EXTRACT_CONFIDENCE = 0.8;

/** 抽取候选（LLM 产出，逐条校验后才可信）。 */
export interface ExtractedCandidate {
  kind: MemoryKind;
  content: string;
  refs?: string[];
  confidence?: number;
}

/**
 * 抽取端口（server 下阶段用 LLM 实现）：
 * 返回 null 表示抽取失败（模型/网络），本次跳过且不写幂等键，下个周期可再抽（02 §7.4）。
 */
export interface MemoryExtractPort {
  extract(input: {
    transcript: string;
    source: "session-end" | "compact";
    workspaceId: string;
  }): Promise<ExtractedCandidate[] | null>;
}

/** 归一化：trim + 空白折叠（去重/互含比较与入库统一口径）。 */
export function normalizeMemoryContent(content: string): string {
  return content.trim().replace(/\s+/g, " ");
}

/** 按 code point 截断到 200 字（DDL length() 按字符计数）。 */
function truncateContent(content: string): string {
  return Array.from(content)
    .slice(0, MAX_CONTENT_LENGTH)
    .join("");
}

/** 素材文本化：`[i] role: text`，content 为 ContentBlock 时取文本块拼接；尾部截断。 */
function materializeTranscript(transcript: MessageRecord[]): string {
  const lines = transcript.map((msg, i) => {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : msg.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    return `[${i}] ${msg.role}: ${text}`;
  });
  const full = lines.join("\n");
  return full.length > MAX_TRANSCRIPT_CHARS ? full.slice(-MAX_TRANSCRIPT_CHARS) : full;
}

export interface ExtractFromSessionDeps {
  repo: MemoryRepo;
  settings: SettingsRepo;
  extractPort: MemoryExtractPort;
}

export interface ExtractFromSessionInput {
  sessionId: string;
  workspaceId: string;
  transcript: MessageRecord[];
  source: "session-end" | "compact";
}

/**
 * 会话结束 / compact 时抽取要点并落盘（02 §7.3 extractFromSession）。
 * 幂等：settings 键已存在 → 返回 []（同会话只抽一次）；抽取失败不写幂等键。
 * 返回本次新落盘条目（去重 touch 与丢弃不计入）。
 */
export async function extractFromSession(
  deps: ExtractFromSessionDeps,
  input: ExtractFromSessionInput,
): Promise<MemoryEntry[]> {
  const idempotencyKey = `${MEMORY_EXTRACT_IDEMPOTENCY_PREFIX}${input.sessionId}`;
  if ((await deps.settings.get(idempotencyKey)) !== null) {
    return [];
  }

  const extracted = await deps.extractPort.extract({
    transcript: materializeTranscript(input.transcript),
    source: input.source,
    workspaceId: input.workspaceId,
  });
  if (extracted === null) {
    return [];
  }

  const now = Date.now();
  const inserted: MemoryEntry[] = [];
  for (const candidate of extracted) {
    const entry = await settleCandidate(deps.repo, input.workspaceId, candidate, input.source, now);
    if (entry !== null) {
      inserted.push(entry);
    }
  }

  // 有落盘才写幂等键（键值存抽取时间戳，05 §5.4 末行）
  if (inserted.length > 0) {
    await deps.settings.set(idempotencyKey, JSON.stringify(now));
  }
  return inserted;
}

/** 单候选落盘：校验 → 精确去重 → 矛盾判定（02 §7.4）。返回新插入条目或 null。 */
async function settleCandidate(
  repo: MemoryRepo,
  workspaceId: string,
  raw: ExtractedCandidate,
  source: "session-end" | "compact",
  now: number,
): Promise<MemoryEntry | null> {
  // 逐条校验：LLM 产出不可信，kind 经 schema 校验、content 归一化 + 截断
  const kind = memoryKindSchema.safeParse(raw.kind);
  if (!kind.success || typeof raw.content !== "string") {
    return null;
  }
  const content = truncateContent(normalizeMemoryContent(raw.content));
  if (content.length === 0) {
    return null;
  }
  const confidence =
    typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
      ? Math.min(1, Math.max(0, raw.confidence))
      : DEFAULT_EXTRACT_CONFIDENCE;
  const refs = Array.isArray(raw.refs) ? raw.refs.filter((ref): ref is string => typeof ref === "string") : [];

  // 精确去重：归一化后完全相等 → touch 旧条目（02 §7.4）
  const duplicate = await repo.findByContent(workspaceId, content);
  if (duplicate !== null) {
    await repo.touch(duplicate.id, now);
    return null;
  }

  // 矛盾检测：同 workspace 同 kind 互含候选，SQL 粗筛 + JS includes 精判
  const candidates = await repo.findSimilar(workspaceId, kind.data, content);
  const related = candidates.filter((candidate) => {
    const candContent = normalizeMemoryContent(candidate.content);
    if (candContent.length === 0) {
      return false;
    }
    return candContent.includes(content) || content.includes(candContent);
  });
  if (related.length > 0) {
    const stronger = related.filter((candidate) => candidate.confidence > confidence);
    if (stronger.length > 0) {
      // 新条目置信度更低：丢弃新条目、touch 最高置信旧者（lastSeenAt 即「新者保留」，02 §7.4）
      const top = related.reduce((a, b) => (b.confidence > a.confidence ? b : a));
      await repo.touch(top.id, now);
      return null;
    }
    // 新条目插入后，全部相关旧者 supersede（superseded_by=新条目 id）
    const created = await repo.insert({ workspaceId, kind: kind.data, content, refs, confidence, source, ts: now });
    for (const candidate of related) {
      await repo.supersede(candidate.id, created.id);
    }
    return created;
  }

  return repo.insert({ workspaceId, kind: kind.data, content, refs, confidence, source, ts: now });
}
