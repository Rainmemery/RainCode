/**
 * SubagentManager（02-module-design §4）：子代理状态机（S1–S6）+ 事件镜像 + 并发排队。
 *
 * - 不做第二套执行引擎：子会话创建经 SubagentLoopHost 依赖注入（server 装配层是唯一组装点，
 *   ADR-06）；本模块只管状态机与镜像，不感知 LLM/存储/工具装配；
 * - 受理即返：spawn 同步受理（并发未满 → Running 异步拉起；超限 → Pending 排队，槽位释放按
 *   FIFO 启动，02 §4.2 S1）；结论经 handle.result() 回传（agent 工具阻塞等待，完成通知注入
 *   主循环的实现路径，02 §4.1）；过程事件经 SubagentMirror 映射为主会话通知；
 * - 终态映射（02 §4.2）：completed→Completed（S2）；cancelled→Stopped（S5）；failed 且
 *   TURN_MAX_ROUNDS_EXCEEDED→Stopped（S4 超轮次截断，已产出内容保留）；其余 failed→Failed（S3）；
 * - 状态机防御：终态迁移一次性，非法迁移忽略 + 诊断输出（onDiagnostic 可注入，风格同 turn-loop）。
 */
import { ulid } from "@novacode/storage";
import type { SubagentId, TokenUsage } from "@novacode/shared";
import { errorMessage } from "../turn/round-helpers.js";
import type { TurnAdmission, TurnOutcome } from "../ports.js";
import { previewText, SubagentMirror } from "./mirror.js";
import type { SubagentEvent, SubagentEventListener } from "./mirror.js";
import type { SubagentProfile } from "./profile.js";

/** 子代理状态（06-api-spec §2.5 五态）。 */
export type SubagentStatus = "Pending" | "Running" | "Completed" | "Failed" | "Stopped";

/** 子代理终态结果（02 §4.3 SubagentResult）。 */
export interface SubagentResult {
  status: "Completed" | "Failed" | "Stopped";
  /** 子代理最终回答（完成通知正文；超轮次截断时含注明与已产出内容）。 */
  summary: string;
  usage: TokenUsage;
  turnsUsed: number;
}

/**
 * 子代理句柄（02 §4.3；status/sessionId 为活值快照；result() 终态后 resolve 且缓存，
 * 重复调用零开销）。startedAt/usage/turnsUsed 为 subagent.list 的 SubagentInfo 数据源。
 */
export interface SubagentHandle {
  readonly id: SubagentId;
  readonly profileName: string;
  readonly status: SubagentStatus;
  readonly sessionId: string | null;
  /** ISO 时刻；Pending 期为 null。 */
  readonly startedAt: string | null;
  readonly usage: TokenUsage;
  readonly turnsUsed: number;
  result(): Promise<SubagentResult>;
}

/**
 * 子会话宿主：由 server 装配层实现（ADR-06 唯一组装点）；manager 只管状态机与镜像。
 */
export interface SubagentLoopHost {
  spawnLoop(input: {
    subagentId: SubagentId;
    profile: SubagentProfile;
    task: string;
    onChildEvent: (event: { name: string; payload: unknown }) => void;
  }): Promise<{
    sessionId: string;
    /** 已 submit(task) 的受理结果（done 永不 reject）。 */
    admission: TurnAdmission;
    /** loop.cancel 语义（幂等）。 */
    cancel: () => void;
    /** 终态后取子会话最后 assistant 文本（超轮次截断时保留已产出内容）。 */
    lastAssistantText: () => string;
  }>;
}

export interface SubagentManagerOptions {
  host: SubagentLoopHost;
  /** 全局并发上限（02 §4.1：默认 4）。 */
  maxConcurrency?: number;
  /** 诊断出口（server 注入；默认 console.error）。 */
  onDiagnostic?: (message: string, err?: unknown) => void;
}

export type Unsubscribe = () => void;

