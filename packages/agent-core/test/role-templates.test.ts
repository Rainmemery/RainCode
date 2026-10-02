/**
 * 内置角色模板单测（T3.6，M3）：模板结构合法（名字/描述/工具白名单/maxTurns/系统提示）
 * 与 builtinRoleOf 查找语义——模板直接进 spawn 链路，结构非法会让运行期才炸，加载期断言拦住。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUILTIN_ROLE_TEMPLATES, SUBAGENT_NAME_PATTERN, builtinRoleOf } from "../src/index.js";

/** 内置工具名全集（与 packages/mcp/src/config.ts BUILTIN_TOOL_NAMES 同步快照；越界即测试失败提醒同步）。 */
const KNOWN_BUILTIN_TOOLS = new Set([
  "bash", "read", "write", "edit", "glob", "grep", "todo_write", "web_fetch", "ask_user_question",
]);

describe("BUILTIN_ROLE_TEMPLATES（T3.6 内置角色模板）", () => {
  it("至少 3 个模板；名字合法且互不重复", () => {
    assert.ok(BUILTIN_ROLE_TEMPLATES.length >= 3, "至少 researcher/reviewer/tester 三个");
    const names = BUILTIN_ROLE_TEMPLATES.map((template) => template.name);
    assert.ok(names.every((name) => SUBAGENT_NAME_PATTERN.test(name)), `名字全过 [a-z0-9-]+（${JSON.stringify(names)}）`);
    assert.equal(new Set(names).size, names.length, "名字互不重复");
  });

  it("每个模板：description/systemPrompt 非空、maxTurns 1~100、tools ⊆ 内置工具名", () => {
    for (const template of BUILTIN_ROLE_TEMPLATES) {
      assert.ok(template.description.length > 0, `${template.name} description 非空`);
      assert.ok(template.systemPrompt.trim().length > 0, `${template.name} systemPrompt 非空`);
      assert.ok(template.maxTurns >= 1 && template.maxTurns <= 100, `${template.name} maxTurns 越界`);
      for (const tool of template.tools ?? []) {
        assert.ok(KNOWN_BUILTIN_TOOLS.has(tool), `${template.name} 引用未知工具 "${tool}"`);
      }
    }
  });

  it("builtinRoleOf：按名命中 / 未命中 undefined", () => {
    assert.ok(builtinRoleOf("researcher") !== undefined);
    assert.equal(builtinRoleOf("no-such-role"), undefined);
    assert.equal(builtinRoleOf("../escape"), undefined);
  });
});
