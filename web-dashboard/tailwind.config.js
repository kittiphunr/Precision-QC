/* Tailwind config for the Dashboard edition.
 * Standard Tailwind utilities (via @apply in src.css); the only custom colour is
 * the user-selectable "primary" below. dark: follows the app's theme toggle (html[data-theme]) and the OS
 * setting for "auto", matching the other editions. */
module.exports = {
  content: ["./index.html", "./app.js", "./ui-dash.js"],
  darkMode: ["variant", [
    '&:where([data-theme="dark"], [data-theme="dark"] *)',
    '@media (prefers-color-scheme: dark) { &:where(:not([data-theme="light"], [data-theme="light"] *)) }',
  ]],
  theme: {
    extend: {
      // "primary" / "accent2" read CSS variables (R G B channels) that the display
      // settings rewrite at runtime — see applyPrimary() in common.js
      colors: {
        primary: Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]
          .map((n) => [n, `rgb(var(--p-${n}) / <alpha-value>)`])),
        accent2: { 400: "rgb(var(--q-400) / <alpha-value>)" },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans Thai"', '"Noto Sans SC"', "system-ui", "-apple-system", '"Segoe UI"', '"PingFang SC"', '"Microsoft YaHei"', "sans-serif"],
      },
    },
  },
  plugins: [],
};
