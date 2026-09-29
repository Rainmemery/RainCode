/**
 * SSRF 防护（T2.7 P1 web_fetch；02-module-design §2.3/§2.4「web_fetch 命中内网地址/黑名单域名
 * → 直接拒绝（SSRF 防护），错误注明原因」）。
 *
 * - 仅 http/https；hostname 为 IP 字面量时直接校验，否则 DNS 解析（lookup all）后逐 IP 校验；
 * - 黑名单为强制安全底线（与 02 §2.3「域名白名单校验」的取舍见 handlers/web-fetch.ts 头注）：
 *   IPv4 私网/环回/链路本地/保留段 + IPv6 环回/链路本地/ULA + IPv4-mapped 映射段；
 * - localhost / *.localhost 直接拒绝；解析失败按执行失败收敛（fail-closed，不连接）。
 */
import dnsPromises from "node:dns/promises";
import { isIP } from "node:net";
import { TOOL_ERROR_CODES } from "@raincode/shared";
import { ToolExecutionError } from "./executor.js";

/** DNS 解析结果的最小投影（node:dns/promises LookupAddress）。 */
interface ResolvedAddress {
  address: string;
  family: number;
}

/** lookup 注入点（单测 mock seam；生产缺省走 node:dns/promises lookup all）。 */
export interface SsrfLookupDeps {
  lookup?: (hostname: string, options: { all: true; verbatim: true }) => Promise<ResolvedAddress[]>;
}

/** IPv4 地址 → 无符号 32 位整数（非法形态返回 null；0.0.0.0 是合法值）。 */
function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255 || !/^\d+$/.test(part)) return null;
    value = value * 256 + octet;
  }
  return value >>> 0;
}

/** IPv4 是否落在 CIDR 网段（prefix 0~32）。 */
function isIpv4InRange(ip: string, cidr: string, prefix: number): boolean {
  const base = ipv4ToUint32(cidr);
  const value = ipv4ToUint32(ip);
  if (base === null || value === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

/** 展开 IPv6 为 8 组 16 位（处理 :: 压缩与 IPv4-mapped 尾段）。 */
function expandIpv6(ip: string): Array<number> | null {
  let head = ip;
  let mappedValue: number | null = null;
  // IPv4-mapped/嵌 IPv4 尾段（::ffff:192.168.1.1）：尾段按 IPv4 解析
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToUint32(tail);
    if (v4 === null) return null;
    mappedValue = v4;
    head = ip.slice(0, lastColon + 1) + "0:0";
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] === "" ? [] : halves[0]!.split(":");
  const right = halves.length === 2 ? (halves[1] === "" ? [] : halves[1]!.split(":")) : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 0) return null;
  const groups: Array<number> = [];
  for (const group of [...left, ...Array<string>(Math.max(missing, 0)).fill("0"), ...right]) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
    groups.push(Number.parseInt(group, 16));
  }
  if (groups.length !== 8) return null;
  // IPv4-mapped 还原为高 16 位组形式（::ffff:aabb:ccdd）供统一判定
  if (mappedValue !== null) {
    groups[6] = (mappedValue >>> 16) & 0xffff;
    groups[7] = mappedValue & 0xffff;
  }
  return groups;
}

/** IPv6 是否落在 CIDR 网段（prefix 0~128；BigInt 位掩码）。 */
function isIpv6InRange(ip: string, cidrGroups: Array<number>, prefix: number): boolean {
  const groups = expandIpv6(ip);
  if (groups === null) return false;
  const toBig = (g: Array<number>): bigint =>
    g.reduce((acc, part) => (acc << 16n) | BigInt(part), 0n);
  const value = toBig(groups);
  const base = toBig(cidrGroups);
  if (prefix === 0) return true;
  const mask = ((1n << BigInt(prefix)) - 1n) << BigInt(128 - prefix);
  return (value & mask) === (base & mask);
}

/** IPv6 黑名单段（任务口径）：环回 ::1、链路本地 fe80::/10、ULA fc00::/7。 */
const IPV6_FE80: Array<number> = expandIpv6("fe80::")!;
const IPV6_FC00: Array<number> = expandIpv6("fc00::")!;

