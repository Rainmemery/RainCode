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
  // T2.7 P1（06 §7.1 需探测级）：permission.respond 增可选请求字段 answerText
  // （ask_user_question 通道），客户端经 system.ping 探测后启用提问卡渲染。
  "permission.respond.answer",
  // T3.8（v1.9，06 §6.3）：websocket 绑定连接级鉴权（ws.auth → system.ping → 业务方法时序）。
  // stdio / in-memory 绑定同生共死不设门，不注册 ws.auth handler（能力声明对传输绑定无感）。
  "ws.auth",
  // T6.1（v1.14，06 §2.10）：marketplace 域装配（市场注册/清单/安装/卸载，path 源先行）；
  // 端层经 system.ping 探测后启用安装入口（未装配调用报 METHOD_NOT_FOUND）。
  "marketplace",
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

// ---------------------------------------------------------------------------
// ws.auth（06 §2.11，v1.9 T3.8：websocket 绑定连接级鉴权握手）
// ---------------------------------------------------------------------------

/**
 * 连接级鉴权（06 §6.3）：websocket 绑定accept连接后首个请求必须为 ws.auth，
 * 成功（ok 应答）后方受理 system.ping 与业务方法；失败（错误应答）门保持关闭。
 * handler 由宿主提供（token 校验属端层，同传输选择权）；stdio / in-memory 不注册。
 */
export const wsAuthParamsSchema = z.strictObject({
  token: z.string().min(1),
});
export type WsAuthParams = z.infer<typeof wsAuthParamsSchema>;

export const wsAuthResultSchema = z.object({
  ok: z.literal(true),
});
export type WsAuthResult = z.infer<typeof wsAuthResultSchema>;
