/**
 * session_search 检索通道装配（T5.3）：storage.searchHistory 薄投影为 agent-core
 * ToolPhaseDeps.searchHistory 通道（server 唯一组装点，agent-service 构造器接线；独立小文件
 * 为架构 500 行治理）。语义单点在 storage history-search：part 级 FTS + 相对分数地板 +
 * LIKE 兜底；此处仅注入排除当前会话（自指噪声防线，02 §7 注记）与错误形态投影——
 * 跨包错误类不越 port，失败收敛 { ok:false, code:"TOOL_EXEC_FAILED" }（同 expandSkill 口径）。
 */
import type { SessionHistorySearchResult } from "@raincode/agent-core";
import type { Storage } from "@raincode/storage";

export function createHistorySearchChannel(storage: Storage) {
  return async ({
    sessionId,
    workspaceId,
    query,
    limit,
  }: {
    sessionId: string;
    workspaceId: string;
    query: string;
    limit?: number;
  }): Promise<SessionHistorySearchResult> => {
    try {
      const hits = await storage.searchHistory(workspaceId, query, {
        ...(limit !== undefined && { limit }),
        excludeSessionId: sessionId,
      });
      return {
        ok: true,
        hits: hits.map((hit) => ({
          sessionId: hit.sessionId,
          role: hit.role,
          kind: hit.kind,
          content: hit.content,
          ts: hit.ts,
        })),
      };
    } catch (reason: unknown) {
      const message = reason instanceof Error ? reason.message : String(reason);
      return { ok: false, code: "TOOL_EXEC_FAILED", message: `session history search failed: ${message}` };
    }
  };
}
