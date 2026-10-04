/**
 * Tailwind tokens：与桌面端同源（03 §3.1 赤陶磷光 v2，UI 重设计轮自 ink-* 迁移）。
 * 组件代码不写死色值，全部经语义色映射；按端最小实现（04 §2.3 policy），不抽公共包。
 */
module.exports = {
  content: ["./src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        void: "var(--bg-void)",
        base: "var(--bg-base)",
        panel: "var(--bg-panel)",
        card: "var(--bg-card)",
        raised: "var(--bg-raised)",
        hover: "var(--bg-hover)",
        selected: "var(--bg-selected)",
        popover: "var(--bg-popover)",
        "border-faint": "var(--border-faint)",
        "border-base": "var(--border)",
        "border-strong": "var(--border-strong)",
        hi: "var(--text-hi)",
        mid: "var(--text-mid)",
        low: "var(--text-low)",
        faint: "var(--text-faint)",
        accent: "var(--accent)",
        "accent-hover": "var(--accent-hover)",
        "accent-dim": "var(--accent-dim)",
        "accent-bg": "var(--accent-bg)",
        ok: "var(--ok)",
        warn: "var(--warn)",
        danger: "var(--danger)",
        info: "var(--info)",
        violet: "var(--violet)",
        cyan: "var(--cyan)",
        mint: "var(--mint)",
      },
      fontFamily: {
        sans: "var(--font-ui)",
        mono: "var(--font-mono)",
      },
      fontSize: {
        "2xs": ["11px", "14px"],
      },
      borderRadius: {
        sm: "4px",
        md: "6px",
        lg: "10px",
        xl: "14px",
      },
      boxShadow: {
        1: "0 1px 2px rgba(0,0,0,.40)",
        2: "0 4px 16px rgba(0,0,0,.45)",
        3: "0 12px 40px rgba(0,0,0,.55)",
      },
      transitionDuration: {
        fast: "120ms",
        med: "200ms",
        slow: "320ms",
      },
    },
  },
  plugins: [],
};
