/* Precision QC - cap counter page (caps.html).
 * A bunch of mushrooms (ช่อดอก) photographed from above: Python
 * (precision_qc.caps) finds every cap and sorts it small / medium / large.
 * Own page, own results and CSV. Needs i18n.js + common.js. */

const CAPS_CSS = `
#sec-caps .caps-bar{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:12px 0}
#sec-caps .caps-bar .muted{margin:0}
#sec-caps .opt{height:auto}
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
    </div>
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
