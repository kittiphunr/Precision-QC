/* Precision QC - cap counter page (caps.html).
 * A bunch of mushrooms (ช่อดอก) photographed from above: Python
 * (precision_qc.caps) finds every cap and sorts it small / medium / large.
 * Own page, own results and CSV. Needs i18n.js + common.js. */

const CAPS_CSS = `
#sec-caps .caps-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:12px 0}
#sec-caps .caps-bar .muted{margin:0}
#sec-caps .opt{height:auto;margin-top:10px}
#sec-caps .caps-info-grid{padding:14px 16px 16px}
#sec-caps .caps-info-grid label{display:flex;flex-direction:column;gap:6px;font-size:.9em;font-weight:600;margin:0}
#sec-caps .caps-info-grid input{width:100%;box-sizing:border-box;margin:0}
#sec-caps .opt>form{padding:4px 16px 16px}
#sec-caps .form-actions{margin-top:14px}
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
.caps-steps{grid-column:1/-1;border:1px solid rgba(128,128,128,.3);border-radius:12px;padding:0}
.caps-steps>summary{cursor:pointer;padding:12px 16px;font-weight:700;list-style:none;display:flex;flex-wrap:wrap;gap:2px 10px;align-items:baseline}
.caps-steps>summary::-webkit-details-marker{display:none}
.caps-steps>summary::before{content:"▸";display:inline-block;width:1em;transition:transform .15s}
.caps-steps[open]>summary::before{transform:rotate(90deg)}
.caps-steps>summary small{font-weight:400;opacity:.7}
.step-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,230px),1fr));gap:14px;padding:4px 16px 16px}
.step-card{margin:0;display:grid;gap:6px;align-content:start;min-width:0}
.step-card img{width:100%;height:auto;display:block;border-radius:8px;cursor:zoom-in;background:#000}
.step-card figcaption{display:grid;gap:2px;font-size:.88em}
.step-card figcaption b{display:flex;gap:8px;align-items:center}
.step-n{flex:none;width:1.7em;height:1.7em;border-radius:50%;display:inline-grid;place-items:center;font-size:.85em;font-weight:800;background:var(--np-accent,#4f46e5);color:#fff}
.step-card figcaption small{opacity:.75;line-height:1.4}
.caps-actions{display:flex;flex-wrap:wrap;gap:8px}
#sec-caps .caps-group{margin:12px 0 0;padding:12px 16px 16px;border:1px solid rgba(128,128,128,.3);border-radius:12px;min-width:0}
#sec-caps .caps-group legend{padding:0 8px;font-size:.78em;font-weight:700;letter-spacing:.04em;text-transform:uppercase;opacity:.8}
#sec-caps .caps-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:16px 20px}
#sec-caps .caps-field{display:grid;grid-template-rows:1fr auto;gap:8px;min-width:0}
#sec-caps .caps-field label{display:flex;flex-direction:column;gap:2px;margin:0;font-size:inherit}
#sec-caps .caps-field label b{font-size:.95em;font-weight:700}
#sec-caps .caps-field label small{font-size:.8em;font-weight:400;opacity:.7;line-height:1.35}
#sec-caps .caps-field input[type=number]{width:100%;box-sizing:border-box;margin:0;text-align:center;font-variant-numeric:tabular-nums;font-weight:700;cursor:pointer}
#sec-caps .caps-switch{position:relative;display:inline-block;width:52px;height:30px;align-self:end}
#sec-caps .caps-switch input{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;opacity:0;cursor:pointer;z-index:1}
#sec-caps .caps-slider{position:absolute;inset:0;border-radius:999px;background:rgba(128,128,128,.4);transition:background .15s}
#sec-caps .caps-slider::after{content:"";position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.35);transition:transform .15s}
#sec-caps .caps-switch input:checked+.caps-slider{background:var(--np-accent,#4f46e5)}
#sec-caps .caps-switch input:checked+.caps-slider::after{transform:translateX(22px)}
#sec-caps .caps-switch input:focus-visible+.caps-slider{outline:2px solid var(--np-accent,#4f46e5);outline-offset:2px}
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
      <button type="button" id="caps-pdf-all" class="pure-button" disabled data-i18n="btn.pdfAll"></button>
    </div>
    <details class="opt">
      <summary><span class="opt-title" data-i18n="info.title"></span><span class="opt-hint" data-i18n="info.hint"></span></summary>
      <form id="caps-info" class="pure-form pure-form-stacked" onsubmit="return false">
        <div class="caps-grid caps-info-grid">
          <label><span data-i18n="f.labName"></span><input name="labName" data-i18n-ph="ph.labName" /></label>
          <label><span data-i18n="f.labAddress"></span><input name="labAddress" /></label>
          <label><span data-i18n="f.customer"></span><input name="customer" /></label>
          <label><span data-i18n="f.species"></span><input name="species" data-i18n-ph="ph.species" /></label>
          <label><span data-i18n="f.batch"></span><input name="batch" /></label>
          <label><span data-i18n="f.analyst"></span><input name="analyst" /></label>
          <label><span data-i18n="f.approver"></span><input name="approver" /></label>
          <label><span data-i18n="f.remarks"></span><input name="remarks" /></label>
        </div>
      </form>
    </details>
    <details class="opt">
      <summary><span class="opt-title" data-i18n="caps.cfg"></span><span class="opt-hint" data-i18n="caps.cfgHint"></span></summary>
      <form id="caps-cfg" class="pure-form pure-form-stacked" onsubmit="return false">
        <fieldset class="caps-group">
          <legend data-i18n="caps.g.split"></legend>
          <div class="caps-grid">
            <div class="caps-field">
              <label for="caps-multi_view"><b data-i18n="caps.f.multi_view"></b><small data-i18n="caps.f.multi_view.h"></small></label>
              <span class="caps-switch"><input id="caps-multi_view" name="multi_view" type="checkbox" /><span class="caps-slider" aria-hidden="true"></span></span>
            </div>
            <div class="caps-field">
              <label for="caps-contrast"><b data-i18n="caps.f.contrast"></b><small data-i18n="caps.f.contrast.h"></small></label>
              <input id="caps-contrast" name="contrast" type="number" step="0.5" min="-10" max="20" />
            </div>
            <div class="caps-field">
              <label for="caps-small_below"><b data-i18n="caps.f.small_below"></b><small data-i18n="caps.f.small_below.h"></small></label>
              <input id="caps-small_below" name="small_below" type="number" step="0.05" min="0.3" max="1" />
            </div>
            <div class="caps-field">
              <label for="caps-large_above"><b data-i18n="caps.f.large_above"></b><small data-i18n="caps.f.large_above.h"></small></label>
              <input id="caps-large_above" name="large_above" type="number" step="0.05" min="1" max="3" />
            </div>
          </div>
        </fieldset>
        <fieldset class="caps-group">
          <legend data-i18n="caps.g.hidden"></legend>
          <div class="caps-grid">
            <div class="caps-field">
              <label for="caps-find_hidden"><b data-i18n="caps.f.find_hidden"></b><small data-i18n="caps.f.find_hidden.h"></small></label>
              <span class="caps-switch"><input id="caps-find_hidden" name="find_hidden" type="checkbox" /><span class="caps-slider" aria-hidden="true"></span></span>
            </div>
            <div class="caps-field">
              <label for="caps-hidden_sat"><b data-i18n="caps.f.hidden_sat"></b><small data-i18n="caps.f.hidden_sat.h"></small></label>
              <input id="caps-hidden_sat" name="hidden_sat" type="number" step="0.02" min="0.05" max="0.5" />
            </div>
            <div class="caps-field">
              <label for="caps-shadow_lift"><b data-i18n="caps.f.shadow_lift"></b><small data-i18n="caps.f.shadow_lift.h"></small></label>
              <input id="caps-shadow_lift" name="shadow_lift" type="number" step="0.05" min="0.2" max="1" />
            </div>
          </div>
        </fieldset>
        <div class="form-actions">
          <button type="button" id="caps-reset" class="pure-button" data-i18n="btn.reset"></button>
          <button type="button" id="caps-rerun" class="pure-button pure-button-primary" disabled data-i18n="btn.rerun"></button>
        </div>
      </form>
    </details>
    <div id="caps-results"></div>`;
  $("#caps-root").appendChild(sec);
  // the report info is shared with the dish QC page (same storage key): merge, never drop its other fields
  loadForm($("#caps-info"), INFO_KEY);
  $("#caps-info").addEventListener("input", () => {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(INFO_KEY) || "{}"); } catch (_) { /* ignore */ }
    try { localStorage.setItem(INFO_KEY, JSON.stringify({ ...saved, ...readForm($("#caps-info"), false) })); } catch (_) { /* ignore */ }
  });
  $("#caps-pdf-all").addEventListener("click", () => downloadCapsPdf(capsList));
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
    $("#caps-pdf-all").disabled = true;
    await runCaps(files);
  });
}
const CAPS_KEY = "precision-qc-caps-config";
const INFO_KEY = "precision-qc-report-info"; // report details, shared with the dish QC page
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
        <button type="button" class="pure-button pure-button-primary caps-pdf">${esc(t("btn.pdfOne"))}</button>
        <button type="button" class="pure-button caps-png">${esc(t("caps.dlPng"))}</button>
        <button type="button" class="pure-button caps-csv">${esc(t("caps.dlCsv"))}</button>
      </div>
    </div>`;
  if (d.steps && d.steps.length) {
    const figs = d.steps.map((st, i) => `
      <figure class="step-card">
        <img src="${st.src}" alt="${esc(t(`caps.step.${st.key}`))}" />
        <figcaption><b><span class="step-n">${i + 1}</span>${esc(t(`caps.step.${st.key}`))}</b><small>${esc(t(`caps.step.${st.key}.d`))}</small></figcaption>
      </figure>`).join("");
    c.el.insertAdjacentHTML("beforeend", `
      <details class="caps-steps"${c.stepsOpen ? " open" : ""}>
        <summary>${esc(t("caps.steps.title"))}<small>${esc(t("caps.steps.hint"))}</small></summary>
        <div class="step-grid">${figs}</div>
      </details>`);
    $(".caps-steps", c.el).addEventListener("toggle", (e) => { c.stepsOpen = e.target.open; });
    c.el.querySelectorAll(".step-card img").forEach((im) => im.addEventListener("click", () => lightbox(im.src)));
  }
  $(".caps-img", c.el).addEventListener("click", (e) => lightbox(e.target.src));
  $(".caps-pdf", c.el).addEventListener("click", () => downloadCapsPdf([c]));
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
      const analyzedAt = new Date();
      const c = { file, data, el, analyzedAt, reportNo: newReportNo(analyzedAt, "PQC-C") };
      capsList.push(c);
      renderCapsCard(c);
      $("#caps-rerun").disabled = false;
      $("#caps-pdf-all").disabled = false;
    } catch (err) {
      console.error(err);
      el.innerHTML = `<p class="error">${esc(t("card.error", { name: file.name }))}</p>`;
    }
  }
}

/* ---------------------------------------------------------------- PDF report
 * Same A4 layout language as the dish QC report (ISO/IEC 17025:2017 cl. 7.8:
 * report number on every page, page x of y, customer & sample, method, results
 * with units, limitations, remarks, authorisation, disclaimer, end mark) but a
 * count has no pass / fail limit, so there is no statement of conformity. */
function capsReportPages(c, info, issued, lng) {
  const L = (key, params) => t(key, params, lng);
  const d = c.data, cfg = d.config, a = d.area_percent;
  const steps = Object.fromEntries((d.steps || []).map((s) => [s.key, s.src]));
  const hasSteps = (d.steps || []).length > 0;
  const total = hasSteps ? 3 : 2;
  const onOff = (v) => L(Number(v) ? "r.cap.on" : "r.cap.off");
  const head = `
    <div class="r-head">
      <div class="r-lab"><b>${info.labName ? esc(info.labName) : L("r.labNone")}</b><span>${dash(info.labAddress)}</span></div>
      <div class="r-id">${L("r.testReport")}<b>${c.reportNo}</b>${L("r.issue", { date: isoDate(issued) })}</div>
    </div>`;
  const foot = (n) => `
    <div class="r-foot">
      <span class="disc">${L("r.disclaimer")}</span>
      <span>${L("r.reportNo", { no: c.reportNo })}<br/>${L("r.page", { n, t: total })}</span>
    </div>`;
  const credit = `${esc(L("credit.line1", { name: L("credit.name") }))}<br/>${esc(L("credit.line2"))}`;
  const photo = steps.final || d.overlay;
  const sw = (k) => `<span style="display:inline-block;width:10px;height:10px;border-radius:50%;border:2.5px solid ${CAP_COLORS[k]};vertical-align:-1px;margin-right:6px"></span>`;
  const countRow = (k) => `<tr><td>${sw(k)}${L(`caps.${k}`)}</td><td class="n">${d.counts[k]}</td><td class="c">${L("r.cap.unitCaps")}</td><td class="n">${fmt(d.percent[k])} %</td></tr>`;
  const areaRow = (k, label, color) => `<tr><td>${color ? sw(color) : ""}${label}</td><td class="n">${fmt(a[k])}</td><td class="c">%</td></tr>`;

  const page1 = `
    <div class="rpage compact" lang="${lng}">
      ${head}
      <div class="r-title">${L("r.cap.title")}</div>
      <div class="r-subtitle">${L("r.cap.subtitle")}</div>

      <div class="r-sec">
        <h4>${L("r.s1")}</h4>
        <div class="r-grid">
          <table class="r-kv grow">
            <tr><td>${L("r.customer")}</td><td>${dash(info.customer)}</td></tr>
            <tr><td>${L("r.sampleId")}</td><td>${esc(stem(c.file.name))} — ${L("r.digitalPhoto")} (${esc(c.file.name)})</td></tr>
            <tr><td>${L("r.organism")}</td><td>${dash(info.species)}</td></tr>
            <tr><td>${L("r.batch")}</td><td>${dash(info.batch)}</td></tr>
            <tr><td>${L("r.analysisDate")}</td><td>${isoDate(c.analyzedAt)}</td></tr>
          </table>
          <div class="r-photo" style="width:140px"><img src="${photo}" alt="" style="width:140px" /></div>
        </div>
        <div class="r-small">${L("r.cap.fig1")}</div>
      </div>

      <div class="r-sec">
        <h4>${L("r.s2")}</h4>
        <p class="r-text">${L("r.cap.method", {
          ver: APP_VERSION, contrast: cfg.contrast, mv: onOff(cfg.multi_view), hid: onOff(cfg.find_hidden),
          small: cfg.small_below, large: cfg.large_above,
        })}</p>
      </div>

      <div class="r-sec">
        <h4>${L("r.s3")}</h4>
        <table class="r-table">
          <thead><tr><th>${L("r.cap.countTitle")}</th><th class="n">${L("r.result")}</th><th class="c">${L("r.unit")}</th><th class="n">${L("r.cap.ofTotal")}</th></tr></thead>
          <tbody>
            <tr><td><b>${L("r.cap.rowTotal")}</b></td><td class="n"><b>${d.total}</b></td><td class="c">${L("r.cap.unitCaps")}</td><td class="n">100 %</td></tr>
            ${["small", "medium", "large", "hidden"].map(countRow).join("")}
          </tbody>
        </table>
        <table class="r-table" style="margin-top:8px">
          <thead><tr><th>${L("r.cap.areaTitle")}</th><th class="n">${L("r.result")}</th><th class="c">${L("r.unit")}</th></tr></thead>
          <tbody>
            ${areaRow("small", L("caps.small"), "small")}${areaRow("medium", L("caps.medium"), "medium")}${areaRow("large", L("caps.large"), "large")}
            ${areaRow("visible", `<b>${L("r.cap.areaVisible")}</b>`)}${areaRow("hidden", L("caps.hiddenArea"), "hidden")}${areaRow("gaps", L("caps.gaps"))}
          </tbody>
        </table>
        <table class="r-table" style="margin-top:8px">
          <thead><tr><th>${L("r.cap.otherTitle")}</th><th class="n">${L("r.result")}</th><th class="c">${L("r.unit")}</th></tr></thead>
          <tbody>
            <tr><td>${L("r.cap.rowMedian")}</td><td class="n">${fmt(d.median_diameter_px, 0)}</td><td class="c">px</td></tr>
            <tr><td>${L("r.cap.rowBunchArea")}</td><td class="n">${fmt(d.bunch_area_pct, 0)}</td><td class="c">%</td></tr>
            <tr><td>${L("r.cap.rowDensity")}</td><td class="n">${fmt(d.caps_per_1000px2, 2)}</td><td class="c">${L("r.cap.unitDensity")}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="r-sec">
        <h4>${L("r.cap.s4")}</h4>
        <p class="r-text">${L("r.cap.limits")}</p>
      </div>

      <div class="r-sec">
        <h4>${L("r.cap.s5")}</h4>
        <p class="r-text">${L("r.remarks", { text: info.remarks ? esc(info.remarks) : L("r.none") })}</p>
      </div>

      <div class="r-sec">
        <h4>${L("r.cap.s6")}</h4>
        <div class="r-sign">
          <div><div class="line"></div><span>${L("r.analysedBy")}</span><b>${dash(info.analyst)}</b><span>${L("r.date", { date: isoDate(c.analyzedAt) })}</span></div>
          <div><div class="line"></div><span>${L("r.approvedBy")}</span><b>${dash(info.approver)}</b><span>${L("r.date", { date: "____________" })}</span></div>
        </div>
      </div>
      ${foot(1)}
    </div>`;

  const fig = (src, caption) => `<figure style="margin:0;width:340px"><img src="${src}" alt="" style="width:340px;display:block;border:1px solid #d5dae1" /><figcaption style="font-size:10px;color:#5b6573;margin-top:3px">${caption}</figcaption></figure>`;
  const page2 = `
    <div class="rpage" lang="${lng}">
      ${head}
      <div class="r-sec">
        <h4>${L("r.cap.annexA")}</h4>
        <div style="display:flex;gap:16px;flex-wrap:wrap">
          ${fig(steps.final || d.overlay, `<b>${L("r.cap.annexPrefix")}1. ${L("caps.step.final")}</b> — ${L("caps.step.final.d")}`)}
          ${steps.area ? fig(steps.area, `<b>${L("r.cap.annexPrefix")}2. ${L("caps.step.area")}</b> — ${L("caps.step.area.d")}`) : ""}
        </div>
        <div class="r-legend" style="margin-top:10px">
          ${L("r.legendTitle")}
          ${["small", "medium", "large", "hidden"].map((k) => `<span>${sw(k)}${L(`caps.${k}`)}</span>`).join("")}
        </div>
      </div>
      ${hasSteps ? "" : `<div class="r-end">${L("r.end")}</div><div class="r-credit">${L("r.software", { ver: APP_VERSION })}<br/>${credit}</div>`}
      ${foot(2)}
    </div>`;

  const cells = (d.steps || []).map((st, i) => `
    <figure style="margin:0;width:164px">
      <img src="${st.src}" alt="" style="width:164px;display:block;border:1px solid #d5dae1" />
      <figcaption style="font-size:9px;line-height:1.35;margin-top:3px;color:#2c3440"><b>${i + 1}. ${esc(L(`caps.step.${st.key}`))}</b><br/><span style="color:#5b6573">${esc(L(`caps.step.${st.key}.d`))}</span></figcaption>
    </figure>`).join("");
  const page3 = hasSteps ? `
    <div class="rpage" lang="${lng}">
      ${head}
      <div class="r-sec">
        <h4>${L("r.cap.annexB")}</h4>
        <div style="display:flex;flex-wrap:wrap;gap:12px 12px">${cells}</div>
      </div>
      <div class="r-end">${L("r.end")}</div>
      <div class="r-credit">${L("r.software", { ver: APP_VERSION })}<br/>${credit}</div>
      ${foot(3)}
    </div>` : "";
  return page1 + page2 + page3;
}

async function downloadCapsPdf(items) {
  if (!items.length) return;
  const lng = lang;
  const info = readForm($("#caps-info"), false);
  const issued = new Date();
  await makePdf({
    n: items.length,
    pages: (i) => capsReportPages(items[i], info, issued, lng),
    props: {
      title: items.length === 1 ? t("r.cap.pdfTitleOne", { no: items[0].reportNo }, lng) : t("r.cap.pdfTitleMany", {}, lng),
      subject: "Mushroom cap count",
    },
    fileName: items.length === 1
      ? `${items[0].reportNo}_${stem(items[0].file.name).replace(/[\\/:*?"<>|\s]+/g, "_")}_${lng.toUpperCase()}.pdf`
      : `Precision-QC_cap-counts_${isoDate(issued)}_${lng.toUpperCase()}.pdf`,
  });
}

pageTitleKey = "caps.pageTitle";
langHooks.push(() => {
  capsList.forEach(renderCapsCard);
  document.querySelectorAll("#caps-samples .chip").forEach((c) => (c.textContent = t("caps.sample", { n: c.dataset.n })));
});
initCapsUI();
initNumpad();
applyLang(lang);
boot({
  manifest: (m) => renderCapsSamples(m.caps_samples || []),
  ready: (py) => {
    capsDefaults = JSON.parse(py.default_caps_config_json());
    loadForm($("#caps-cfg"), CAPS_KEY, capsDefaults);
    $("#caps-file").disabled = false;
  },
});
