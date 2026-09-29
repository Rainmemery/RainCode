/**
 * web_fetch 工具（T2.7 P1；02-module-design §2.3 清单「抓取 URL 转 Markdown」/ §2.4 SSRF 行）。
 *
 * - 安全边界：assertPublicHttpUrl 黑名单校验（含 DNS 解析后逐 IP 判定）+ 重定向逐跳重校验
 *   （redirect: manual，Location 重新过守卫，上限 5 跳）；
 * - 偏差注记（交付报告申报）：02 §2.3「域名白名单校验」原义为用户可配置白名单；本实现以
 *   SSRF 黑名单为强制底线、审批 allow-always 即工具级放行（工具级规则 pattern 缺省匹配全部
 *   调用，与域名粒度白名单存在张力）——不做用户可配置白名单，黑名单不可绕过（02 §2.4）。
 * - metadata needsApproval=true（首个网络工具从严：每次联网审批；readOnly=true 仅影响并行度，
 *   normal 策略下 sideEffectScope=network 不进 L1/L2 静默放行路径，仍走 default ask）。
 * - HTML → 文本转换为正则级最小实现（剔 script/style、块级标签换行、实体解码、空行折叠），
 *   不引入依赖；JSON content-type 原文返回；一切网络超时受 ctx.signal 约束（executor 链接
 *   metadata.timeoutMs=30s，02 §2.4）。
 */
import { z } from "zod";
import { TOOL_ERROR_CODES } from "@raincode/shared";
import type { Tool, ToolOutput, ToolExecutionContext } from "../tool.js";
import { ToolExecutionError } from "../executor.js";
import { assertPublicHttpUrl } from "../ssrf.js";
import { truncateToByteBudget } from "../truncate.js";

/** 缺省字节上限（对齐 DEFAULT_MAX_OUTPUT_BYTES，02 §2.3 输出预算缺省 256KB）。 */
const DEFAULT_MAX_BYTES = 256 * 1024;
/** 重定向跟随上限（02 §2.4 SSRF 防护：逐跳重校验，防跳板绕过）。 */
const MAX_REDIRECTS = 5;

export interface WebFetchInput {
  url: string;
  maxBytes?: number;
}

export interface WebFetchOutput {
  url: string;
  status: number;
  bytes: number;
  truncated: boolean;
  text: string;
}

