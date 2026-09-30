/* Precision QC web UI.
 * Image analysis is done by the Python package `precision_qc`, running in the
 * browser through Pyodide. PDF reports are rendered from HTML (A4 portrait)
 * with html2canvas + jsPDF, both loaded on demand. */

const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const PDF_LIBS = [
  "https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
];
const CFG_KEY = "precision-qc-config";
const INFO_KEY = "precision-qc-report-info";
const APP_VERSION = "1.1";
const CREDIT_TH = "พัฒนาโดย นายกิตติพันธ์ รัตนคร นักวิชาการคอมพิวเตอร์ มหาวิทยาลัยมหาจุฬาลงกรณราชวิทยาลัย วิทยาเขตแพร่";
const CREDIT_EN = "Developed by Mr. Kittiphun Rattanakorn, Computer Technical Officer, Mahachulalongkornrajavidyalaya University, Phrae Campus";

const $ = (s, root = document) => root.querySelector(s);
let api = null;
let defaults = {};
let results = []; // { id, file, report, analyzedAt, reportNo }
let seq = 0;

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(+v) ? "—" : (+v).toFixed(d));
const stem = (name) => name.replace(/\.[^.]+$/, "");

function setEngine(state, text) {
  $("#engine").className = `engine ${state}`;
  $("#engine-text").textContent = text;
}

/* --------------------------------------------------------------------- boot */
async function boot() {
  try {
    const manifest = await (await fetch("manifest.json", { cache: "no-store" })).json();
    renderSamples(manifest.samples || []);
    const pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX });
    setEngine("loading", "กำลังเตรียมระบบ… (ครั้งแรกอาจใช้เวลาสักครู่)");
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
    setEngine("ready", "พร้อมใช้งาน");
    $("#drop").classList.remove("disabled");
    document.querySelectorAll(".chip").forEach((b) => (b.disabled = false));
  } catch (err) {
    console.error(err);
    setEngine("error", "เตรียมระบบไม่สำเร็จ — ตรวจสอบอินเทอร์เน็ตแล้วรีเฟรชหน้า");
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
    b.className = "btn chip";
    b.textContent = stem(n).replace(/_/g, " ");
    b.disabled = true;
    b.addEventListener("click", async () => {
      const blob = await (await fetch(`samples/${n}`)).blob();
      runFiles([new File([blob], n, { type: blob.type || "image/jpeg" })]);
    });
    box.appendChild(b);
  }
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
    card.innerHTML = `<div class="loading-card"><div class="spinner"></div>กำลังตรวจ ${esc(file.name)}…</div>`;
    $("#results").prepend(card);
    await new Promise((r) => setTimeout(r, 30)); // let the spinner paint
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const report = JSON.parse(api.analyze_to_json(bytes, cfgJson, file.name));
      const analyzedAt = new Date();
      const item = { id: ++seq, file, report, analyzedAt, reportNo: newReportNo(analyzedAt) };
      results.push(item);
      card.id = `r-${item.id}`;
      card.innerHTML = renderCard(item);
      $(".dl-one", card).addEventListener("click", () => downloadPdf([item]));
      card.querySelectorAll(".thumbs img, .photo img").forEach((img) => img.addEventListener("click", () => lightbox(img.src)));
    } catch (err) {
      console.error(err);
      card.innerHTML = `<p class="error">ตรวจภาพ ${esc(file.name)} ไม่สำเร็จ กรุณาลองภาพอื่น หรือถ่ายภาพจากด้านบนให้เห็นจานทั้งใบ</p>`;
    }
    renderSummary();
  }
}

/* -------------------------------------------------------- wording (TH / EN) */
const GRADE_TH = { A: "ดีเยี่ยม", B: "ดี", C: "พอใช้", D: "ต้องปรับปรุง" };

