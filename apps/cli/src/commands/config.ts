/**
 * raincode config dump（T5.5 可观测性）：配置静态归并投影 + 来源标签 + --default-only 损坏诊断。
 *
 * 归并链（dsh dump-config 同纪律：不 boot 服务、不 eval 配置副作用，纯静态列层）：
 *   - Provider 启动配置域：内置默认 → providers 配置文件（providers.local.json）→ env（RAINCODE_PROVIDER_*）→ CLI 参数；
 *   - 全局配置域：内置默认 → <dataRoot>/config.json（permissions/compaction 节当前 schema 已声明、
 *     运行时消费方未接线，如实标注——dump 与实际生效一致是验收标准）。
 *
 * 安全（04 §5.3）：明文 key / ws token 绝不入输出——apiKey 只显示来源层与「已配置」状态，
 * 敏感环境变量值以（已设置，值不打印）遮蔽。
 *
 * --default-only：跳过一切文件读取（config.json / providers 配置文件），只打印内置默认层与
 * 环境变量——配置文件损坏时的恢复诊断模式（正常 dump 在文件损坏时也会尽量打印其余层并报诊断行，
 * 退出码 1）。
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_MAX_CONTEXT_TOKENS,
  resolveProviderConfig,
  resolveDataRoot,
  ConfigStore,
  ConfigStoreError,
} from "@raincode/server";
import type { ResolvedProviderConfig } from "@raincode/server";
import { parseCliArgs } from "../context.js";
import type { ParsedCliArgs } from "../context.js";

/** dump 入参（测试可注入 env/cwd，不触真实用户目录）。 */
export interface DumpConfigOptions {
  env: NodeJS.ProcessEnv;
  /** providers 配置文件与展示路径的编址基准（生产 = process.cwd()）。 */
  cwd: string;
  /** 已解析的 CLI 参数（provider 四要素 + --default-only；positionals 已剥除子命令）。 */
  args: ParsedCliArgs;
  /** 损坏诊断模式：跳过一切文件读取，只打印内置默认层。 */
  defaultOnly: boolean;
}

export interface DumpResult {
  text: string;
  /** 0 = 正常；1 = 有诊断错误（配置文件损坏，其余层已尽量打印）。 */
  exitCode: number;
}

/** 敏感环境变量：值绝不入输出（04 §5.3）。 */
const SENSITIVE_ENV_VARS = new Set(["RAINCODE_PROVIDER_API_KEY", "RAINCODE_WEB_TOKEN"]);

/** 环境变量清单（消费点注记；RAINCODE_APP_VERSION/VERSION 为产物内置常量、桌面开发变量不入表）。 */
const ENV_VAR_DOCS: Array<[string, string]> = [
  ["RAINCODE_HOME", "数据根覆盖（05 §2.1），缺省 ~/.raincode"],
  ["RAINCODE_PROVIDER_BASE_URL", "Provider 启动配置（覆盖配置文件，被 CLI 参数覆盖）"],
  ["RAINCODE_PROVIDER_MODEL", "Provider 启动配置（同上）"],
  ["RAINCODE_PROVIDER_API_KEY", "Provider 明文 key 注入（敏感，值不打印）"],
  ["RAINCODE_PROVIDER_NAME", "Provider 显示名"],
  ["RAINCODE_PROVIDER_MAX_CONTEXT_TOKENS", "Provider 上下文窗口"],
  ["RAINCODE_PROVIDER_CONFIG", "providers 配置文件路径覆盖"],
  ["RAINCODE_WEB_TOKEN", "web 工作台 ws 鉴权 token（敏感，值不打印）"],
  ["RAINCODE_WEB_STATIC", "web 静态资源目录"],
  ["RAINCODE_WS_DELTA_WINDOW_MS", "WS 通道 message.delta 批量窗口毫秒数"],
  ["RAINCODE_CLI_SHOW_REASONING", "CLI 思考块显示开关"],
  ["RAINCODE_MIGRATIONS_DIR", "存储迁移目录覆盖（测试用）"],
];

const SOURCE_LABEL: Record<string, string> = {
  cli: "CLI 参数",
  env: "env",
  config: "配置文件",
  default: "内置默认",
  unset: "未配置",
};

/** 来源层 → 展示标签；config 层区分两文件（config.json / providers 配置文件）。 */
function sourceLabel(layer: string, kind: "global" | "provider"): string {
  if (layer === "config") return kind === "global" ? "config.json" : "providers 配置文件";
  return SOURCE_LABEL[layer] ?? layer;
}

