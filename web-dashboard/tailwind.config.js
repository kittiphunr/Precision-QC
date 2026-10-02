/* Tailwind config for the Dashboard edition.
 * Standard Tailwind only: the UI is styled with Tailwind's default palette and
 * utilities (via @apply in src.css) — no custom theme colours or arbitrary
 * values. dark: follows the app's theme toggle (html[data-theme]) and the OS
 * setting for "auto", matching the other editions. */
module.exports = {
  content: ["./index.html", "./app.js"],
  darkMode: ["variant", [
    '&:where([data-theme="dark"], [data-theme="dark"] *)',
    '@media (prefers-color-scheme: dark) { &:where(:not([data-theme="light"], [data-theme="light"] *)) }',
  ]],
  theme: {
    extend: {
      fontFamily: {
        sans: ['"IBM Plex Sans Thai"', '"Noto Sans SC"', "system-ui", "-apple-system", '"Segoe UI"', '"PingFang SC"', '"Microsoft YaHei"', "sans-serif"],
      },
    },
  },
  plugins: [],
};
