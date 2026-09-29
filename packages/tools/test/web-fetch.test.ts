/**
 * web_fetch 工具单测（T2.7 任务 1 · 02-module-design §2.3/§2.4）。
 * - 正向路径：本地 http server（127.0.0.1）回 HTML——守卫经 mock dns.promises.lookup（公网 IP）
 *   放行、连接经 mock dns.lookup（undici 走 callback 版 lookup）落到回环 server；
 *   断言剥标签 / script style 剔除 / 实体解码 / 块级换行 / 空行折叠；
 * - JSON content-type 原文返回；非 2xx → TOOL_EXEC_FAILED（HTTP <code>）；
 * - maxBytes 截断（truncateToByteBudget 复用，content 字节数不超预算且带截断标记）；
 * - 重定向：302 → 相对 Location（公网）跟随成功；302 → 127.0.0.1（跳板）被 SSRF 守卫拦截
 *   （02 §2.4「重定向也过校验」的拦截路径端到端验证）。
 */
import assert from "node:assert/strict";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { after, afterEach, describe, it, mock } from "node:test";
import { webFetchTool } from "../src/index.js";
import { ToolExecutionError } from "../src/index.js";
import { TOOL_ERROR_CODES } from "@raincode/shared";
import type { BackgroundTaskRegistry, ToolExecutionContext } from "../src/index.js";

/** 请求路由表（path → 响应）；startServer 消费。 */
type Routes = Record<string, { status?: number; contentType: string; body: string }>;

function startServer(routes: Routes): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const route = routes[req.url ?? "/"];
    if (route === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(route.status ?? 200, { "content-type": route.contentType });
    res.end(route.body);
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({
        server,
        port,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
      });
    });
  });
}

/** 测试期宿主名（不真实解析；守卫经 dnsPromises mock 放行、连接经 dns mock 落回环）。 */
const TEST_HOST = "webfetch.test.example";

/** 双 mock：守卫读公网 IP（dnsPromises.lookup），fetch 连接落回环（dns.lookup）。 */
function mockDnsToLoopback(): void {
  mock.method(dnsPromises, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
  mock.method(dns, "lookup", (_hostname: string, options: unknown, cb?: unknown) => {
    const callback = typeof options === "function" ? options : cb;
    if (typeof callback === "function") {
      (callback as (err: null, addresses: Array<{ address: string; family: number }>) => void)(
        null,
        [{ address: "127.0.0.1", family: 4 }],
      );
    }
  });
}

const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of closers.reverse()) {
    await close();
  }
});
afterEach(() => {
  mock.restoreAll();
});

function makeCtx(): ToolExecutionContext {
  return {
    signal: new AbortController().signal,
    workspaceRoot: process.cwd(),
    cwd: process.cwd(),
    sessionKey: "test",
    background: {} as BackgroundTaskRegistry,
  };
}

/** 断言以 ToolExecutionError(code) 抛出（executor 之外的直调路径）。 */
async function assertToolError(run: () => Promise<unknown>, code: string, messagePart?: string): Promise<void> {
  await assert.rejects(
    run,
    (err: unknown) => {
      assert.ok(err instanceof ToolExecutionError, `应抛 ToolExecutionError，实得 ${String(err)}`);
      assert.equal(err.code, code);
      if (messagePart !== undefined) {
        assert.ok(err.message.includes(messagePart), `消息应含「${messagePart}」：${err.message}`);
      }
      return true;
    },
  );
}

describe("web_fetch：HTML → 可读文本（02 §2.3）", () => {
  it("剥标签/剔 script+style/实体解码/块级换行/空行折叠", async () => {
    const server = await startServer({
      "/page": {
        contentType: "text/html; charset=utf-8",
        body: [
          "<html><head><title>t</title>",
          "<style>.x{color:red}</style></head>",
          "<body>",
          "<h1>标题一</h1>",
          "<p>第一段&nbsp;&amp;&nbsp;第二段 &lt;tag&gt; &quot;引&quot; &#39;单&#39;</p>",
          "<script>alert('bad')</script>",
          "<div>div 文本</div>",
          "<ul><li>条目 A</li><li>条目 B</li></ul>",
          "<br/><span>换行后文本</span>",
          "</body></html>",
        ].join("\n"),
      },
    });
    closers.push(server.close);
    mockDnsToLoopback();

    const output = await webFetchTool.execute({ url: `http://${TEST_HOST}:${String(server.port)}/page` }, makeCtx());
    const text = output.content ?? "";
    // 结构标签应全部剥离（注意：实体解码产物 `<tag>` 字面文本属预期，不在此列）
    for (const tag of ["<html", "<h1", "<p>", "<div", "<li", "<br", "<script", "<style", "<span"]) {
      assert.ok(!text.includes(tag), `不应残留结构标签 ${tag}`);
    }
    assert.ok(!text.includes("alert"), "script 内容应剔除");
    assert.ok(!text.includes("color:red"), "style 内容应剔除");
    assert.ok(text.includes("标题一"), "h1 文本保留");
    assert.ok(text.includes("第一段 & 第二段 <tag> \"引\" '单'"), `实体应解码：${text}`);
    assert.ok(text.includes("div 文本") && text.includes("条目 A") && text.includes("条目 B"));
    assert.ok(/\n/.test(text), "块级标签应换行");
    assert.ok(!/\n{3,}/.test(text), "连续空行应折叠");
    assert.equal(output.data.truncated, false);
    assert.equal(output.data.status, 200);
    assert.equal(output.data.url, `http://${TEST_HOST}:${String(server.port)}/page`);
  });
});

