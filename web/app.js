/* Precision QC web UI - dish QC page (index.html) (ไทย · English · 中文).
 * Image analysis is done by the Python package `precision_qc`, running in the
 * browser through Pyodide. PDF reports are rendered from HTML (A4 portrait)
 * with html2canvas + jsPDF, both loaded on demand. Shared code (language,
 * theme, engine loader, numpad) is in common.js, texts in i18n.js. */

const CFG_KEY = "precision-qc-config";
const INFO_KEY = "precision-qc-report-info";

let defaults = {};
let results = []; // { id, file, report, analyzedAt, reportNo, card }
let seq = 0;
let bseq = 0;
let batches = []; // batch photos: { id, file, data, items, el, labels }
const labelStore = new Map(); // "name|size" -> { plateNo: dish ID typed by the user }, survives re-runs
const BATCH_KEY = "precision-qc-batch";
let batchMode = false;
try { batchMode = localStorage.getItem(BATCH_KEY) === "1"; } catch (_) { /* storage unavailable */ }

$("#cfg").addEventListener("input", () => {
  persist($("#cfg"), CFG_KEY, true);
  $("#rerun").disabled = results.length === 0;
});
Telemetry.watchParams($("#cfg"), () => readForm($("#cfg"), true));
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
      runFiles([Telemetry.tag(new File([blob], n, { type: blob.type || "image/jpeg" }), "sample")], true);
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
      runFiles([Telemetry.tag(new File([blob], n, { type: blob.type || "image/jpeg" }), "sample")]);
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
    const t0 = performance.now();
    const data = JSON.parse(api.analyze_plates_to_json(bytes, cfgJson, file.name));
    const ms = Math.round(performance.now() - t0);
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
      Telemetry.log("analyze_done", { source: Telemetry.sourceOf(file), batch: { plates: data.plates.length, rank: rep.rank },
        image: Telemetry.imageInfo(file, rep.image_size), params: Telemetry.params(rep.config),
        result: Telemetry.dishResult(rep), timing_ms: { analyze: ms } });
    }
    $("#results").prepend(...cards);
    batches.push(b);
    renderBatch(b);
  } catch (err) {
    console.error(err);
    Telemetry.log("analyze_error", { source: Telemetry.sourceOf(file), batch: true, error: String(err?.message || err).slice(0, 120) });
    el.innerHTML = `<p class="error">${esc(t("card.error", { name: file.name }))}</p>`;
  }
  renderSummary();
}

/* ------------------------------------------------------------------ analyse */

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
      const t0 = performance.now();
      const report = JSON.parse(api.analyze_to_json(bytes, cfgJson, file.name));
      Telemetry.log("analyze_done", { source: Telemetry.sourceOf(file), image: Telemetry.imageInfo(file, report.image_size),
        params: Telemetry.params(report.config), result: Telemetry.dishResult(report), timing_ms: { analyze: Math.round(performance.now() - t0) } });
      const analyzedAt = new Date();
      const item = { id: ++seq, file, report, analyzedAt, reportNo: newReportNo(analyzedAt), card };
      results.push(item);
      card.id = `r-${item.id}`;
      mountCard(item);
      openResult(item); // modal editions: pop the result up full-screen (no-op otherwise)
    } catch (err) {
      console.error(err);
      Telemetry.log("analyze_error", { source: Telemetry.sourceOf(file), error: String(err?.message || err).slice(0, 120) });
      card.innerHTML = `<p class="error">${esc(t("card.error", { name: file.name }))}</p>`;
    }
    renderSummary();
  }
}

function mountCard(item) {
  const card = item.card;
  card.innerHTML = renderCard(item);
  $(".dl-one", card).addEventListener("click", () => downloadPdf([item]));
  item.fb = item.fb || {};
  const bar = Telemetry.feedbackBar({ kind: "dish", result: Telemetry.dishResult(item.report), state: item.fb });
  ($(".reasons", card) || $(".card-body", card) || card).after(bar);
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

/* ------------------------------------------------------------------- export */
$("#dl-csv").addEventListener("click", () => {
  Telemetry.log("export", { format: "csv", n: results.length });
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

async function downloadPdf(items) {
  Telemetry.log("export", { format: "pdf", n: items.length });
  if (!items.length) return;
  const lng = lang;
  const info = readForm($("#info"), false);
  const issued = new Date();
  await makePdf({
    n: items.length,
    pages: (i) => reportPages(items[i], info, issued, lng),
    props: {
      title: items.length === 1 ? t("r.pdfTitleOne", { no: items[0].reportNo }, lng) : t("r.pdfTitleMany", {}, lng),
      subject: "Fungal culture quality assessment",
    },
    fileName: items.length === 1
      ? `${items[0].reportNo}_${stem(items[0].report.name).replace(/[\\/:*?"<>|\s]+/g, "_")}_${lng.toUpperCase()}.pdf`
      : `Precision-QC_reports_${isoDate(issued)}_${lng.toUpperCase()}.pdf`,
  });
}


initBatchUI();
langHooks.push(() => {
  results.forEach(mountCard);
  renderSummary();
  batches.forEach(renderBatch);
  relabelBatchSamples();
});
initNumpad();
applyLang(lang);
initCamera((file) => runFiles([Telemetry.tag(file, "camera")]));
boot({
  manifest: (m) => renderSamples(m.samples || [], m.batch_samples || []),
  ready: (py) => {
    defaults = JSON.parse(py.default_config_json());
    loadForm($("#cfg"), CFG_KEY, defaults);
    $("#drop").classList.remove("disabled");
  },
});
