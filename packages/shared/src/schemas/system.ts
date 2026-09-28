import { z } from "zod";

/**
 * system 域（06-api-spec §2.8）：握手、版本发现与能力协商。
 * 本波 walking skeleton 仅需 system.ping；system.version / system.shutdown 随 server 接线波次补充。
 */

/** 连接后首个请求：存活探测 + 版本协商 + 能力发现（06 §1.4、§7）。 */
export const systemPingParamsSchema = z.strictObject({});
export type SystemPingParams = z.infer<typeof systemPingParamsSchema>;

export const systemPingResultSchema = z.object({
  protocolVersion: z.string(),
  capabilities: z.array(z.string()),
  serverTime: z.number(),
});
export type SystemPingResult = z.infer<typeof systemPingResultSchema>;

/** v1.0 内置 capability 列表（06 §7.2）。 */
export const V1_CAPABILITIES = [
  "session.steer",
  "session.attachments",
  "subagent.spawn",
  "mcp.transport.http",
  "memory.promote",
] as const satisfies readonly string[];

// ---------------------------------------------------------------------------
// system.version（06 §2.8：详细版本信息，用于诊断与「关于」页）
// ---------------------------------------------------------------------------

export const systemVersionParamsSchema = z.strictObject({});
export type SystemVersionParams = z.infer<typeof systemVersionParamsSchema>;

export const systemVersionResultSchema = z.object({
  protocolVersion: z.string(),
  appVersion: z.string(),
  configVersion: z.number().int(),
  nodeVersion: z.string().optional(),
});
export type SystemVersionResult = z.infer<typeof systemVersionResultSchema>;

// ---------------------------------------------------------------------------
// system.shutdown（06 §2.8：优雅停机——取消运行中 turn → flush → 关闭存储与传输）
// ---------------------------------------------------------------------------

export const systemShutdownParamsSchema = z.strictObject({
  reason: z.string().optional(),
});
export type SystemShutdownParams = z.infer<typeof systemShutdownParamsSchema>;

export const systemShutdownResultSchema = z.object({
  shuttingDown: z.literal(true),
});
export type SystemShutdownResult = z.infer<typeof systemShutdownResultSchema>;
