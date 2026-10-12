/* Precision QC — Dashboard edition UI: the side menu (icon rail that expands on
 * hover, drawer on phones), display-settings panel (text size), and the
 * About / credits dialog with its technology + licence list.
 * Interface guideline: Certify Hub admin (side menu, settings panel, About dialog).
 * Language and theme switching stay in app.js; this file only adds what the
 * Dashboard header needs and re-applies translated attributes after a language
 * change. Loaded after app.js (it uses the global t() from there). */
(function () {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ----------------------------------------------------------- text size */
  const SIZE_KEY = "precision-qc-size";
  const SIZES = { sm: "87.5%", md: "100%", lg: "112.5%" };
  function currentSize() {
    try { const v = localStorage.getItem(SIZE_KEY); return v === "sm" || v === "lg" ? v : "md"; } catch (_) { return "md"; }
  }
  function setSize(size) {
    document.documentElement.style.fontSize = SIZES[size];
    try { if (size === "md") localStorage.removeItem(SIZE_KEY); else localStorage.setItem(SIZE_KEY, size); } catch (_) { /* storage unavailable */ }
    $$(".size-switch button").forEach((b) => {
      const on = b.dataset.size === size;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", String(on));
    });
  }
  $$(".size-switch button").forEach((b) => b.addEventListener("click", () => setSize(b.dataset.size)));
  setSize(currentSize());

  /* ------------------------------------------------------ settings panel */
  const toggle = $("#settingsToggle"), panel = $("#settingsPanel");
  function closePanel() {
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  }
  if (toggle && panel) {
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      panel.hidden = !panel.hidden;
      toggle.setAttribute("aria-expanded", String(!panel.hidden));
    });
    panel.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", closePanel);
  }

  /* ---------------------------------------------------------- step strip
   * 1 upload -> 2 review -> 3 report: the badge follows the work. With no results the
   * first step is active; once something has been analysed step 1 is done and step 2
   * (review the results) is the active one. */
  const steps = $$(".stepper li");
  const totalEl = $("#stat-total");
  function syncSteps() {
    const has = Number(totalEl?.textContent || 0) > 0;
    const state = has ? ["done", "active", "todo"] : ["active", "todo", "todo"];
    steps.forEach((li, i) => {
      li.dataset.state = state[i];
      $(".n", li).textContent = state[i] === "done" ? "✓" : String(i + 1);
      if (state[i] === "active") li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
    });
  }
  if (totalEl && steps.length) {
    new MutationObserver(syncSteps).observe(totalEl, { childList: true, characterData: true, subtree: true });
    syncSteps();
  }

  /* ------------------------------------------------------------ side menu */
  const root = document.documentElement, sb = $("#sidebar");
  const MIN_KEY = "precision-qc-sbmin";
  const sbToggle = $("#sbToggle"), fab = $("#sbFab"), backdrop = $("#sbBackdrop");
  function syncSb() {
    if (!sbToggle) return;
    const min = root.classList.contains("sb-min");
    sbToggle.setAttribute("aria-expanded", String(!min));
    const label = t(min ? "ui.expand" : "ui.collapse");
    $("#sbToggleText").textContent = label;
    sbToggle.title = label;
  }
  function drawer(on) {
    sb.classList.toggle("open", on);
    backdrop.hidden = !on;
    fab.setAttribute("aria-expanded", String(on));
  }
  if (sb) {
    sbToggle.addEventListener("click", () => {
      root.classList.toggle("sb-min");
      try { localStorage.setItem(MIN_KEY, root.classList.contains("sb-min") ? "1" : "0"); } catch (_) { /* ignore */ }
      syncSb();
    });
    fab.addEventListener("click", () => drawer(!sb.classList.contains("open")));
    backdrop.addEventListener("click", () => drawer(false));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") drawer(false); });
  }

  // highlight the section being read (scroll-spy) and close the drawer after a jump
  const links = $$("[data-spy]");
  function setActive(id) {
    links.forEach((a) => {
      const on = a.dataset.spy === id;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "true"); else a.removeAttribute("aria-current");
    });
  }
  let ticking = false, lockUntil = 0;
  function spy() {
    ticking = false;
    if (Date.now() < lockUntil) return; // a menu click chose the section; don't override while it scrolls
    let current = links[0]?.dataset.spy;
    for (const a of links) {
      const el = document.getElementById(a.dataset.spy);
      if (el && el.getBoundingClientRect().top <= window.innerHeight * 0.3) current = a.dataset.spy;
    }
    setActive(current);
  }
  window.addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(spy); } }, { passive: true });
  links.forEach((a) => a.addEventListener("click", () => { setActive(a.dataset.spy); lockUntil = Date.now() + 1200; drawer(false); }));
  spy();

  /* --------------------------------------------------------- About dialog */
  const about = $("#aboutModal");
  function openAbout() {
    closePanel();
    if (sb) drawer(false);
    about.hidden = false;
    document.body.classList.add("modal-open");
    $("#aboutClose").focus();
  }
  function closeAbout() {
    if (about.hidden) return;
    about.hidden = true;
    const rm = document.getElementById("result-modal");
    if (!rm || rm.hidden) document.body.classList.remove("modal-open"); // keep the lock while a result is open
  }
  if (about) {
    $("#aboutBtn").addEventListener("click", openAbout);
    $("#aboutFoot")?.addEventListener("click", openAbout);
    $("#aboutClose").addEventListener("click", closeAbout);
    about.addEventListener("click", (e) => { if (e.target === about) closeAbout(); });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closePanel();
    if (about) closeAbout();
  });

  /* ------------------------------------------- technologies + their licences
   * [name, link, licence (text or i18n key), i18n key of what it is used for]
   * Keep in sync with THIRD-PARTY-NOTICES.md. Keys starting "credit." are translated. */
  const CREDITS = [
    ["Certify Hub", "https://github.com/kittiphunr/certify-hub", "credit.same", "credit.certify"],
    ["Pyodide 0.27.7", "https://pyodide.org", "MPL-2.0", "credit.pyodide"],
    ["NumPy", "https://numpy.org", "BSD-3-Clause", "credit.numpy"],
    ["Pillow", "https://python-pillow.org", "MIT-CMU (HPND)", "credit.pillow"],
    ["Python", "https://www.python.org", "PSF-2.0", "credit.python"],
    ["html2canvas 1.4.1", "https://github.com/niklasvh/html2canvas", "MIT", "credit.html2canvas"],
    ["jsPDF 2.5.1", "https://github.com/parallax/jsPDF", "MIT", "credit.jspdf"],
    ["Tailwind CSS 3.4.17", "https://tailwindcss.com", "MIT", "credit.tailwind"],
    ["terser 5.36.0", "https://github.com/terser/terser", "BSD-2-Clause", "credit.terser"],
    ["Sarabun", "https://github.com/cadsondemak/Sarabun", "SIL OFL 1.1", "credit.sarabun"],
    ["IBM Plex Sans Thai", "https://github.com/IBM/plex", "SIL OFL 1.1", "credit.plex"],
    ["Noto Sans SC", "https://github.com/notofonts/noto-cjk", "SIL OFL 1.1", "credit.noto"],
    ["Google Fonts", "https://fonts.google.com", "credit.perFont", "credit.gfonts"],
  ];
  const list = $("#creditList");
  if (list) {
    const lic = (l) => (l.startsWith("credit.") ? `<span data-i18n="${l}"></span>` : esc(l));
    list.innerHTML = CREDITS.map(([name, url, license, use]) =>
      `<li><a href="${esc(url)}" target="_blank" rel="noopener">${esc(name)}</a> (${lic(license)}) — <span data-i18n="${use}"></span></li>`).join("");
    $$("[data-i18n]", list).forEach((el) => (el.textContent = t(el.dataset.i18n)));
  }

  /* --------------------------------------- translated labels / build number */
  let build = "";
  function refresh() {
    $$("[data-i18n-aria]").forEach((el) => el.setAttribute("aria-label", t(el.dataset.i18nAria)));
    $$("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle)));
    syncSb();
    const b = $("#aboutBuild");
    if (b) b.textContent = build ? `Precision QC · ${t("about.build")} ${build}` : "";
  }
  // app.js re-translates [data-i18n] on a language click; follow it for attributes
  $$(".lang-switch button").forEach((b) => b.addEventListener("click", () => setTimeout(refresh, 0)));
  refresh();
  fetch("manifest.json", { cache: "no-store" })
    .then((r) => r.json())
    .then((m) => { build = String(m.build || ""); refresh(); })
    .catch(() => { /* build number is optional */ });
})();
