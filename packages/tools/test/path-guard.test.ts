/**
 * guardPath / normalizeForGuard 单测（T2.7 任务 4 的守卫层断言）。
 * 02-module-design §5.1/§5.3：workspace 内放行、越界拒绝（.. 逃逸 / 绝对路径越界）、
 * win32 大小写不敏感规范化比对、PathPolicyHook.allowEscaped 显式放行（02 §5.4 权限层钩子）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join, resolve } from "node:path";
import { guardPath, normalizeForGuard } from "../src/index.js";

/** 以测试进程 cwd 为 workspace 基准（平台中立；守卫只做路径运算不做 IO）。 */
const root = process.cwd();

describe("guardPath（02 §5.1）", () => {
  it("workspace 内相对路径：放行并返回绝对路径", () => {
    const verdict = guardPath(root, "src/a/b.ts");
    assert.equal(verdict.ok, true);
    assert.ok(verdict.ok && verdict.absolutePath === resolve(root, "src/a/b.ts"));
  });

  it("target 为 '.'：返回 workspaceRoot 本身", () => {
    const verdict = guardPath(root, ".");
    assert.equal(verdict.ok, true);
    assert.ok(verdict.ok && resolve(verdict.absolutePath) === resolve(root));
  });

  it("workspace 内绝对路径：放行", () => {
    const verdict = guardPath(root, join(root, "inside.txt"));
    assert.equal(verdict.ok, true);
  });

  it(".. 逃逸：拒绝并标记 escaped", () => {
    const verdict = guardPath(root, "../outside.txt");
    assert.deepEqual(verdict, {
      ok: false,
      absolutePath: resolve(root, "../outside.txt"),
      reason: "escaped",
    });
  });

  it("绝对路径越界：拒绝", () => {
    const outside = resolve(root, "../sibling/x.txt");
    const verdict = guardPath(root, outside);
    assert.equal(verdict.ok, false);
    assert.ok(!verdict.ok && verdict.reason === "escaped");
  });

  it("同前缀但非子路径（目录名前缀撞车）：拒绝", () => {
    // 构造与 root 仅差一个后缀字符的兄弟目录（如 NovaCode → NovaCode-other）：
    // 字符串级共享前缀，但非 root 的子路径，守卫必须拒绝
    const parent = resolve(root, "..");
    const sibling = `${parent}${resolve(root).slice(parent.length)}-other/x`;
    const verdict = guardPath(root, sibling);
    assert.equal(verdict.ok, false, "前缀比对必须按路径段（root + /）而非裸字符串");
  });

  it("win32 大小写不敏感（02 §5.3）", (t) => {
    if (process.platform !== "win32") {
      t.skip("仅 win32 平台适用");
      return;
    }
    assert.equal(guardPath(root, root.toUpperCase()).ok, true);
    assert.equal(guardPath(root.toUpperCase(), join(root, "a.txt")).ok, true);
    assert.equal(guardPath(root, join(root, "a.txt").toUpperCase()).ok, true);
  });
});

describe("guardPath × PathPolicyHook（02 §5.4 放行钩子）", () => {
  const escaped = resolve(root, "../approved.txt");

  it("hook 允许该绝对路径：放行", () => {
    const verdict = guardPath(root, "../approved.txt", { allowEscaped: () => true });
    assert.equal(verdict.ok, true);
    assert.ok(verdict.ok && verdict.absolutePath === escaped);
  });

  it("hook 拒绝：维持 escaped（fail-safe）", () => {
    const verdict = guardPath(root, "../approved.txt", { allowEscaped: () => false });
    assert.equal(verdict.ok, false);
  });

  it("hook 缺省（不注入）：越界一律拒绝", () => {
    assert.equal(guardPath(root, "../approved.txt").ok, false);
  });

  it("精确放行口径：仅批准路径放行，其余越界路径仍拒绝", () => {
    // 与 tool-phase 注入形态一致：normalizeForGuard 逐字节比对审批通过的绝对路径
    const approved = normalizeForGuard(escaped);
    const hook = { allowEscaped: (target: string): boolean => normalizeForGuard(target) === approved };
    assert.equal(guardPath(root, "../approved.txt", hook).ok, true);
    assert.equal(guardPath(root, "../other.txt", hook).ok, false);
  });
});

describe("normalizeForGuard（守卫口径规范化）", () => {
  it("分隔符统一为 /，去尾分隔符", () => {
    const normalized = normalizeForGuard(join(root, "a", "b") + (process.platform === "win32" ? "\\" : "/"));
    assert.ok(!normalized.endsWith("/"), "尾分隔符应被去除");
    assert.ok(!normalized.includes("\\"), "分隔符应统一为 /");
  });

  it("win32 大小写不敏感；同义路径规范化结果一致", (t) => {
    if (process.platform !== "win32") {
      t.skip("大小写折叠仅 win32 平台适用");
      return;
    }
    assert.equal(normalizeForGuard("C:\\A\\B\\c.txt"), normalizeForGuard("c:/a/b/C.TXT"));
  });

  it("同义路径（相对/绝对、正反斜杠）规范化结果一致（跨平台口径）", () => {
    assert.equal(normalizeForGuard(join(root, "x", "y")), normalizeForGuard(`${root}/x/y`));
    assert.equal(normalizeForGuard(root), normalizeForGuard(resolve(root, "sub", "..")));
  });
});
