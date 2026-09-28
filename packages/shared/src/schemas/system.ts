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
