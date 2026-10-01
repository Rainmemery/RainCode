/**
 * raincode chat：readline 交互 REPL（最小命令集 /exit /sessions /resume <id> /rename /fork /usage
 * /mode /archive /compact /providers /skills）。
 * 首条输入自动创建会话；/resume 切换活动会话后续输入续接该会话历史（session.resume 幂等）。
 * T2.6（06 §2.1 AC-9/AC-10）：/rename 重命名、/fork 分叉新会话并切换活动会话（同 /resume 模式）、
 * /usage 会话累计用量与费用估算（costEstimateUsd 缺省 = 活跃 Provider 未配置单价）。
 * T3.4（06 §2.9）：/skills 技能面板（workspace/global 双源）；`/<技能名> [参数]` → skills.invoke
 * （server 侧模板展开受理，流式渲染与普通输入同管线；SKILL_NOT_FOUND 回退未知命令提示）。
 * 审批：permission.requested 交互四级决策（[1]仅本次 [2]本会话始终 [3]项目始终 [4]拒绝），
 * 选项[2]写 session 规则、[3]写 project 规则、[4]respond deny（02 §6.2 审批闭环）。
 * TUI 演进点：本波按 04 ADR-02 不引入 Ink，readline REPL + ANSI 富文本渲染层（ui/theme）为中间形态。
 */
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { RpcCallError } from "@raincode/rpc";
import type { RpcClient } from "@raincode/rpc";
import type {
  CollaborationMode,
  ConfigProvidersListResult,
  SessionCompactResult,
  SessionForkResult,
  SessionRenameResult,
  SessionUsageResult,
  SessionCreateResult,
  SessionListResult,
  SessionResumeResult,
  SkillsInvokeResult,
  SkillsListResult,
} from "@raincode/shared";
import { parseCliArgs, startServiceNode, teardown } from "../context.js";
import { sendAndStream, streamTurn } from "../stream.js";
import type { ApprovalChoice } from "../stream.js";
import { out } from "../ui/theme.js";

const MODES: readonly CollaborationMode[] = ["normal", "plan", "auto-accept"];

