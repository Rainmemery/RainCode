/**
 * SSRF 守卫单测（T2.7 任务 1 · 02-module-design §2.4「web_fetch 命中内网地址/黑名单域名
 * → 直接拒绝（SSRF 防护），错误注明原因」）。
 * - 字面 IP：IPv4 私网/环回/链路本地/保留段全清单 + IPv6 环回/链路本地/ULA + IPv4-mapped；
 * - localhost / *.localhost 直接拒绝；非 http(s) scheme 拒绝；
 * - 公网域名：mock dns.promises.lookup 返回公网 IP → 放行；多地址含私网 → 拒绝；
 * - 解析失败 fail-closed（TOOL_EXEC_FAILED）；无法解析的 URL → TOOL_SSRF_BLOCKED。
 */
import assert from "node:assert/strict";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { afterEach, describe, it, mock } from "node:test";
import { assertPublicHttpUrl } from "../src/index.js";
import { ToolExecutionError } from "../src/index.js";
import { TOOL_ERROR_CODES } from "@raincode/shared";

afterEach(() => {
  mock.restoreAll();
});

/** 断言 URL 被 SSRF 守卫拒绝且原因可读（02 §2.4「错误注明原因」）。 */
async function assertBlocked(raw: string, reasonPart?: string): Promise<void> {
  await assert.rejects(
    assertPublicHttpUrl(raw),
    (err: unknown) => {
      assert.ok(err instanceof ToolExecutionError, `应抛 ToolExecutionError，实得 ${String(err)}`);
      assert.equal(err.code, TOOL_ERROR_CODES.SSRF_BLOCKED);
      if (reasonPart !== undefined) {
        assert.ok(err.message.includes(reasonPart), `原因应含「${reasonPart}」：${err.message}`);
      }
      return true;
    },
  );
}

describe("SSRF 守卫（02 §2.4）：IP 字面量黑名单", () => {
  const blockedIpv4 = [
    "0.0.0.0", // 0.0.0.0/8 本网络
    "10.1.2.3", // 10/8 私网
    "127.0.0.1", // 127/8 环回
    "169.254.169.254", // 169.254/16 链路本地（云 metadata 端点）
    "172.16.0.1", // 172.16/12 私网
    "172.31.255.255", // 172.16/12 上界
    "192.168.1.1", // 192.168/16 私网
    "100.64.0.1", // 100.64/10 CGNAT
    "192.0.0.1", // 192.0.0/24 IETF 协议保留
    "198.18.0.1", // 198.18/15 基准测试保留
    "198.19.255.255", // 198.18/15 上界
    "224.0.0.1", // 224/4 组播
    "240.0.0.1", // 240/4 保留
  ];
  for (const ip of blockedIpv4) {
    it(`拒绝 IPv4 ${ip}`, async () => {
      await assertBlocked(`http://${ip}/x`, ip);
    });
  }

  it("放行公网 IPv4 字面量（93.184.216.34）", async () => {
    const url = await assertPublicHttpUrl("http://93.184.216.34/page");
    assert.equal(url.hostname, "93.184.216.34");
  });

  const blockedIpv6 = [
    "[::1]", // 环回
    "[fe80::1]", // 链路本地 fe80::/10
    "[fc00::1]", // ULA fc00::/7
    "[fd12:3456:789a::1]", // ULA fd00::/8
    "[::ffff:10.0.0.1]", // IPv4-mapped → 私网
    "[::ffff:127.0.0.1]", // IPv4-mapped → 环回
    "[::ffff:192.168.1.1]", // IPv4-mapped → 私网
  ];
  for (const host of blockedIpv6) {
    it(`拒绝 IPv6 ${host}`, async () => {
      await assertBlocked(`http://${host}/x`);
    });
  }

  it("放行公网 IPv6 字面量（2606:2800:220:1:248:1893:25c8:1946）", async () => {
    const url = await assertPublicHttpUrl("http://[2606:2800:220:1:248:1893:25c8:1946]/page");
    assert.equal(url.port, "");
  });
});

describe("SSRF 守卫（02 §2.4）：本机地址与协议", () => {
  it("拒绝 localhost", async () => {
    await assertBlocked("http://localhost:8080/admin", "localhost");
  });

  it("拒绝 *.localhost 子域", async () => {
    await assertBlocked("http://api.localhost/x", "localhost");
  });

  it("拒绝非 http(s) scheme（ftp/file）", async () => {
    await assertBlocked("ftp://example.com/file");
    await assertBlocked("file:///etc/passwd");
  });

  it("拒绝无法解析的 URL", async () => {
    await assertBlocked("not-a-url");
  });
});

describe("SSRF 守卫（02 §2.4）：域名解析路径（mock dns.promises.lookup）", () => {
  it("公网域名（解析为公网 IP）→ 放行并返回归一化 URL", async () => {
    mock.method(dnsPromises, "lookup", async () => [{ address: "93.184.216.34", family: 4 }]);
    const url = await assertPublicHttpUrl("https://example.com/page?a=1");
    assert.equal(url.hostname, "example.com");
    assert.equal(url.protocol, "https:");
  });

  it("多地址解析任一命中私网 → 拒绝并注明地址", async () => {
    mock.method(dnsPromises, "lookup", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);
    await assertBlocked("http://mixed.example.com/x", "10.0.0.5");
  });

  it("解析为 IPv6 私网（fe80::）→ 拒绝", async () => {
    mock.method(dnsPromises, "lookup", async () => [{ address: "fe80::1", family: 6 }]);
    await assertBlocked("http://v6-private.example.com/x");
  });

  it("解析失败 fail-closed（TOOL_EXEC_FAILED，不连接）", async () => {
    mock.method(dnsPromises, "lookup", async () => {
      throw new Error("ENOTFOUND");
    });
    await assert.rejects(
      assertPublicHttpUrl("http://missing.example.com/x"),
      (err: unknown) => err instanceof ToolExecutionError && err.code === TOOL_ERROR_CODES.EXEC_FAILED,
    );
  });

  it("lookup 注入点（deps.lookup）可替代 dns.promises 模块 mock", async () => {
    const url = await assertPublicHttpUrl("http://injected.example.com/x", {
      lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    });
    assert.equal(url.hostname, "injected.example.com");
  });
});

describe("SSRF 守卫（02 §2.4）：dns 模块未被 mock 时的真实路径", () => {
  it("字面 IP 校验不触发 DNS（127.0.0.1 即刻拒绝）", async () => {
    // 不 mock 任何 dns：字面量路径不发起解析，直接黑名单拒绝
    await assertBlocked("http://127.0.0.1:1/x", "127.0.0.1");
  });

  it("mock.method(dns, ...) 连接侧风格与守卫互不干扰（守卫用 dns/promises 对象）", async () => {
    // 守卫走 dnsPromises（默认导出对象）；此 mock 只动 node:dns 的 callback 版本
    mock.method(dns, "lookup", () => {
      throw new Error("should not be called");
    });
    await assertBlocked("http://10.9.8.7/x", "10.9.8.7");
  });
});
