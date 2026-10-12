/* Precision QC — code shared by every page (the dish QC page and the cap counter page).
 * Language + theme switching, the Python (Pyodide) engine loader, form helpers,
 * the on-screen numpad and a few small utilities. Texts live in i18n.js.
 * Load order on a page: i18n.js, common.js, then the page script (app.js / caps.js). */

const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const LANG_KEY = "precision-qc-lang";
const THEME_KEY = "precision-qc-theme";
const LANGS = ["th", "en", "zh"];
const LOCALE = { th: "th-TH", en: "en-GB", zh: "zh-CN" };
const APP_VERSION = "1.2";

const $ = (s, root = document) => root.querySelector(s);
let api = null;
let engineState = ["loading", "engine.loading"];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(+v) ? "—" : (+v).toFixed(d));
const stem = (name) => name.replace(/\.[^.]+$/, "");

/* --------------------------------------------------------------- language */
function pickLang() {
  const fromUrl = new URLSearchParams(location.search).get("lang");
  if (LANGS.includes(fromUrl)) return fromUrl;
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (LANGS.includes(saved)) return saved;
  } catch (_) { /* storage unavailable */ }
  const nav = (navigator.language || "").toLowerCase();
  if (nav.startsWith("zh")) return "zh";
  if (nav.startsWith("en")) return "en";
  return "th";
}
let lang = pickLang();
let pageTitleKey = "app.title"; // a page may point this at its own title
const langHooks = []; // callbacks run after every language change

// t("key", {name: value}) in the current (or given) language, falling back to English then Thai
function t(key, params = {}, lng = lang) {
  const s = window.I18N[lng]?.[key] ?? window.I18N.en[key] ?? window.I18N.th[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => (k in params ? params[k] : `{${k}}`));
}

function setEngine(state, key) {
  engineState = [state, key];
  $("#engine").className = `engine ${state}`;
  $("#engine-text").textContent = t(key);
}

// mark the chosen button of a segmented switch as active (class + aria-pressed)
function markActive(selector, isActive) {
  document.querySelectorAll(selector).forEach((b) => {
    const on = isActive(b);
    b.classList.toggle("is-active", on);
    b.setAttribute("aria-pressed", String(on));
  });
}

function applyLang(next) {
  lang = next;
  try { localStorage.setItem(LANG_KEY, lang); } catch (_) { /* ignore */ }
  document.documentElement.lang = lang === "zh" ? "zh-CN" : lang;
  document.title = t(pageTitleKey);
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  markActive(".lang-switch button", (b) => b.dataset.lang === lang);
  const credit = $("#credit");
  if (credit) {
    credit.lang = document.documentElement.lang;
    credit.innerHTML = `${t("credit.line1", { name: `<b>${esc(t("credit.name"))}</b>` })}<br />${esc(t("credit.line2"))}`;
  }
  setEngine(...engineState);
  langHooks.forEach((fn) => fn()); // each page re-renders its own dynamic text
}

document.querySelectorAll(".lang-switch button").forEach((b) => b.addEventListener("click", () => applyLang(b.dataset.lang)));

/* ------------------------------------------------------------------ theme
 * "light" / "dark" set html[data-theme]; "auto" removes it and follows the OS. */
function currentTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "auto";
  } catch (_) { return "auto"; }
}

function applyTheme(choice) {
  if (choice === "light" || choice === "dark") document.documentElement.setAttribute("data-theme", choice);
  else document.documentElement.removeAttribute("data-theme");
  try {
    if (choice === "auto") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, choice);
  } catch (_) { /* ignore */ }
  markActive(".theme-switch button", (b) => b.dataset.themeChoice === choice);
}

document.querySelectorAll(".theme-switch button").forEach((b) => b.addEventListener("click", () => applyTheme(b.dataset.themeChoice)));
applyTheme(currentTheme());

