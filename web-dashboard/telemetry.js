/* Precision QC — usage log (docs/LOGGING.md).
 * Records numbers and metadata about real use (never the image, its file name
 * or anything that identifies a person) so the criteria and the algorithm can
 * be improved later.
 *   Level A: the log lives in localStorage; the user can download it (.jsonl)
 *            or delete it from the footer. Nothing leaves the device.
 *   Level B: only if the host sets window.PQC_CONFIG.logEndpoint (config.js) AND
 *            the visitor agrees in the banner, new events are also sent in small
 *            batches to that endpoint (hosting/log-endpoint/log.php). The visitor
 *            can switch it off again from the footer at any time.
 * Also provides the "was this result right?" feedback bar.
 * Needs config.js + i18n.js + common.js; load before the page script (app.js / caps.js). */

const Telemetry = (() => {
  const LOG_KEY = "precision-qc-log";
  const MAX_EVENTS = 500; // oldest events are dropped beyond this
  const SCHEMA = 1;
  const session = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replace(/-/g, "").slice(0, 16);
  const sources = new WeakMap(); // File -> "upload" | "camera" | "sample"
  const CONSENT_KEY = "precision-qc-consent"; // "yes" | "no" | unset = not asked yet
  const SEND_EVERY_MS = 10000, BATCH = 50, MAX_QUEUE = 200;
  const endpoint = () => String((window.PQC_CONFIG && window.PQC_CONFIG.logEndpoint) || "");
  let consent = "";
  try { consent = localStorage.getItem(CONSENT_KEY) || ""; } catch (_) { /* storage unavailable */ }
  const sending = () => !!endpoint() && consent === "yes";
  let queue = []; // events waiting to be sent (level B)
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
      const rec = {
        v: SCHEMA, ts: new Date().toISOString(), session, event,
        app: { ui: document.querySelector(".sb-cap") ? "dashboard" : "pure", ver: APP_VERSION, lang, theme: theme() },
        mode: page(), ...data,
        env: { ua_family: uaFamily(), mobile: /Mobi|Android/i.test(navigator.userAgent), cores: navigator.hardwareConcurrency || null },
      };
      events.push(rec);
      if (sending()) queue = [...queue, rec].slice(-MAX_QUEUE);
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

  /* ---- level B: send new events to the host's endpoint (only with consent) ---- */
  function flush(leaving = false) {
    if (!sending() || !queue.length) return;
    const batch = queue.splice(0, BATCH);
    const body = JSON.stringify({ v: SCHEMA, events: batch });
    const retry = () => { queue = [...batch, ...queue].slice(-MAX_QUEUE); };
    try {
      if (leaving && navigator.sendBeacon) { // page is closing: the browser delivers this after unload
        if (!navigator.sendBeacon(endpoint(), new Blob([body], { type: "text/plain" }))) retry();
      } else {
        fetch(endpoint(), { method: "POST", body, keepalive: true, headers: { "Content-Type": "text/plain" } })
          .then((r) => { if (r.status >= 500 || r.status === 429) retry(); }) // other 4xx: the endpoint refused it, don't loop
          .catch(retry);
      }
    } catch (_) { retry(); }
  }
  setInterval(flush, SEND_EVERY_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(true); });
  window.addEventListener("pagehide", () => flush(true));

  function setConsent(yes) {
    consent = yes ? "yes" : "no";
    try { localStorage.setItem(CONSENT_KEY, consent); } catch (_) { /* ignore */ }
    if (!yes) queue = [];
    log("consent", { granted: yes }); // queued (and so sent) only when granted
    hideBanner();
    refreshFooter();
  }
  let banner = null;
  function hideBanner() { if (banner) { banner.remove(); banner = null; } }
  function showBanner() {
    if (!endpoint() || consent || banner) return;
    banner = document.createElement("div");
    banner.className = "tele-banner";
    banner.setAttribute("role", "region");
    banner.innerHTML = `<div class="tele-banner-text"><b></b><span></span></div>
      <div class="tele-banner-btns"><button type="button" class="tele-no"></button><button type="button" class="tele-yes"></button></div>`;
    $(".tele-no", banner).addEventListener("click", () => setConsent(false));
    $(".tele-yes", banner).addEventListener("click", () => setConsent(true));
    document.body.appendChild(banner);
    refreshBanner();
  }
  function refreshBanner() {
    if (!banner) return;
    banner.setAttribute("aria-label", t("consent.title"));
    $("b", banner).textContent = t("consent.title");
    $("span", banner).textContent = t("consent.text");
    $(".tele-no", banner).textContent = t("consent.no");
    $(".tele-yes", banner).textContent = t("consent.yes");
  }

  /* ---- footer: how many events are stored + download / delete (+ share switch) ---- */
  let line = null;
  function refreshFooter() {
    if (!line) return;
    $(".tele-n", line).textContent = t("log.count", { n: events.length }) + (sending() ? "" : " " + t("log.localOnly")); // reassure only while nothing is sent
    $(".tele-dl", line).textContent = t("log.download");
    $(".tele-clear", line).textContent = t("log.clear");
    $(".tele-dl", line).disabled = $(".tele-clear", line).disabled = events.length === 0;
    const share = $(".tele-share", line);
    share.hidden = !endpoint(); // level B is off unless the host configured an endpoint
    share.textContent = t(consent === "yes" ? "log.shareOn" : "log.shareOff");
    share.setAttribute("aria-pressed", String(consent === "yes"));
    refreshBanner();
  }
  function initFooter() {
    const anchor = document.querySelector('[data-i18n="footer.privacy"]'); // the "images stay on your device" line, in every edition
    if (!anchor || line) return;
    line = document.createElement(anchor.tagName);
    line.className = `${anchor.className} tele-line`.trim();
    line.innerHTML = `<span class="tele-n"></span> <button type="button" class="tele-dl"></button> <button type="button" class="tele-clear"></button> <button type="button" class="tele-share" hidden></button>`;
    $(".tele-share", line).addEventListener("click", () => setConsent(consent !== "yes"));
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
.tele-banner{position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-width:760px;margin:0 auto;display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;justify-content:space-between;padding:12px 16px;border-radius:14px;border:1px solid rgba(128,128,128,.45);background:Canvas;color:CanvasText;box-shadow:0 8px 28px rgba(0,0,0,.25);font-size:.9em}
.tele-banner-text{flex:1 1 320px;display:grid;gap:3px}
.tele-banner-text span{opacity:.85}
.tele-banner-btns{display:flex;gap:8px}
.tele-banner-btns button{font:inherit;padding:.45em 1.1em;border-radius:999px;border:1px solid rgba(128,128,128,.55);background:transparent;color:inherit;cursor:pointer}
.tele-banner-btns .tele-yes{background:#2563eb;border-color:#2563eb;color:#fff}
.tele-line button{font:inherit;color:inherit;background:none;border:0;padding:0;margin-left:.6em;text-decoration:underline;cursor:pointer}
.tele-line button:disabled{opacity:.4;cursor:default;text-decoration:none}
`;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  initFooter();
  showBanner();
  log("page_open", { referrer_same_site: !!document.referrer && new URL(document.referrer).origin === location.origin });

  return { log, tag, flush, sourceOf, imageInfo, params, dishResult, capsResult, watchParams, feedbackBar, get events() { return events.slice(); } };
})();
