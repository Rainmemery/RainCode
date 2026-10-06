/**
 * McpRequestCatalog 状态机单测（T5.6）：目录模式载荷装配、请求域激活、调度守卫、
 * digest 热失效与 round===1 重置。目录端口以内存桩实现（快照 + 确定性检索）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { ToolRegistry } from "@raincode/tools";
import type { Tool, ToolResult } from "@raincode/tools";
import { MCP_TOOL_SEARCH_NAME } from "@raincode/tools";
import { McpRequestCatalog, toCatalogedLlmFunctionTools } from "../src/index.js";
import type { McpToolCatalogPort, McpToolCatalogSnapshot } from "../src/index.js";

function fakeMcpTool(name: string, description: string): Tool<Record<string, never>> {
  return {
    name,
    description,
    parametersSchema: z.object({}),
    metadata: { readOnly: false, destructive: false, sideEffectScope: "machine", riskLevel: "medium", needsApproval: true },
    async execute() {
      return { data: "ok", content: "ok" };
    },
  };
}

function fakeBuiltin(name: string): Tool<Record<string, never>> {
  return {
    name,
    description: `builtin ${name}`,
    parametersSchema: z.object({}),
    metadata: { readOnly: true, destructive: false, sideEffectScope: "none", riskLevel: "low", needsApproval: false },
    async execute() {
      return { data: "ok", content: "ok" };
    },
  };
}

/** 目录桩：entries 给定 → 固定 digest；search 按词包含关系返回命中（确定性）。 */
function stubPort(entries: Array<{ name: string; description: string }>): McpToolCatalogPort {
  const digest = `d${String(entries.length).padStart(2, "0")}`;
  return {
    snapshot: () => (entries.length === 0 ? null : { digest, description: `CATALOG:${digest}`, entries }),
    search: async (query: string, limit?: number) => {
      const matches = entries
        .filter((entry) => query.split(" ").some((word) => entry.name.includes(word) || entry.description.includes(word)))
        .slice(0, limit ?? 8)
        .map((entry) => ({ ...entry, score: 1 }));
      return { ok: true, digest, matches };
    },
  };
}

function makeRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(fakeBuiltin("read"));
  registry.register(fakeBuiltin(MCP_TOOL_SEARCH_NAME));
  registry.register(fakeMcpTool("mcp__alpha__read_file", "alpha read file"), "mcp");
  registry.register(fakeMcpTool("mcp__beta__run_query", "beta run query"), "mcp");
  return registry;
}

const CATALOG_ENTRIES = [
  { name: "mcp__alpha__read_file", description: "alpha read file" },
  { name: "mcp__beta__run_query", description: "beta run query" },
];

function resultOf(callId: string, name: string, isError = false): ToolResult {
  return { toolCallId: callId, toolName: name, content: isError ? "err" : "ok", isError, truncated: false, durationMs: 1 };
}

describe("McpRequestCatalog 载荷装配", () => {
  it("端口缺省（子代理/fork 未装配）→ 全量投影剔除检索工具，MCP schema 照旧", () => {
    const catalog = new McpRequestCatalog();
    const payload = catalog.payloadFor(undefined, makeRegistry(), 1);
    assert.ok(payload !== undefined);
    const names = payload.map((tool) => tool.function.name);
    assert.ok(names.includes("mcp__alpha__read_file"));
    assert.ok(!names.includes(MCP_TOOL_SEARCH_NAME));
  });

  it("目录模式未生效（空目录快照 null）→ 全量投影剔除检索工具", () => {
    const catalog = new McpRequestCatalog();
    const port = stubPort([]);
    const payload = catalog.payloadFor(port, makeRegistry(), 1);
    const names = payload?.map((tool) => tool.function.name);
    assert.ok(names?.includes("mcp__alpha__read_file"));
    assert.ok(!names?.includes(MCP_TOOL_SEARCH_NAME));
    assert.equal(catalog.eligibility(), undefined);
  });

  it("目录模式生效 → 未激活 MCP 不进载荷 + 检索工具 description 换目录摘要", () => {
    const catalog = new McpRequestCatalog();
    const port = stubPort(CATALOG_ENTRIES);
    const payload = catalog.payloadFor(port, makeRegistry(), 1);
    const names = payload?.map((tool) => tool.function.name);
    assert.ok(!names?.includes("mcp__alpha__read_file"));
    assert.ok(names?.includes(MCP_TOOL_SEARCH_NAME));
    const searchTool = payload?.find((tool) => tool.function.name === MCP_TOOL_SEARCH_NAME);
    assert.equal(searchTool?.function.description, "CATALOG:d02");
    assert.ok(catalog.eligibility() !== undefined);
  });

  it("registry 缺省 → undefined 载荷（保持无工具系统行为）", () => {
    const catalog = new McpRequestCatalog();
    assert.equal(catalog.payloadFor(stubPort(CATALOG_ENTRIES), undefined, 1), undefined);
  });
});