/** 每个子代理的内部记录（handle 的活值来源；终态后整条保留供消费）。 */
interface InternalRecord {
  id: SubagentId;
  profile: SubagentProfile;
  task: string;
  status: SubagentStatus;
  /** 主会话归属（subagent.list 的 sessionId 过滤数据源；spawn opts 注入）。 */
  parentSessionId: string | null;
  sessionId: string | null;
  startedAt: string | null;
  usage: TokenUsage;
  turnsUsed: number;
  mirror: SubagentMirror;
  cancel: (() => void) | null;
  lastAssistantText: (() => string) | null;
  resultPromise: Promise<SubagentResult>;
  resolveResult: (result: SubagentResult) => void;
  handle: SubagentHandle;
}

const DEFAULT_MAX_CONCURRENCY = 4;

export class SubagentManager {
  private limit: number;
  private runningCount = 0;
  private readonly queue: InternalRecord[] = [];
  private readonly records = new Map<SubagentId, InternalRecord>();
  private readonly listeners = new Set<SubagentEventListener>();

  constructor(private readonly options: SubagentManagerOptions) {
    this.limit = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  }

  /** 运行时调整并发上限（调大立即补位；下限 1 防御）。 */
  setConcurrencyLimit(n: number): void {
    this.limit = Math.max(1, Math.floor(n));
    this.pumpQueue();
  }

  /**
   * 受理即返（不等执行完）：并发未满 → Running 并异步 spawnLoop；超限 → Pending 排队
   * （S1/S6，02 §4.2）。受理即派发 subagent.spawned 镜像事件（06 §3.2 C 组）。
   * opts.parentSessionId 可选注入主会话归属（server 侧 subagent.list 过滤/子会话回链用）。
   */
  spawn(
    profile: SubagentProfile,
    task: string,
    opts?: { parentSessionId?: string },
  ): Promise<SubagentHandle> {
    const id = `sub_${ulid()}`;
    let resolveResult!: (result: SubagentResult) => void;
    const resultPromise = new Promise<SubagentResult>((resolve) => {
      resolveResult = resolve;
    });
    let rec: InternalRecord;
    const handle: SubagentHandle = {
      get id() {
        return rec.id;
      },
      get profileName() {
        return rec.profile.name;
      },
      get status() {
        return rec.status;
      },
      get sessionId() {
        return rec.sessionId;
      },
      get startedAt() {
        return rec.startedAt;
      },
      get usage() {
        return rec.usage;
      },
      get turnsUsed() {
        return rec.turnsUsed;
      },
      result: () => rec.resultPromise,
    };
    rec = {
      id,
      profile,
      task,
      status: "Pending",
      parentSessionId: opts?.parentSessionId ?? null,
      sessionId: null,
      startedAt: null,
      usage: zeroUsage(),
      turnsUsed: 0,
      mirror: new SubagentMirror(id, (event) => this.dispatch(event)),
      cancel: null,
      lastAssistantText: null,
      resultPromise,
      resolveResult,
      handle,
    };
    this.records.set(id, rec);
    if (this.runningCount < this.limit) {
      this.dispatch({
        kind: "spawned",
        subagentId: id,
        profileName: profile.name,
        taskPreview: previewText(task),
        status: "Running",
      });
      this.admit(rec);
    } else {
      this.queue.push(rec);
      this.dispatch({
        kind: "spawned",
        subagentId: id,
        profileName: profile.name,
        taskPreview: previewText(task),
        status: "Pending",
        queuePosition: this.queue.length,
      });
    }
    return Promise.resolve(handle);
  }

  get(id: SubagentId): SubagentHandle | undefined {
    return this.records.get(id)?.handle;
  }

  /** 信息快照（含 SubagentInfo 所需全部字段；含排队中与终态句柄）。 */
  list(): SubagentHandle[] {
    return [...this.records.values()].map((rec) => rec.handle);
  }

