/* Precision QC — usage log, level A (kept on this device only).
 * Records numbers and metadata about real use (never the image, its file name
 * or anything that identifies a person) so the criteria and the algorithm can
 * be improved later. Nothing is sent anywhere: the log lives in localStorage and
 * the user can download it (.jsonl) or delete it from the footer. Also provides
 * the "was this result right?" feedback bar. Schema: docs/LOGGING.md.
 * Needs i18n.js + common.js; load before the page script (app.js / caps.js). */

const Telemetry = (() => {
  const LOG_KEY = "precision-qc-log";
  const MAX_EVENTS = 500; // oldest events are dropped beyond this
  const SCHEMA = 1;
  const session = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, "").slice(0, 16);
  const sources = new WeakMap(); // File -> "upload" | "camera" | "sample"
  let events = [];
  try { events = JSON.parse(localStorage.getItem(LOG_KEY) || "[]").filter((e) => e && e.event); } catch (_) { events = []; }

  const save = () => {
    try { localStorage.setItem(LOG_KEY, JSON.stringify(events)); } catch (_) { /* storage full or blocked: keep in memory */ }
  };
  const theme = () => document.documentElement.getAttribute("data-theme") || "auto";
  const uaFamily = () => {
    const u = navigator.userAgent;
    return /Edg\//.test(u) ? "Edge" : /OPR\//.test(u) ? "Opera" : /Chrome\//.test(u) ? "Chrome" : /Firefox\//.test(u) ? "Firefox" : /Safari\//.test(u) ? "Safari" : "other";
  };
  const page = () => (document.getElementById("caps-root") ? "caps" : "dish");

  /* Record one event. Never throws, never blocks the UI. */
  function log(event, data = {}) {
    try {
      events.push({
        v: SCHEMA, ts: new Date().toISOString(), session, event,
        app: { ui: document.querySelector(".sb-cap") ? "dashboard" : "pure", ver: APP_VERSION, lang, theme: theme() },
        mode: page(), ...data,
        env: { ua_family: uaFamily(), mobile: /Mobi|Android/i.test(navigator.userAgent), cores: navigator.hardwareConcurrency || null },
      });
      if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
      save();
      refreshFooter();
    } catch (err) { console.warn("telemetry", err); }
  }

  /* remember where a File came from (sample button, camera) — default "upload" */
  const tag = (file, source) => { if (file && typeof file === "object") sources.set(file, source); return file; };
  const sourceOf = (file) => sources.get(file) || "upload";
  const imageInfo = (file, size) => ({ w: size?.[0] ?? null, h: size?.[1] ?? null, bytes: file?.size ?? null });

  // keep only the settings that matter, as plain numbers
  const params = (cfg) => Object.fromEntries(Object.entries(cfg || {}).filter(([, v]) => typeof v === "number" || typeof v === "boolean"));

  /* ---- result summaries (numbers only) ---- */
  function dishResult(r) {
    return { verdict: r.result, score: r.score, grade: r.grade, reasons: (r.reasons || []).map((x) => x.code),
      growth: r.metrics?.growth, contamination: r.contamination?.contamination, agar: r.contamination?.agar };
  }
  function capsResult(d) {
    return { count: d.total, small: d.counts?.small, medium: d.counts?.medium, large: d.counts?.large, hidden: d.counts?.hidden,
      bunch_area_pct: d.bunch_area_pct, density: d.caps_per_1000px2 };
  }

  /* settings changes: one event per burst of typing */
  function watchParams(form, getParams) {
    let timer = 0, before = getParams();
    form.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const now = getParams(), changed = {};
        for (const k of Object.keys(now)) if (now[k] !== before[k]) changed[k] = { from: before[k] ?? null, to: now[k] };
        before = now;
        if (Object.keys(changed).length) log("param_change", { changed });
      }, 1200);
    });
  }

  /* ---- feedback bar ----
   * ctx = { kind: "dish"|"caps", verdict | count, state: {} } — `state` is kept by
   * the caller so the bar survives a re-render (language switch). */
  function feedbackBar(ctx) {
    const el = document.createElement("div");
    el.className = "fb-bar";
    const st = ctx.state;
    const done = () => { el.innerHTML = `<span class="fb-thanks">✓ ${esc(t("fb.thanks"))}</span>`; };
    const send = (value) => {
      Object.assign(st, { sent: true });
      log("feedback", { result: ctx.result, feedback: value });
      done();
    };
    if (st.sent) { done(); return el; }
    const btn = (cls, label, fn) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `fb-btn ${cls}`;
      b.textContent = label;
      b.addEventListener("click", fn);
      return b;
    };
    el.append(Object.assign(document.createElement("span"), { className: "fb-ask", textContent: t("fb.ask") }));
    el.append(btn("good", `👍 ${t("fb.good")}`, () => send({ correct: true })));
    if (ctx.kind === "dish") {
      const other = ctx.result.verdict === "PASS" ? "FAIL" : "PASS";
      el.append(btn("bad", `👎 ${t("fb.shouldBe", { v: other })}`, () => send({ correct: false, expected_verdict: other })));
    } else {
      el.append(btn("bad", `👎 ${t("fb.wrong")}`, () => {
        el.innerHTML = "";
        const input = Object.assign(document.createElement("input"), { type: "number", min: 0, step: 1, className: "fb-num", placeholder: t("fb.actual") });
        input.setAttribute("aria-label", t("fb.actual"));
        const go = btn("good", t("fb.send"), () => {
          const n = Number(input.value);
          send(input.value !== "" && Number.isFinite(n) && n >= 0 ? { correct: false, expected_count: Math.round(n) } : { correct: false });
        });
        el.append(input, go);
        input.focus();
      }));
    }
    return el;
  }

  /* ---- footer: how many events are stored + download / delete ---- */
  let line = null;
  function refreshFooter() {
    if (!line) return;
    $(".tele-n", line).textContent = t("log.count", { n: events.length });
    $(".tele-dl", line).textContent = t("log.download");
    $(".tele-clear", line).textContent = t("log.clear");
    $(".tele-dl", line).disabled = $(".tele-clear", line).disabled = events.length === 0;
  }
  function initFooter() {
    const anchor = document.querySelector('[data-i18n="footer.privacy"]'); // the "images stay on your device" line, in every edition
    if (!anchor || line) return;
    line = document.createElement(anchor.tagName);
    line.className = `${anchor.className} tele-line`.trim();
    line.innerHTML = `<span class="tele-n"></span> <button type="button" class="tele-dl"></button> <button type="button" class="tele-clear"></button>`;
    anchor.after(line);
    $(".tele-dl", line).addEventListener("click", () => {
      const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      download(`precision_qc_log_${isoDate(new Date())}.jsonl`, new Blob([body], { type: "application/x-ndjson" }));
      log("log_download", { n: events.length });
    });
    $(".tele-clear", line).addEventListener("click", () => {
      if (!confirm(t("log.confirmClear"))) return;
      events = [];
      save();
      refreshFooter();
    });
    langHooks.push(refreshFooter);
    refreshFooter();
  }

  const CSS = `
.fb-bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:12px 0 0;font-size:.9em}
.fb-ask{opacity:.8}
.fb-btn{font:inherit;padding:.35em .9em;border:1px solid rgba(128,128,128,.5);border-radius:999px;background:transparent;color:inherit;cursor:pointer}
.fb-btn:hover{background:rgba(128,128,128,.14)}
.fb-num{font:inherit;width:9em;padding:.3em .6em;border:1px solid rgba(128,128,128,.5);border-radius:8px;background:transparent;color:inherit}
.fb-thanks{opacity:.85}
.tele-line button{font:inherit;color:inherit;background:none;border:0;padding:0;margin-left:.6em;text-decoration:underline;cursor:pointer}
.tele-line button:disabled{opacity:.4;cursor:default;text-decoration:none}
`;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  initFooter();
  log("page_open", { referrer_same_site: !!document.referrer && new URL(document.referrer).origin === location.origin });

  return { log, tag, sourceOf, imageInfo, params, dishResult, capsResult, watchParams, feedbackBar, get events() { return events.slice(); } };
})();
