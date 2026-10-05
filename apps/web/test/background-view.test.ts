/**
 * background-view 纯函数单测（polish-ui-states-and-runtime 轮 B1）：
 * 五态状态灯映射 / isRunning / sortTasks（Running 优先 + startedAt 倒序 + 不改入参）。node:test 直跑。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BackgroundTaskInfo } from "@raincode/shared";
import { backgroundStatusView, isRunning, sortTasks } from "../src/background-view.js";

function task(partial: Partial<BackgroundTaskInfo> & { taskId: string }): BackgroundTaskInfo {
  return { command: "sleep 1", status: "Running", startedAt: 0, ...partial };
}

describe("backgroundStatusView（五态状态灯映射）", () => {
  it("Running → 青脉冲 + 运行中", () => {
    assert.deepEqual(backgroundStatusView("Running"), { dot: "dot dot-run", label: "运行中", textClass: "text-cyan" });
  });

  it("Completed / Failed / Timeout / Killed 各自映射", () => {
    assert.deepEqual(backgroundStatusView("Completed"), {
      dot: "dot dot-ok",
      label: "已完成",
      textClass: "text-ok",
    });
    assert.deepEqual(backgroundStatusView("Failed"), { dot: "dot dot-err", label: "失败", textClass: "text-danger" });
    assert.deepEqual(backgroundStatusView("Timeout"), { dot: "dot dot-warn", label: "超时", textClass: "text-warn" });
    assert.deepEqual(backgroundStatusView("Killed"), {
      dot: "dot dot-idle",
      label: "已终止",
      textClass: "text-faint",
    });
  });
});

describe("isRunning（轮询触发判定）", () => {
  it("仅 Running 为 true", () => {
    assert.equal(isRunning("Running"), true);
    assert.equal(isRunning("Completed"), false);
    assert.equal(isRunning("Failed"), false);
    assert.equal(isRunning("Timeout"), false);
    assert.equal(isRunning("Killed"), false);
  });
});

describe("sortTasks（Running 优先 + 最近启动优先）", () => {
  it("Running 一律排在终态之前", () => {
    const sorted = sortTasks([
      task({ taskId: "c", status: "Completed", startedAt: 100 }),
      task({ taskId: "r", status: "Running", startedAt: 1 }),
      task({ taskId: "k", status: "Killed", startedAt: 200 }),
    ]);
    assert.deepEqual(
      sorted.map((t) => t.taskId),
      ["r", "k", "c"],
    );
  });

  it("组内按 startedAt 倒序（最近启动优先）", () => {
    const sorted = sortTasks([
      task({ taskId: "old", status: "Completed", startedAt: 10 }),
      task({ taskId: "new", status: "Completed", startedAt: 30 }),
      task({ taskId: "mid", status: "Failed", startedAt: 20 }),
    ]);
    assert.deepEqual(
      sorted.map((t) => t.taskId),
      ["new", "mid", "old"],
    );
  });

  it("多个 Running 亦按 startedAt 倒序", () => {
    const sorted = sortTasks([
      task({ taskId: "r1", status: "Running", startedAt: 5 }),
      task({ taskId: "r2", status: "Running", startedAt: 9 }),
    ]);
    assert.deepEqual(
      sorted.map((t) => t.taskId),
      ["r2", "r1"],
    );
  });

  it("返回新数组、不改入参", () => {
    const input = [task({ taskId: "a", startedAt: 1 }), task({ taskId: "b", status: "Killed", startedAt: 2 })];
    const snapshot = input.map((t) => t.taskId);
    const sorted = sortTasks(input);
    assert.notEqual(sorted, input);
    assert.deepEqual(
      input.map((t) => t.taskId),
      snapshot,
    );
  });

  it("空数组安全", () => {
    assert.deepEqual(sortTasks([]), []);
  });
});
