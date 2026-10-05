/**
 * background-view 单测（polish-ui-states-and-runtime Task 4.1）：五态状态灯映射 /
 * isRunning 判定 / sortTasks（Running 置顶 + startedAt 倒序 + 不改原数组）。
 * 纯函数，node:test 直跑；与 Web 端同语义镜像。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BackgroundTaskInfo } from "@raincode/shared";
import { backgroundStatusView, isRunning, sortTasks, statusView } from "../src/renderer/background-view.js";

function task(overrides: Partial<BackgroundTaskInfo> & Pick<BackgroundTaskInfo, "taskId">): BackgroundTaskInfo {
  return { command: "npm run dev", status: "Running", startedAt: 0, ...overrides };
}

describe("backgroundStatusView（五态映射）", () => {
  it("Running：青脉冲灯 + 运行中 + text-cyan", () => {
    assert.deepEqual(backgroundStatusView("Running"), { dot: "dot dot-run", label: "运行中", textClass: "text-cyan" });
  });

  it("Completed：绿常亮 + 已完成", () => {
    assert.deepEqual(backgroundStatusView("Completed"), { dot: "dot dot-ok", label: "已完成", textClass: "text-ok" });
  });

  it("Failed：红常亮 + 失败", () => {
    assert.deepEqual(backgroundStatusView("Failed"), { dot: "dot dot-err", label: "失败", textClass: "text-danger" });
  });

  it("Timeout：琥珀脉冲 + 超时", () => {
    assert.deepEqual(backgroundStatusView("Timeout"), { dot: "dot dot-warn", label: "超时", textClass: "text-warn" });
  });

  it("Killed：灰常亮 + 已终止", () => {
    assert.deepEqual(backgroundStatusView("Killed"), { dot: "dot dot-idle", label: "已终止", textClass: "text-faint" });
  });

  it("statusView 别名同语义", () => {
    assert.equal(statusView, backgroundStatusView);
  });
});

describe("isRunning", () => {
  it("Running → true，其余四态 → false", () => {
    assert.equal(isRunning("Running"), true);
    assert.equal(isRunning("Completed"), false);
    assert.equal(isRunning("Failed"), false);
    assert.equal(isRunning("Timeout"), false);
    assert.equal(isRunning("Killed"), false);
  });
});

describe("sortTasks", () => {
  it("Running 置顶，其余按 startedAt 倒序", () => {
    const sorted = sortTasks([
      task({ taskId: "t-1", status: "Completed", startedAt: 100 }),
      task({ taskId: "t-2", status: "Running", startedAt: 5 }),
      task({ taskId: "t-3", status: "Running", startedAt: 50 }),
      task({ taskId: "t-4", status: "Failed", startedAt: 200 }),
    ]);
    assert.deepEqual(
      sorted.map((t) => t.taskId),
      ["t-3", "t-2", "t-4", "t-1"],
    );
  });

  it("不修改入参数组（返回新数组）", () => {
    const input = [task({ taskId: "a", status: "Completed", startedAt: 1 }), task({ taskId: "b", status: "Running", startedAt: 2 })];
    const original = input.map((t) => t.taskId);
    const sorted = sortTasks(input);
    assert.notEqual(sorted, input);
    assert.deepEqual(input.map((t) => t.taskId), original);
  });

  it("空数组安全", () => {
    assert.deepEqual(sortTasks([]), []);
  });
});
