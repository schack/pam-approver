// Applies the colour theme before first paint to avoid a flash of the wrong
// theme. Loaded synchronously in <head> (a separate file, not inline, because
// the strict CSP forbids inline scripts). Uses the stored choice if present,
// otherwise the OS preference. The header toggle in app.js keeps `pam.theme`
// and the `.dark` class in sync at runtime.
(() => {
  try {
    const stored = localStorage.getItem("pam.theme");
    const dark = stored
      ? stored === "dark"
      : window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.classList.toggle("dark", dark);
  } catch (_) {
    /* localStorage/matchMedia unavailable: fall back to light. */
  }
})();
