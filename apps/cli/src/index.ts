#!/usr/bin/env tsx
/**
 * novacode CLI 入口（bin：tsx 运行，04-architecture §3.1 单进程内嵌 Agent Service）。
 *
 * 命令：ping / run "<prompt>" / chat（readline REPL）。
 * TUI 演进点：按 04 ADR-02，本波刻意不引入 Ink——readline 是最小可用形态，
 * 会话流式渲染 / 工具卡片 / 审批交互迁入 Ink 时复用同一事件消费逻辑（stream.ts）。
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runPing } from "./commands/ping.js";
import { runCommand } from "./commands/run.js";
import { chatCommand } from "./commands/chat.js";

export async function main(argv: string[]): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);
  try {
    switch (command) {
      case "ping":
        return await runPing();
      case "run":
        return await runCommand(rest);
      case "chat":
        return await chatCommand(rest);
      case "help":
      case "--help":
      case "-h":
        printHelp(process.stdout);
        return 0;
      case undefined:
        printHelp(process.stderr);
        return 2;
      default:
        process.stderr.write(`unknown command: ${command}\n`);
        printHelp(process.stderr);
        return 2;
    }
  } catch (reason: unknown) {
    // 参数解析失败等入口层错误；凭据绝不进入错误输出（04 §5.3）
    process.stderr.write(`novacode: ${reason instanceof Error ? reason.message : String(reason)}\n`);
    return 2;
  }
}

function printHelp(stream: NodeJS.WriteStream): void {
  stream.write(
    [
      "novacode — coding agent CLI",
      "",
      "用法:",
      "  novacode ping                  连接本进程 Agent Service 并握手（打印协议版本）",
      '  novacode run "<prompt>"        非交互模式：创建会话 → 发送 → 流式打印 → 退出',
      "  novacode chat                  交互 REPL（/exit /sessions /resume <id>）",
      "",
      "Provider 选项（优先级: 参数 > NOVACODE_PROVIDER_* 环境变量 > config/providers.local.json）:",
      "  --base-url <url>               OpenAI 兼容 baseURL",
      "  --model <model>                模型名",
      "  --api-key <key>                API key（明文参数有 shell 历史泄露风险，建议 env / file: 引用）",
      "  --name <name>                  Provider 显示名",
      "  --provider-config <path>       配置文件路径（缺省 config/providers.local.json）",
      "  --workspace <dir>              工作区目录（run/chat，缺省当前目录）",
      "  --title <title>                会话标题（run/chat）",
      "",
    ].join("\n") + "\n",
  );
}

/** 直接执行（node_modules/.bin/novacode 或 tsx src/index.ts）时启动；被 import（smoke）时不自动运行。 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined || entry === "") return false;
  const entryUrl = pathToFileURL(resolve(entry)).href;
  return process.platform === "win32"
    ? import.meta.url.toLowerCase() === entryUrl.toLowerCase()
    : import.meta.url === entryUrl;
}

if (isDirectRun()) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