/** IPv6（含 IPv4-mapped 映射段）黑名单判定。 */
function isBlockedIpv6(ip: string): boolean {
  const groups = expandIpv6(ip);
  if (groups === null) return true; // 解析失败按拦截收敛（fail-closed）
  // IPv4-mapped（::ffff:0:0/96）：还原映射的 IPv4 后按 IPv4 黑名单判定
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = `${(groups[6]! >> 8).toString()}.${(groups[6]! & 0xff).toString()}.${(groups[7]! >> 8).toString()}.${(groups[7]! & 0xff).toString()}`;
    return isBlockedIpv4(v4);
  }
  if (isIpv6InRange(ip, [0, 0, 0, 0, 0, 0, 0, 1], 128)) return true; // ::1
  if (isIpv6InRange(ip, IPV6_FE80, 10)) return true; // fe80::/10 链路本地
  if (isIpv6InRange(ip, IPV6_FC00, 7)) return true; // fc00::/7 ULA
  if (isIpv6InRange(ip, [0, 0, 0, 0, 0, 0, 0, 0], 128)) return true; // :: 未指定地址
  return false;
}

/** IPv4 黑名单段（任务口径，02 §2.4「内网地址/黑名单域名」的落地清单）。 */
function isBlockedIpv4(ip: string): boolean {
  return (
    isIpv4InRange(ip, "0.0.0.0", 8) || // 0.0.0.0/8 本网络
    isIpv4InRange(ip, "10.0.0.0", 8) || // 10/8 私网
    isIpv4InRange(ip, "127.0.0.0", 8) || // 127/8 环回
    isIpv4InRange(ip, "169.254.0.0", 16) || // 169.254/16 链路本地（云 metadata）
    isIpv4InRange(ip, "172.16.0.0", 12) || // 172.16/12 私网
    isIpv4InRange(ip, "192.168.0.0", 16) || // 192.168/16 私网
    isIpv4InRange(ip, "100.64.0.0", 10) || // 100.64/10 CGNAT
    isIpv4InRange(ip, "192.0.0.0", 24) || // 192.0.0/24 IETF 协议保留
    isIpv4InRange(ip, "198.18.0.0", 15) || // 198.18/15 基准测试保留
    isIpv4InRange(ip, "224.0.0.0", 4) || // 224/4 组播
    isIpv4InRange(ip, "240.0.0.0", 4) // 240/4 保留（含广播）
  );
}

/** 单个解析地址黑名单判定（按 family 分派；未知 family fail-closed）。 */
function isBlockedAddress(address: string, family: number): boolean {
  if (family === 4) return isBlockedIpv4(address);
  if (family === 6) return isBlockedIpv6(address);
  return true;
}

function reject(reason: string, detail?: string): ToolExecutionError {
  return new ToolExecutionError(TOOL_ERROR_CODES.SSRF_BLOCKED, reason, detail);
}

/**
 * SSRF 守卫：仅 http/https；拒绝 localhost/*.localhost 与一切黑名单网段地址。
 * IP 字面量直接校验；域名经 DNS lookup all 后逐地址校验（任一地址命中即拒绝）。
 * 返回归一化 URL（校验通过）；拒绝抛 ToolExecutionError(TOOL_SSRF_BLOCKED) 并注明原因。
 */
export async function assertPublicHttpUrl(raw: string, deps: SsrfLookupDeps = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw reject(`URL 无法解析: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw reject(`仅允许 http/https 协议: ${url.protocol.replace(/:$/, "")}`, raw);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw reject(`拒绝访问本机地址: ${hostname}`, raw);
  }
  const literalFamily = isIP(hostname);
  if (literalFamily !== 0) {
    if (isBlockedAddress(hostname, literalFamily)) {
      throw reject(`拒绝访问内网/保留地址: ${hostname}`, raw);
    }
    return url;
  }
  const doLookup = deps.lookup ?? (async (host: string, options: { all: true; verbatim: true }) =>
    (await dnsPromises.lookup(host, options)) as ResolvedAddress[]);
  let addresses: ResolvedAddress[];
  try {
    addresses = await doLookup(hostname, { all: true, verbatim: true });
  } catch (reason: unknown) {
    // fail-closed：解析失败无法证明公网属性，按执行失败收敛（不发起连接）
    const message = reason instanceof Error ? reason.message : String(reason);
    throw new ToolExecutionError(TOOL_ERROR_CODES.EXEC_FAILED, `DNS 解析失败: ${hostname}: ${message}`);
  }
  if (addresses.length === 0) {
    throw reject(`DNS 解析无地址: ${hostname}`, raw);
  }
  const blocked = addresses.find((entry) => isBlockedAddress(entry.address, entry.family));
  if (blocked !== undefined) {
    throw reject(`拒绝访问内网/保留地址: ${hostname} → ${blocked.address}`, raw);
  }
  return url;
}