describe("McpRequestCatalog 激活与守卫", () => {
  it("搜索命中 → captureSearches 登记 → 下一轮载荷含已激活工具", async () => {
    const catalog = new McpRequestCatalog();
    const port = stubPort(CATALOG_ENTRIES);
    catalog.payloadFor(port, makeRegistry(), 1);
    const call = { toolCallId: "c1", toolName: MCP_TOOL_SEARCH_NAME, argumentsJSON: JSON.stringify({ query: "read file" }) };
    await catalog.captureSearches(port, [call], [resultOf("c1", MCP_TOOL_SEARCH_NAME)]);
    const payload = catalog.payloadFor(port, makeRegistry(), 2);
    const names = payload?.map((tool) => tool.function.name);
    assert.ok(names?.includes("mcp__alpha__read_file"), "命中工具下一轮应激活");
    assert.ok(!names?.includes("mcp__beta__run_query"), "未命中工具仍不进载荷");
  });

  it("调度守卫：未激活 mcp__* 拒绝并指引检索；已激活与非 mcp 工具放行", async () => {
    const catalog = new McpRequestCatalog();
    const port = stubPort(CATALOG_ENTRIES);
    catalog.payloadFor(port, makeRegistry(), 1);
    const guard = catalog.eligibility();
    assert.ok(guard !== undefined);
    assert.match(guard("mcp__alpha__read_file") ?? "", /mcp_tool_search/);
    assert.equal(guard("read"), undefined);

    await catalog.captureSearches(
      port,
      [{ toolCallId: "c1", toolName: MCP_TOOL_SEARCH_NAME, argumentsJSON: JSON.stringify({ query: "read file" }) }],
      [resultOf("c1", MCP_TOOL_SEARCH_NAME)],
    );
    assert.equal(catalog.eligibility()?.("mcp__alpha__read_file"), undefined);
  });

  it("失败的搜索调用不激活；digest 变化 → 激活整体失效", async () => {
    const catalog = new McpRequestCatalog();
    const port = stubPort(CATALOG_ENTRIES);
    catalog.payloadFor(port, makeRegistry(), 1);
    await catalog.captureSearches(
      port,
      [{ toolCallId: "c1", toolName: MCP_TOOL_SEARCH_NAME, argumentsJSON: JSON.stringify({ query: "read file" }) }],
      [resultOf("c1", MCP_TOOL_SEARCH_NAME, true)], // isError
    );
    assert.match(catalog.eligibility()?.("mcp__alpha__read_file") ?? "", /not loaded/);

    // 热变更：目录条目数变化 → digest 变化 → 已激活失效
    await catalog.captureSearches(
      port,
      [{ toolCallId: "c2", toolName: MCP_TOOL_SEARCH_NAME, argumentsJSON: JSON.stringify({ query: "read file" }) }],
      [resultOf("c2", MCP_TOOL_SEARCH_NAME)],
    );
    const nextPort = stubPort([...CATALOG_ENTRIES, { name: "mcp__beta__new_tool", description: "new" }]);
    const payload = catalog.payloadFor(nextPort, makeRegistry(), 2);
    // digest 不一致：本轮捕获的激活作废（mcp-catalog 在 payloadFor 时按 digest 清空）
    assert.ok(payload?.every((tool) => tool.function.name !== "mcp__alpha__read_file"));
    assert.ok(catalog.eligibility()?.("mcp__alpha__read_file"));
  });

  it("round===1 重置请求域激活（新用户消息重新隐藏）", async () => {
    const catalog = new McpRequestCatalog();
    const port = stubPort(CATALOG_ENTRIES);
    catalog.payloadFor(port, makeRegistry(), 1);
    await catalog.captureSearches(
      port,
      [{ toolCallId: "c1", toolName: MCP_TOOL_SEARCH_NAME, argumentsJSON: JSON.stringify({ query: "read file" }) }],
      [resultOf("c1", MCP_TOOL_SEARCH_NAME)],
    );
    assert.equal(catalog.eligibility()?.("mcp__alpha__read_file"), undefined);
    // 下一 turn：round 1 重置
    catalog.payloadFor(port, makeRegistry(), 1);
    assert.match(catalog.eligibility()?.("mcp__alpha__read_file") ?? "", /not loaded/);
  });

  it("激活累计上限 32（多次搜索累计超限部分忽略）", async () => {
    const registry = new ToolRegistry();
    registry.register(fakeBuiltin(MCP_TOOL_SEARCH_NAME));
    // 40 个工具分两组描述（各 20）：两次搜索累计 40 次激活尝试 → 上限截断至 32
    const entries = Array.from({ length: 40 }, (_, i) => ({
      name: `mcp__s__t${String(i)}`,
      description: i % 2 === 0 ? "groupA" : "groupB",
    }));
    for (const entry of entries) registry.register(fakeMcpTool(entry.name, entry.description), "mcp");
    const catalog = new McpRequestCatalog();
    const port = stubPort(entries);
    catalog.payloadFor(port, registry, 1);
    await catalog.captureSearches(
      port,
      [{ toolCallId: "c1", toolName: MCP_TOOL_SEARCH_NAME, argumentsJSON: JSON.stringify({ query: "groupA", limit: 32 }) }],
      [resultOf("c1", MCP_TOOL_SEARCH_NAME)],
    );
    await catalog.captureSearches(
      port,
      [{ toolCallId: "c2", toolName: MCP_TOOL_SEARCH_NAME, argumentsJSON: JSON.stringify({ query: "groupB", limit: 32 }) }],
      [resultOf("c2", MCP_TOOL_SEARCH_NAME)],
    );
    const payload = catalog.payloadFor(port, registry, 2);
    const mcpNames = payload?.map((tool) => tool.function.name).filter((name) => name.startsWith("mcp__")) ?? [];
    assert.equal(mcpNames.length, 32);
  });
});

describe("toCatalogedLlmFunctionTools", () => {
  it("MCP 工具只投影已激活子集；检索工具换目录摘要；其余内建原样", () => {
    const registry = makeRegistry();
    const snapshot: McpToolCatalogSnapshot = {
      digest: "d02",
      description: "CATALOG",
      entries: CATALOG_ENTRIES,
    };
    const payload = toCatalogedLlmFunctionTools(registry, snapshot, new Set(["mcp__beta__run_query"]));
    const names = payload.map((tool) => tool.function.name);
    assert.equal(names.length, 3);
    assert.ok(names.includes(MCP_TOOL_SEARCH_NAME));
    assert.ok(names.includes("mcp__beta__run_query"));
    assert.ok(names.includes("read"));
    assert.ok(!names.includes("mcp__alpha__read_file"), "未激活 MCP 工具不投影");
    const searchTool = payload.find((tool) => tool.function.name === MCP_TOOL_SEARCH_NAME);
    assert.equal(searchTool?.function.description, "CATALOG");
    assert.equal(payload.find((tool) => tool.function.name === "read")?.function.description, "builtin read");
  });
});