export const webFetchTool: Tool<WebFetchInput, WebFetchOutput> = {
  name: "web_fetch",
  description:
    "Fetch a public HTTP(S) URL and return its content converted to readable text " +
    "(HTML simplified to text/markdown; JSON returned verbatim). " +
    "Private/loopback/reserved addresses are rejected (SSRF protection). " +
    "Use maxBytes to cap the response size.",
  parametersSchema: z.object({
    url: z.string().min(1).describe("Absolute http(s) URL of a public host"),
    maxBytes: z
      .number()
      .int()
      .min(1024)
      .max(2_097_152)
      .optional()
      .describe(`Max response bytes kept (default ${String(DEFAULT_MAX_BYTES)}; larger pages are truncated)`),
  }),
  metadata: {
    readOnly: true,
    destructive: false,
    sideEffectScope: "network",
    riskLevel: "medium",
    needsApproval: true,
    timeoutMs: 30_000,
  },
  async execute(
    input: WebFetchInput,
    ctx: ToolExecutionContext,
  ): Promise<ToolOutput<WebFetchOutput>> {
    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    let currentUrl = await assertPublicHttpUrl(input.url);

    let response: Response | undefined;
    let redirects = 0;
    for (;;) {
      // redirect: manual —— 3xx 的 Location 重新过 SSRF 守卫再跟随（02 §2.4 跳板防护）
      const attempt = await fetch(currentUrl, {
        redirect: "manual",
        signal: ctx.signal,
        headers: { accept: "text/html,application/json;q=0.9,text/*;q=0.8" },
      }).catch((reason: unknown): never => {
        throw new ToolExecutionError(
          TOOL_ERROR_CODES.EXEC_FAILED,
          `fetch failed: ${currentUrl.href}: ${reason instanceof Error ? reason.message : String(reason)}`,
        );
      });
      const status = attempt.status;
      if (status >= 300 && status < 400) {
        const location = attempt.headers.get("location");
        void attempt.body?.cancel().catch(() => undefined);
        if (location === null || location.length === 0) {
          throw new ToolExecutionError(TOOL_ERROR_CODES.EXEC_FAILED, `HTTP ${String(status)} 无 Location`);
        }
        redirects += 1;
        if (redirects > MAX_REDIRECTS) {
          throw new ToolExecutionError(
            TOOL_ERROR_CODES.EXEC_FAILED,
            `重定向超过上限 ${String(MAX_REDIRECTS)} 跳: ${currentUrl.href}`,
          );
        }
        let next: URL;
        try {
          next = new URL(location, currentUrl);
        } catch {
          throw new ToolExecutionError(TOOL_ERROR_CODES.EXEC_FAILED, `非法 Location: ${location}`);
        }
        // 重定向目标同样过 SSRF 守卫（私网/环回跳板直接拒绝，02 §2.4）
        currentUrl = await assertPublicHttpUrl(next.href);
        continue;
      }
      response = attempt;
      break;
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new ToolExecutionError(
        TOOL_ERROR_CODES.EXEC_FAILED,
        `HTTP ${String(response.status)} ${response.statusText}`.trim(),
        currentUrl.href,
      );
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const bodyCapped = buffer.length > maxBytes;
    const rawText = (bodyCapped ? buffer.subarray(0, maxBytes) : buffer).toString("utf8");
    const converted = convertBody(rawText, response.headers.get("content-type") ?? "");
    // 字节上限截断复用 truncateToByteBudget（02 §2.4：保留头 70% / 尾 30% + 截断提示行）；
    // body 被封顶时先附省略注记，保证 content 恒带截断标记（转换后文本恰巧 ≤ 预算的场景）
    const omittedBytes = Math.max(buffer.length - maxBytes, 0);
    const withNote = bodyCapped
      ? `${converted}\n…[response body capped at ${String(maxBytes)} bytes; ${String(omittedBytes)} bytes omitted — raise maxBytes]…`
      : converted;
    const { text: content, truncated } = truncateToByteBudget(withNote, maxBytes);
    ctx.onProgress?.({
      stream: "generic",
      text: `${currentUrl.href} · ${String(buffer.length)} bytes · HTTP ${String(response.status)}`,
    });
    return {
      data: {
        url: currentUrl.href,
        status: response.status,
        bytes: buffer.length,
        truncated: bodyCapped || truncated,
        text: converted,
      },
      content,
    };
  },
};

/** 响应体转换：application/json 原文；其余文本类型走 HTML → 可读文本最小转换。 */
function convertBody(raw: string, contentType: string): string {
  if (contentType.toLowerCase().includes("json")) {
    return raw; // JSON 原文返回（剥标签会破坏结构）
  }
  return htmlToText(raw);
}

/**
 * HTML → 可读文本（正则级最小实现）：剔 script/style/注释 → 块级标签换行 → 剥剩余标签 →
 * 实体解码（&amp; &lt; &gt; &quot; &#39; &nbsp; 最小集）→ 连续空行折叠。
 */
export function htmlToText(html: string): string {
  const withoutScripts = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style\s*>/gi, " ");
  const withBreaks = withoutScripts.replace(
    /<\s*(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/blockquote|\/pre|\/section|\/article|\/header|\/footer)\b[^>]*>/gi,
    "\n",
  );
  const stripped = withBreaks.replace(/<[^>]*>/g, "");
  const decoded = stripped
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
  return decoded
    .split("\r\n")
    .join("\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