const PANEL_TH = {
  whiteness: ["ความขาวของเส้นใย", "สีเขียว = เส้นใยสีขาว"],
  fluffiness: ["ความฟูของเส้นใย", "สีสว่าง = เส้นใยฟูละเอียด"],
  contamination: ["แผนที่การปนเปื้อน", "ดูสีตามคำอธิบายด้านล่าง"],
  color_ratio: ["บริเวณสีผิดปกติ", "เหลือง · แดง · น้ำเงิน"],
  shape: ["รูปทรงโคโลนี", "เส้นส้ม = ขอบโคโลนี"],
};

const PANEL_EN = {
  original: ["Original image", "Plate outline, colony axes and 1 cm scale bar"],
  whiteness: ["Whiteness", "Green overlay marks white mycelium"],
  fluffiness: ["Hyphal texture (fluffiness)", "Brighter colour = finer, fluffier hyphae"],
  contamination: ["Contamination map", "Classification of every pixel on the plate"],
  color_ratio: ["Colour anomalies", "Yellow = exposed agar, red = pigment, blue = ink"],
  shape: ["Colony shape", "Orange = colony edge, cyan = ideal circle, blue = plate"],
};

function reasonText(code, r, lang) {
  const c = r.config, m = r.metrics, k = r.contamination;
  const th = {
    "Contaminated": `พบบริเวณที่อาจปนเปื้อน ${fmt(k.contamination)}% (เกณฑ์ไม่เกิน ${c.max_contamination}%)`,
    "Agar Exposed": `เส้นใยคลุมอาหารวุ้นไม่ทั่ว วุ้นเปลือย ${fmt(k.agar)}% (เกณฑ์ไม่เกิน ${c.max_agar}%)`,
    "Low Growth": `โคโลนีเจริญน้อย ครอบคลุม ${fmt(m.growth)}% ของจาน (เกณฑ์อย่างน้อย ${c.min_growth}%)`,
    "Check Shape": `รูปทรงโคโลนีไม่สม่ำเสมอ ความกลม ${fmt(m.iou * 100, 0)}% (เกณฑ์อย่างน้อย ${fmt(c.min_iou * 100, 0)}%)`,
    "Low Score": `คะแนนรวม ${fmt(r.score)} ต่ำกว่าเกณฑ์ ${c.min_score}`,
  };
  const en = {
    "Contaminated": `Pigmented (possible contaminant) area ${fmt(k.contamination)} % exceeds the limit of ${c.max_contamination} %`,
    "Agar Exposed": `Exposed agar ${fmt(k.agar)} % exceeds the limit of ${c.max_agar} %`,
    "Low Growth": `Plate coverage ${fmt(m.growth)} % is below the minimum of ${c.min_growth} %`,
    "Check Shape": `Shape conformity ${fmt(m.iou, 2)} is below the minimum of ${fmt(c.min_iou, 2)}`,
    "Low Score": `Overall score ${fmt(r.score)} is below the minimum of ${c.min_score}`,
  };
  return (lang === "en" ? en : th)[code] || code;
}

/* ------------------------------------------------------------------ UI card */
function tile({ label, value, unit, pct, limit, tickPct, dir }) {
  // dir: "min" (value must be >= limit), "max" (<= limit) or undefined (information only)
  let cls = "", crit = "ใช้ประกอบคะแนน", state = "";
  if (dir) {
    const ok = dir === "min" ? value >= limit : value <= limit;
    cls = ok ? "pass" : "fail";
    crit = `เกณฑ์ ${dir === "min" ? "≥" : "≤"} ${limit}${unit}`;
    state = ok ? `<span class="ok">✓ ผ่าน</span>` : `<span class="ng">✕ ไม่ผ่าน</span>`;
  }
  const clamp = (x) => Math.max(0, Math.min(100, x));
  const tick = dir ? `<u style="left:calc(${clamp(tickPct ?? limit)}% - 1px)"></u>` : "";
  return `
    <div class="tile">
      <div class="label">${label}</div>
      <div class="value">${fmt(value)}<small> ${unit}</small></div>
      <div class="meter ${cls}"><i style="width:${clamp(pct ?? value)}%"></i>${tick}</div>
      <div class="crit"><span>${crit}</span>${state}</div>
    </div>`;
}

