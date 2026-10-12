/* Precision QC web UI (ไทย · English · 中文).
 * Image analysis is done by the Python package `precision_qc`, running in the
 * browser through Pyodide. PDF reports are rendered from HTML (A4 portrait)
 * with html2canvas + jsPDF, both loaded on demand. Texts live in i18n.js. */

const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const PDF_LIBS = [
  "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
];
const CFG_KEY = "precision-qc-config";
const INFO_KEY = "precision-qc-report-info";
const LANG_KEY = "precision-qc-lang";
const THEME_KEY = "precision-qc-theme";
const LANGS = ["th", "en", "zh"];
const LOCALE = { th: "th-TH", en: "en-GB", zh: "zh-CN" };
const APP_VERSION = "1.2";

const $ = (s, root = document) => root.querySelector(s);
let api = null;
let defaults = {};
let results = []; // { id, file, report, analyzedAt, reportNo, card }
let seq = 0;
let bseq = 0;
let batches = []; // batch photos: { id, file, data, items, el, labels }
const labelStore = new Map(); // "name|size" -> { plateNo: dish ID typed by the user }, survives re-runs
const BATCH_KEY = "precision-qc-batch";
let batchMode = false;
try { batchMode = localStorage.getItem(BATCH_KEY) === "1"; } catch (_) { /* storage unavailable */ }
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
  document.title = t("app.title");
  document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  markActive(".lang-switch button", (b) => b.dataset.lang === lang);
  const credit = $("#credit");
  credit.lang = document.documentElement.lang;
  credit.innerHTML = `${t("credit.line1", { name: `<b>${esc(t("credit.name"))}</b>` })}<br />${esc(t("credit.line2"))}`;
  setEngine(...engineState);
  results.forEach(mountCard);
  renderSummary();
  batches.forEach(renderBatch);
  capsList.forEach(renderCapsCard);
  document.querySelectorAll("#caps-samples .chip").forEach((c) => (c.textContent = t("caps.sample", { n: c.dataset.n })));
  relabelBatchSamples();
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

/* --------------------------------------------------------------------- boot */
async function boot() {
  if (window.__QC_DENY__) return; // hosted build: blocked on an unauthorised domain
  try {
    const manifest = await (await fetch("manifest.json", { cache: "no-store" })).json();
    renderSamples(manifest.samples || [], manifest.batch_samples || []);
    renderCapsSamples(manifest.caps_samples || []);
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
    defaults = JSON.parse(api.default_config_json());
    loadForm($("#cfg"), CFG_KEY, defaults);
    capsDefaults = JSON.parse(api.default_caps_config_json());
    loadForm($("#caps-cfg"), CAPS_KEY, capsDefaults);
    $("#caps-file").disabled = false;
    setEngine("ready", "engine.ready");
    $("#drop").classList.remove("disabled");
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
    out[input.name] = numeric ? (input.value === "" ? null : Number(input.value)) : input.value.trim();
  }
  return out;
}

function loadForm(form, key, base = {}) {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(key) || "{}"); } catch (_) { /* storage unavailable */ }
  const data = { ...base, ...saved };
  for (const input of form.querySelectorAll("input[name]")) input.value = data[input.name] ?? "";
}

function persist(form, key, numeric) {
  try { localStorage.setItem(key, JSON.stringify(readForm(form, numeric))); } catch (_) { /* ignore */ }
}

$("#cfg").addEventListener("input", () => {
  persist($("#cfg"), CFG_KEY, true);
  $("#rerun").disabled = results.length === 0;
});
$("#info").addEventListener("input", () => persist($("#info"), INFO_KEY, false));
loadForm($("#info"), INFO_KEY);

$("#cfg-reset").addEventListener("click", () => {
  try { localStorage.removeItem(CFG_KEY); } catch (_) { /* ignore */ }
  loadForm($("#cfg"), CFG_KEY, defaults);
});
$("#rerun").addEventListener("click", async () => {
  const singles = [...new Set(results.filter((r) => !r.batch).map((r) => r.file))];
  const groups = [...new Set(results.filter((r) => r.batch).map((r) => r.file))];
  closeResult();
  results = [];
  batches = [];
  $("#results").innerHTML = "";
  $("#batches").innerHTML = "";
  await runFiles(singles, false);
  await runFiles(groups, true);
});

/* -------------------------------------------------------------------- input */
const drop = $("#drop");
$("#file").addEventListener("change", (e) => runFiles([...e.target.files]).then(() => (e.target.value = "")));
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => runFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"))));

function renderSamples(names, batchNames = []) {
  const box = $("#sample-list");
  box.innerHTML = "";
  batchNames.forEach((n, i) => {
    const b = document.createElement("button");
    b.className = "pure-button chip";
    b.dataset.kind = "batch";
    b.dataset.n = i + 1;
    b.disabled = true;
    b.addEventListener("click", async () => {
      const blob = await (await fetch(`samples/batch/${n}`)).blob();
      runFiles([new File([blob], n, { type: blob.type || "image/jpeg" })], true);
    });
    box.appendChild(b);
  });
  for (const n of names) {
    const b = document.createElement("button");
    b.className = "pure-button chip";
    b.textContent = stem(n).replace(/_/g, " ");
    b.disabled = true;
    b.addEventListener("click", async () => {
      const blob = await (await fetch(`samples/${n}`)).blob();
      runFiles([new File([blob], n, { type: blob.type || "image/jpeg" })]);
    });
    box.appendChild(b);
  }
  relabelBatchSamples();
  syncSamples();
}

/* ------------------------------------------------------------- batch mode
 * One photo with several dishes: Python (precision_qc.batch) finds each whole
 * dish, assesses it on its own and ranks them. Every dish becomes an ordinary
 * result (card, summary row, PDF, CSV); a batch card above shows the annotated
 * photo and the ranking. The UI is injected here so all editions share it. */
