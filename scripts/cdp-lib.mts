/**
 * CDP 走查共享件（walkthrough-desktop / walkthrough-web 共用）：最小 CDP 客户端与 DOM 助手。
 * 设计口径延续 M2 场景 5：Runtime.evaluate（DOM 语义点击）与 Input.insertText / dispatchKeyEvent
 * （真实键盘流）——断言以页面真实渲染为准，不以被测方自述为准（defensive-patterns N-3）。
 */
import WebSocket from "ws";

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (value: unknown) => void>();

  private constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on("message", (raw: WebSocket.RawData) => {
      const msg = JSON.parse(String(raw)) as { id?: number; result?: unknown };
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg.result);
        this.pending.delete(msg.id);
      }
    });
  }

  static async connect(
    port: number,
    urlFilter?: (target: { url: string; id: string }) => boolean,
  ): Promise<Cdp> {
    const match = urlFilter ?? (() => true);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const list = (await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()) as Array<{
          type: string;
          id: string;
          url: string;
          webSocketDebuggerUrl: string;
        }>;
        const page = list.find((t) => t.type === "page" && !t.url.startsWith("devtools") && match(t));
        if (page !== undefined) {
          const cdp = new Cdp(page.webSocketDebuggerUrl);
          await new Promise<void>((res, rej) => {
            cdp.ws.once("open", () => res());
            cdp.ws.once("error", (err) => rej(err));
          });
          return cdp;
        }
      } catch {
        // 端口未就绪，轮询
      }
      await sleep(500);
    }
    throw new Error("CDP 连接超时（目标进程未启动或 --remote-debugging-port 失效）");
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, res as (value: unknown) => void);
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`CDP ${method} 超时`));
        }
      }, 30_000);
    });
  }

  /** 页面内表达式求值（awaitPromise + returnByValue；异常抛出）。 */
  async eval<T>(expression: string): Promise<T> {
    const result = await this.send<{ result?: { value?: T }; exceptionDetails?: { exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
    );
    if (result.exceptionDetails !== undefined) {
      throw new Error(`页面异常: ${String(result.exceptionDetails.exception?.description ?? "unknown")}`);
    }
    return result.result?.value as T;
  }

  /** 轮询等待页面内条件成立。 */
  async waitFor(expr: string, label: string, timeoutMs = 15_000): Promise<void> {
    const started = Date.now();
    for (;;) {
      const ok = await this.eval<boolean>(expr).catch(() => false);
      if (ok === true) return;
      if (Date.now() - started > timeoutMs) throw new Error(`等待超时: ${label}`);
      await sleep(300);
    }
  }

  /** 真实按键（windowsVirtualKeyCode 必须给，React onKeyDown 读 key 字段）。 */
  async key(keyText: string, code: string, vk: number): Promise<void> {
    const base = { key: keyText, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async insertText(text: string): Promise<void> {
    await this.send("Input.insertText", { text });
  }

  close(): void {
    this.ws.close();
  }
}

// ---------------------------------------------------------------------------
// DOM 助手（页面内表达式字符串）
// ---------------------------------------------------------------------------

export const clickButtonExpr = (label: string): string =>
  `(() => { const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim().includes(${JSON.stringify(label)})); if (!b) return false; b.click(); return true; })()`;

export const bodyContains = (needle: string): string =>
  `document.body.innerText.includes(${JSON.stringify(needle)})`;

/** 点指定 section（按内容定位）下的精确文本按钮。 */
export const clickInSection = (sectionNeedle: string, buttonText: string): string =>
  `(() => { const row = [...document.querySelectorAll("section")].find(s => s.innerText.includes(${JSON.stringify(sectionNeedle)})); if (!row) return false; const b = [...row.querySelectorAll("button")].find(x => x.textContent.trim() === ${JSON.stringify(buttonText)}); if (!b) return false; b.click(); return true; })()`;