function renderCard(item) {
  const r = item.report, m = r.metrics, k = r.contamination, c = r.config;
  const pass = r.passed;
  const panels = Object.fromEntries(r.panels.map((p) => [p.key, p.src]));
  const reasons = r.reasons.length
    ? r.reasons.map((x) => `<li>${esc(reasonText(x.code, r, "th"))}</li>`).join("")
    : `<li class="ok">ผ่านเกณฑ์คุณภาพครบทุกข้อ</li>`;
  const size = r.colony.detected ? `${fmt(r.colony.width_cm)} × ${fmt(r.colony.height_cm)} ซม.` : "ไม่พบโคโลนี";
  // contamination limits are small (a few %), so scale that meter to twice the limit
  const contamScale = Math.max(c.max_contamination * 2, 1);
  const thumbs = Object.entries(PANEL_TH)
    .map(([key, [title, hint]]) => `
      <figure>
        <img src="${panels[key]}" alt="${esc(title)}" loading="lazy" />
        <figcaption>${esc(title)}<span>${esc(hint)}</span></figcaption>
      </figure>`)
    .join("");

  return `
    <div class="card-head">
      <div>
        <h2>${esc(r.name)}</h2>
        <div class="sub">ตรวจเมื่อ ${item.analyzedAt.toLocaleString("th-TH")} · เลขที่รายงาน ${item.reportNo}</div>
      </div>
      <button class="btn primary dl-one">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        ดาวน์โหลดรายงาน PDF
      </button>
    </div>
    <div class="card-body">
      <figure class="photo" style="margin:0">
        <img src="${panels.original}" alt="ภาพจานเพาะเชื้อ" />
        <figcaption>ขนาดโคโลนี ${size} · จานขนาด ${c.plate_cm} ซม.</figcaption>
      </figure>
      <div>
        <div class="verdict ${pass ? "pass" : "fail"}">
          <div class="v-icon" aria-hidden="true">${pass ? "✓" : "✕"}</div>
          <div class="v-text">
            <b>${pass ? "ผ่าน" : "ไม่ผ่าน"}</b>
            <span>${pass ? "ตัวอย่างนี้ได้มาตรฐานคุณภาพ" : "ตัวอย่างนี้ไม่ได้มาตรฐานคุณภาพ"}</span>
          </div>
          <div class="score">
            <div class="hero">${fmt(r.score)}<small> /100</small></div>
            <div class="grade">เกรด ${r.grade} · ${GRADE_TH[r.grade] || ""}</div>
          </div>
        </div>
        <ul class="reasons">${reasons}</ul>
        <div class="tiles">
          ${tile({ label: "พื้นที่เจริญบนจาน", value: m.growth, unit: "%", limit: c.min_growth, dir: "min" })}
          ${tile({ label: "การปนเปื้อน", value: k.contamination, unit: "%", pct: (k.contamination / contamScale) * 100, limit: c.max_contamination, tickPct: (c.max_contamination / contamScale) * 100, dir: "max" })}
          ${tile({ label: "วุ้นเปลือย (เส้นใยไม่คลุม)", value: k.agar, unit: "%", limit: c.max_agar, dir: "max" })}
          ${tile({ label: "ความกลมของโคโลนี", value: m.iou * 100, unit: "%", limit: +(c.min_iou * 100).toFixed(0), dir: "min" })}
          ${tile({ label: "ความขาวของเส้นใย", value: m.whiteness, unit: "%" })}
          ${tile({ label: "ความฟูของเส้นใย", value: m.fluffiness, unit: "%" })}
        </div>
      </div>
    </div>
    <div class="gallery">
      <h3>ภาพประกอบการวิเคราะห์</h3>
      <div class="thumbs">${thumbs}</div>
      <div class="legend">
        <span><i style="background:#fff"></i>เส้นใยปกติ</span>
        <span><i style="background:#f0c814"></i>วุ้นเปลือย</span>
        <span><i style="background:#d72828"></i>อาจปนเปื้อน</span>
        <span><i style="background:#3c5ad2"></i>หมึก / ปากกา (ไม่นับ)</span>
        <span><i style="background:#5f5f5f"></i>พื้นที่มืด</span>
      </div>
    </div>`;
}