const BATCH_CSS = `
.batch-toggle{display:flex;gap:.7rem;align-items:flex-start;margin:0 0 14px;padding:11px 14px;border:1px solid rgba(128,128,128,.4);border-radius:10px;cursor:pointer}
.batch-toggle input{margin-top:.25em;width:1.15em;height:1.15em;flex:none}
.batch-toggle b{display:block}
.batch-toggle small{display:block;opacity:.75;margin-top:2px}
#batches .batch-card{margin-bottom:16px}
.batch-body{display:grid;gap:18px;grid-template-columns:repeat(auto-fit,minmax(min(100%,380px),1fr));padding:16px;align-items:start}
.batch-fig{margin:0;position:sticky;top:16px}
.batch-fig figcaption,.batch-note{opacity:.75;font-size:.85em;margin:.4rem 0 0}
.plate-list{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;min-width:0}
.plate-card{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;min-width:0;padding:12px;border:1px solid rgba(128,128,128,.35);border-radius:12px;cursor:pointer;transition:background .12s}
.plate-card:hover{background:rgba(128,128,128,.07)}
.plate-card.r1{border-color:#f5c542;box-shadow:0 0 0 1px #f5c542}
.pc-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pc-head b{font-size:1.05em}
.pc-spacer{flex:1}
.pc-score{font-weight:800;font-size:1.3em;font-variant-numeric:tabular-nums;line-height:1}
.pc-grade{opacity:.75;font-size:.85em}
.pc-note{margin:0;font-size:.85em;opacity:.85}
.pc-id{display:flex;gap:8px;align-items:center}
.batch-svg{width:100%;height:auto;display:block;border-radius:8px;cursor:zoom-in}
.batch-svg text{paint-order:stroke;stroke:#fff;stroke-linejoin:round;font-family:system-ui,sans-serif;font-weight:700}
.batch-strips{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,160px),1fr));gap:6px}
.batch-strip{display:block;width:100%;height:auto;background:#fff;border:1px solid rgba(128,128,128,.4);border-radius:4px;cursor:zoom-in}
.batch-strips.rot .batch-strip,.lightbox .rot{transform:rotate(180deg)}
.batch-rot{font-size:.8em;padding:.35em .8em;white-space:nowrap;flex:none}
.batch-lb{display:grid;gap:10px;justify-items:center;cursor:default}
.batch-lb img.batch-strip{width:min(94vw,1100px);max-width:none;cursor:default}
.batch-id{flex:1;min-width:0;box-sizing:border-box;padding:6px 8px;border:1px solid rgba(128,128,128,.5);border-radius:6px;font:inherit;background:transparent;color:inherit}
.rank-badge{display:inline-block;min-width:1.9em;text-align:center;padding:1px 9px;border-radius:999px;font-weight:700;font-size:.85em;background:rgba(128,128,128,.25);white-space:nowrap}
.rank-badge.r1{background:#f5c542;color:#3b2d00}
`;

function initBatchUI() {
  const style = document.createElement("style");
  style.textContent = BATCH_CSS;
  document.head.appendChild(style);
  const label = document.createElement("label");
  label.className = "batch-toggle";
  label.innerHTML = `<input type="checkbox" id="batch-mode" /><span><b data-i18n="batch.mode"></b><small data-i18n="batch.modeHint"></small></span>`;
  $("#drop").insertAdjacentElement("beforebegin", label);
  const box = document.createElement("section");
  box.id = "batches";
  $("#results").insertAdjacentElement("beforebegin", box);
  const cb = $("#batch-mode");
  cb.checked = batchMode;
  cb.addEventListener("change", () => {
    batchMode = cb.checked;
    try { localStorage.setItem(BATCH_KEY, batchMode ? "1" : "0"); } catch (_) { /* ignore */ }
    syncSamples();
  });
}

// show only the sample chips that fit the current mode
function syncSamples() {
  document.querySelectorAll("#sample-list .chip").forEach((c) => {
    c.style.display = (c.dataset.kind === "batch") === batchMode ? "" : "none";
  });
}
function relabelBatchSamples() {
  document.querySelectorAll('#sample-list .chip[data-kind="batch"]').forEach((c) => (c.textContent = t("batch.sample", { n: c.dataset.n })));
}

const rankBadge = (it) => it.batch
  ? ` <span class="rank-badge r${it.batch.rank}">${esc(t("batch.rankBadge", { r: it.batch.rank, n: it.batch.plates }))}</span>` : "";

const plateName = (file, rep, label) => (label ? `${label} (#${rep.plate})` : `${stem(file.name)} #${rep.plate}`);
const labelKey = (file) => `${file.name}|${file.size}`;

// photo with every dish circled and tagged "#N  R<rank>" + the dish ID typed by the user
function overviewSvg(b) {
  const [W, H] = b.data.photo_size;
  const fs = W / 46, fs2 = W / 58, sw = Math.max(3, W / 380);
  const marks = b.items.map((it) => {
    const r = it.report, c = r.circle, col = r.passed ? "#15935a" : "#d62f2f";
    const label = (it.label || "").slice(0, 28);
    return `<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}" fill="none" stroke="${col}" stroke-width="${sw}" />
      <text x="${c.cx}" y="${c.cy - c.r * 0.5}" text-anchor="middle" fill="${col}" font-size="${fs}" stroke-width="${fs / 5}">#${r.plate} · R${r.rank}</text>
      ${label ? `<text x="${c.cx}" y="${c.cy - c.r * 0.5 + fs * 1.15}" text-anchor="middle" fill="#14202c" font-size="${fs2}" stroke-width="${fs2 / 5}">${esc(label)}</text>` : ""}`;
  }).join("");
  return `<svg class="batch-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(t("batch.alt"))}"><image href="${b.data.photo}" width="${W}" height="${H}" />${marks}</svg>`;
}

function bindOverview(b) {
  $(".batch-svg", b.el).addEventListener("click", () => {
    const box = document.createElement("div");
    box.className = "lightbox";
    box.innerHTML = overviewSvg(b).replace('class="batch-svg"', 'class="batch-svg" style="max-width:96vw;max-height:94vh;width:auto;cursor:zoom-out"');
    box.addEventListener("click", () => box.remove());
    document.body.appendChild(box);
  });
}

function setPlateLabel(b, it, value) {
  it.label = value.trim();
  b.labels[it.report.plate] = it.label;
  it.report.name = plateName(b.file, it.report, it.label);
  mountCard(it);
  renderSummary();
}