/* --------------------------------------------------------------------- boot
 * Loads the Python engine in the browser. A page passes
 *   manifest(m)  - called as soon as manifest.json is read (render sample buttons)
 *   ready(api)   - called once the engine is up (load defaults, enable inputs) */
async function boot(page = {}) {
  if (window.__QC_DENY__) return; // hosted build: blocked on an unauthorised domain
  try {
    const manifest = await (await fetch("manifest.json", { cache: "no-store" })).json();
    if (page.manifest) page.manifest(manifest);
    const pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX });
    setEngine("loading", "engine.loading2");
    await pyodide.loadPackage(["numpy", "pillow"]);
    const root = "/home/pyodide/precision_qc";
    pyodide.FS.mkdirTree(root);
    for (const f of manifest.py_files) {
      const src = await (await fetch(`py/precision_qc/${f}?v=${manifest.build}`)).text();
      pyodide.FS.writeFile(`${root}/${f}`, src);
    }
    pyodide.runPython("import sys; sys.path.insert(0, '/home/pyodide')");
    api = pyodide.pyimport("precision_qc.api");
    if (page.ready) await page.ready(api);
    setEngine("ready", "engine.ready");
    document.querySelectorAll(".chip").forEach((b) => (b.disabled = false));
  } catch (err) {
    console.error(err);
    setEngine("error", "engine.error");
  }
}

/* -------------------------------------------------------------------- forms */
function readForm(form, numeric) {
  const out = {};
  for (const input of form.querySelectorAll("input[name]")) {
    if (input.type === "checkbox") { out[input.name] = numeric ? (input.checked ? 1 : 0) : input.checked; continue; }
    out[input.name] = numeric ? (input.value === "" ? null : Number(input.value)) : input.value.trim();
  }
  return out;
}

function loadForm(form, key, base = {}) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || "{}"); } catch (_) { /* storage unavailable */ }
  const data = { ...base, ...saved };
  for (const input of form.querySelectorAll("input[name]")) {
    if (input.type === "checkbox") input.checked = Number(data[input.name]) === 1 || data[input.name] === true;
    else input.value = data[input.name] ?? "";
  }
}

function persist(form, key, numeric) {
  try { localStorage.setItem(key, JSON.stringify(readForm(form, numeric))); } catch (_) { /* ignore */ }
}

/* ---------------------------------------------------------------- utilities */
function lightbox(src) {
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<img src="${src}" alt="" />`;
  box.addEventListener("click", () => box.remove());
  document.body.appendChild(box);
}

function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------------------------------------------------------------- PDF engine
 * Shared by both pages. A page builds the HTML of its A4 report pages
 * (".rpage" blocks, styled in the edition CSS); makePdf() renders each with
 * html2canvas and assembles them into one PDF with jsPDF (both loaded on demand). */
const PDF_LIBS = [
  "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
];

const libPromises = {};
function loadScript(src) {
  libPromises[src] ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => { delete libPromises[src]; s.remove(); reject(new Error(`cannot load ${src}`)); };
    document.head.appendChild(s);
  });
  return libPromises[src];
}

// ISO 8601 calendar dates (YYYY-MM-DD) in local time
const isoDate = (d) => {
  if (!d) return "—";
  if (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const x = new Date(d), p = (n) => String(n).padStart(2, "0");
  return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`;
};
const dash = (v) => (v ? esc(v) : "—");

// Content must end above the footer; if it does not, use the denser layout.
function fitPage(page) {
  const limit = page.querySelector(".r-foot").offsetTop - 8;
  const bottom = () => Math.max(...[...page.children].filter((el) => !el.classList.contains("r-foot"))
    .map((el) => el.offsetTop + el.offsetHeight));
  if (bottom() > limit) page.classList.add("compact");
}

async function waitForImages(root) {
  await Promise.all([...root.querySelectorAll("img")].map((img) =>
    img.complete ? Promise.resolve() : new Promise((res) => { img.onload = img.onerror = res; })));
}

