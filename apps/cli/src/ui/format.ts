/**
 * 耗时格式化（参考 MiMo-Code print 模式调研结论 util/format.ts 语义，实现从简）：
 * <60s → x.xs；<1h → Xm Ys（如 1m 20s）；≥1h → Xh Ym。
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (totalSeconds < 3_600) {
    return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  }
  return `${Math.floor(totalSeconds / 3600)}h ${Math.floor((totalSeconds % 3600) / 60)}m`;
}
