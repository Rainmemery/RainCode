/**
 * raincode serve：headless Agent Service 宿主（T2.8 / 04-architecture §3.2 agent 子进程同形态）。
 *
 * - 进程 stdin/stdout 绑定 StdioTransport（JSONL 帧），复用 createAgentServiceNode 唯一组装点；
 * - stdout 只承载协议帧；诊断日志全部走 stderr（02 §3.4）；
 * - 退出路径：stdin end（宿主断开，本次收尾）与 system.shutdown（服务已关存储，宿主级联终止兜底）。
 * 调试：帧可人工 cat/重放（ADR-08），如
 * `echo '{"kind":"request","id":"r1","method":"system.ping","params":{}}' | raincode serve`
 */
import { createStdioHostContext } from "../host.js";

export async function serveCommand(rest: string[]): Promise<number> {
  const context = await createStdioHostContext(rest);
  // stdin end → 宿主断开；transport 保持可写直至 close()，保证在途响应 flush（06 §1.3 半开语义）
  await new Promise<void>((resolve) => {
    const done = (): void => {
      process.stdin.removeListener("end", done);
      process.stdin.removeListener("error", done);
      resolve();
    };
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
  await context.close();
  return 0;
}