function newReportNo(date, prefix = "PQC") {
  const d = isoDate(date).replace(/-/g, "");
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, "0");
  return `${prefix}-${d}-${rnd}`;
}

// pages(i) -> HTML of report i; props -> {title, subject}; fileName -> output name
async function makePdf({ n, pages, props, fileName }) {
  const lng = lang;
  const overlay = $("#busy");
  overlay.hidden = false;
  $("#busy-text").textContent = t("busy.pdf");
  const host = document.createElement("div");
  host.className = "report-host";
  document.body.appendChild(host);
  try {
    for (const src of PDF_LIBS) await loadScript(src);
    if (document.fonts?.ready) await document.fonts.ready;
    const { jsPDF } = window.jspdf;
    const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4", compress: true });
    let first = true;
    for (let i = 0; i < n; i++) {
      $("#busy-text").textContent = t("busy.pdfN", { i: i + 1, n });
      host.innerHTML = pages(i);
      await waitForImages(host);
      for (const page of host.querySelectorAll(".rpage")) {
        fitPage(page);
        const canvas = await html2canvas(page, { scale: 2, backgroundColor: "#ffffff", logging: false, scrollX: 0, scrollY: 0 });
        if (!first) pdf.addPage("a4", "portrait");
        first = false;
        pdf.addImage(canvas.toDataURL("image/jpeg", 0.9), "JPEG", 0, 0, 210, 297, undefined, "FAST");
      }
    }
    pdf.setProperties({
      ...props,
      creator: `Precision QC v${APP_VERSION}`,
      author: `${t("credit.name", {}, lng)}, ${t("credit.line2", {}, lng)}`,
    });
    download(fileName, pdf.output("blob"));
  } catch (err) {
    console.error(err);
    alert(t("alert.pdfFail"));
  } finally {
    host.remove();
    overlay.hidden = true;
  }
}

/* ------------------------------------------------------------------ numpad
 * On-screen number pad for every <input type="number"> (gloved hands / tablets
 * in the lab). Tapping a field opens it; keys edit the field live, and the
 * physical keyboard still works (the OS keyboard is suppressed with
 * inputmode="none"). OK / tapping outside keeps the value (clamped to the
 * field's min/max), Cancel restores it. */
const NUMPAD_CSS = `
.np{position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:90;width:min(340px,calc(100vw - 24px));box-sizing:border-box;padding:12px;border-radius:16px;border:1px solid rgba(128,128,128,.45);background:var(--np-bg,#fff);color:var(--np-fg,#111);box-shadow:0 14px 44px rgba(0,0,0,.4);display:grid;gap:10px;user-select:none;-webkit-user-select:none;touch-action:manipulation}
.np[hidden]{display:none}
.np.anchored{bottom:auto;transform:none}
input[type=number]{-moz-appearance:textfield;appearance:textfield}
input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
.np-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;min-width:0}
.np-title{font-weight:700;font-size:.9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.np-range{font-size:.78em;opacity:.65;white-space:nowrap}
.np-display{font-size:2em;font-weight:800;font-variant-numeric:tabular-nums;text-align:right;padding:6px 12px;border-radius:10px;background:rgba(128,128,128,.14);min-height:1.4em;line-height:1.4;overflow:hidden}
.np-keys{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.np-key{font:inherit;font-size:1.35em;font-weight:700;height:54px;border-radius:12px;border:1px solid rgba(128,128,128,.4);background:rgba(128,128,128,.16);color:inherit;cursor:pointer;padding:0;display:flex;align-items:center;justify-content:center}
.np-key:active{background:rgba(128,128,128,.4)}
.np-key:disabled{opacity:.3;cursor:default}
.np-key.fn{font-size:1em;background:rgba(128,128,128,.08)}
.np-key.step{font-size:.95em}
.np-key.ok{background:var(--np-accent,#4f46e5);border-color:transparent;color:#fff;grid-column:span 2}
.np-key.cancel{grid-column:span 2;font-size:1em}
`;