  /** 排队位次（1 起始；不在队列——运行中/终态/未知 id——返回 undefined。spawn 出参 queuePosition 数据源）。 */
  queuePositionOf(id: SubagentId): number | undefined {
    const rec = this.records.get(id);
    if (rec === undefined) return undefined;
    const index = this.queue.indexOf(rec);
    return index >= 0 ? index + 1 : undefined;
  }

  /** 主会话归属（subagent.list 的 sessionId 过滤数据源；未注入返回 undefined）。 */
  parentSessionIdOf(id: SubagentId): string | undefined {
    return this.records.get(id)?.parentSessionId ?? undefined;
  }

  /**
   * 停止（02 §4.2）：Running → S5 级联取消（终态立即落定，子循环后续 cancelled 迁移由防御忽略）；
   * Pending → S6 直接 Stopped；终态句柄幂等返回 stopped:false（06 §2.5 subagent.stop）。
   */
  async stop(id: SubagentId, opts?: { reason?: string }): Promise<{ stopped: boolean; status: SubagentStatus }> {
    const rec = this.records.get(id);
    if (rec === undefined) {
      // 未知 id（server 侧应先经 get 判 SUBAGENT_NOT_FOUND）；防御性幂等返回
      this.diag(`stop: subagent ${id} 不存在`);
      return { stopped: false, status: "Stopped" };
    }
    if (rec.status === "Running") {
      const summary = opts?.reason !== undefined ? `子代理已停止：${opts.reason}` : "子代理已停止";
      this.finalize(rec, { status: "Stopped", summary, usage: zeroUsage(), turnsUsed: 0 });
      rec.cancel?.();
      return { stopped: true, status: "Stopped" };
    }
    if (rec.status === "Pending") {
      const index = this.queue.indexOf(rec);
      if (index >= 0) this.queue.splice(index, 1);
      const summary =
        opts?.reason !== undefined ? `排队中的子代理已停止：${opts.reason}` : "排队中的子代理已停止";
      this.finalize(rec, { status: "Stopped", summary, usage: zeroUsage(), turnsUsed: 0 });
      return { stopped: true, status: "Stopped" };
    }
    return { stopped: false, status: rec.status };
  }

  /** 全量停止（archive/shutdown 用，02 §4.4）。 */
  async stopAll(reason?: string): Promise<void> {
    const active = [...this.records.values()].filter((rec) => rec.status === "Pending" || rec.status === "Running");
    await Promise.all(active.map((rec) => this.stop(rec.id, { ...(reason !== undefined && { reason }) })));
  }