describe("web_fetch：content-type 与错误收敛（02 §2.4）", () => {
  it("application/json 原文返回（不剥标签）", async () => {
    const server = await startServer({
      "/api": { contentType: "application/json", body: '{"key": "a & b <c>"}' },
    });
    closers.push(server.close);
    mockDnsToLoopback();

    const output = await webFetchTool.execute({ url: `http://${TEST_HOST}:${String(server.port)}/api` }, makeCtx());
    assert.equal(output.content, '{"key": "a & b <c>"}');
  });

  it("非 2xx → TOOL_EXEC_FAILED，消息含 HTTP 状态码", async () => {
    const server = await startServer({
      "/missing": { status: 404, contentType: "text/plain", body: "nope" },
    });
    closers.push(server.close);
    mockDnsToLoopback();

    await assertToolError(
      () => webFetchTool.execute({ url: `http://${TEST_HOST}:${String(server.port)}/missing` }, makeCtx()),
      TOOL_ERROR_CODES.EXEC_FAILED,
      "HTTP 404",
    );
  });

  it("目标为回环地址（无 dns mock）→ TOOL_SSRF_BLOCKED", async () => {
    const server = await startServer({ "/": { contentType: "text/plain", body: "x" } });
    closers.push(server.close);
    await assertToolError(
      () => webFetchTool.execute({ url: `http://127.0.0.1:${String(server.port)}/` }, makeCtx()),
      TOOL_ERROR_CODES.SSRF_BLOCKED,
      "127.0.0.1",
    );
  });
});

describe("web_fetch：maxBytes 预算（02 §2.3/§2.4）", () => {
  it("超限截断：content 字节数 ≤ maxBytes 且带截断提示标记", async () => {
    const big = `word `.repeat(2000); // 10KB 文本
    const server = await startServer({
      "/big": { contentType: "text/plain", body: big },
    });
    closers.push(server.close);
    mockDnsToLoopback();

    const output = await webFetchTool.execute(
      { url: `http://${TEST_HOST}:${String(server.port)}/big`, maxBytes: 2048 },
      makeCtx(),
    );
    const content = output.content ?? "";
    assert.ok(Buffer.byteLength(content, "utf8") <= 2048, "content 应不超字节预算");
    assert.ok(content.includes("output truncated"), "应带截断提示");
    assert.equal(output.data.truncated, true);
    assert.equal(output.data.bytes, Buffer.byteLength(big, "utf8"));
  });
});

describe("web_fetch：重定向防护（02 §2.4，redirect manual 逐跳重校验）", () => {
  it("相对 Location（公网）跟随成功", async () => {
    const manual = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/hop") {
        res.writeHead(302, { location: "/final" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("final page");
    });
    await new Promise<void>((resolvePromise) => manual.listen(0, "127.0.0.1", resolvePromise));
    const address = manual.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    closers.push(() => new Promise((resolveClose) => manual.close(() => resolveClose())));
    mockDnsToLoopback();

    const output = await webFetchTool.execute({ url: `http://${TEST_HOST}:${String(port)}/hop` }, makeCtx());
    assert.equal(output.content, "final page");
  });

  it("302 跳板到 127.0.0.1 → 重定向目标过 SSRF 守卫被拦截", async () => {
    const manual = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(302, { location: "http://127.0.0.1:9/x" });
      res.end();
    });
    await new Promise<void>((resolvePromise) => manual.listen(0, "127.0.0.1", resolvePromise));
    const address = manual.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    closers.push(() => new Promise((resolveClose) => manual.close(() => resolveClose())));
    mockDnsToLoopback(); // 首跳经守卫放行（mock 公网 IP），跳板 Location 为字面回环 → 拦截

    await assertToolError(
      () => webFetchTool.execute({ url: `http://${TEST_HOST}:${String(port)}/x` }, makeCtx()),
      TOOL_ERROR_CODES.SSRF_BLOCKED,
      "127.0.0.1",
    );
  });
});
