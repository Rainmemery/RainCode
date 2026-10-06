/**
 * pinned 包管理器校验单测（T5.7 门禁升级轮测试补全；实现 scripts/check-pinned-manager.mjs 纯函数面）。
 * 动因：MiMo pinned 教训（调研报告 §2.1 build.ts:22-29）——杂散包管理器二进制可致运行时挂死
 * 而 smoke 仍绿；packageManager 字段形态校验 = 第一道闸。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parsePinnedManager } from "../../../scripts/check-pinned-manager.mjs";

describe("parsePinnedManager（pinned 包管理器校验纯函数面）", () => {
  it("精确 pinned 形态通过：pnpm@11.24.0", () => {
    assert.deepEqual(parsePinnedManager("pnpm@11.24.0"), { name: "pnpm", version: "11.24.0" });
  });

  it("corepack 改写形态（+sha512 哈希后缀）仍为精确 pinned，通过", () => {
    const parsed = parsePinnedManager("pnpm@11.24.0+sha512.abcdef0123456789");
    assert.equal(parsed.version, "11.24.0");
  });

  it("范围形态一律拒绝（^ / ~ / >= / 区间）", () => {
    for (const field of ["pnpm@^11.24.0", "pnpm@~11.24.0", "pnpm@>=10", "pnpm@11.x", "pnpm@11.24.0 - 12.0.0"]) {
      assert.throws(() => parsePinnedManager(field), /精确 pinned/, `${field} 应拒绝`);
    }
  });

  it("非 pnpm 包管理器与缺失/非字符串字段拒绝", () => {
    assert.throws(() => parsePinnedManager("npm@10.0.0"), /pnpm@/);
    assert.throws(() => parsePinnedManager(undefined), /缺少 packageManager/);
    assert.throws(() => parsePinnedManager(""), /缺少 packageManager/);
    assert.throws(() => parsePinnedManager(11), /缺少 packageManager|精确 pinned/);
  });
});