  /** 镜像事件订阅（spawned/progress/completed；listener 异常隔离，不影响其他订阅方）。 */
  onEvent(listener: SubagentEventListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------------

  /** S1：Pending → Running（同步改态），子会话异步拉起（受理不等执行）。 */
  private admit(rec: InternalRecord): void {
    if (rec.status !== "Pending") {
      this.diag(`admit: subagent ${rec.id} 状态为 ${rec.status}，忽略 S1 迁移`);
      return;
    }
    rec.status = "Running";
    rec.startedAt = new Date().toISOString();
    this.runningCount += 1;
    void this.run(rec);
  }

  private async run(rec: InternalRecord): Promise<void> {
    try {
      const child = await this.options.host.spawnLoop({
        subagentId: rec.id,
        profile: rec.profile,
        task: rec.task,
        onChildEvent: (event) => {
          // 终态后子会话残余事件（取消竞态）不再镜像（02 §4.2：镜像服务于进行中的子代理）
          if (!isTerminal(rec.status)) rec.mirror.onChildEvent(event);
        },
      });
      rec.sessionId = child.sessionId;
      rec.cancel = child.cancel;
      rec.lastAssistantText = child.lastAssistantText;
      if (rec.status === "Running" && child.admission.admission === "started") {
        rec.mirror.markStarted();
      }
      if (rec.status !== "Running") {
        // 竞态：拉起期间已被 stop（S5）——立即取消子循环，终态以 stop 路径为准
        child.cancel();
      }
      const outcome = await child.admission.done;
      this.settle(rec, outcome);
    } catch (reason: unknown) {
      // spawnLoop 拉起失败：S3（子会话未建立即失败，02 §4.4）
      this.finalize(rec, {
        status: "Failed",
        summary: `子代理启动失败：${errorMessage(reason)}`,
        usage: zeroUsage(),
        turnsUsed: 0,
      });
    } finally {
      this.runningCount -= 1;
      this.pumpQueue();
    }
  }

  /** 子 turn 终态映射（02 §4.2 S2–S5；progress done/failed 随终态路径发出，永不合并）。 */
  private settle(rec: InternalRecord, outcome: TurnOutcome): void {
    if (rec.status !== "Running") {
      this.diag(`settle: subagent ${rec.id} 已终态（${rec.status}），忽略 ${outcome.status} 迁移`);
      return;
    }
    if (outcome.status === "completed") {
      rec.mirror.emitDone();
      this.finalize(rec, {
        status: "Completed",
        summary: rec.lastAssistantText?.() ?? "",
        usage: outcome.usage ?? zeroUsage(),
        turnsUsed: outcome.rounds,
      });
      return;
    }
    if (outcome.status === "cancelled") {
      rec.mirror.emitFailed("子代理已取消");
      this.finalize(rec, { status: "Stopped", summary: "子代理已取消", usage: zeroUsage(), turnsUsed: 0 });
      return;
    }
    // failed：TURN_MAX_ROUNDS_EXCEEDED → S4 超轮次截断（Stopped，已产出内容保留）；其余 → S3 Failed
    rec.mirror.emitFailed(outcome.error.message);
    if (outcome.error.code === "TURN_MAX_ROUNDS_EXCEEDED") {
      const partial = rec.lastAssistantText?.() ?? "";
      const note = `已达 maxTurns（${String(rec.profile.maxTurns)}）上限，输出被截断`;
      this.finalize(rec, {
        status: "Stopped",
        summary: partial.length > 0 ? `${partial}\n[${note}]` : `[${note}，未产出最终回答]`,
        usage: zeroUsage(),
        turnsUsed: 0,
      });
      return;
    }
    this.finalize(rec, {
      status: "Failed",
      summary: outcome.error.message.length > 0 ? outcome.error.message : "子代理内部错误",
      usage: zeroUsage(),
      turnsUsed: 0,
    });
  }

  /** 终态落定：结果缓存 + resolve result() + subagent.completed 镜像（一次性防御）。 */
  private finalize(rec: InternalRecord, result: SubagentResult): void {
    if (isTerminal(rec.status)) {
      this.diag(`finalize: subagent ${rec.id} 已终态（${rec.status}），忽略重复落定`);
      return;
    }
    rec.status = result.status;
    rec.usage = result.usage;
    rec.turnsUsed = result.turnsUsed;
    rec.resolveResult(result);
    this.dispatch({
      kind: "completed",
      subagentId: rec.id,
      status: result.status,
      summary: result.summary,
      usage: result.usage,
      turnsUsed: result.turnsUsed,
    });
  }

  /** 槽位释放后按 FIFO 补位（02 §4.2 S1）。 */
  private pumpQueue(): void {
    while (this.runningCount < this.limit && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next === undefined) break;
      this.admit(next);
    }
  }

  private dispatch(event: SubagentEvent): void {
    // Array.from 快照：listener 回调内可安全退订（oxlint no-useless-spread 不接受展开写法）
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (reason: unknown) {
        this.diag("subagent event listener failed", reason);
      }
    }
  }

  private diag(message: string, err?: unknown): void {
    const sink = this.options.onDiagnostic ?? console.error;
    sink(`[novacode/agent-core subagent] ${message}`, err ?? "");
  }
}

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

function isTerminal(status: SubagentStatus): boolean {
  return status === "Completed" || status === "Failed" || status === "Stopped";
}
