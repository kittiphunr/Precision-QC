/* Precision QC web UI.
 * All image analysis is done by the Python package `precision_qc`
 * running inside the browser through Pyodide (numpy + Pillow). */

const PYODIDE_INDEX = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const CFG_KEY = "precision-qc-config";

const $ = (s) => document.querySelector(s);
let api = null;
let defaults = {};
let results = []; // { file, report }

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function setEngine(state, text) {
  const el = $("#engine");
  el.className = `engine ${state}`;
  $("#engine-text").textContent = text;
}

/* ------------------------------------------------------------------ boot */
async function boot() {
  try {
    const manifest = await (await fetch("manifest.json", { cache: "no-store" })).json();
    renderSamples(manifest.samples || []);
    const pyodide = await loadPyodide({ indexURL: PYODIDE_INDEX });
    setEngine("loading", "กำลังโหลด numpy + Pillow…");
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
    loadConfigForm();
    setEngine("ready", "Python engine พร้อมใช้งาน");
    $("#drop").classList.remove("disabled");
    document.querySelectorAll(".chip").forEach((b) => (b.disabled = false));
  } catch (err) {
    console.error(err);
    setEngine("error", "โหลด engine ไม่สำเร็จ — ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต");
  }
}

/* --------------------------------------------------------------- config */
function readConfig() {
  const cfg = {};
  for (const input of $("#cfg").elements) {
    if (!input.name) continue;
    cfg[input.name] = input.value === "" ? null : Number(input.value);
  }
  return cfg;
}

function loadConfigForm() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); } catch (_) { /* ignore */ }
  const cfg = { ...defaults, ...saved };
  for (const input of $("#cfg").elements) {
    if (input.name) input.value = cfg[input.name] ?? "";
  }
}

$("#cfg").addEventListener("input", () => {
  try { localStorage.setItem(CFG_KEY, JSON.stringify(readConfig())); } catch (_) { /* ignore */ }
  $("#rerun").disabled = results.length === 0;
});
$("#cfg-reset").addEventListener("click", () => {
  try { localStorage.removeItem(CFG_KEY); } catch (_) { /* ignore */ }
  loadConfigForm();
});
$("#rerun").addEventListener("click", async () => {
  const files = results.map((r) => r.file);
  results = [];
  $("#results").innerHTML = "";
  await runFiles(files);
});

/* ---------------------------------------------------------------- input */
const drop = $("#drop");
drop.classList.add("disabled");
$("#file").addEventListener("change", (e) => runFiles([...e.target.files]).then(() => (e.target.value = "")));
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); })
);
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); })
);
drop.addEventListener("drop", (e) => runFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"))));

function renderSamples(names) {
  const box = $("#sample-list");
  box.innerHTML = "";
  for (const n of names) {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = n.replace(/\.[^.]+$/, "");
    b.disabled = true;
    b.addEventListener("click", async () => {
      const blob = await (await fetch(`samples/${n}`)).blob();
      runFiles([new File([blob], n, { type: blob.type || "image/jpeg" })]);
    });
    box.appendChild(b);
  }
}

/* -------------------------------------------------------------- analyse */
async function runFiles(files) {
  if (!api || !files.length) return;
  const cfgJson = JSON.stringify(readConfig());
  for (const file of files) {
    const card = document.createElement("article");
    card.className = "panel card";
    card.innerHTML = `<div class="busy"><div class="spinner"></div>กำลังวิเคราะห์ ${esc(file.name)}…</div>`;
    $("#results").prepend(card);
    await new Promise((r) => setTimeout(r, 30)); // let the spinner paint
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const report = JSON.parse(api.analyze_to_json(bytes, cfgJson, file.name));
      results.push({ file, report });
      card.id = `r-${results.length}`;
      card.innerHTML = renderCard(report);
    } catch (err) {
      console.error(err);
      card.innerHTML = `<p class="error">วิเคราะห์ ${esc(file.name)} ไม่สำเร็จ: ${esc(err.message || err)}</p>`;
    }
    renderSummary();
  }
}

