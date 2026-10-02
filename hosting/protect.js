/* Precision QC — client-side deterrents for the hosted copy.
 *
 * This file is added to the build ONLY (see scripts/build_site.py). It is a
 * deterrent against casual copying of the deployed site, NOT real security:
 * anyone determined can still read the shipped files. The only strong
 * protection is keeping the source repository private (it is).
 *
 * The build replaces __ALLOWED_HOSTS__ with the hostnames the site is meant
 * to run on. On any other hostname the app refuses to start.
 */
(function () {
  "use strict";

  var ALLOWED = __ALLOWED_HOSTS__; // e.g. ["qc.example.ac.th","localhost","127.0.0.1"]
  var host = (location.hostname || "").toLowerCase();

  // file:// (opened straight off disk) has an empty hostname — block it too.
  var ok = ALLOWED.some(function (h) {
    return host === h || (h.charAt(0) === "." && host.endsWith(h));
  });

  if (!ok) {
    // Stop the engine from booting and replace the page with a notice.
    window.__QC_DENY__ = true;
    var msg =
      '<div style="font-family:system-ui,sans-serif;max-width:40rem;margin:18vh auto;padding:0 1.5rem;text-align:center;color:#1a2230">' +
      '<h1 style="font-size:1.4rem;margin:0 0 .6rem">โปรแกรมนี้ไม่ได้รับอนุญาตให้ใช้งานบนโดเมนนี้</h1>' +
      '<p style="line-height:1.6;color:#4a5568">This copy of Precision QC is licensed to run on an authorised domain only.<br>' +
      'หากคุณคิดว่าเป็นข้อผิดพลาด โปรดติดต่อผู้พัฒนา</p></div>';
    var paint = function () { document.body.innerHTML = msg; };
    if (document.body) paint();
    else document.addEventListener("DOMContentLoaded", paint);
    return;
  }

  // --- light deterrents against casual "inspect / view source / save" -------
  // These only slow down a non-technical user; power users can bypass them.
  var block = function (e) { e.preventDefault(); };
  document.addEventListener("contextmenu", block);
  document.addEventListener("dragstart", block);
  document.addEventListener("keydown", function (e) {
    var k = (e.key || "").toLowerCase();
    if (
      e.key === "F12" ||
      (e.ctrlKey && e.shiftKey && (k === "i" || k === "j" || k === "c")) || // DevTools
      (e.ctrlKey && (k === "u" || k === "s")) // view-source / save page
    ) {
      e.preventDefault();
      e.stopPropagation();
    }
  });
})();