function showItem(id) {
  const item = results.find((r) => r.id === id);
  if (resultModal() && item) openResult(item);
  else document.getElementById(`r-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderBatch(b) {
  const s = b.data.summary;
  const ranked = [...b.items].sort((x, y) => x.report.rank - y.report.rank);
  const cards = ranked.map((it) => {
    const r = it.report;
    const note = r.reasons.length ? r.reasons.map((x) => t(`reason.short.${x.code}`)).join(", ") : "";
    return `
      <article class="plate-card r${r.rank}" data-item="${it.id}">
        <header class="pc-head">
          <span class="rank-badge r${r.rank}" title="${esc(t("batch.th.rank"))}">${r.rank}</span>
          <b>#${r.plate}</b>
          <span class="status ${r.passed ? "pass" : "fail"}">${t(r.passed ? "tile.ok" : "tile.ng")}</span>
          <span class="pc-spacer"></span>
          <span class="pc-score">${fmt(r.score)}</span>
          <span class="pc-grade">${r.grade} · ${esc(t(`grade.${r.grade}`))}</span>
          <button type="button" class="pure-button view-btn">${t("btn.view")}</button>
        </header>
        ${note ? `<p class="pc-note">${esc(note)}</p>` : ""}
        <div class="batch-strips${it.rot ? " rot" : ""}">
          <img class="batch-strip" src="${r.strips.top}" alt="${esc(t("batch.strip.top"))}" title="${esc(t("batch.strip.top"))}" />
          <img class="batch-strip" src="${r.strips.bottom}" alt="${esc(t("batch.strip.bottom"))}" title="${esc(t("batch.strip.bottom"))}" />
        </div>
        <div class="pc-id">
          <input type="text" class="batch-id" maxlength="60" value="${esc(it.label || "")}" placeholder="${esc(t("batch.ph"))}" aria-label="${esc(`${t("batch.th.label")} #${r.plate}`)}" />
          <button type="button" class="pure-button batch-rot">↻ ${esc(t("batch.rot"))}</button>
        </div>
      </article>`;
  }).join("");
  b.el.className = "panel card batch-card";
  b.el.innerHTML = `
    <div class="card-head">
      <div>
        <h2>${esc(t("batch.title"))} — ${esc(b.file.name)}</h2>
        <div class="sub">${esc(t("batch.sub", { n: s.plates, pass: s.pass, fail: s.fail, mean: fmt(s.mean_score), spread: fmt(s.score_spread ?? 0) }))}</div>
      </div>
      <button type="button" class="pure-button pure-button-primary dl-batch">${esc(t("batch.pdf"))}</button>
    </div>
    <div class="batch-body">
      <figure class="batch-fig">${overviewSvg(b)}<figcaption>${esc(t("batch.note"))}</figcaption></figure>
      <div class="plate-list">${cards}</div>
    </div>`;
  $(".dl-batch", b.el).addEventListener("click", () => downloadPdf(ranked));
  bindOverview(b);
  const hint = document.createElement("p");
  hint.className = "batch-note";
  hint.textContent = t("batch.labelHint");
  $(".plate-list", b.el).appendChild(hint);
  b.el.querySelectorAll(".plate-card").forEach((tr) => {
    const it = b.items.find((x) => x.id === Number(tr.dataset.item));
    const input = $(".batch-id", tr);
    input.addEventListener("click", (e) => e.stopPropagation());
    const strips = $(".batch-strips", tr);
    $(".batch-rot", tr).addEventListener("click", (e) => {
      e.stopPropagation();
      it.rot = !it.rot;
      strips.classList.toggle("rot", it.rot);
    });
    strips.querySelectorAll("img").forEach((img) => img.addEventListener("click", (e) => {
      e.stopPropagation();
      const box = document.createElement("div");
      box.className = "lightbox";
      box.innerHTML = `<div class="batch-lb"><img class="batch-strip${it.rot ? " rot" : ""}" src="${img.src}" alt="" /><button type="button" class="pure-button">↻ ${esc(t("batch.rot"))}</button></div>`;
      const big = $("img", box);
      $("button", box).addEventListener("click", (ev) => { ev.stopPropagation(); it.rot = !it.rot; big.classList.toggle("rot", it.rot); strips.classList.toggle("rot", it.rot); });
      big.addEventListener("click", (ev) => ev.stopPropagation());
      box.addEventListener("click", () => box.remove());
      document.body.appendChild(box);
    }));
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const nextId = tr.nextElementSibling?.dataset.item;
      input.blur(); // fires "change"
      if (nextId) b.el.querySelector(`.plate-card[data-item="${nextId}"] .batch-id`)?.focus();
    });
    input.addEventListener("change", () => {
      setPlateLabel(b, it, input.value);
      $(".batch-svg", b.el).outerHTML = overviewSvg(b); // refresh the tags only; the cards keep their focus
      bindOverview(b);
    });
    tr.addEventListener("click", () => showItem(Number(tr.dataset.item)));
  });
}

async function runBatchFile(file, cfgJson) {
  const el = document.createElement("article");
  el.className = "panel card";
  el.innerHTML = `<div class="loading-card"><div class="spinner"></div>${esc(t("batch.loading", { name: file.name }))}</div>`;
  $("#batches").prepend(el);
  await new Promise((r) => setTimeout(r, 30)); // let the spinner paint
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const data = JSON.parse(api.analyze_plates_to_json(bytes, cfgJson, file.name));
    const key = labelKey(file);
    if (!labelStore.has(key)) labelStore.set(key, {});
    if (!data.plates.length) {
      el.innerHTML = `<p class="error">${esc(t("batch.none", { name: file.name }))}</p>`;
      return;
    }
    const analyzedAt = new Date();
    const b = { id: ++bseq, file, data, items: [], el, labels: labelStore.get(key) };
    el.id = `b-${b.id}`;
    const cards = [];
    for (const rep of [...data.plates].sort((x, y) => x.plate - y.plate)) { // reading order: #1, #2, ...
      const label = b.labels[rep.plate] || "";
      rep.name = plateName(file, rep, label);
      const card = document.createElement("article");
      card.className = "panel card";
      const item = { id: ++seq, file, report: rep, analyzedAt, reportNo: newReportNo(analyzedAt), card, label,
        batch: { id: b.id, rank: rep.rank, plate: rep.plate, plates: data.plates.length } };
      card.id = `r-${item.id}`;
      b.items.push(item);
      results.push(item);
      mountCard(item);
      cards.push(card);
    }
    $("#results").prepend(...cards);
    batches.push(b);
    renderBatch(b);
  } catch (err) {
    console.error(err);
    el.innerHTML = `<p class="error">${esc(t("card.error", { name: file.name }))}</p>`;
  }
  renderSummary();
}

/* ------------------------------------------------------------ cap counter
 * A bunch of mushrooms (ช่อดอก) photographed from above: Python
 * (precision_qc.caps) finds every cap and sorts it small / medium / large.
 * Independent of the dish QC above; its own section, results and CSV. The UI
 * is injected here so all editions share it. */
const CAPS_CSS = `
#sec-caps .caps-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:12px 0}
#sec-caps .caps-bar .muted{margin:0}
#sec-caps .opt{height:auto}
#sec-caps .opt>form{padding:14px 16px 16px}
#caps-results{display:grid;gap:16px;margin-top:14px}
.caps-card{border:1px solid rgba(128,128,128,.35);border-radius:12px;padding:14px;display:grid;gap:14px;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));align-items:start}
.caps-card img.caps-img{width:100%;height:auto;display:block;border-radius:8px;cursor:zoom-in}
.caps-info{display:grid;gap:12px;min-width:0}
.caps-info h3{margin:0;font-size:1.05em;overflow-wrap:anywhere}
.caps-total{font-size:2.6em;font-weight:800;line-height:1;font-variant-numeric:tabular-nums}
.caps-total small{font-size:.35em;font-weight:600;opacity:.7;margin-left:.3em}
.caps-split{display:grid;gap:8px}
.caps-row{display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;align-items:center}
.caps-dot{width:14px;height:14px;border-radius:50%;border:3px solid;box-sizing:border-box}
.caps-bar-track{height:8px;border-radius:4px;background:rgba(128,128,128,.2);overflow:hidden;grid-column:2}
.caps-bar-fill{height:100%}
.caps-n{font-weight:700;font-variant-numeric:tabular-nums;text-align:right}
.caps-sub{margin:4px 0 0;font-size:.95em}
.caps-meta{margin:0;font-size:.85em;opacity:.75}
.caps-actions{display:flex;flex-wrap:wrap;gap:8px}
.caps-set{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-bottom:12px}
`;
const CAP_COLORS = { small: "#50dc5a", medium: "#283ce6", large: "#eb3228", hidden: "#ffaa00" };
const CAP_CLASSES = ["small", "medium", "large", "hidden"];
const CAP_AREA_ROWS = [["small", "caps.small"], ["medium", "caps.medium"], ["large", "caps.large"], ["hidden", "caps.hiddenArea"], ["gaps", "caps.gaps"]];
let capsList = []; // { file, data }

function initCapsUI() {
  const style = document.createElement("style");
  style.textContent = CAPS_CSS;
  document.head.appendChild(style);
  const sec = document.createElement("section");
  sec.id = "sec-caps";
  sec.className = "panel block scroll-anchor";
  sec.innerHTML = `
    <h2 class="section-title" data-i18n="caps.title"></h2>
    <p class="muted" data-i18n="caps.hint"></p>
    <div class="caps-bar">
      <label class="pure-button pure-button-primary" id="caps-pick-label">
        <input id="caps-file" type="file" accept="image/*" multiple hidden disabled />
        <span data-i18n="caps.pick"></span>
      </label>
      <span class="muted" data-i18n="samples.label"></span>
      <div id="caps-samples" class="chips"></div>
    </div>
    <details class="opt">
      <summary><span class="opt-title" data-i18n="caps.cfg"></span><span class="opt-hint" data-i18n="caps.cfgHint"></span></summary>
      <form id="caps-cfg" class="pure-form pure-form-stacked" onsubmit="return false">
        <div class="caps-set">
          <label><span data-i18n="caps.f.contrast"></span><input name="contrast" type="number" step="0.5" min="-10" max="20" /></label>
          <label><span data-i18n="caps.f.find_hidden"></span><input name="find_hidden" type="number" step="1" min="0" max="1" /></label>
          <label><span data-i18n="caps.f.hidden_sat"></span><input name="hidden_sat" type="number" step="0.02" min="0.05" max="0.5" /></label>
          <label><span data-i18n="caps.f.shadow_lift"></span><input name="shadow_lift" type="number" step="0.05" min="0.2" max="1" /></label>
          <label><span data-i18n="caps.f.small_below"></span><input name="small_below" type="number" step="0.05" min="0.3" max="1" /></label>
          <label><span data-i18n="caps.f.large_above"></span><input name="large_above" type="number" step="0.05" min="1" max="3" /></label>
        </div>
        <div class="form-actions">
          <button type="button" id="caps-reset" class="pure-button" data-i18n="btn.reset"></button>
          <button type="button" id="caps-rerun" class="pure-button pure-button-primary" disabled data-i18n="btn.rerun"></button>
        </div>
      </form>
    </details>
    <div id="caps-results"></div>`;
  const anchor = $("#summary");
  anchor.parentNode.insertBefore(sec, anchor);
  $("#caps-file").addEventListener("change", (e) => runCaps([...e.target.files]).then(() => (e.target.value = "")));
  $("#caps-cfg").addEventListener("input", () => {
    persist($("#caps-cfg"), CAPS_KEY, true);
    $("#caps-rerun").disabled = capsList.length === 0;
  });
  $("#caps-reset").addEventListener("click", () => {
    try { localStorage.removeItem(CAPS_KEY); } catch (_) { /* ignore */ }
    loadForm($("#caps-cfg"), CAPS_KEY, capsDefaults);
  });
  $("#caps-rerun").addEventListener("click", async () => {
    const files = capsList.map((c) => c.file);
    capsList = [];
    $("#caps-results").innerHTML = "";
    await runCaps(files);
  });
}
const CAPS_KEY = "precision-qc-caps-config";
let capsDefaults = {};

function renderCapsSamples(names) {
  const box = $("#caps-samples");
  box.innerHTML = "";
  names.forEach((n, i) => {
    const b = document.createElement("button");
    b.className = "pure-button chip";
    b.textContent = t("caps.sample", { n: i + 1 });
    b.dataset.n = i + 1;
    b.disabled = !api;
    b.addEventListener("click", async () => {
      const blob = await (await fetch(`samples/caps/${n}`)).blob();
      runCaps([new File([blob], n, { type: blob.type || "image/jpeg" })]);
    });
    box.appendChild(b);
  });
}

function renderCapsCard(c) {
  const d = c.data;
  const rows = CAP_CLASSES.map((k) => `
    <div class="caps-row">
      <span class="caps-dot" style="border-color:${CAP_COLORS[k]}"></span><b>${esc(t(`caps.${k}`))}</b>
      <span class="caps-n">${d.counts[k]} <span class="muted">(${fmt(d.percent[k])}%)</span></span>
      <span class="caps-bar-track"><span class="caps-bar-fill" style="display:block;width:${d.percent[k]}%;background:${CAP_COLORS[k]}"></span></span>
    </div>`).join("");
  const a = d.area_percent;
  const areaRows = CAP_AREA_ROWS.map(([k, label]) => `
    <div class="caps-row">
      <span class="caps-dot" style="border-color:${CAP_COLORS[k] || "#8a8f98"}"></span><span>${esc(t(label))}</span>
      <span class="caps-n">${fmt(a[k])}%</span>
      <span class="caps-bar-track"><span class="caps-bar-fill" style="display:block;width:${Math.min(100, a[k])}%;background:${CAP_COLORS[k] || "#8a8f98"}"></span></span>
    </div>`).join("");
  c.el.innerHTML = `
    <img class="caps-img" src="${d.overlay}" alt="${esc(t("caps.alt"))}" />
    <div class="caps-info">
      <h3>${esc(c.file.name)}</h3>
      <div class="caps-total">${d.total}<small>${esc(t("caps.unit"))}</small></div>
      <div class="caps-split">${rows}</div>
      <h4 class="caps-sub">${esc(t("caps.areaTitle"))}</h4>
      <div class="caps-split">${areaRows}</div>
      <p class="caps-meta">${esc(t("caps.areaNote", { v: fmt(a.visible), a: fmt(d.bunch_area_pct, 0) }))}</p>
      <p class="caps-meta">${esc(t("caps.meta", { d: fmt(d.median_diameter_px, 0), a: fmt(d.bunch_area_pct, 0) }))}</p>
      <p class="caps-meta">${esc(t("caps.note"))}</p>
      <div class="caps-actions">
        <button type="button" class="pure-button caps-png">${esc(t("caps.dlPng"))}</button>
        <button type="button" class="pure-button caps-csv">${esc(t("caps.dlCsv"))}</button>
      </div>
    </div>`;
  $(".caps-img", c.el).addEventListener("click", (e) => lightbox(e.target.src));
  $(".caps-png", c.el).addEventListener("click", async () => {
    download(`${stem(c.file.name)}_caps.jpg`, await (await fetch(d.overlay)).blob());
  });
  $(".caps-csv", c.el).addEventListener("click", () => {
    const lines = ["cap,x_px,y_px,diameter_px,size", ...d.caps.map((p, i) => [i + 1, p[0], p[1], (p[2] * 2).toFixed(1), p[3]].join(","))];
    download(`${stem(c.file.name)}_caps.csv`, new Blob(["﻿" + lines.join("\n")], { type: "text/csv" }));
  });
}

async function runCaps(files) {
  if (!api || !files.length) return;
  const cfgJson = JSON.stringify(readForm($("#caps-cfg"), true));
  for (const file of files) {
    const el = document.createElement("article");
    el.className = "caps-card";
    el.innerHTML = `<div class="loading-card"><div class="spinner"></div>${esc(t("caps.loading", { name: file.name }))}</div>`;
    $("#caps-results").prepend(el);
    await new Promise((r) => setTimeout(r, 30)); // let the spinner paint
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const data = JSON.parse(api.count_caps_to_json(bytes, cfgJson, file.name));
      const c = { file, data, el };
      capsList.push(c);
      renderCapsCard(c);
      $("#caps-rerun").disabled = false;
    } catch (err) {
      console.error(err);
      el.innerHTML = `<p class="error">${esc(t("card.error", { name: file.name }))}</p>`;
    }
  }
}

/* ------------------------------------------------------------------- camera
 * Optional: only wires up when the edition's page includes the camera markup
 * (#cam-toggle). Captures a still from a webcam and feeds it into runFiles,
 * exactly like a dropped file. Needs a secure context (HTTPS or localhost). */
function initCamera() {
  const toggle = $("#cam-toggle");
  if (!toggle) return; // edition without the camera UI
  if (!navigator.mediaDevices?.getUserMedia) { toggle.hidden = true; return; }
  const panel = $("#cam-panel"), video = $("#cam-video"), canvas = $("#cam-canvas"), select = $("#cam-select");
  let stream = null;

  function stop() {
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    video.srcObject = null;
  }
  function close() { stop(); panel.hidden = true; toggle.hidden = false; }

  async function start(deviceId) {
    stop();
    const video_c = deviceId ? { deviceId: { exact: deviceId } } : { facingMode: "environment" };
    stream = await navigator.mediaDevices.getUserMedia({ video: video_c, audio: false });
    video.srcObject = stream;
    await video.play().catch(() => { /* autoplay quirks */ });
    if (select) {
      try {
        const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput");
        select.innerHTML = cams.map((d, i) => `<option value="${esc(d.deviceId)}">${esc(d.label || `${t("cam.switch")} ${i + 1}`)}</option>`).join("");
        if (deviceId) select.value = deviceId;
        select.hidden = cams.length < 2;
      } catch (_) { /* labels need permission; ignore */ }
    }
    panel.hidden = false;
    toggle.hidden = true;
  }

  toggle.addEventListener("click", () => start().catch((err) => { console.error(err); alert(t("cam.error")); }));
  $("#cam-close")?.addEventListener("click", close);
  select?.addEventListener("change", () => start(select.value).catch((err) => console.error(err)));
  $("#cam-shot")?.addEventListener("click", () => {
    if (!video.videoWidth) return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext("2d").drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const name = `camera_${isoDate(new Date())}_${Date.now().toString().slice(-4)}.jpg`;
      close();
      runFiles([new File([blob], name, { type: "image/jpeg" })]);
    }, "image/jpeg", 0.95);
  });
}

/* ------------------------------------------------------------------ analyse */
function newReportNo(date) {
  const d = isoDate(date).replace(/-/g, "");
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase().padEnd(4, "0");
  return `PQC-${d}-${rnd}`;
}

async function runFiles(files, batch = batchMode) {
  if (!api || !files.length) return;
  const cfgJson = JSON.stringify(readForm($("#cfg"), true));
  for (const file of files) {
    if (batch) { await runBatchFile(file, cfgJson); continue; }
    const card = document.createElement("article");
    card.className = "panel card";
    card.innerHTML = `<div class="loading-card"><div class="spinner"></div>${esc(t("card.checking", { name: file.name }))}</div>`;
    $("#results").prepend(card);
    await new Promise((r) => setTimeout(r, 30)); // let the spinner paint
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const report = JSON.parse(api.analyze_to_json(bytes, cfgJson, file.name));
      const analyzedAt = new Date();
      const item = { id: ++seq, file, report, analyzedAt, reportNo: newReportNo(analyzedAt), card };
      results.push(item);
      card.id = `r-${item.id}`;
      mountCard(item);
      openResult(item); // modal editions: pop the result up full-screen (no-op otherwise)
    } catch (err) {
      console.error(err);
      card.innerHTML = `<p class="error">${esc(t("card.error", { name: file.name }))}</p>`;
    }
    renderSummary();
  }
}

function mountCard(item) {
  const card = item.card;
  card.innerHTML = renderCard(item);
  $(".dl-one", card).addEventListener("click", () => downloadPdf([item]));
  card.querySelectorAll(".thumbs img, .photo img").forEach((img) => img.addEventListener("click", () => lightbox(img.src)));
}

/* ----------------------------------------------------------------- wording */
const PANEL_KEYS = ["whiteness", "fluffiness", "contamination", "color_ratio", "shape"];
const REPORT_PANEL_KEYS = ["original", ...PANEL_KEYS];

function reasonText(code, r, lng = lang) {
  const c = r.config, m = r.metrics, k = r.contamination;
  const p = {
    "Contaminated": { v: fmt(k.contamination), lim: c.max_contamination },
    "Agar Exposed": { v: fmt(k.agar), lim: c.max_agar },
    "Low Growth": { v: fmt(m.growth), lim: c.min_growth },
    "Check Shape": { v: fmt(m.iou * 100, 0), lim: fmt(c.min_iou * 100, 0) },
    "Low Score": { v: fmt(r.score), lim: c.min_score },
  }[code];
  return p ? t(`reason.${code}`, p, lng) : code;
}

/* ------------------------------------------------------------------ UI card */
function tile({ label, value, unit, pct, limit, tickPct, dir }) {
  // dir: "min" (value must be >= limit), "max" (<= limit) or undefined (information only)
  let cls = "", crit = t("tile.info"), state = "";
  if (dir) {
    const ok = dir === "min" ? value >= limit : value <= limit;
    cls = ok ? "pass" : "fail";
    crit = t("tile.crit", { op: dir === "min" ? "≥" : "≤", limit, unit });
    state = ok ? `<span class="ok">${t("tile.ok")}</span>` : `<span class="ng">${t("tile.ng")}</span>`;
  }
  const clamp = (x) => Math.max(0, Math.min(100, x));
  const tick = dir ? `<u style="left:calc(${clamp(tickPct ?? limit)}% - 1px)"></u>` : "";
  return `
    <div class="pure-u-1 pure-u-sm-1-2 pure-u-xl-1-3"><div class="tile">
      <div class="label">${label}</div>
      <div class="value">${fmt(value)}<small> ${unit}</small></div>
      <div class="meter ${cls}"><i style="width:${clamp(pct ?? value)}%"></i>${tick}</div>
      <div class="crit"><span>${crit}</span>${state}</div>
    </div></div>`;
}

function renderCard(item) {
  const r = item.report, m = r.metrics, k = r.contamination, c = r.config;
  const pass = r.passed;
  const panels = Object.fromEntries(r.panels.map((p) => [p.key, p.src]));
  const reasons = r.reasons.length
    ? r.reasons.map((x) => `<li>${esc(reasonText(x.code, r))}</li>`).join("")
    : `<li class="ok">${t("reasons.ok")}</li>`;
  const size = r.colony.detected
    ? t("size.value", { w: fmt(r.colony.width_cm), h: fmt(r.colony.height_cm) })
    : t("size.none");
  // contamination limits are small (a few %), so scale that meter to twice the limit
  const contamScale = Math.max(c.max_contamination * 2, 1);
  const thumbs = PANEL_KEYS
    .map((key) => `
      <figure class="pure-u-1-2 pure-u-sm-1-3 pure-u-lg-1-5">
        <img src="${panels[key]}" alt="${esc(t(`panel.${key}`))}" loading="lazy" />
        <figcaption>${esc(t(`panel.${key}`))}<span>${esc(t(`panel.${key}.h`))}</span></figcaption>
      </figure>`)
    .join("");

  return `
    <div class="card-head">
      <div>
        <h2>${esc(r.name)}${rankBadge(item)}</h2>
        <div class="sub">${esc(t("card.meta", { date: item.analyzedAt.toLocaleString(LOCALE[lang]), no: item.reportNo }))}</div>
      </div>
      <button class="pure-button pure-button-primary dl-one">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        ${t("btn.pdfOne")}
      </button>
    </div>
    <div class="card-body pure-g gutter">
      <figure class="photo pure-u-1 pure-u-md-5-12">
        <img src="${panels.original}" alt="${esc(t("photo.alt"))}" />
        <figcaption>${esc(t("photo.caption", { size, plate: c.plate_cm }))}</figcaption>
      </figure>
      <div class="pure-u-1 pure-u-md-7-12">
        <div class="verdict ${pass ? "pass" : "fail"}">
          <div class="v-icon" aria-hidden="true">${pass ? "✓" : "✕"}</div>
          <div class="v-text">
            <b>${t(pass ? "v.pass" : "v.fail")}</b>
            <span>${t(pass ? "v.passSub" : "v.failSub")}</span>
          </div>
          <div class="score">
            <div class="hero">${fmt(r.score)}<small> /100</small></div>
            <div class="grade">${t("grade", { g: r.grade, label: t(`grade.${r.grade}`) })}</div>
          </div>
        </div>
        <ul class="reasons">${reasons}</ul>
        <div class="tiles pure-g gutter">
          ${tile({ label: t("tile.growth"), value: m.growth, unit: "%", limit: c.min_growth, dir: "min" })}
          ${tile({ label: t("tile.contam"), value: k.contamination, unit: "%", pct: (k.contamination / contamScale) * 100, limit: c.max_contamination, tickPct: (c.max_contamination / contamScale) * 100, dir: "max" })}
          ${tile({ label: t("tile.agar"), value: k.agar, unit: "%", limit: c.max_agar, dir: "max" })}
          ${tile({ label: t("tile.round"), value: m.iou * 100, unit: "%", limit: +(c.min_iou * 100).toFixed(0), dir: "min" })}
          ${tile({ label: t("tile.white"), value: m.whiteness, unit: "%" })}
          ${tile({ label: t("tile.fluffy"), value: m.fluffiness, unit: "%" })}
        </div>
      </div>
    </div>
    <div class="gallery">
      <h3>${t("gallery.title")}</h3>
      <div class="thumbs pure-g gutter">${thumbs}</div>
      <div class="legend">
        <span><i style="background:#fff"></i>${t("legend.clean")}</span>
        <span><i style="background:#f0c814"></i>${t("legend.agar")}</span>
        <span><i style="background:#d72828"></i>${t("legend.contam")}</span>
        <span><i style="background:#3c5ad2"></i>${t("legend.ink")}</span>
        <span><i style="background:#5f5f5f"></i>${t("legend.dark")}</span>
      </div>
    </div>`;
}

function renderSummary() {
  $("#summary").hidden = results.length === 0;
  $("#rerun").disabled = results.length === 0;
  const nPass = results.filter((x) => x.report.passed).length;
  $("#n-pass").textContent = nPass;
  $("#n-fail").textContent = results.length - nPass;
  $("#n-total").textContent = t("sum.total", { n: results.length });
  // optional top-of-page stat cards (editions that include them, e.g. Dashboard)
  const setStat = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setStat("stat-pass", nPass);
  setStat("stat-fail", results.length - nPass);
  setStat("stat-total", results.length);
  const viewCell = resultModal() ? `<td><button type="button" class="pure-button view-btn">${t("btn.view")}</button></td>` : "";
  $("#summary-body").innerHTML = results
    .map((it) => { const { id, report: r } = it; return `
      <tr data-target="r-${id}">
        <td>${esc(r.name)}${rankBadge(it)}</td>
        <td><span class="status ${r.passed ? "pass" : "fail"}">${t(r.passed ? "tile.ok" : "tile.ng")}</span></td>
        <td class="num">${fmt(r.score)}</td>
        <td>${r.grade} · ${t(`grade.${r.grade}`)}</td>
        <td>${esc(r.reasons.length ? r.reasons.map((x) => t(`reason.short.${x.code}`)).join(", ") : "—")}</td>
        ${viewCell}
      </tr>`; })
    .join("");
}

$("#summary-body").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (!tr) return;
  const id = Number(tr.dataset.target.slice(2)); // "r-12" -> 12
  const item = results.find((r) => r.id === id);
  if (resultModal() && item) { openResult(item); return; }
  document.getElementById(tr.dataset.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
});

/* --------------------------------------------------------- result modal
 * Opt-in: active only on editions whose page includes #result-modal (e.g.
 * Dashboard). Shows a result card full-screen with a close button; other
 * editions keep the inline cards and these helpers are no-ops. */
function resultModal() { return document.getElementById("result-modal"); }
function stowModalCard() {
  const m = resultModal(); if (!m) return;
  const card = m.querySelector(".rm-body").firstElementChild;
  if (card) $("#results").appendChild(card); // park it back (hidden) in #results
}
function openResult(item) {
  const m = resultModal(); if (!m || !item) return;
  stowModalCard();
  m.querySelector(".rm-body").appendChild(item.card);
  m.hidden = false;
  document.body.classList.add("modal-open");
  m.querySelector(".rm-close")?.focus();
}
function closeResult() {
  const m = resultModal(); if (!m) return;
  stowModalCard();
  m.hidden = true;
  document.body.classList.remove("modal-open");
}

function lightbox(src) {
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<img src="${src}" alt="" />`;
  box.addEventListener("click", () => box.remove());
  document.body.appendChild(box);
}

