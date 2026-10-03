/** Tailwind tokens 与桌面端 03 §3.1 同源（深色工作台基调）。 */
module.exports = {
  content: ["./src/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        ink: { 950: "#0d1117", 900: "#161b22", 800: "#21262d", 700: "#30363d" },
        accent: { DEFAULT: "#58a6ff", dim: "#1f6feb" },
        ok: "#3fb950",
        warn: "#d29922",
        danger: "#f85149",
      },
    },
  },
  plugins: [],
};
