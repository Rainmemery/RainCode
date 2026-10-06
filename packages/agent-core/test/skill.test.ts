/**
 * 技能包解析/双源解析/模板展开单测（T3.4，M3）。
 * 覆盖：frontmatter 解析与校验（name 回退文件名 / description 必填 / argumentHint 可选）、
 * 双源目录先命中生效（workspace 优先）、名字正则挡路径逃逸、
 * $ARGUMENTS 占位替换与无占位符追加语义（expandSkillTemplate）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  SKILL_NAME_PATTERN,
  SkillError,
  expandSkillTemplate,
  parseSkillMarkdown,
  resolveSkillFile,
} from "../src/index.js";

describe("parseSkillMarkdown（T3.4 技能包规范）", () => {
  it("frontmatter 完整：name/description/argumentHint + 正文模板", () => {
    const raw = [
      "---",
      "name: review",
      "description: 对指定文件做代码审查",
      'argumentHint: "<file 或关注点>"',
      "---",
      "",
      "请审查 $ARGUMENTS 的代码质量。",
    ].join("\n");
    const skill = parseSkillMarkdown(raw, "fallback");
    assert.equal(skill.name, "review");
    assert.equal(skill.description, "对指定文件做代码审查");
    assert.equal(skill.argumentHint, "<file 或关注点>");
    assert.equal(skill.template, "请审查 $ARGUMENTS 的代码质量。");
  });

  it("name 缺省回退文件名（去 .md）", () => {
    const skill = parseSkillMarkdown("---\ndescription: 无名技能\n---\n\n正文", "gen-docs");
    assert.equal(skill.name, "gen-docs");
    assert.equal(skill.argumentHint, undefined);
  });

  it("缺 frontmatter → SKILL_INVALID（description 无处可取）", () => {
    assert.throws(() => parseSkillMarkdown("没有围栏的正文", "x"), (err: unknown) => {
      assert.ok(err instanceof SkillError);
      assert.equal(err.code, "SKILL_INVALID");
      return true;
    });
  });

  it("缺 description / name 非法 → SKILL_INVALID", () => {
    assert.throws(() => parseSkillMarkdown("---\nname: ok\n---\n\n正文", "x"), (err: unknown) => {
      assert.ok(err instanceof SkillError && err.code === "SKILL_INVALID");
      return true;
    });
    assert.throws(() => parseSkillMarkdown("---\nname: Bad_Name\ndescription: d\n---\n\n正文", "x"), (err: unknown) => {
      assert.ok(err instanceof SkillError && err.code === "SKILL_INVALID");
      return true;
    });
  });

  it("SKILL_NAME_PATTERN：小写字母/数字/连字符", () => {
    assert.ok(SKILL_NAME_PATTERN.test("review-pr"));
    assert.ok(!SKILL_NAME_PATTERN.test("../escape"));
    assert.ok(!SKILL_NAME_PATTERN.test("Review"));
  });
});

describe("resolveSkillFile（workspace/global 双源）", () => {
  const home = mkdtempSync(join(tmpdir(), "raincode-skill-test-"));
  const workspace = join(home, "ws");
  after(() => rmSync(home, { recursive: true, force: true }));

  it("workspace 层先命中生效；global 兜底；全未命中 SKILL_NOT_FOUND", () => {
    mkdirSync(join(workspace, ".raincode", "skills"), { recursive: true });
    mkdirSync(join(home, "skills"), { recursive: true });
    writeFileSync(
      join(workspace, ".raincode", "skills", "review.md"),
      "---\nname: review\ndescription: ws 版\n---\n\nWS",
      "utf8",
    );
    writeFileSync(join(home, "skills", "review.md"), "---\ndescription: global 版\n---\n\nGLOBAL", "utf8");
    writeFileSync(join(home, "skills", "deploy.md"), "---\ndescription: 部署检查\n---\n\nDEPLOY", "utf8");

    const dirs = [
      { path: join(workspace, ".raincode", "skills"), source: "workspace" as const },
      { path: join(home, "skills"), source: "global" as const },
    ];
    const wsHit = resolveSkillFile(dirs, "review");
    assert.equal(wsHit.skill.source, "workspace");
    assert.equal(wsHit.skill.description, "ws 版");
    const globalHit = resolveSkillFile(dirs, "deploy");
    assert.equal(globalHit.skill.source, "global");
    assert.equal(globalHit.skill.name, "deploy"); // name 回退文件名
    assert.throws(() => resolveSkillFile(dirs, "no-such"), (err: unknown) => {
      assert.ok(err instanceof SkillError && err.code === "SKILL_NOT_FOUND");
      return true;
    });
  });

  it("plugin 第三源（T6.1）：workspace > global > plugin 优先级——用户自定义可覆盖市场随附技能", () => {
    const pluginRoot = join(home, "mkt-cache", "hello", "0.1.0", "skills");
    mkdirSync(pluginRoot, { recursive: true });
    writeFileSync(join(pluginRoot, "review.md"), "---\nname: review\ndescription: plugin 版\n---\n\nPLUGIN", "utf8");
    writeFileSync(join(pluginRoot, "vendor-only.md"), "---\ndescription: 市场独有技能\n---\n\nVENDOR", "utf8");
    writeFileSync(join(home, "skills", "vendor-both.md"), "---\ndescription: global 版\n---\n\nGLOBAL", "utf8");
    writeFileSync(join(pluginRoot, "vendor-both.md"), "---\ndescription: plugin 版\n---\n\nPLUGIN", "utf8");

    const dirs = [
      { path: join(workspace, ".raincode", "skills"), source: "workspace" as const },
      { path: join(home, "skills"), source: "global" as const },
      { path: pluginRoot, source: "plugin" as const },
    ];
    // plugin 源独有技能可见
    const vendorHit = resolveSkillFile(dirs, "vendor-only");
    assert.equal(vendorHit.skill.source, "plugin");
    // global 与 plugin 双层同名 → global 生效（用户覆盖市场技能）
    const globalOverPlugin = resolveSkillFile(dirs, "vendor-both");
    assert.equal(globalOverPlugin.skill.source, "global");
    // 三层同名 → workspace 最高优先（既有行为不回退）
    const wsTop = resolveSkillFile(dirs, "review");
    assert.equal(wsTop.skill.source, "workspace");
  });

  it("首个命中者解析失败即 INVALID，不回落后续目录", () => {
    const a = join(home, "a");
    const b = join(home, "b");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    writeFileSync(join(a, "bad.md"), "无 frontmatter", "utf8");
    writeFileSync(join(b, "bad.md"), "---\ndescription: 合法\n---\n\nB", "utf8");
    assert.throws(() => resolveSkillFile([{ path: a, source: "workspace" }, { path: b, source: "global" }], "bad"), (
      err: unknown,
    ) => {
      assert.ok(err instanceof SkillError && err.code === "SKILL_INVALID");
      return true;
    });
  });

  it("非法名（路径逃逸形态）直接 SKILL_NOT_FOUND，不触碰文件系统", () => {
    assert.throws(() => resolveSkillFile([{ path: join(home, "skills"), source: "global" }], "../etc/passwd"), (
      err: unknown,
    ) => {
      assert.ok(err instanceof SkillError && err.code === "SKILL_NOT_FOUND");
      return true;
    });
  });
});

describe("expandSkillTemplate（T3.4 展开语义）", () => {
  it("$ARGUMENTS 占位替换（含多次出现）", () => {
    assert.equal(
      expandSkillTemplate("审查 $ARGUMENTS 并总结 $ARGUMENTS 的风险", "src/a.ts"),
      "审查 src/a.ts 并总结 src/a.ts 的风险",
    );
  });

  it("无占位符且有参数 → 参数独立行追加模板末尾", () => {
    assert.equal(expandSkillTemplate("部署前检查清单：", "staging 环境"), "部署前检查清单：\n\nstaging 环境");
  });

  it("无占位符且无参数 → 模板原样", () => {
    assert.equal(expandSkillTemplate("今日站会纪要模板", undefined), "今日站会纪要模板");
    assert.equal(expandSkillTemplate("模板", "   "), "模板");
  });
});

describe("parseSkillMarkdown modelInvocable 开关（T4.4 模型侧可发现性）", () => {
  it("缺省（无字段/空值）→ true", () => {
    assert.equal(parseSkillMarkdown("---\ndescription: 甲\n---\n\n正文", "a").modelInvocable, true);
    assert.equal(parseSkillMarkdown("---\ndescription: 甲\nmodelInvocable:\n---\n\n正文", "b").modelInvocable, true);
  });

  it("显式 true/false 正确解析", () => {
    assert.equal(parseSkillMarkdown("---\ndescription: 甲\nmodelInvocable: true\n---\n\n正文", "c").modelInvocable, true);
    assert.equal(parseSkillMarkdown("---\ndescription: 乙\nmodelInvocable: false\n---\n\n正文", "d").modelInvocable, false);
  });

  it("非法值 → SKILL_INVALID", () => {
    assert.throws(() => parseSkillMarkdown("---\ndescription: 丙\nmodelInvocable: yes\n---\n\n正文", "e"), (err: unknown) => {
      assert.ok(err instanceof SkillError);
      assert.equal(err.code, "SKILL_INVALID");
      return true;
    });
  });
});
