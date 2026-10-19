// This classic script has no imports and runs independently of the app entry.
// It is emitted with a content hash and is allowed by Connect's script-src 'self'.
(() => {
  const shell = document.getElementById("stillon-startup")
  const root = document.getElementById("root")
  if (!shell || !root) return
  const status = document.getElementById("stillon-startup-status")
  const detail = document.getElementById("stillon-startup-detail")
  const recovery = document.getElementById("stillon-startup-recovery")
  let generation = 0, done = false, failed = false, exitTimer, slowTimer
  const portal = shell.dataset.mode === "portal"
  if (portal) status.textContent = location.pathname === "/authorize" ? "Connecting to your computer…" : "Opening Still On…"
  // Upgrade the static dialog to native modal isolation before React/portals exist.
  shell.removeAttribute("open")
  if (typeof shell.showModal === "function") shell.showModal()
  else shell.setAttribute("open", "")
  shell.addEventListener("cancel", event => event.preventDefault())
  shell.addEventListener("close", () => { if (!done && !shell.open && shell.showModal) shell.showModal() })
  function fail() {
    if (done) return
    failed = true
    hold()
    status.textContent = "We couldn’t open Still On."
    detail.textContent = "Check your connection, then reload the page."
    recovery.open = true
    shell.setAttribute("aria-busy", "false")
  }
  function hold() {
    if (done) return
    generation++
    clearTimeout(exitTimer)
    shell.removeAttribute("data-leaving")
  }
  // Print-media styles download without holding up the critical HTML paint.
  // Activate them from this CSP-compatible script, never an inline onload handler.
  const stylesReady = Promise.all([...document.querySelectorAll("link[data-stillon-styles]")].map(link => new Promise(resolve => {
    const loaded = () => { link.media = "all"; resolve() }
    link.addEventListener("load", loaded, { once: true })
    link.addEventListener("error", () => { fail(); resolve() }, { once: true })
    if (link.sheet) loaded()
  })))
  function watch() {
    clearTimeout(slowTimer)
    slowTimer = setTimeout(() => {
      if (done || failed) return
      detail.textContent = "Taking a little longer. You can reload if the connection has stopped."
      recovery.open = true
    }, 8000)
  }
  watch()
  window.StillOnStartup = {
    version: 1,
    get active() { return !done },
    show() {
      if (!done) { hold(); return }
      done = false; failed = false
      hold()
      root.inert = true
      root.setAttribute("aria-hidden", "true")
      shell.hidden = false
      shell.setAttribute("aria-busy", "true")
      status.textContent = "Connecting to your computer…"
      detail.textContent = ""
      recovery.open = false
      if (shell.showModal) shell.showModal()
      else shell.setAttribute("open", "")
      watch()
    },
    hold,
    fail,
    reveal(valid = () => true) {
      const ticket = ++generation
      void stylesReady.then(() => requestAnimationFrame(() => {
        if (done || failed || ticket !== generation || !valid()) return
        shell.setAttribute("data-leaving", "")
        exitTimer = setTimeout(() => {
          if (done || failed || ticket !== generation || !valid()) return
          done = true
          clearTimeout(slowTimer)
          shell.hidden = true
          if (shell.open && shell.close) shell.close()
          root.inert = false
          root.removeAttribute("aria-hidden")
          shell.setAttribute("aria-busy", "false")
          performance.mark("stillon:startup:revealed")
          // A programmatic main-region focus must not open a mobile keyboard.
          if (document.activeElement === shell || shell.contains(document.activeElement)) {
            root.tabIndex = -1
            root.focus({ preventScroll: true })
          }
        }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180)
      }))
    },
  }
  window.addEventListener("error", event => {
    const target = event.target
    if (target instanceof HTMLScriptElement || (target instanceof HTMLLinkElement
      && ["stylesheet", "modulepreload"].includes(target.rel))) fail()
  }, true)
  window.addEventListener("vite:preloadError", fail)
})()
