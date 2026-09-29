/**
 * bash 命令级规则求值器（02-module-design §6.2「bash 命令级求值」/ §6.3 BashRuleEvaluator）。
 *
 * 1. argv 解析：命令串 → 分段结构（识别 &&/||/;/|/& 链式分段、引号与转义、wrapper 命令
 *    sudo/env/nohup/time、脚本执行器版本旗标）；变量展开/子 shell/引号不闭合 → inconclusive
 *    （宁严勿松，02 §6.4 → ask）；
 * 2. 只读白名单：内置只读命令注册表（git status/log/diff、ls、cat 等），全段只读才判只读；
 *    含重定向的片段不判只读（写副作用）；
 * 3. 高危根命令（rm/sh/powershell/dd/mkfs…）：禁止被通配规则 allow（02 §6.4「匹配器强制
 *    跳过 allow 语义」），匹配由 Service 层结合本求值器的 dangerous 标记执行。
 */
import type { BashCommandAnalysis, BashSegment } from "./types.js";
import type { PermissionRule } from "@raincode/shared";
import {
  DANGEROUS_ROOTS,
  ENV_ASSIGNMENT,
  READONLY_GIT_SUBCOMMANDS,
  READONLY_ROOTS,
  VERSION_FLAG,
  VERSION_ONLY_ROOTS,
  WRAPPER_ROOTS,
  WRAPPER_VALUE_OPTS,
} from "./bash-tables.js";

export class BashRuleEvaluator {
  /** argv 分段 + wrapper/脚本识别（02 §6.3 parse）。 */
  parse(command: string): BashCommandAnalysis {
    const segments: BashSegment[] = [];
    let inconclusive = false;
    const markInconclusive = (): void => {
      inconclusive = true;
    };
    for (const raw of splitTopLevel(command, markInconclusive)) {
      const trimmed = raw.trim();
      if (trimmed.length === 0) continue;
      const tokenized = tokenize(trimmed, markInconclusive);
      if (tokenized.argv.length === 0) continue;
      const classified = classify(tokenized.argv, tokenized.hasRedirect);
      segments.push({
        raw: trimmed,
        text: tokenized.argv.join(" "),
        root: classified.root,
        readonly: classified.readonly,
        dangerous: classified.dangerous,
      });
    }
    if (segments.length === 0 && command.trim().length > 0) {
      inconclusive = true;
    }
    return { segments, inconclusive };
  }

  /** 只读白名单（02 §6.3 isReadOnlyCommand）：全段只读才为 true。 */
  isReadOnlyCommand(command: string): boolean {
    const analysis = this.parse(command);
    return (
      !analysis.inconclusive &&
      analysis.segments.length > 0 &&
      analysis.segments.every((segment) => segment.readonly)
    );
  }

  /** 高危根命令探测（任一含高危根命令的片段即成立）。 */
  isDangerousCommand(command: string): boolean {
    return this.parse(command).segments.some((segment) => segment.dangerous);
  }

  /**
   * 通配/精确/正则规则匹配（02 §6.3 matchRules）：返回最严命中规则；无命中返回 null。
   * 高危片段命中 allow 通配规则时跳过该规则（02 §6.4：降级为 ask）。
   */
  matchRules(analysis: BashCommandAnalysis, rules: PermissionRule[]): PermissionRule | null {
    if (analysis.inconclusive || analysis.segments.length === 0) {
      return null;
    }
    const hits: PermissionRule[] = [];
    for (const rule of rules) {
      const matchedSegments = analysis.segments.filter((segment) => this.segmentMatches(rule, segment.text));
      if (matchedSegments.length === 0) continue;
      if (
        rule.behavior === "allow" &&
        effectiveMatchType(rule) === "wildcard" &&
        matchedSegments.some((segment) => segment.dangerous)
      ) {
        continue; // 02 §6.4：高危根命令不允许被通配规则 allow
      }
      hits.push(rule);
    }
    return strictestRule(hits);
  }

