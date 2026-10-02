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
    renderSamples(manifest.samples || []);
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
  const files = results.map((r) => r.file);
  results = [];
  $("#results").innerHTML = "";
  await runFiles(files);
});

/* -------------------------------------------------------------------- input */
const drop = $("#drop");
$("#file").addEventListener("change", (e) => runFiles([...e.target.files]).then(() => (e.target.value = "")));
["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => runFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"))));

function renderSamples(names) {
  const box = $("#sample-list");
  box.innerHTML = "";
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

async function runFiles(files) {
  if (!api || !files.length) return;
  const cfgJson = JSON.stringify(readForm($("#cfg"), true));
  for (const file of files) {
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
        <h2>${esc(r.name)}</h2>
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
  $("#summary-body").innerHTML = results
    .map(({ id, report: r }) => `
      <tr data-target="r-${id}">
        <td>${esc(r.name)}</td>
        <td><span class="status ${r.passed ? "pass" : "fail"}">${t(r.passed ? "tile.ok" : "tile.ng")}</span></td>
        <td class="num">${fmt(r.score)}</td>
        <td>${r.grade} · ${t(`grade.${r.grade}`)}</td>
        <td>${esc(r.reasons.length ? r.reasons.map((x) => t(`reason.short.${x.code}`)).join(", ") : "—")}</td>
      </tr>`)
    .join("");
}

$("#summary-body").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (tr) document.getElementById(tr.dataset.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
});

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
    "shape_iou", "exposed_agar_pct", "contamination_pct", "colony_width_cm", "colony_height_cm", "reasons"];
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = results.map(({ report: r, reportNo }) => [reportNo, r.name, r.result, r.score, r.grade, r.metrics.growth,
    r.metrics.whiteness, r.metrics.fluffiness, r.metrics.iou, r.contamination.agar, r.contamination.contamination,
    r.colony.width_cm, r.colony.height_cm, r.reasons.map((x) => x.code).join("; ")].map(q).join(","));
  download("precision_qc_summary.csv", new Blob(["﻿" + [head.join(","), ...lines].join("\n")], { type: "text/csv" }));
});

$("#clear").addEventListener("click", () => {
  results = [];
  $("#results").innerHTML = "";
  renderSummary();
});

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
      ? `${items[0].reportNo}_${stem(items[0].report.name)}_${lng.toUpperCase()}.pdf`
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

applyLang(lang);
initCamera();
boot();
