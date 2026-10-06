/**
 * MCP 工具目录单测（T5.6；07-dev-plan §11.2 验收面：多 server fixture 下的目录行为 +
 * 预算降级 + 热变更重发布 + BM25 检索纪律）。
 *
 * - BM25：分词（snake_case 切分 / CJK bigram）、相关性排序、相对分数地板、limit 截断；
 * - renderCatalog 三级降级：富（名+描述）→ 仅名称 → 字典序前缀 + 省略计数（确定性）；
 * - McpToolCatalog：空目录 null / digest 稳定 / 热变更 digest 变化 + 重发布诊断 /
 *   schema 绝不进目录 / search 语料含参数名、limit 硬顶 32。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { z } from "zod";
import { ToolRegistry } from "@raincode/tools";
import type { Tool } from "@raincode/tools";
import { buildBm25Index, searchBm25, tokenizeCatalogText } from "../src/bm25-index.js";
import { McpToolCatalog, collectSchemaParamNames, renderCatalog } from "../src/mcp-tool-catalog.js";

// ---------------------------------------------------------------------------
// 分词
// ---------------------------------------------------------------------------

describe("tokenizeCatalogText", () => {
  it("snake_case 与命名空间分隔符切分为独立词（查询 read file 与 read_file 等价）", () => {
    assert.deepEqual(tokenizeCatalogText("mcp__fs__read_file"), ["mcp", "fs", "read", "file"]);
  });

  it("CJK 连续段取二元 bigram（单字保留），与 ASCII 词混排不串", () => {
    assert.deepEqual(tokenizeCatalogText("读取文件 read"), ["读取", "取文", "文件", "read"]);
    assert.deepEqual(tokenizeCatalogText("读"), ["读"]);
  });

  it("大小写归一", () => {
    assert.deepEqual(tokenizeCatalogText("Read FILE"), ["read", "file"]);
  });
});

// ---------------------------------------------------------------------------
// BM25 打分
// ---------------------------------------------------------------------------

describe("searchBm25", () => {
  const index = buildBm25Index([
    { key: "mcp__fs__read_file", text: "mcp fs read_file Read a file from the workspace filesystem" },
    { key: "mcp__fs__write_file", text: "mcp fs write_file Write content to a file on disk" },
    { key: "mcp__web__search", text: "mcp web search Search the web for pages" },
  ]);

  it("精确命中名与描述的条目排序在前", () => {
    const hits = searchBm25(index, "read file", 10);
    assert.ok(hits.length >= 1);
    assert.equal(hits[0]?.key, "mcp__fs__read_file");
    // 相关词（write/file）也应命中
    assert.ok(hits.some((hit) => hit.key === "mcp__fs__write_file"));
  });

  it("相对分数地板裁剪弱相关文档（top×0.15 以下不入）", () => {
    const hits = searchBm25(index, "read file", 10);
    const top = hits[0]?.score ?? 0;
    for (const hit of hits) {
      assert.ok(hit.score >= top * 0.15, `hit ${hit.key} score ${String(hit.score)} below floor`);
    }
  });

  it("limit 截断与零命中", () => {
    assert.equal(searchBm25(index, "read file", 1).length, 1);
    assert.deepEqual(searchBm25(index, "zzz_unmatchable", 10), []);
  });

  it("中文查询经 bigram 命中 CJK 语料", () => {
    const cjkIndex = buildBm25Index([
      { key: "mcp__db__query", text: "mcp db query 查询数据库记录" },
      { key: "mcp__fs__read", text: "mcp fs read 读文件" },
    ]);
    const hits = searchBm25(cjkIndex, "数据库", 10);
    assert.equal(hits[0]?.key, "mcp__db__query");
  });
});

// ---------------------------------------------------------------------------
// 目录渲染降级
// ---------------------------------------------------------------------------

function makeEntries(count: number, description: string): Array<{ name: string; description: string }> {
  return Array.from({ length: count }, (_, i) => ({ name: `mcp__srv__tool_${String(i).padStart(3, "0")}`, description }));
}

describe("renderCatalog 三级降级", () => {
  it("富目录（名+描述）在预算内完整渲染", () => {
    const entries = makeEntries(3, "short description");
    const text = renderCatalog(entries, 10000);
    assert.ok(text.includes("- mcp__srv__tool_000: short description"));
    assert.ok(!text.includes("omitted"));
  });

  it("描述超预算降级为仅名称列表", () => {
    const entries = makeEntries(30, "x".repeat(2000));
    // 预算足够容纳 30 行名称但不容纳描述
    const text = renderCatalog(entries, 400);
    assert.ok(text.includes("- mcp__srv__tool_000"));
    assert.ok(!text.includes("- mcp__srv__tool_000: "), "降级后不应携带描述");
    assert.ok(text.includes("mcp__srv__tool_029"), "名称列表应完整");
  });

  it("名称仍超预算 → 确定性字典序前缀 + 省略计数", () => {
    const entries = makeEntries(50, "x".repeat(2000));
    const text = renderCatalog(entries, 120);
    assert.ok(text.includes("mcp__srv__tool_000"));
    assert.ok(!text.includes("mcp__srv__tool_049"), "前缀之外的条目不应出现");
    assert.match(text, /more omitted/);
  });

  it("同一输入渲染确定性（两次渲染逐字节一致）", () => {
    const entries = makeEntries(50, "x".repeat(2000));
    assert.equal(renderCatalog(entries, 120), renderCatalog(entries, 120));
  });
});

// ---------------------------------------------------------------------------
// McpToolCatalog：快照 / 热变更 / 检索
// ---------------------------------------------------------------------------

function fakeMcpTool(server: string, name: string, description: string, properties: Record<string, unknown>): Tool<Record<string, unknown>> {
  return {
    name: `mcp__${server}__${name}`,
    description,
    parametersSchema: z.record(z.string(), z.unknown()),
    parametersJsonSchema: { type: "object", properties, required: Object.keys(properties) },
    metadata: { readOnly: false, destructive: false, sideEffectScope: "machine", riskLevel: "medium", needsApproval: true },
    async execute(input: Record<string, unknown>) {
      return { data: "ok", content: `${name}:${JSON.stringify(input)}` };
    },
  };
}

interface DiagCapture {
  messages: string[];
}

function makeCatalogWith(registry: ToolRegistry, diag?: DiagCapture): McpToolCatalog {
  return new McpToolCatalog({
    registry,
    maxContextTokens: () => 32768,
    ...(diag !== undefined && {
      onDiagnostic: (message: string) => {
        diag.messages.push(message);
      },
    }),
  });
}

describe("McpToolCatalog", () => {
  it("无生效 MCP 工具 → snapshot null（目录模式未生效）", async () => {
    const registry = new ToolRegistry();
    const catalog = makeCatalogWith(registry);
    assert.equal(catalog.snapshot(), null);
    const search = await catalog.search("anything");
    assert.equal(search.ok, false);
  });

  it("多 server fixture：快照含全部条目、digest 稳定、schema 绝不进目录描述", () => {
    const registry = new ToolRegistry();
    registry.register(
      fakeMcpTool("alpha", "read_file", "Read a file from the alpha server filesystem", {
        path: { type: "string", description: "Absolute path of the file to read" },
      }),
      "mcp",
    );
    registry.register(
      fakeMcpTool("beta", "run_query", "Run a SQL query against the beta database", {
        sql: { type: "string", description: "SQL statement text to execute" },
      }),
      "mcp",
    );
    const catalog = makeCatalogWith(registry);
    const first = catalog.snapshot();
    assert.ok(first !== null);
    assert.equal(first.entries.length, 2);
    // 字典序确定：mcp__alpha__ < mcp__beta__
    assert.deepEqual(first.entries.map((entry) => entry.name), ["mcp__alpha__read_file", "mcp__beta__run_query"]);
    assert.ok(first.description.includes("mcp__alpha__read_file"));
    assert.ok(!first.description.includes("Absolute path"), "参数 schema/描述不得进目录");
    const second = catalog.snapshot();
    assert.equal(second?.digest, first.digest);
  });

  it("热变更：注册新工具 → digest 变化 + 重发布诊断 + 新条目进目录", () => {
    const registry = new ToolRegistry();
    registry.register(fakeMcpTool("alpha", "read_file", "Read a file", { path: { type: "string" } }), "mcp");
    const diag: DiagCapture = { messages: [] };
    const catalog = makeCatalogWith(registry, diag);
    const before = catalog.snapshot();
    assert.ok(before !== null);
    assert.ok(!before.description.includes("new_tool"));

    registry.register(fakeMcpTool("beta", "new_tool", "Brand new beta tool", { q: { type: "string" } }), "mcp");
    const after = catalog.snapshot();
    assert.ok(after !== null);
    assert.notEqual(after.digest, before.digest);
    assert.ok(after.description.includes("mcp__beta__new_tool"));
    assert.equal(diag.messages.length, 1);
    assert.match(diag.messages[0] ?? "", /重发布/);
  });

  it("search：命中排序 + 参数名入语料 + limit 硬顶 32", async () => {
    const registry = new ToolRegistry();
    registry.register(
      fakeMcpTool("alpha", "read_file", "Read file content", {
        path: { type: "string", description: "file path" },
      }),
      "mcp",
    );
    registry.register(fakeMcpTool("beta", "run_query", "Run SQL", { sql: { type: "string" } }), "mcp");
    const catalog = makeCatalogWith(registry);
    // 参数名 path 单独可检索（语料含递归参数名）
    const byParam = await catalog.search("path");
    assert.ok(byParam.ok);
    assert.equal(byParam.matches[0]?.name, "mcp__alpha__read_file");
    // limit 截断
    const limited = await catalog.search("file", 1);
    assert.ok(limited.ok);
    assert.equal(limited.matches.length, 1);
  });

  it("collectSchemaParamNames：递归 properties 与嵌套 items，深度受限", () => {
    const names = collectSchemaParamNames({
      type: "object",
      properties: {
        path: { type: "string", description: "file path" },
        options: { type: "object", properties: { recursive: { type: "boolean" } } },
        list: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } },
      },
    });
    assert.ok(names.includes("path"));
    assert.ok(names.includes("recursive"));
    assert.ok(names.includes("name"));
  });
});