  /** 单条规则对单个规范化片段的匹配（wildcard / exact / regex）。 */
  segmentMatches(rule: PermissionRule, segmentText: string): boolean {
    const pattern = rule.pattern ?? null;
    if (pattern === null || pattern.length === 0) {
      return true; // pattern 缺省 = 匹配该工具全部调用（02 §6.3）
    }
    switch (effectiveMatchType(rule)) {
      case "exact":
        return pattern === segmentText;
      case "regex":
        try {
          return new RegExp(pattern).test(segmentText);
        } catch {
          return false; // 非法正则永不命中（add 规则入口已校验）
        }
      case "wildcard":
      default:
        return wildcardToRegExp(pattern).test(segmentText);
    }
  }
}

// ---------------------------------------------------------------------------

function effectiveMatchType(rule: PermissionRule): "wildcard" | "exact" | "regex" {
  return rule.matchType ?? "wildcard";
}

function strictestRule(rules: PermissionRule[]): PermissionRule | null {
  const rank = (behavior: string): number => (behavior === "deny" ? 2 : behavior === "ask" ? 1 : 0);
  let best: PermissionRule | null = null;
  for (const rule of rules) {
    if (
      best === null ||
      rank(rule.behavior) > rank(best.behavior) ||
      (rule.behavior === best.behavior && rule.createdAt > best.createdAt)
    ) {
      best = rule; // 层级内 deny > ask > allow；同行为取最新（02 §6.4）
    }
  }
  return best;
}

/** 通配模式（仅 `*`）→ 全串正则（大小写敏感）。 */
function wildcardToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*");
  return new RegExp(`^${escaped}$`);
}

interface SplitResult {
  argv: string[];
  hasRedirect: boolean;
}

/** 顶层链式分段：&&/||/;/|/&/换行（引号内不分段）；未闭合引号与展开 → inconclusive。 */
function splitTopLevel(command: string, markInconclusive: () => void): string[] {
  const parts: string[] = [];
  let current = "";
  let single = false;
  let double = false;

  const flush = (): void => {
    parts.push(current);
    current = "";
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;
    if (single) {
      current += ch;
      if (ch === "'") single = false;
      continue;
    }
    if (double) {
      if (ch === "\\" && i + 1 < command.length) {
        current += ch + command[i + 1]!;
        i += 1;
        continue;
      }
      if (ch === '"') {
        double = false;
        current += ch;
        continue;
      }
      if (ch === "$" || ch === "`") markInconclusive(); // 双引号内展开/子 shell
      current += ch;
      continue;
    }
    if (ch === "'") {
      single = true;
      current += ch;
      continue;
    }
    if (ch === '"') {
      double = true;
      current += ch;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= command.length) {
        markInconclusive(); // 尾随转义
      }
      current += ch;
      continue;
    }
    if (ch === "$" || ch === "`") {
      markInconclusive(); // 非单引号内的变量展开/子 shell（02 §6.4 inconclusive → ask）
      current += ch;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "&" || ch === "|") {
      if (ch === "&" && (current.endsWith(">") || (current.endsWith("2") && command[i - 1] === ">"))) {
        // `2>&1` / `>&` 属重定向语法，非链式分段符
        current += ch;
        continue;
      }
      if ((ch === "&" || ch === "|") && command[i + 1] === ch) {
        flush();
        i += 1;
        continue;
      }
      flush();
      continue;
    }
    current += ch;
  }
  if (single || double) markInconclusive();
  flush();
  return parts;
}

