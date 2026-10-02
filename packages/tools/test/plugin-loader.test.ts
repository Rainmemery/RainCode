/**
 * 插件加载器/适配器/registry 命名空间单测（T3.5，v1.8）。
 * 覆盖：清单校验（非法 JSON / 目录名与 name 一致性 / 非法名防路径逃逸）、目录扫描
 * （根缺失空数组 / 非法目录名忽略）、activate 契约（缺入口 / 无 activate / activate 抛错 /
 * 返回非数组 / 描述符缺 execute 与名字模式违规逐一拦截）、toPluginToolName、
 * createPluginTool（metadata 缺省从严 / 声明收窄 / 非字符串返回值序列化 / 抛错映射
 * TOOL_EXEC_FAILED）、ToolRegistry source="plugin" 命名空间豁免（plugin__ 放行、
 * mcp__ 与 builtin 占用 `__` 仍拒绝）。
 * 插件模块经临时目录真实 .mjs 动态 import（每用例独立 mkdtemp 目录规避 ESM 缓存串扰）。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  PluginError,
  ToolExecutionError,
  ToolRegistry,
  activatePlugin,
  createPluginTool,
  readPluginManifest,
  scanPluginDir,
  toPluginToolName,
} from "../src/index.js";
import type { PluginToolDescriptor } from "../src/index.js";

const tmpRoots: string[] = [];
after(async () => {
  for (const root of tmpRoots) {
    await rm(root, { recursive: true, force: true });
  }
});

async function makeHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "raincode-plugin-test-"));
  tmpRoots.push(root);
  return root;
}

async function writePlugin(
  root: string,
  dirName: string,
  manifest: unknown,
  moduleSource?: string,
): Promise<string> {
  const dir = join(root, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "plugin.json"), JSON.stringify(manifest), "utf8");
  if (moduleSource !== undefined) {
    await writeFile(join(dir, "index.mjs"), moduleSource, "utf8");
  }
  return dir;
}

const GOOD_MODULE = `
export function activate() {
  return [
    {
      name: "greet",
      description: "问候语生成",
      parametersJsonSchema: { type: "object", properties: { name: { type: "string" } } },
      metadata: { readOnly: true, needsApproval: false, riskLevel: "low" },
      async execute(args) { return "hi " + (args && args.name ? args.name : "world"); },
    },
  ];
}
export function deactivate() {}
`;

describe("readPluginManifest（清单校验）", () => {
  it("合法清单 + 目录名一致性校验", async () => {
    const root = await makeHome();
    const dir = await writePlugin(root, "hello", { name: "hello", description: "示例", version: "0.1.0" });
    const manifest = await readPluginManifest(dir);
    assert.equal(manifest.name, "hello");
    assert.equal(manifest.version, "0.1.0");
  });

  it("非法 JSON / 目录名与 name 不一致 → PLUGIN_MANIFEST_INVALID", async () => {
    const root = await makeHome();
    const bad = join(root, "broken");
    await mkdir(bad, { recursive: true });
    await writeFile(join(bad, "plugin.json"), "{not json", "utf8");
    await assert.rejects(readPluginManifest(bad), (err: unknown) => err instanceof PluginError && err.code === "PLUGIN_MANIFEST_INVALID");

    const mismatched = await writePlugin(root, "dir-a", { name: "dir-b", description: "不一致" });
    await assert.rejects(readPluginManifest(mismatched), (err: unknown) => err instanceof PluginError && err.code === "PLUGIN_MANIFEST_INVALID");
  });

  it("manifest name 非法（大写/点号路径逃逸形态）被 schema 拦截", async () => {
    const root = await makeHome();
    const dir = await writePlugin(root, "hello", { name: "../escape", description: "越权" });
    await assert.rejects(readPluginManifest(dir), (err: unknown) => err instanceof PluginError && err.code === "PLUGIN_MANIFEST_INVALID");
  });
});

describe("scanPluginDir（目录扫描）", () => {
  it("根目录缺失返回空数组；非法目录名忽略；合法目录收进", async () => {
    const root = await makeHome();
    assert.deepEqual(await scanPluginDir(join(root, "not-exist")), []);
    await writePlugin(root, "hello", { name: "hello", description: "d" });
    await mkdir(join(root, "Bad_Name"), { recursive: true }); // 非法目录名
    await mkdir(join(root, "dots.."), { recursive: true });
    const found = await scanPluginDir(root);
    assert.deepEqual(found.map((f) => f.name), ["hello"]);
  });
});

describe("activatePlugin（激活契约）", () => {
  it("合法模块：activate 返回描述符 + deactivate 可选导出", async () => {
    const root = await makeHome();
    const dir = await writePlugin(root, "hello", { name: "hello", description: "d" }, GOOD_MODULE);
    const activation = await activatePlugin(dir, await readPluginManifest(dir));
    assert.equal(activation.tools.length, 1);
    assert.equal(activation.tools[0]!.name, "greet");
    assert.notEqual(activation.deactivate, undefined);
  });

  it("入口缺失 / 无 activate 导出 → PLUGIN_ENTRY_INVALID", async () => {
    const root = await makeHome();
    const noEntry = await writePlugin(root, "p1", { name: "p1", description: "d" });
    await assert.rejects(activatePlugin(noEntry, await readPluginManifest(noEntry)), (err: unknown) => err instanceof PluginError && err.code === "PLUGIN_ENTRY_INVALID");

    const noActivate = await writePlugin(root, "p2", { name: "p2", description: "d" }, "export const x = 1;");
    await assert.rejects(activatePlugin(noActivate, await readPluginManifest(noActivate)), (err: unknown) => err instanceof PluginError && err.code === "PLUGIN_ENTRY_INVALID");
  });

  it("activate 抛错 / 返回非数组 / 描述符缺 execute → PLUGIN_ACTIVATE_FAILED", async () => {
    const root = await makeHome();
    const throws = await writePlugin(root, "p1", { name: "p1", description: "d" }, "export function activate(){ throw new Error('boom'); }");
    await assert.rejects(activatePlugin(throws, await readPluginManifest(throws)), (err: unknown) => err instanceof PluginError && err.code === "PLUGIN_ACTIVATE_FAILED");

    const nonArray = await writePlugin(root, "p2", { name: "p2", description: "d" }, "export function activate(){ return {}; }");
    await assert.rejects(activatePlugin(nonArray, await readPluginManifest(nonArray)), (err: unknown) => err instanceof PluginError && err.code === "PLUGIN_ACTIVATE_FAILED");

    const noExecute = await writePlugin(
      root, "p3", { name: "p3", description: "d" },
      'export function activate(){ return [{ name: "t", description: "x" }]; }',
    );
    await assert.rejects(activatePlugin(noExecute, await readPluginManifest(noExecute)), (err: unknown) => err instanceof PluginError && err.code === "PLUGIN_ACTIVATE_FAILED");

    const badName = await writePlugin(
      root, "p4", { name: "p4", description: "d" },
      'export function activate(){ return [{ name: "Bad-Name", description: "x", execute: async () => "y" }]; }',
    );
    await assert.rejects(activatePlugin(badName, await readPluginManifest(badName)), (err: unknown) => err instanceof PluginError && err.code === "PLUGIN_ACTIVATE_FAILED");
  });
});

describe("createPluginTool（适配器）", () => {
  it("metadata 缺省从严（needsApproval=true / riskLevel=medium）；声明可收窄", async () => {
    const strict = createPluginTool("p", {
      name: "t1",
      description: "d",
      execute: async () => "ok",
    });
    assert.equal(strict.metadata.readOnly, false);
    assert.equal(strict.metadata.needsApproval, true);
    assert.equal(strict.metadata.riskLevel, "medium");
    assert.equal(strict.name, "plugin__p__t1");

    const relaxed = createPluginTool("p", {
      name: "t2",
      description: "d",
      metadata: { readOnly: true, needsApproval: false, riskLevel: "low", timeoutMs: 2500 },
      execute: async () => "ok",
    });
    assert.equal(relaxed.metadata.readOnly, true);
    assert.equal(relaxed.metadata.needsApproval, false);
    assert.equal(relaxed.metadata.riskLevel, "low");
    assert.equal(relaxed.metadata.timeoutMs, 2500);
  });

  it("execute 非字符串返回值 JSON 序列化；抛错映射数据级 TOOL_EXEC_FAILED", async () => {
    // 契约签名 Promise<string>；plain JS 插件可能返回任意值——适配器 JSON 序列化兜底（cast 表达该越界）
    const serializer = createPluginTool("p", {
      name: "t1",
      description: "d",
      execute: (async () => ({ a: 1 })) as unknown as PluginToolDescriptor["execute"],
    });
    const out = await serializer.execute({}, { signal: new AbortController().signal, sessionId: "s", workspaceRoot: null } as never);
    assert.equal(out.content, '{"a":1}');

    const failing = createPluginTool("p", { name: "t2", description: "d", execute: async () => { throw new Error("crash"); } });
    await assert.rejects(
      failing.execute({}, { signal: new AbortController().signal, sessionId: "s", workspaceRoot: null } as never),
      (err: unknown) => err instanceof ToolExecutionError && err.code === "TOOL_EXEC_FAILED",
    );
  });
});

describe("ToolRegistry 插件命名空间（v1.8 豁免）", () => {
  const dummy = (name: string) => ({
    name,
    description: "d",
    parametersSchema: { safeParse: (v: unknown) => ({ success: true, data: v }) } as never,
    metadata: { readOnly: true, destructive: false, sideEffectScope: "none" as const, riskLevel: "low" as const, needsApproval: false },
    execute: async () => ({ data: "x", content: "x" }),
  });

  it("source=plugin 放行 plugin__ 前缀；其余来源 mcp__/plugin__/内嵌 __ 一律拒绝", () => {
    const registry = new ToolRegistry();
    registry.register(dummy(toPluginToolName("hello", "greet")), "plugin");
    assert.equal(registry.sourceOf("plugin__hello__greet"), "plugin");

    assert.throws(() => registry.register(dummy("plugin__x__t"), "builtin"), /reserved namespace/);
    assert.throws(() => registry.register(dummy("mcp__srv__t"), "plugin"), /reserved namespace/);
    assert.throws(() => registry.register(dummy("foo__bar"), "mcp"), /reserved namespace/);
  });
});