export function dumpConfigText(options: DumpConfigOptions): DumpResult {
  const { env, cwd, args, defaultOnly } = options;
  const lines: string[] = [];
  let exitCode = 0;

  if (defaultOnly) {
    lines.push(
      "raincode config dump --default-only（损坏诊断模式：跳过 config.json 与 providers 配置文件读取，仅打印内置默认层与环境变量）",
      "",
    );
  } else {
    lines.push(
      "raincode config dump（静态归并投影，不启动服务；语义权威 docs/04-architecture §5）",
      "",
    );
  }

  // --- 数据根（只依赖 env，两种模式都打印） ---
  const dataRoot = resolveDataRoot(env);
  lines.push(
    "## 数据根",
    "",
    `- RAINCODE_HOME: ${formatEnvValue("RAINCODE_HOME", env)}`,
    `- dataRoot: ${dataRoot}（来源 ${env["RAINCODE_HOME"] ? "env" : "内置默认 ~/.raincode"}）`,
    "",
  );

  // --- 内置默认层（--default-only 的主体；正常模式并入 config.json 节的来源标签） ---
  if (defaultOnly) {
    lines.push(
      "## 内置默认层",
      "",
      "| 字段 | 值 |",
      "| --- | --- |",
      `| configVersion | ${1} |`,
      "| sandbox.executor | local（config.json 未设置时 node.ts 缺省） |",
      `| Provider maxContextTokens | ${DEFAULT_MAX_CONTEXT_TOKENS} |`,
      "| apiKeyRef scheme | 仅 file:（相对 config.json 所在目录；不支持的前缀直接报错） |",
      `| providers 配置文件缺省路径 | ${join(cwd, "config", "providers.local.json")} |`,
      "| permissions / compaction 节 | schema 已声明，无内置默认值（运行时消费方未接线） |",
      "",
    );
  }

  // --- 全局 config.json（default-only 跳过文件读取） ---
  if (!defaultOnly) {
    const configPath = join(dataRoot, "config.json");
    lines.push(`## 全局 config.json（${configPath}）`, "");
    try {
      const doc = new ConfigStore({ dataRoot }).read();
      if (!existsSync(configPath)) {
        lines.push("（文件不存在——下表为存储层回退的内置默认文档）", "");
      }
      const kind = existsSync(configPath) ? "global" : "default";
      lines.push(
        "| 字段 | 值 | 来源 |",
        "| --- | --- | --- |",
        `| configVersion | ${doc.configVersion} | ${kind === "global" ? "config.json" : "内置默认"} |`,
        `| providers | ${describeProviders(doc.providers ?? [])} | ${doc.providers !== undefined ? "config.json" : "内置默认"} |`,
        `| activeProviderId | ${doc.activeProviderId ?? "（未设置）"} | ${doc.activeProviderId !== undefined ? "config.json" : "内置默认（首个 Provider 引导，未配置则无）"} |`,
      );
      const permissions = doc.permissions?.defaultBehavior;
      lines.push(
        `| permissions.defaultBehavior | ${permissions ?? "（未设置）"} | ${sourceLabel(permissions !== undefined ? "config" : "default", "global")}${DOC_ONLY_NOTE} |`,
      );
      const compaction = doc.compaction;
      lines.push(
        `| compaction | ${compaction ? `thresholdRatio=${compaction.thresholdRatio}, keepRecentCount=${compaction.keepRecentCount}` : "（未设置）"} | ${sourceLabel(compaction !== undefined ? "config" : "default", "global")}${DOC_ONLY_NOTE} |`,
      );
      const sandbox = doc.sandbox;
      lines.push(
        `| sandbox.executor | ${sandbox?.executor ?? "local"} | ${sourceLabel(sandbox !== undefined ? "config" : "default", "global")}（node.ts 读取，缺省 local） |`,
      );
      for (const [key, value] of Object.entries(sandbox ?? {})) {
        if (key === "executor") continue;
        lines.push(`| sandbox.${key} | ${JSON.stringify(value) ?? "（未设置）"} | config.json |`);
      }
    } catch (reason: unknown) {
      exitCode = 1;
      lines.push(
        `⚠ config.json 读取失败：${reason instanceof ConfigStoreError || reason instanceof Error ? reason.message : String(reason)}`,
        "  （--default-only 可跳过文件读取打印内置默认层）",
      );
    }
    lines.push("");
  }

  // --- Provider 启动配置（default-only 不读文件，resolveProviderConfig 需要文件层） ---
  if (!defaultOnly) {
    const providerConfigPath =
      args.providerConfig ?? env["RAINCODE_PROVIDER_CONFIG"] ?? join(cwd, "config", "providers.local.json");
    lines.push("## Provider 启动配置（run/chat/serve；归并链 参数 > env > 配置文件）", "");
    let resolved: ResolvedProviderConfig | null = null;
    try {
      resolved = resolveProviderConfig({
        args: args.provider,
        env,
        configPath: providerConfigPath,
      });
    } catch (reason: unknown) {
      exitCode = 1;
      lines.push(
        `⚠ providers 配置读取失败：${reason instanceof Error ? reason.message : String(reason)}`,
        "  （--default-only 可跳过文件读取打印内置默认层）",
      );
    }
    if (resolved === null) {
      lines.push("未配置任何 Provider（run/chat 将报 no provider configured；ping/list/resume 可用）。");
    } else {
      const fields: Array<[string, string, string]> = [
        ["baseURL", resolved.baseURL, sourceLabel(resolved.fieldSources.baseURL, "provider")],
        ["model", resolved.model, sourceLabel(resolved.fieldSources.model, "provider")],
        [
          "name",
          resolved.name,
          `${sourceLabel(resolved.fieldSources.name, "provider")}${resolved.fieldSources.name === "default" ? "（缺省=model）" : ""}`,
        ],
        ["maxContextTokens", String(resolved.maxContextTokens), sourceLabel(resolved.fieldSources.maxContextTokens, "provider")],
        [
          "apiKey",
          resolved.fieldSources.apiKey === "unset" ? "（未配置）" : "（已配置，值不打印）",
          sourceLabel(resolved.fieldSources.apiKey, "provider"),
        ],
      ];
      lines.push(
        `配置文件路径：${resolved.configPath}`,
        "",
        "| 字段 | 值 | 来源 |",
        "| --- | --- | --- |",
        ...fields.map(([name, value, source]) => `| ${name} | ${value} | ${source} |`),
      );
    }
    lines.push("");
  }

  // --- 环境变量（两种模式都打印；env 读取无文件依赖，损坏诊断仍可用） ---
  lines.push("## 环境变量（RAINCODE_*）", "", "| 变量 | 值 | 说明 |", "| --- | --- | --- |");
  for (const [name, doc] of ENV_VAR_DOCS) {
    lines.push(`| ${name} | ${formatEnvValue(name, env)} | ${doc} |`);
  }
  lines.push("");
  return { text: `${lines.join("\n")}\n`, exitCode };
}