/* ------------------------------------------------------------------- export */
function download(name, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

$("#dl-csv").addEventListener("click", () => {
  const head = ["report_no", "image", "result", "score", "grade", "growth_pct", "whiteness_pct", "fluffiness_pct",
    "shape_iou", "exposed_agar_pct", "contamination_pct", "colony_width_cm", "colony_height_cm", "reasons", "photo", "plate", "rank_in_photo"];
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = results.map(({ report: r, reportNo, batch }) => [reportNo, r.name, r.result, r.score, r.grade, r.metrics.growth,
    r.metrics.whiteness, r.metrics.fluffiness, r.metrics.iou, r.contamination.agar, r.contamination.contamination,
    r.colony.width_cm, r.colony.height_cm, r.reasons.map((x) => x.code).join("; "),
    batch ? r.source : "", batch ? r.plate : "", batch ? r.rank : ""].map(q).join(","));
  download("precision_qc_summary.csv", new Blob(["﻿" + [head.join(","), ...lines].join("\n")], { type: "text/csv" }));
});

$("#clear").addEventListener("click", () => {
  closeResult();
  results = [];
  batches = [];
  $("#results").innerHTML = "";
  $("#batches").innerHTML = "";
  renderSummary();
});

/* result modal: close on the ×, on the backdrop, or with Escape */
(function wireResultModal() {
  const m = resultModal();
  if (!m) return;
  m.querySelector(".rm-close")?.addEventListener("click", closeResult);
  m.addEventListener("click", (e) => { if (e.target === m) closeResult(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !m.hidden) closeResult(); });
})();

$("#dl-pdf-all").addEventListener("click", () => downloadPdf(results));

/* ---------------------------------------------------------------- PDF report
 * Written in the selected interface language. Content follows ISO/IEC 17025:2017
 * clause 7.8 (reporting of results): title, laboratory, unique report number on
 * every page, page x of y, customer, sample description & dates, method, results
 * with units, requirements, statement of conformity with the decision rule,
 * remarks/deviations, authorisation, disclaimer and end-of-report mark. */
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

function resultRows(r, L) {
  const m = r.metrics, k = r.contamination, c = r.config;
  const judge = (ok) => (ok ? `<span class="r-pass">${L("r.pass")}</span>` : `<span class="r-fail">${L("r.fail")}</span>`);
  const info = `<span class="r-info">${L("r.info")}</span>`;
  const rows = [
    [L("r.row.size"), r.colony.detected ? `${fmt(r.colony.width_cm)} × ${fmt(r.colony.height_cm)}` : L("r.notDetected"), L("r.cm"), "—", info],
    [L("r.row.growth"), fmt(m.growth), "%", `≥ ${c.min_growth}`, judge(m.growth >= c.min_growth)],
    [L("r.row.contam"), fmt(k.contamination), "%", `≤ ${c.max_contamination}`, judge(k.contamination <= c.max_contamination)],
    [L("r.row.agar"), fmt(k.agar), "%", `≤ ${c.max_agar}`, judge(k.agar <= c.max_agar)],
    [L("r.row.iou"), fmt(m.iou, 2), "—", `≥ ${fmt(c.min_iou, 2)}`, judge(!r.colony.detected || m.iou >= c.min_iou)],
    [L("r.row.white"), fmt(m.whiteness), "%", "—", info],
    [L("r.row.fluffy"), fmt(m.fluffiness), "%", "—", info],
    [L("r.row.circ"), fmt(m.circularity), "%", "—", info],
    [L("r.row.score"), fmt(r.score), "/100", `≥ ${c.min_score}`, judge(r.score >= c.min_score)],
    [L("r.row.grade"), `${r.grade} (${L(`grade.${r.grade}`)})`, "—", "—", info],
  ];
  return rows
    .map(([p, v, u, req, a]) => `<tr><td>${p}</td><td class="n">${v}</td><td class="c">${u}</td><td class="c">${req}</td><td class="c">${a}</td></tr>`)
    .join("");
}

function reportPages(item, info, issued, lng) {
  const L = (key, params) => t(key, params, lng);
  const r = item.report, c = r.config, w = r.weights;
  const panels = Object.fromEntries(r.panels.map((p) => [p.key, p.src]));
  const total = 2;
  const head = `
    <div class="r-head">
      <div class="r-lab"><b>${info.labName ? esc(info.labName) : L("r.labNone")}</b><span>${dash(info.labAddress)}</span></div>
      <div class="r-id">${L("r.testReport")}<b>${item.reportNo}</b>${L("r.issue", { date: isoDate(issued) })}</div>
    </div>`;
  const foot = (n) => `
    <div class="r-foot">
      <span class="disc">${L("r.disclaimer")}</span>
      <span>${L("r.reportNo", { no: item.reportNo })}<br/>${L("r.page", { n, t: total })}</span>
    </div>`;
  const reasons = r.reasons.length
    ? `<ul>${r.reasons.map((x) => `<li>${esc(reasonText(x.code, r, lng))}</li>`).join("")}</ul>`
    : `<div>${L("r.allMet")}</div>`;
  const credit = `${esc(L("credit.line1", { name: L("credit.name") }))}<br/>${esc(L("credit.line2"))}`;

  const page1 = `
    <div class="rpage" lang="${lng}">
      ${head}
      <div class="r-title">${L("r.title")}</div>
      <div class="r-subtitle">${L("r.subtitle")}</div>

      <div class="r-sec">
        <h4>${L("r.s1")}</h4>
        <div class="r-grid">
          <table class="r-kv grow">
            <tr><td>${L("r.customer")}</td><td>${dash(info.customer)}</td></tr>
            <tr><td>${L("r.sampleId")}</td><td>${esc(stem(r.name))} — ${L("r.digitalPhoto")} (${esc(r.name)})</td></tr>
            <tr><td>${L("r.organism")}</td><td>${dash(info.species)}</td></tr>
            <tr><td>${L("r.batch")}</td><td>${dash(info.batch)}</td></tr>
            <tr><td>${L("r.medium")}</td><td>${dash(info.medium)}</td></tr>
            <tr><td>${L("r.incubation")}</td><td>${dash(info.incubation)}</td></tr>
            <tr><td>${L("r.inoculation")}</td><td>${isoDate(info.inoculationDate)}</td></tr>
            <tr><td>${L("r.analysisDate")}</td><td>${isoDate(item.analyzedAt)}</td></tr>
          </table>
          <div class="r-photo"><img src="${panels.original}" alt="" /><span>${L("r.fig1")}</span></div>
        </div>
      </div>

      <div class="r-sec">
        <h4>${L("r.s2")}</h4>
        <p class="r-text">${L("r.method", {
          ver: APP_VERSION, plate: c.plate_cm, wg: Math.round(w.growth * 100), ww: Math.round(w.whiteness * 100),
          wf: Math.round(w.fluffiness * 100), ws: Math.round(w.shape * 100),
        })}</p>
      </div>

      <div class="r-sec">
        <h4>${L("r.s3")}</h4>
        <table class="r-table">
          <thead><tr><th>${L("r.param")}</th><th class="n">${L("r.result")}</th><th class="c">${L("r.unit")}</th><th class="c">${L("r.req")}</th><th class="c">${L("r.assess")}</th></tr></thead>
          <tbody>${resultRows(r, L)}</tbody>
        </table>
        <div class="r-small">${L("r.gradeScale")}</div>
      </div>

      <div class="r-sec">
        <h4>${L("r.s4")}</h4>
        <div class="r-conform ${r.passed ? "pass" : "fail"}">
          <div class="mark">${r.passed ? "✓" : "✕"}</div>
          <div><b>${L(r.passed ? "r.conformPass" : "r.conformFail")}</b>${reasons}</div>
        </div>
        <div class="r-small">${L("r.decision")}</div>
      </div>

      <div class="r-sec">
        <h4>${L("r.s5")}</h4>
        <p class="r-text">${L("r.remarks", { text: info.remarks ? esc(info.remarks) : L("r.none") })}</p>
      </div>

      <div class="r-sec">
        <h4>${L("r.s6")}</h4>
        <div class="r-sign">
          <div><div class="line"></div><span>${L("r.analysedBy")}</span><b>${dash(info.analyst)}</b><span>${L("r.date", { date: isoDate(item.analyzedAt) })}</span></div>
          <div><div class="line"></div><span>${L("r.approvedBy")}</span><b>${dash(info.approver)}</b><span>${L("r.date", { date: "____________" })}</span></div>
        </div>
      </div>
      ${foot(1)}
    </div>`;

  const annex = REPORT_PANEL_KEYS
    .map((key, i) => `
      <figure><img src="${panels[key]}" alt="" /><figcaption><b>${L("r.annexPrefix")}${i + 1}. ${L(`r.panel.${key}`)}</b>${L(`r.panel.${key}.h`)}</figcaption></figure>`)
    .join("");
  const calib = r.calibration
    .map((e) => `<tr><td>${L(`r.colour.${e.name}`)}</td><td class="c"><span class="r-sw" style="background:rgb(${e.standard.join(",")})"></span></td>
      <td class="c">${e.sample ? `<span class="r-sw" style="background:rgb(${e.sample.join(",")})"></span>` : "—"}</td>
      <td class="n">${e.match === null ? L("r.notPresent") : `${fmt(e.match, 0)} %`}</td></tr>`)
    .join("");

  const page2 = `
    <div class="rpage" lang="${lng}">
      ${head}
      <div class="r-sec">
        <h4>${L("r.annexA")}</h4>
        <div class="r-panels">${annex}</div>
        <div class="r-legend">
          ${L("r.legendTitle")}
          <span><i style="background:#fff"></i>${L("r.legend.clean")}</span>
          <span><i style="background:#f0c814"></i>${L("r.legend.agar")}</span>
          <span><i style="background:#d72828"></i>${L("r.legend.contam")}</span>
          <span><i style="background:#3c5ad2"></i>${L("r.legend.ink")}</span>
          <span><i style="background:#5f5f5f"></i>${L("r.legend.dark")}</span>
        </div>
      </div>
      <div class="r-sec">
        <h4>${L("r.annexB")}</h4>
        <table class="r-table" style="width:60%">
          <thead><tr><th>${L("r.colourClass")}</th><th class="c">${L("r.reference")}</th><th class="c">${L("r.sample")}</th><th class="n">${L("r.match")}</th></tr></thead>
          <tbody>${calib}</tbody>
        </table>
      </div>
      <div class="r-end">${L("r.end")}</div>
      <div class="r-credit">${L("r.software", { ver: APP_VERSION })}<br/>${credit}</div>
      ${foot(2)}
    </div>`;
  return page1 + page2;
}

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

async function downloadPdf(items) {
  if (!items.length) return;
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
    const info = readForm($("#info"), false);
    const issued = new Date();
    let first = true;
    for (const [i, item] of items.entries()) {
      $("#busy-text").textContent = t("busy.pdfN", { i: i + 1, n: items.length });
      host.innerHTML = reportPages(item, info, issued, lng);
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
      title: items.length === 1 ? t("r.pdfTitleOne", { no: items[0].reportNo }, lng) : t("r.pdfTitleMany", {}, lng),
      subject: "Fungal culture quality assessment",
      creator: `Precision QC v${APP_VERSION}`,
      author: `${t("credit.name", {}, lng)}, ${t("credit.line2", {}, lng)}`,
    });
    const name = items.length === 1
      ? `${items[0].reportNo}_${stem(items[0].report.name).replace(/[\\/:*?"<>|\s]+/g, "_")}_${lng.toUpperCase()}.pdf`
      : `Precision-QC_reports_${isoDate(issued)}_${lng.toUpperCase()}.pdf`;
    download(name, pdf.output("blob"));
  } catch (err) {
    console.error(err);
    alert(t("alert.pdfFail"));
  } finally {
    host.remove();
    overlay.hidden = true;
  }
}

initBatchUI();
initCapsUI();
applyLang(lang);
initCamera();
boot();
