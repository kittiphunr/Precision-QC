/* Tailwind config for the Dashboard edition. Tailwind is the core framework
 * here (preflight + utilities); form controls and buttons are authored with
 * @apply in src.css. Colours map to the CSS variables so light/dark theming
 * (html[data-theme] + prefers-color-scheme) keeps working. */
module.exports = {
  content: ["./index.html", "./app.js"],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans Thai"', '"Noto Sans SC"', "system-ui", "-apple-system", '"Segoe UI"', '"PingFang SC"', '"Microsoft YaHei"', "sans-serif"],
      },
      colors: {
        bg: "var(--bg)", card: "var(--card)", field: "var(--field)",
        ink: "var(--ink)", "ink-2": "var(--ink-2)", muted: "var(--muted)",
        line: "var(--line)", soft: "var(--soft)",
        accent: "var(--accent)", "accent-ink": "var(--accent-ink)", "accent-soft": "var(--accent-soft)",
        good: "var(--good)", "good-ink": "var(--good-ink)", "good-soft": "var(--good-soft)",
        critical: "var(--critical)", "critical-ink": "var(--critical-ink)", "critical-soft": "var(--critical-soft)",
      },
    },
  },
  plugins: [],
};