const DOC_ONLY_NOTE = "（schema 已声明，运行时消费方未接线）";

/** env 值展示：敏感变量遮蔽为设置状态，其余原样（未设置 → （未设置））。 */
function formatEnvValue(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (value === undefined || value.length === 0) return "（未设置）";
  if (SENSITIVE_ENV_VARS.has(name)) return "（已设置，值不打印）";
  return value;
}

function describeProviders(providers: Array<{ id?: string; name: string; model: string }>): string {
  if (providers.length === 0) return "0 个";
  return `${providers.length} 个（${providers
    .map((p) => `id=${p.id ?? p.name} model=${p.model}`)
    .join("; ")}）`;
}

/** `raincode config` 子命令入口（main 分发；config dump 之外报用法错误）。 */
export async function runConfigCommand(argv: string[]): Promise<number> {
  const subcommand = argv[0];
  if (subcommand !== "dump") {
    process.stderr.write(
      [
        "用法: raincode config dump [--default-only] [Provider 选项]",
        "",
        "  --default-only    损坏诊断模式：跳过配置文件读取，只打印内置默认层与环境变量",
        "  Provider 选项     与 run/chat 相同（--base-url/--model/--api-key/--name/--provider-config），",
        "                    dump 会按归并链展示覆盖结果",
        "",
      ].join("\n") + "\n",
    );
    return 2;
  }
  const args = parseCliArgs(argv.slice(1));
  const result = dumpConfigText({
    env: process.env,
    cwd: resolve(),
    args,
    defaultOnly: args.defaultOnly === true,
  });
  process.stdout.write(result.text);
  return result.exitCode;
}
