/**
 * stdio 绑定占位（04-architecture §4.4：P1 落地，本波 walking skeleton 不实现）。
 *
 * 计划形态（届时补充，签名对齐 IMessageTransport）：
 * - `StdioTransport implements IMessageTransport`，kind: "stdio"；
 * - stdin/stdout 每行一帧 JSONL（\n 分隔，06-api-spec §1.3）；
 * - stdout 只承载协议帧，诊断日志走 stderr（避免非协议输出混入，02 §3.4）；
 * - 畸形行按 06 §1.2 处理：可定位 id 则回 PARSE_ERROR response，否则丢弃 + stderr 告警，不断开；
 * - message.delta 走 50ms 批量窗口（06 §3.4），边界事件先 flush。
 *
 * 使用场景：桌面 main ↔ agent 子进程（04 §3.2）与任意 headless 宿主。
 * websocket 绑定（P2 预留）同理后续补充。
 */