/* ------------------------------------------------------------- rendering */
function panelCaption(key, r) {
  const m = r.metrics, c = r.contamination, cr = r.color_ratio;
  switch (key) {
    case "original": return `Colony ${r.colony.width_cm}×${r.colony.height_cm} cm · Growth ${m.growth}% · จาน ${r.dish.plate_cm} cm`;
    case "whiteness": return `Whiteness ${m.whiteness}% (raw ${m.whiteness_raw}%) · WhiteRatio ${m.white_ratio}%`;
    case "fluffiness": return `Fluffy ${m.fluffiness}% · Lap ${m.laplacian} · Tex ${m.texture} · E ${m.edge_density}%`;
    case "contamination": return `Clean ${c.clean}% · Agar ${c.agar}% · Contam ${c.contamination}% · Ink ${c.ink}% · Dark ${c.dark}%`;
    case "color_ratio": return `Yellow ${cr.yellow}% · Red ${cr.red}% · Blue ${cr.blue}%`;
    case "shape": return `Circularity ${m.circularity}% · IoU ${m.iou} · Symmetry ${m.symmetry}%`;
    default: return "";
  }
}

const LEGEND = `
  <div class="legend">
    <span><i style="background:#fff"></i>เส้นใยสะอาด</span>
    <span><i style="background:#f0c814"></i>วุ้นเปลือย</span>
    <span><i style="background:#d72828"></i>ปนเปื้อน</span>
    <span><i style="background:#3c5ad2"></i>หมึก/ปากกา</span>
    <span><i style="background:#5f5f5f"></i>พื้นที่มืด</span>
  </div>`;

const rgb = (a) => `rgb(${a[0]},${a[1]},${a[2]})`;
const barColor = (p) => (p >= 75 ? "#27a35a" : p >= 50 ? "#e08a2c" : "#d64545");

function renderCard(r) {
  const cls = r.passed ? "pass" : "fail";
  const panels = r.panels
    .map((p) => `
      <figure>
        <img src="${p.src}" alt="${esc(p.title)}" loading="lazy" />
        <figcaption><b>${esc(p.title)}</b><span>${esc(panelCaption(p.key, r))}</span></figcaption>
        ${p.key === "contamination" ? LEGEND : ""}
      </figure>`)
    .join("");

  const calib = r.calibration
    .map((e) => `
      <div class="calib-row">
        <span>${e.name}</span>
        <span class="sw" style="background:${rgb(e.standard)}"></span>
        ${e.sample
          ? `<span class="sw" style="background:${rgb(e.sample)}"></span>
             <div class="bar"><i style="width:${e.match}%;background:${barColor(e.match)}"></i><em>${Math.round(e.match)}%</em></div>`
          : `<span class="nd">n/a</span><span class="nd">ไม่พบ</span>`}
      </div>`)
    .join("");

  const w = r.weights, m = r.metrics, s = r.subscores;
  const row = (wt, label, value, sub, extraCls = "") => `
    <div class="rrow">
      <span class="w ${extraCls}">${Math.round(wt * 100)}%</span>
      <span>${label}</span>
      <div><span class="v">${value}</span><div class="meter"><i style="width:${Math.min(100, sub)}%"></i></div></div>
    </div>`;

  const reasons = r.reasons.length
    ? r.reasons.map((x) => `<li><b>${esc(x.code)}</b> — ${esc(x.th)} (${esc(x.detail)})</li>`).join("")
    : `<li class="ok"><b>Acceptable</b> — ผ่านเกณฑ์ทุกข้อ</li>`;

  return `
    <div class="card-head">
      <h2>${esc(r.name)}</h2>
      <div class="verdict">
        <span class="score">คะแนน <b>${r.score}</b>/100 · เกรด <b>${r.grade}</b> (${r.grade_label})</span>
        <span class="big ${cls}">${r.result}</span>
      </div>
    </div>
    <div class="panels">${panels}</div>
    <div class="lower">
      <div>
        <h3>7. Color Calibration Standard</h3>
        <div class="calib-row muted"><span>Color</span><span>Std</span><span>Sample</span><span>Match</span></div>
        ${calib}
      </div>
      <div>
        <h3>8. QC Report</h3>
        <div class="report-rows">
          <div class="rrow"><span></span><span>ขนาดโคโลนี</span><span class="v">${r.colony.width_cm} × ${r.colony.height_cm} cm</span></div>
          ${row(w.growth, "Growth", `${m.growth}%`, s.growth)}
          ${row(w.whiteness, "Whiteness", `${m.whiteness}% (raw ${m.whiteness_raw}%)`, s.whiteness)}
          ${row(w.fluffiness, "Fluffiness", `${m.fluffiness}% (Lap ${m.laplacian})`, s.fluffiness)}
          ${row(w.shape, "Shape (IoU)", `${m.shape}% · IoU ${m.iou}`, s.shape, "shape")}
        </div>
        <ul class="reasons">${reasons}</ul>
      </div>
    </div>`;
}