function initNumpad() {
  const style = document.createElement("style");
  style.textContent = NUMPAD_CSS;
  document.head.appendChild(style);
  const pad = document.createElement("div");
  pad.className = "np";
  pad.hidden = true;
  pad.setAttribute("role", "dialog");
  const key = (txt, act, cls = "") => `<button type="button" class="np-key ${cls}" data-k="${act}">${txt}</button>`;
  pad.innerHTML = `
    <div class="np-head"><span class="np-title"></span><span class="np-range"></span></div>
    <div class="np-display" aria-live="polite"></div>
    <div class="np-keys">
      ${key("7", "7")}${key("8", "8")}${key("9", "9")}${key("⌫", "bs", "fn")}
      ${key("4", "4")}${key("5", "5")}${key("6", "6")}${key("C", "clear", "fn")}
      ${key("1", "1")}${key("2", "2")}${key("3", "3")}${key("−", "dec", "step")}
      ${key("±", "neg", "fn")}${key("0", "0")}${key(".", ".")}${key("+", "inc", "step")}
      ${key("", "cancel", "cancel fn")}${key("", "ok", "ok")}
    </div>`;
  document.body.appendChild(pad);
  const $k = (k) => pad.querySelector(`[data-k="${k}"]`);
  let cur = null, orig = "", buf = "", fresh = false, savedPad = "";

  const attr = (n) => (cur && cur.getAttribute(n) !== null && cur.getAttribute(n) !== "" ? Number(cur.getAttribute(n)) : null);
  const decimals = (x) => (String(x).split(".")[1] || "").length;
  const labelOf = (inp) => {
    const l = (inp.id && document.querySelector(`label[for="${inp.id}"]`)) || inp.closest("label");
    const b = l && (l.querySelector("b, span") || l);
    return (b ? b.textContent : inp.name || "").trim();
  };
  const solidBg = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (c && !/rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(c)) return c;
    }
    return matchMedia("(prefers-color-scheme: dark)").matches ? "#161c24" : "#fff";
  };
  // wide screens: float the pad right under (or above) the field; narrow ones: bottom sheet
  const place = () => {
    if (!cur) return;
    const r = cur.getBoundingClientRect(), w = pad.offsetWidth, h = pad.offsetHeight, vw = innerWidth, vh = innerHeight;
    const below = vh - r.bottom - 12 >= h, above = r.top - 12 >= h;
    if (vw < 640 || !(below || above)) {
      pad.classList.remove("anchored");
      pad.style.left = pad.style.top = "";
      document.body.style.paddingBottom = `${h + 24}px`;
      return;
    }
    document.body.style.paddingBottom = savedPad;
    pad.classList.add("anchored");
    pad.style.left = `${Math.max(12, Math.min(r.left + r.width / 2 - w / 2, vw - w - 12))}px`;
    pad.style.top = `${below ? r.bottom + 8 : r.top - h - 8}px`;
  };
  const show = () => {
    pad.querySelector(".np-display").textContent = buf === "" ? "—" : buf;
  };
  const apply = () => {
    // keep the field valid while typing ("1." / "-" are shown in the pad but stored as "1" / "")
    cur.value = /^-?\d*\.?\d*$/.test(buf) && !/^-?\.?$/.test(buf) ? buf.replace(/\.$/, "") : "";
    cur.dispatchEvent(new Event("input", { bubbles: true }));
    show();
  };
  const clamp = (v) => {
    const mn = attr("min"), mx = attr("max");
    if (mn !== null && v < mn) v = mn;
    if (mx !== null && v > mx) v = mx;
    return v;
  };
  const stepBy = (dir) => {
    const st = attr("step") || 1;
    const base = buf === "" || buf === "-" ? 0 : Number(buf);
    const nd = Math.max(decimals(st), decimals(base));
    buf = String(clamp(Number((base + dir * st).toFixed(nd))));
    fresh = false;
    apply();
  };
  const close = (commit) => {
    if (!cur) return;
    const inp = cur;
    if (commit) {
      if (inp.value !== "") {
        const v = clamp(Number(inp.value));
        if (String(v) !== inp.value) { inp.value = String(v); inp.dispatchEvent(new Event("input", { bubbles: true })); }
      }
    } else if (inp.value !== orig) {
      inp.value = orig;
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    }
    cur = null;
    pad.hidden = true;
    document.body.style.paddingBottom = savedPad;
    inp.blur();
  };
  const open = (inp) => {
    if (cur === inp) return;
    if (cur) close(true);
    cur = inp;
    orig = buf = inp.value;
    fresh = true; // the first digit replaces the old value
    const accent = document.querySelector(".pure-button-primary");
    pad.style.setProperty("--np-bg", solidBg(inp.closest(".panel") || inp));
    pad.style.setProperty("--np-fg", getComputedStyle(inp).color);
    if (accent) pad.style.setProperty("--np-accent", getComputedStyle(accent).backgroundColor);
    pad.querySelector(".np-title").textContent = labelOf(inp);
    const mn = attr("min"), mx = attr("max"), st = attr("step") || 1;
    pad.querySelector(".np-range").textContent = mn !== null && mx !== null ? t("np.range", { min: mn, max: mx }) : "";
    $k("dec").textContent = `− ${st}`;
    $k("inc").textContent = `+ ${st}`;
    $k("cancel").textContent = t("np.cancel");
    $k("ok").textContent = t("np.ok");
    $k(".").disabled = Number.isInteger(st) && Number.isInteger(mn ?? 0);
    $k("neg").disabled = mn !== null && mn >= 0;
    pad.setAttribute("aria-label", labelOf(inp));
    show();
    pad.hidden = false;
    savedPad = document.body.style.paddingBottom;
    pad.classList.remove("anchored");
    inp.scrollIntoView({ block: "center" });
    place();
  };

  pad.addEventListener("pointerdown", (e) => e.preventDefault()); // keep focus on the field
  pad.addEventListener("click", (e) => {
    const b = e.target.closest("[data-k]");
    if (!b || !cur) return;
    const k = b.dataset.k;
    if (k === "ok") return close(true);
    if (k === "cancel") return close(false);
    if (k === "inc" || k === "dec") return stepBy(k === "inc" ? 1 : -1);
    if (k === "clear") buf = "";
    else if (k === "bs") buf = fresh ? "" : buf.slice(0, -1);
    else if (k === "neg") buf = buf.startsWith("-") ? buf.slice(1) : `-${buf}`;
    else {
      const base = fresh ? "" : buf;
      if (k === ".") buf = base.includes(".") ? base : `${base === "" || base === "-" ? `${base}0` : base}.`;
      else buf = base === "0" ? k : base === "-0" ? `-${k}` : base + k;
    }
    fresh = false;
    apply();
  });
  document.addEventListener("focusin", (e) => { if (isNumberInput(e.target)) open(e.target); });
  document.addEventListener("click", (e) => { if (isNumberInput(e.target)) open(e.target); });
  document.addEventListener("pointerdown", (e) => {
    if (cur && !pad.contains(e.target) && e.target !== cur) close(true);
  });
  document.addEventListener("keydown", (e) => {
    if (!cur) return;
    if (e.key === "Enter") { e.preventDefault(); close(true); }
    else if (e.key === "Escape") { e.preventDefault(); close(false); }
  });
  document.addEventListener("input", (e) => { if (e.target === cur && e.isTrusted) { buf = cur.value; fresh = false; show(); } });
  document.querySelectorAll("input[type=number]").forEach((i) => i.setAttribute("inputmode", "none"));
  window.addEventListener("resize", place);
  window.addEventListener("scroll", place, { passive: true, capture: true });
}
const isNumberInput = (n) => n instanceof HTMLInputElement && n.type === "number" && !n.disabled && !n.readOnly;
