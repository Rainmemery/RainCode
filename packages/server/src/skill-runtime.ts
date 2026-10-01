/**
 * SkillRuntime：skills 域装配（T3.4 / 06-api-spec §2.9）。
 *
 * - skills.list：双源技能清单（sessionId 提供时含该会话 workspace 层，global 兜底；
 *   同名 workspace 优先；非法文件跳过不阻塞面板——低频控制面，坏文件只产诊断，同 profile 清单口径）；
 * - skills.invoke：按名解析 → 模板展开（agent-core expandSkillTemplate，$ARGUMENTS 替换 /
 *   无占位符追加）→ 复用 session.send 提交链（agent-service.submitTurn 注入；受理即返 +
 *   usage 旁路，turn 事件流与 send 一致，端层复用同一渲染管线）。
 *
 * 展开在 server 侧（04 ADR-06 唯一组装点）：CLI 与桌面端只做 `/name args` 转发，无第二展开点；
 * workspace 层技能目录按会话 workspaceRoot 逐会话解析（storage.workspaceRootOf），
 * 装配期无需 workspace 参数（与 memory 域同形态，与 subagent 域装配期解析不同——技能调用总是会话内行为）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RpcCallError } from "@raincode/rpc";
import { SkillError, expandSkillTemplate, parseSkillMarkdown, resolveSkillFile } from "@raincode/agent-core";
import type { SkillDir } from "@raincode/agent-core";
import type { SkillSummary, SkillsInvokeParams, SkillsListParams } from "@raincode/shared";

/** skills 域装配依赖（agent-service 注入；风格对齐 SubagentRuntimeOptions）。 */
export interface SkillRuntimeOptions {
  /** 数据根（global 技能目录 <dataRoot>/skills）。 */
  dataRoot: string;
  /** 会话 → workspace 根反查（storage.workspaceRootOf 转发）；null = 会话或工作区记录不存在。 */
  workspaceRootOf: (sessionId: string) => Promise<string | null>;
  /** turn 提交链（agent-service.submitTurn 注入：requireActive + provider 缺席拒绝 + 受理即返 + usage 旁路）。 */
  submitTurn: (sessionId: string, text: string) => Promise<unknown>;
  /** 诊断出口（缺省 console.error，风格同 subagent-runtime）。 */
  onDiagnostic?: (message: string, err?: unknown) => void;
}

export class SkillRuntime {
  constructor(private readonly options: SkillRuntimeOptions) {}

  /** 控制面方法表（06 §2.9 skills 域 2 方法；形态对齐 subagent-runtime.methods）。 */
  methods(register: (method: string, handler: (params: unknown) => Promise<unknown>) => unknown): Record<string, unknown> {
    return {
      "skills.list": register("skills.list", async (params) => this.list(params as SkillsListParams)),
      "skills.invoke": register("skills.invoke", async (params) => this.invoke(params as SkillsInvokeParams)),
    };
  }

  // -------------------------------------------------------------------------
  // 控制面方法（06 §2.9）
  // -------------------------------------------------------------------------

  /** skills.list：双源清单（frontmatter 投影，不含模板正文）；sessionId 未命中 → SESSION_NOT_FOUND。 */
  private async list(params: SkillsListParams): Promise<{ items: SkillSummary[] }> {
    return { items: this.skillCatalog(await this.skillDirs(params.sessionId)) };
  }

  /**
   * skills.invoke：解析（NOT_FOUND/INVALID 透传域码）→ 展开 → 提交链受理。
   * 会话存在性/活跃性由 submitTurn（requireActive）统一判定，语义与 session.send 完全一致。
   */
  private async invoke(params: SkillsInvokeParams): Promise<unknown> {
    const dirs = await this.skillDirs(params.sessionId);
    const { skill } = this.resolveSkill(dirs, params.name);
    const expanded = expandSkillTemplate(skill.template, params.arguments);
    return this.options.submitTurn(params.sessionId, expanded);
  }

  // -------------------------------------------------------------------------
  // 目录与解析（低频同步 IO，同 profile 口径）
  // -------------------------------------------------------------------------

  /** 技能目录候选：sessionId 提供时 workspace 层优先（未命中会话 → SESSION_NOT_FOUND），global 兜底。 */
  private async skillDirs(sessionId: string | undefined): Promise<SkillDir[]> {
    const dirs: SkillDir[] = [];
    if (sessionId !== undefined) {
      const root = await this.options.workspaceRootOf(sessionId);
      if (root === null) {
        throw new RpcCallError("SESSION_NOT_FOUND", `session not found: ${sessionId}`);
      }
      dirs.push({ path: join(root, ".raincode", "skills"), source: "workspace" });
    }
    dirs.push({ path: join(this.options.dataRoot, "skills"), source: "global" });
    return dirs;
  }

  /** 按名解析（agent-core resolveSkillFile；SkillError 域码透传，错误语义同 profile 解析）。 */
  private resolveSkill(dirs: readonly SkillDir[], name: string) {
    try {
      return resolveSkillFile(dirs, name);
    } catch (reason: unknown) {
      if (reason instanceof SkillError) {
        throw new RpcCallError(reason.code, reason.message);
      }
      throw reason;
    }
  }

  /** 双源清单（skills.list 数据源）：扫描两目录 *.md，同名（frontmatter name）workspace 优先。 */
  private skillCatalog(dirs: readonly SkillDir[]): SkillSummary[] {
    const byName = new Map<string, SkillSummary>();
    for (const dir of dirs) {
      for (const fileName of this.listSkillFiles(dir.path)) {
        try {
          const raw = readFileSync(join(dir.path, fileName), "utf8");
          const skill = parseSkillMarkdown(raw, fileName.replace(/\.md$/, ""));
          if (byName.has(skill.name)) continue; // 同名跨层：dirs 有序，workspace 先命中生效
          byName.set(skill.name, {
            name: skill.name,
            description: skill.description,
            source: dir.source,
            ...(skill.argumentHint !== undefined && { argumentHint: skill.argumentHint }),
          });
        } catch (reason: unknown) {
          this.diag(`技能解析失败，已跳过: ${join(dir.path, fileName)}`, reason);
        }
      }
    }
    return [...byName.values()];
  }

  /** 目录 *.md 文件名列举（目录缺失/不可读返回空——目录属可选配置，不视为错误）。 */
  private listSkillFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir).filter((name) => name.endsWith(".md"));
    } catch (reason: unknown) {
      this.diag(`技能目录读取失败: ${dir}`, reason);
      return [];
    }
  }

  private diag(message: string, err?: unknown): void {
    const sink =
      this.options.onDiagnostic ??
      ((text: string, error?: unknown) => console.error(`[raincode/server] ${text}`, error ?? ""));
    sink(message, err);
  }
}