function renderSummary() {
  const done = results.map((x) => x.report);
  $("#summary").hidden = done.length === 0;
  $("#rerun").disabled = done.length === 0;
  const nPass = done.filter((r) => r.passed).length;
  $("#n-pass").textContent = nPass;
  $("#n-fail").textContent = done.length - nPass;
  $("#n-total").textContent = `ทั้งหมด ${done.length} ภาพ`;
  $("#summary-body").innerHTML = done
    .map((r, i) => `
      <tr data-target="r-${i + 1}">
        <td>${esc(r.name)}</td>
        <td><span class="badge ${r.passed ? "pass" : "fail"}">${r.result}</span></td>
        <td class="num">${r.score}</td><td>${r.grade}</td>
        <td class="num">${r.metrics.growth}</td><td class="num">${r.metrics.whiteness}</td>
        <td class="num">${r.metrics.fluffiness}</td><td class="num">${r.metrics.shape}</td>
        <td class="num">${r.contamination.agar}</td><td class="num">${r.contamination.contamination}</td>
        <td>${esc(r.reasons.map((x) => x.code).join(", ") || "Acceptable")}</td>
      </tr>`)
    .join("");
}

$("#summary-body").addEventListener("click", (e) => {
  const tr = e.target.closest("tr");
  if (tr) document.getElementById(tr.dataset.target)?.scrollIntoView({ behavior: "smooth", block: "start" });
});

/* -------------------------------------------------------------- export */
function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

$("#dl-csv").addEventListener("click", () => {
  const head = ["image", "result", "score", "grade", "growth", "whiteness", "fluffiness", "shape", "iou",
    "agar", "contamination", "ink", "width_cm", "height_cm", "reasons"];
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const lines = results.map(({ report: r }) => [r.name, r.result, r.score, r.grade, r.metrics.growth,
    r.metrics.whiteness, r.metrics.fluffiness, r.metrics.shape, r.metrics.iou, r.contamination.agar,
    r.contamination.contamination, r.contamination.ink, r.colony.width_cm, r.colony.height_cm,
    r.reasons.map((x) => x.code).join("; ")].map(q).join(","));
  download("precision_qc_summary.csv", "﻿" + [head.join(","), ...lines].join("\n"), "text/csv");
});

$("#dl-json").addEventListener("click", () => {
  const data = results.map(({ report }) => { const { panels, ...rest } = report; return rest; });
  download("precision_qc_results.json", JSON.stringify(data, null, 2), "application/json");
});

$("#clear").addEventListener("click", () => {
  results = [];
  $("#results").innerHTML = "";
  renderSummary();
});

boot();