export async function chatCommand(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv);
  const workspaceRoot = resolve(parsed.workspace ?? process.cwd());
  const context = await startServiceNode(parsed);
  // 同一 stdin 只允许挂一个 terminal=true 的 readline：interface 构造时常驻监听 keypress，
  // 双 interface 会导致每个按键被消费两次（双回显 eexxiitt）。
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let currentSessionId: string | null = null;

  const promptApproval = async (): Promise<ApprovalChoice> => {
    for (;;) {
      // 复用主 rl：审批发生在 sendAndStream 期间，主 question 已 resolve，不存在并发挂起。
      const answer = (await rl.question(out.warn("choice> "))).trim();
      if (answer === "1") return "allow";
      if (answer === "2") return "allow-session";
      if (answer === "3") return "allow-project";
      if (answer === "4") return "deny";
      process.stdout.write(out.warn("无效选项；请输入 1/2/3/4\n"));
    }
  };

  try {
    await context.client.call("system.ping", {});
    // banner：产品名 accent+bold（03 §tokens --accent），命令说明 dim；readline prompt 含 ANSI
    // 转义安全（readline 以 stripVTControlCharacters 计宽，行内回显不受影响）。
    process.stdout.write(
      `${out.bold(out.accent("RainCode"))} ${out.dim(`chat · workspace ${workspaceRoot}`)}\n` +
        out.dim(
          "命令: /exit /sessions /resume <id> /rename <title> /fork [title] /usage /mode <normal|plan|auto-accept> /archive [--force] /compact /providers /skills\n",
        ) +
        out.dim("技能: /<技能名> [参数]（/skills 查看可用技能；workspace/global 双源加载）\n") +
        out.dim("其余输入直接发送\n"),
    );

    for (;;) {
      // 显式注解：打断「question 模板引用 currentSessionId ↔ 循环内回填 currentSessionId」的推断环
      const line: string = await rl.question(
        currentSessionId === null ? out.accent("you> ") : out.accent(`you·${currentSessionId.slice(-6)}> `),
      );
      const trimmed: string = line.trim();
      if (trimmed.length === 0) continue;

      if (trimmed === "/exit" || trimmed === "/quit") {
        break;
      }
      if (trimmed === "/sessions") {
        await printSessions(context.client);
        continue;
      }
      if (trimmed.startsWith("/resume")) {
        const id: string | undefined = trimmed.split(/\s+/)[1];
        if (id === undefined || id.length === 0) {
          process.stdout.write("usage: /resume <sessionId>\n");
          continue;
        }
        try {
          const result = await context.client.call<SessionResumeResult>("session.resume", { sessionId: id });
          currentSessionId = result.sessionId;
          process.stdout.write(
            `resumed ${result.sessionId} · phase ${result.snapshot.phase} · lastSeq ${result.snapshot.lastSeq}\n`,
          );
        } catch (reason: unknown) {
          printRpcError(reason);
        }
        continue;
      }
      if (trimmed.startsWith("/rename")) {
        // T2.6 session.rename（AC-9）：title 取参数其余部分；schema 层 trim（1~200），空参 → usage 提示
        const title = trimmed.slice("/rename".length).trim();
        if (currentSessionId === null) {
          process.stdout.write("no active session\n");
          continue;
        }
        if (title.length === 0) {
          process.stdout.write("usage: /rename <title>\n");
          continue;
        }
        try {
          const result = await context.client.call<SessionRenameResult>("session.rename", {
            sessionId: currentSessionId,
            title,
          });
          process.stdout.write(`renamed → ${out.accent(result.title)}\n`);
        } catch (reason: unknown) {
          printRpcError(reason);
        }
        continue;
      }
      if (trimmed.startsWith("/fork")) {
        // T2.6 session.fork（AC-9）：复制全量历史分叉新会话；成功后切换活动会话（同 /resume 模式）
        if (currentSessionId === null) {
          process.stdout.write("no active session\n");
          continue;
        }
        const title = trimmed.slice("/fork".length).trim();
        // 显式快照注解：打断「call 入参读 currentSessionId ↔ 循环内回填 currentSessionId = result」的推断环
        const sourceId: string = currentSessionId;
        try {
          const result = await context.client.call<SessionForkResult>("session.fork", {
            sessionId: sourceId,
            ...(title.length > 0 && { title }), // 无参 → server 缺省 `fork: <源title>`
          });
          currentSessionId = result.sessionId;
          const parentShort = result.parentSessionId.slice(-6);
          const newShort = result.sessionId.slice(-6);
          process.stdout.write(
            `forked ${out.dim(parentShort)} → ${out.accent(newShort)} · ${out.dim(`${String(result.messageCount)} msgs`)}\n`,
          );
        } catch (reason: unknown) {
          printRpcError(reason);
        }
        continue;
      }
      if (trimmed === "/usage") {
        // T2.6 session.usage（AC-10）：累计用量读数 + 活跃 Provider 单价费用估算（有单价才给 cost）
        if (currentSessionId === null) {
          process.stdout.write("no active session\n");
          continue;
        }
        try {
          const result = await context.client.call<SessionUsageResult>("session.usage", {
            sessionId: currentSessionId,
          });
          process.stdout.write(
            `input ${String(result.inputTokens)} tokens · output ${String(result.outputTokens)} tokens · turns ${String(result.turnsCount)}\n`,
          );
          const cost =
            result.costEstimateUsd !== undefined
              ? `cost ≈ ${out.ok(`$${result.costEstimateUsd.toFixed(6)}`)}`
              : out.dim("cost: n/a（provider 未配置单价）");
          process.stdout.write(`${cost}\n`);
        } catch (reason: unknown) {
          printRpcError(reason);
        }
        continue;
      }
      if (trimmed.startsWith("/mode")) {
        const arg = trimmed.slice("/mode".length).trim();
        if (currentSessionId === null) {
          process.stdout.write("no active session\n");
          continue;
        }
        if (!MODES.includes(arg as CollaborationMode)) {
          process.stdout.write(`usage: /mode <${MODES.join("|")}>\n`);
          continue;
        }
        try {
          await context.client.call("session.setMode", { sessionId: currentSessionId, mode: arg });
          process.stdout.write(`mode → ${arg}\n`);
        } catch (reason: unknown) {
          printRpcError(reason);
        }
        continue;
      }
      if (trimmed.startsWith("/archive")) {
        if (currentSessionId === null) {
          process.stdout.write("no active session\n");
          continue;
        }
        const force = /(--force|\bforce\b)/.test(trimmed);
        try {
          await context.client.call("session.archive", {
            sessionId: currentSessionId,
            ...(force && { force: true }),
          });
          process.stdout.write(`archived ${currentSessionId}\n`);
          currentSessionId = null;
        } catch (reason: unknown) {
          printRpcError(reason);
        }
        continue;
      }
      if (trimmed.startsWith("/compact")) {
        if (currentSessionId === null) {
          process.stdout.write("no active session\n");
          continue;
        }
        try {
          const result = await context.client.call<SessionCompactResult>("session.compact", {
            sessionId: currentSessionId,
          });
          process.stdout.write(
            `compaction ${result.compactionId} → ${result.alreadyRunning ? "already running" : "scheduled"} · epoch ${String(result.epoch)}\n`,
          );
        } catch (reason: unknown) {
          printRpcError(reason);
        }
        continue;
      }
      if (trimmed === "/providers") {
        try {
          const result = await context.client.call<ConfigProvidersListResult>("config.providers.list", {});
          if (result.providers.length === 0) {
            process.stdout.write("(no providers; use config.providers.add)\n");
          }
          for (const p of result.providers) {
            const active = p.id === result.activeProviderId ? "*" : " ";
            const key = p.apiKeyConfigured ? "key:configured" : "key:missing";
            // AC-10 单价（06 §2.3）：双价齐备才展示（与 session.usage cost 估算口径一致），` $in/out`
            const price =
              p.inputPricePerMtok !== undefined && p.outputPricePerMtok !== undefined
                ? `  ${out.dim(`$${String(p.inputPricePerMtok)}/${String(p.outputPricePerMtok)}`)}`
                : "";
            process.stdout.write(`${active} ${p.id}  ${p.name}  ${p.model}  ${key}${price}\n`);
          }
        } catch (reason: unknown) {
          printRpcError(reason);
        }
        continue;
      }
      if (trimmed === "/skills") {
        // T3.4 技能面板：有活动会话时含 workspace 层；否则仅 global 层（server 侧按会话解析目录）
        try {
          const result = await context.client.call<SkillsListResult>(
            "skills.list",
            currentSessionId === null ? {} : { sessionId: currentSessionId },
          );
          if (result.items.length === 0) {
            process.stdout.write(
              "(no skills; 放置 <workspace>/.raincode/skills/<name>.md 或全局技能目录 <dataRoot>/skills/<name>.md)\n",
            );
          }
          for (const s of result.items) {
            const hint = s.argumentHint !== undefined ? ` ${out.dim(s.argumentHint)}` : "";
            process.stdout.write(`/${s.name}${hint}  ${out.dim(`[${s.source}]`)} ${s.description}\n`);
          }
        } catch (reason: unknown) {
          printRpcError(reason);
        }
        continue;
      }
      if (trimmed.startsWith("/")) {
        // T3.4 技能路由：内置命令未命中的斜杠输入 → 尝试技能（server 侧展开，受理后流式渲染同 send）
        const slashBody: string = trimmed.slice(1);
        const name: string = slashBody.split(/\s+/)[0] ?? "";
        const args: string = slashBody.slice(name.length).trim();
        if (currentSessionId === null) {
          process.stdout.write("no active session（技能在会话内执行；先发送一条输入自动创建会话）\n");
          continue;
        }
        const sessionId: string = currentSessionId;
        process.stdout.write(out.dim(`[${name}] 技能展开受理\n`));
        try {
          await streamTurn(
            context.client,
            { approval: { kind: "interactive", prompt: promptApproval } },
            () =>
              context.client.call<SkillsInvokeResult>("skills.invoke", {
                sessionId,
                name,
                ...(args.length > 0 && { arguments: args }),
              }),
          );
        } catch (reason: unknown) {
          if (reason instanceof RpcCallError && reason.code === "SKILL_NOT_FOUND") {
            process.stdout.write(
              `unknown command or skill: /${name}\n` +
                `${out.dim("用 /skills 查看可用技能；内置命令见 /exit 顶部说明\n")}`,
            );
          } else {
            printRpcError(reason);
          }
        }
        continue;
      }

      try {
        if (currentSessionId === null) {
          const created = await context.client.call<SessionCreateResult>("session.create", {
            workspaceRoot,
            title: trimmed.slice(0, 60),
          });
          currentSessionId = created.sessionId;
          process.stdout.write(`[session ${created.sessionId}]\n`);
        }
        await sendAndStream(context.client, currentSessionId, trimmed, {
          approval: { kind: "interactive", prompt: promptApproval },
        });
      } catch (reason: unknown) {
        printRpcError(reason);
      }
    }
    return 0;
  } finally {
    rl.close();
    await teardown(context);
  }
}

async function printSessions(client: RpcClient): Promise<void> {
  const result = await client.call<SessionListResult>("session.list", {});
  if (result.items.length === 0) {
    process.stdout.write("(no sessions)\n");
    return;
  }
  for (const item of result.items) {
    const title = item.title.length > 0 ? item.title : "(untitled)";
    const time = new Date(item.lastActiveAt).toISOString().replace("T", " ").slice(0, 19);
    process.stdout.write(`${item.id}  ${item.state.padEnd(9)} ${time}  ${title}\n`);
  }
}

function printRpcError(reason: unknown): void {
  if (reason instanceof RpcCallError) {
    process.stdout.write(out.danger(`[error:${reason.code}] ${reason.message}\n`));
    return;
  }
  process.stdout.write(out.danger(`[error] ${reason instanceof Error ? reason.message : String(reason)}\n`));
}
