/* Tailwind config for the Tailwind-CSS edition of the web app.
 * Colours map to the CSS variables in src.css so light / dark / auto theming
 * (html[data-theme] + prefers-color-scheme) keeps working with plain utilities
 * such as bg-card / text-ink / border-line. */
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
        brand1: "var(--brand1)", brand2: "var(--brand2)",
        accent: "var(--accent)", "accent-ink": "var(--accent-ink)", "accent-soft": "var(--accent-soft)",
        good: "var(--good)", "good-ink": "var(--good-ink)", "good-soft": "var(--good-soft)",
        critical: "var(--critical)", "critical-ink": "var(--critical-ink)", "critical-soft": "var(--critical-soft)",
      },
      borderRadius: { xl2: "var(--radius)" },
      boxShadow: { card: "var(--shadow)" },
      maxWidth: { wrap: "1180px" },
    },
  },
  corePlugins: {
    // the design sets light/dark via CSS variables, not Tailwind's dark: variant
    preflight: true,
  },
  plugins: [],
};
