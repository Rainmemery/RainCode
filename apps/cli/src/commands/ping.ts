/**
 * raincode ping：连接本进程 Agent Service → system.ping 握手 → 打印协议版本（06 §1.4）。
 * 不需要 Provider 配置（ping 不触碰模型链路）。
 */
import type { SystemPingResult } from "@raincode/shared";
import { startServiceNode, teardown } from "../context.js";

export async function runPing(): Promise<number> {
  const context = await startServiceNode({
    positionals: [],
    provider: {},
  });
  try {
    const result = await context.client.call<SystemPingResult>("system.ping", {});
    const capabilities = result.capabilities.join(", ");
    process.stdout.write(
      `raincode agent service ok\nprotocol: ${result.protocolVersion}\ncapabilities: ${capabilities}\nserverTime: ${new Date(result.serverTime).toISOString()}\n`,
    );
    return 0;
  } finally {
    await teardown(context);
  }
}
