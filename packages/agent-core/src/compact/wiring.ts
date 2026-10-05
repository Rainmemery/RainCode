/**
 * Turn 循环的压缩服务装配与宿主桥（从 SessionTurnLoop 拆出，单文件 ≤500 行治理）：
 * CompactionService + MicrocompactService（T5.4）的构造编排与 CompactionHost /
 * MicrocompactHost 宿主实现——两服务同生命周期（options.compaction 且配置了 Provider 时
 * 启用，否则双 null）；宿主经 TurnCompactionRefs 窄引用面操作循环私有状态（历史 / 代次 /
 * usage 估算），循环自身不持有压缩面细节。
 */
import type { CheckpointState } from "@raincode/storage";
import type { CollaborationMode, MessageRecord } from "@raincode/shared";
import type { LlmPort, StoragePort } from "../ports.js";
import { estimateContextTokens, createCompactionService, type CompactionHost, type CompactionOptions, type CompactionService, type CompactionTicket } from "./service.js";
import { createMicrocompactService, type MicrocompactHost, type MicrocompactService } from "./microcompact.js";

/** 事件/串行化/诊断出口的最小视图（SessionTurnLoop.events 满足，同 compact/service.ts）。 */
interface LoopEventsView {
  serialWrite<T>(task: () => Promise<T>): Promise<T>;
  emitPersisted(name: "compact.started" | "compact.completed", build: (seq: number, ts: number) => unknown): void;
  diag(message: string, err?: unknown): void;
}

export interface TurnCompactionServices {
  compaction: CompactionService | null;
  microcompact: MicrocompactService | null;
}

/** 循环私有状态的窄引用面（TurnCompactionBridge 经此操作历史 / 代次 / usage 估算）。 */
export interface TurnCompactionRefs {
  history(): MessageRecord[];
  setHistory(history: MessageRecord[]): void;
  replaceAt(index: number, record: MessageRecord): void;
  mode(): CollaborationMode;
  epoch(): number;
  updateEpoch(epoch: number): void;
  lastPromptTokens(): number;
  reduceLastPromptTokens(savedTokens: number): void;
}

/**
 * 压缩宿主桥：CompactionHost + MicrocompactHost 的实现（宿主由桥充当，装配后服务回填）+
 * 循环转授面（compact() / runBoundary()）。runBoundary 落 02 §1.2.5 边界顺序——
 * microcompact 预剪枝先行（同步确定性单过），节省 tokens 回落 usage 估算后交 full compact
 * 阈值判定，预剪枝足够时 full compact 让位不再触发。
 */
export class TurnCompactionBridge implements CompactionHost, MicrocompactHost {
  private compaction: CompactionService | null = null;
  private microcompact: MicrocompactService | null = null;

  constructor(private readonly refs: TurnCompactionRefs) {}

  /** createTurnCompactionServices 装配后回填（compact()/runBoundary() 转授用）。 */
  attach(services: TurnCompactionServices): void {
    this.compaction = services.compaction;
    this.microcompact = services.microcompact;
  }

  // —— CompactionHost（compact/service.ts）——
  getHistory(): MessageRecord[] {
    return [...this.refs.history()];
  }
  replaceWith(prefix: MessageRecord[], count: number): void {
    this.refs.setHistory([...prefix, ...this.refs.history().slice(count)]);
  }
  historyLength(): number {
    return this.refs.history().length;
  }
  currentEpoch(): number {
    return this.refs.epoch();
  }
  updateEpoch(epoch: number): void {
    this.refs.updateEpoch(epoch);
  }
  checkpointBase(): Pick<CheckpointState, "mode" | "todo"> {
    return { mode: this.refs.mode(), todo: [] };
  }

  // —— MicrocompactHost（compact/microcompact.ts）——
  replaceAt(index: number, record: MessageRecord): void {
    this.refs.replaceAt(index, record);
  }

  // —— 循环转授 ——
  compact(): CompactionTicket | null {
    return this.compaction?.compactNow() ?? null;
  }

  runBoundary(): void {
    const compaction = this.compaction;
    if (compaction === null) {
      return;
    }
    const outcome = this.microcompact?.maybePrune(this.refs.lastPromptTokens());
    if (outcome !== undefined && outcome.applied && outcome.tokensSaved > 0) {
      this.refs.reduceLastPromptTokens(outcome.tokensSaved);
    }
    compaction.maybeTrigger(estimateContextTokens(this.refs.history(), this.refs.lastPromptTokens()));
  }
}

/** 装配入口（SessionTurnLoop 构造器调用）：未配置 compaction 或未配置 Provider → 双 null。 */
export function createTurnCompactionServices(input: {
  host: CompactionHost & MicrocompactHost;
  sessionId: string;
  llm: LlmPort | null;
  storage: StoragePort;
  events: LoopEventsView;
  systemPrompt?: string;
  onBeforeReplace?: (prefix: MessageRecord[]) => Promise<void>;
  compaction: CompactionOptions | undefined;
}): TurnCompactionServices {
  if (input.compaction === undefined || input.llm === null) {
    return { compaction: null, microcompact: null };
  }
  const compaction = createCompactionService(
    input.host,
    {
      sessionId: input.sessionId,
      llm: input.llm,
      storage: input.storage,
      ...(input.systemPrompt !== undefined && { systemPrompt: input.systemPrompt }),
      ...(input.onBeforeReplace !== undefined && { onBeforeReplace: input.onBeforeReplace }),
      events: input.events,
    },
    input.compaction,
  );
  const microcompact = createMicrocompactService(
    input.host,
    {
      sessionId: input.sessionId,
      storage: input.storage,
      serialWrite: (task) => input.events.serialWrite(task),
      diag: (message, err) => input.events.diag(message, err),
    },
    input.compaction.microcompact,
    () => compaction.fullCompactThresholdTokens,
  );
  return { compaction, microcompact };
}