function renderSummary() {
  $("#summary").hidden = results.length === 0;
  $("#rerun").disabled = results.length === 0;
  const nPass = results.filter((x) => x.report.passed).length;
  $("#n-pass").textContent = nPass;
  $("#n-fail").textContent = results.length - nPass;
  $("#n-total").textContent = `จากทั้งหมด ${results.length} ภาพ`;
  $("#summary-body").innerHTML = results
    .map(({ id, report: r }) => `
      <tr data-target="r-${id}">
        <td>${esc(r.name)}</td>
        <td><span class="status ${r.passed ? "pass" : "fail"}">${r.passed ? "✓ ผ่าน" : "✕ ไม่ผ่าน"}</span></td>
        <td class="num">${fmt(r.score)}</td>
        <td>${r.grade} · ${GRADE_TH[r.grade] || ""}</td>
        <td>${esc(r.reasons.length ? r.reasons.map((x) => reasonText(x.code, r, "th").split(" (")[0]).join(", ") : "—")}</td>
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
 * Content follows ISO/IEC 17025:2017 clause 7.8 (reporting of results):
 * title, laboratory, unique report number on every page, page x of y,
 * customer, sample description & dates, method, results with units,
 * requirements, statement of conformity with the decision rule,
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

function resultRows(r) {
  const m = r.metrics, k = r.contamination, c = r.config;
  const judge = (ok) => (ok ? `<span class="r-pass">Pass</span>` : `<span class="r-fail">Fail</span>`);
  const info = `<span class="r-info">Info</span>`;
  const rows = [
    ["Colony size (width × height)", r.colony.detected ? `${fmt(r.colony.width_cm)} × ${fmt(r.colony.height_cm)}` : "not detected", "cm", "—", info],
    ["Plate coverage (mycelial growth)", fmt(m.growth), "%", `≥ ${c.min_growth}`, judge(m.growth >= c.min_growth)],
    ["Pigmented area (possible contamination)", fmt(k.contamination), "%", `≤ ${c.max_contamination}`, judge(k.contamination <= c.max_contamination)],
    ["Exposed agar", fmt(k.agar), "%", `≤ ${c.max_agar}`, judge(k.agar <= c.max_agar)],
    ["Shape conformity (IoU with ideal circle)", fmt(m.iou, 2), "—", `≥ ${fmt(c.min_iou, 2)}`, judge(!r.colony.detected || m.iou >= c.min_iou)],
    ["Whiteness index", fmt(m.whiteness), "%", "—", info],
    ["Fluffiness index (hyphal texture)", fmt(m.fluffiness), "%", "—", info],
    ["Circularity", fmt(m.circularity), "%", "—", info],
    ["Overall quality score", fmt(r.score), "/100", `≥ ${c.min_score}`, judge(r.score >= c.min_score)],
    ["Quality grade", `${r.grade} (${r.grade_label})`, "—", "—", info],
  ];
  return rows
    .map(([p, v, u, req, a]) => `<tr><td>${p}</td><td class="n">${v}</td><td class="c">${u}</td><td class="c">${req}</td><td class="c">${a}</td></tr>`)
    .join("");
}

function reportPages(item, info, issued) {
  const r = item.report, c = r.config, w = r.weights;
  const panels = Object.fromEntries(r.panels.map((p) => [p.key, p.src]));
  const total = 2;
  const head = `
    <div class="r-head">
      <div class="r-lab"><b>${info.labName ? esc(info.labName) : "Laboratory name not specified"}</b><span>${dash(info.labAddress)}</span></div>
      <div class="r-id">TEST REPORT<b>${item.reportNo}</b>Issue date: ${isoDate(issued)}</div>
    </div>`;
  const foot = (n) => `
    <div class="r-foot">
      <span class="disc">The results relate only to the item tested. This report shall not be reproduced except in full
      without the written approval of the laboratory.</span>
      <span>Report No. ${item.reportNo}<br/>Page ${n} of ${total}</span>
    </div>`;
  const reasons = r.reasons.length
    ? `<ul>${r.reasons.map((x) => `<li>${esc(reasonText(x.code, r, "en"))}</li>`).join("")}</ul>`
    : `<div>All requirements in Section 3 are fulfilled.</div>`;

  const page1 = `
    <div class="rpage">
      ${head}
      <div class="r-title">Fungal Culture Quality Assessment — Test Report</div>
      <div class="r-subtitle">Automated image-based evaluation of mycelial growth on a culture plate</div>

      <div class="r-sec">
        <h4>1. Customer and sample information</h4>
        <div class="r-grid">
          <table class="r-kv grow">
            <tr><td>Customer</td><td>${dash(info.customer)}</td></tr>
            <tr><td>Sample ID / test item</td><td>${esc(stem(r.name))} — digital photograph (${esc(r.name)})</td></tr>
            <tr><td>Organism / strain</td><td>${dash(info.species)}</td></tr>
            <tr><td>Batch / lot</td><td>${dash(info.batch)}</td></tr>
            <tr><td>Culture medium</td><td>${dash(info.medium)}</td></tr>
            <tr><td>Incubation conditions</td><td>${dash(info.incubation)}</td></tr>
            <tr><td>Inoculation date</td><td>${isoDate(info.inoculationDate)}</td></tr>
            <tr><td>Date of analysis</td><td>${isoDate(item.analyzedAt)}</td></tr>
          </table>
          <div class="r-photo"><img src="${panels.original}" alt="" /><span>Fig. 1 — Test item with plate outline and 1 cm scale bar</span></div>
        </div>
      </div>

      <div class="r-sec">
        <h4>2. Test method</h4>
        <p class="r-text">Automated image analysis, Precision QC v${APP_VERSION}. Top-view photograph; plate diameter ${c.plate_cm} cm
        used as length reference; pixels classified in CIE L*a*b* colour space after lighting compensation. Overall score is the
        weighted sum of growth ${Math.round(w.growth * 100)} %, whiteness ${Math.round(w.whiteness * 100)} %,
        fluffiness ${Math.round(w.fluffiness * 100)} % and shape ${Math.round(w.shape * 100)} %.</p>
      </div>

      <div class="r-sec">
        <h4>3. Results</h4>
        <table class="r-table">
          <thead><tr><th>Parameter</th><th class="n">Result</th><th class="c">Unit</th><th class="c">Requirement</th><th class="c">Assessment</th></tr></thead>
          <tbody>${resultRows(r)}</tbody>
        </table>
        <div class="r-small">Grade scale: A ≥ 80 (Excellent) · B ≥ 65 (Good) · C ≥ 50 (Fair) · D &lt; 50 (Poor). “Info” = reported for information only, no requirement.</div>
      </div>

      <div class="r-sec">
        <h4>4. Statement of conformity</h4>
        <div class="r-conform ${r.passed ? "pass" : "fail"}">
          <div class="mark">${r.passed ? "✓" : "✕"}</div>
          <div><b>${r.passed ? "PASS — The sample CONFORMS to the specified requirements" : "FAIL — The sample DOES NOT CONFORM to the specified requirements"}</b>${reasons}</div>
        </div>
        <div class="r-small">Decision rule: simple acceptance (ILAC-G8:09/2019); measurement uncertainty not taken into account.
        The sample conforms only when every requirement in Section 3 is met.</div>
      </div>

      <div class="r-sec">
        <h4>5. Remarks and deviations</h4>
        <p class="r-text">Remarks: ${info.remarks ? esc(info.remarks) : "none"}. Deviations from the test method: none.</p>
      </div>

      <div class="r-sec">
        <h4>6. Authorisation</h4>
        <div class="r-sign">
          <div><div class="line"></div><span>Analysed by</span><b>${dash(info.analyst)}</b><span>Date: ${isoDate(item.analyzedAt)}</span></div>
          <div><div class="line"></div><span>Reviewed and approved by</span><b>${dash(info.approver)}</b><span>Date: ____________</span></div>
        </div>
      </div>
      ${foot(1)}
    </div>`;

  const annex = Object.entries(PANEL_EN)
    .map(([key, [title, hint]], i) => `
      <figure><img src="${panels[key]}" alt="" /><figcaption><b>A${i + 1}. ${title}</b>${hint}</figcaption></figure>`)
    .join("");
  const calib = r.calibration
    .map((e) => `<tr><td>${e.name}</td><td class="c"><span class="r-sw" style="background:rgb(${e.standard.join(",")})"></span></td>
      <td class="c">${e.sample ? `<span class="r-sw" style="background:rgb(${e.sample.join(",")})"></span>` : "—"}</td>
      <td class="n">${e.match === null ? "not present" : `${fmt(e.match, 0)} %`}</td></tr>`)
    .join("");

  const page2 = `
    <div class="rpage">
      ${head}
      <div class="r-sec">
        <h4>Annex A — Image analysis</h4>
        <div class="r-panels">${annex}</div>
        <div class="r-legend">
          Contamination map (A4):
          <span><i style="background:#fff"></i>clean mycelium</span>
          <span><i style="background:#f0c814"></i>exposed agar</span>
          <span><i style="background:#d72828"></i>pigmented / possible contamination</span>
          <span><i style="background:#3c5ad2"></i>ink or marker (excluded)</span>
          <span><i style="background:#5f5f5f"></i>dark area</span>
        </div>
      </div>
      <div class="r-sec">
        <h4>Annex B — Colour reference check</h4>
        <table class="r-table" style="width:60%">
          <thead><tr><th>Colour class</th><th class="c">Reference</th><th class="c">Sample</th><th class="n">Match</th></tr></thead>
          <tbody>${calib}</tbody>
        </table>
      </div>
      <div class="r-end">— END OF REPORT —</div>
      <div class="r-credit">Software: Precision QC v${APP_VERSION} · ${CREDIT_EN}<br/>${CREDIT_TH}</div>
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
  const overlay = $("#busy");
  overlay.hidden = false;
  $("#busy-text").textContent = "กำลังสร้างรายงาน PDF…";
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
      $("#busy-text").textContent = `กำลังสร้างรายงาน PDF… (${i + 1}/${items.length})`;
      host.innerHTML = reportPages(item, info, issued);
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
      title: items.length === 1 ? `Test report ${items[0].reportNo}` : "Fungal culture QC test reports",
      subject: "Fungal culture quality assessment",
      creator: `Precision QC v${APP_VERSION}`,
      author: CREDIT_EN.replace("Developed by ", ""),
    });
    const name = items.length === 1
      ? `${items[0].reportNo}_${stem(items[0].report.name)}.pdf`
      : `Precision-QC_reports_${isoDate(issued)}.pdf`;
    download(name, pdf.output("blob"));
  } catch (err) {
    console.error(err);
    alert("สร้างรายงาน PDF ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองอีกครั้ง");
  } finally {
    host.remove();
    overlay.hidden = true;
  }
}

boot();