/** 片段 → argv（引号解包 + 转义；重定向探测）。 */
function tokenize(segment: string, markInconclusive: () => void): SplitResult {
  const argv: string[] = [];
  let hasRedirect = false;
  let current = "";
  let hasWord = false;
  let single = false;
  let double = false;

  const pushWord = (): void => {
    if (hasWord) argv.push(current);
    current = "";
    hasWord = false;
  };

  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i]!;
    if (single) {
      current += ch;
      if (ch === "'") single = false;
      continue;
    }
    if (double) {
      if (ch === "\\" && i + 1 < segment.length) {
        current += segment[i + 1]!;
        i += 1;
        continue;
      }
      if (ch === '"') {
        double = false;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === "'") {
      single = true;
      hasWord = true;
      continue;
    }
    if (ch === '"') {
      double = true;
      hasWord = true;
      continue;
    }
    if (ch === "\\" && i + 1 < segment.length) {
      current += segment[i + 1]!;
      hasWord = true;
      i += 1;
      continue;
    }
    if (ch === ">" || ch === "<") {
      hasRedirect = true;
      pushWord();
      if (ch === ">" && segment[i + 1] === ">") i += 1; // 跳过 >> 的第二个 >
      if (segment[i + 1] === "&") i += 1; // 跳过 >&（如 2>&1，&1 由后续词收集）
      continue;
    }
    if (/\s/.test(ch)) {
      pushWord();
      continue;
    }
    current += ch;
    hasWord = true;
  }
  if (single || double) markInconclusive();
  pushWord();
  return { argv, hasRedirect };
}

interface Classified {
  root: string;
  readonly: boolean;
  dangerous: boolean;
}

/** wrapper 剥壳 + 根命令分类（只读白名单 / 高危 / 普通）。 */
function classify(argv: string[], hasRedirect: boolean): Classified {
  let rest = argv.slice();
  let root = (rest[0] ?? "").toLowerCase();

  while (WRAPPER_ROOTS.has(root)) {
    rest = rest.slice(1);
    while (rest.length > 0) {
      const head = rest[0]!;
      if (head.startsWith("-") && head !== "-") {
        rest = rest.slice(1);
        if (WRAPPER_VALUE_OPTS.has(head) && rest.length > 0 && !rest[0]!.startsWith("-")) {
          rest = rest.slice(1); // 带值选项一并丢弃（近似：env -u NAME 等）
        }
        continue;
      }
      if (ENV_ASSIGNMENT.test(head)) {
        rest = rest.slice(1); // env VAR=val CMD
        continue;
      }
      break;
    }
    if (rest.length === 0) {
      return { root, readonly: !hasRedirect, dangerous: false }; // 纯 wrapper（如 `env` 打印环境）
    }
    root = rest[0]!.toLowerCase();
  }

  const args = rest.slice(1);
  if (DANGEROUS_ROOTS.has(root)) {
    return { root, readonly: false, dangerous: true };
  }
  if (root === "git") {
    return { root, readonly: isReadonlyGit(args) && !hasRedirect, dangerous: false };
  }
  if (VERSION_ONLY_ROOTS.has(root)) {
    return { root, readonly: args.every((arg) => VERSION_FLAG.test(arg)) && !hasRedirect, dangerous: false };
  }
  if (READONLY_ROOTS.has(root)) {
    return { root, readonly: !hasRedirect, dangerous: false };
  }
  return { root, readonly: false, dangerous: false };
}

/** git 子命令只读判定（branch/tag/remote/config/stash/worktree 按参数形态细分）。 */
function isReadonlyGit(args: string[]): boolean {
  if (args.length === 0) return true; // `git` 打印用法，无副作用
  const sub = args[0]!.toLowerCase();
  if (sub.startsWith("-")) return args.every((arg) => VERSION_FLAG.test(arg)); // git --version
  if (!READONLY_GIT_SUBCOMMANDS.has(sub)) return false;
  const rest = args.slice(1);
  switch (sub) {
    case "branch":
    case "tag":
    case "remote":
      return rest.every((arg) => arg.startsWith("-")); // 带位置参数即写（branch <name> 等）
    case "config":
      return rest.length === 0 || /^(--get|--get-all|--get-regexp|--list|-l)$/.test(rest[0]!);
    case "stash":
    case "worktree": {
      const next = rest[0]?.toLowerCase();
      return next === undefined || next === "list" || next === "show";
    }
    default:
      return true;
  }
}
