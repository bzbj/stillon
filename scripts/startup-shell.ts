import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { Plugin } from "vite"

const source = (name: string) => readFileSync(new URL(`../src/startup/${name}`, import.meta.url), "utf8")
const controller = source("controller.js")
const assetName = `assets/startup-${createHash("sha256").update(controller).digest("hex").slice(0, 12)}.js`

export const isStartupDocument = (filename: string, entry: string) => filename.replaceAll("\\", "/") === entry.replaceAll("\\", "/")

export function injectStartupShell(html: string, mode: "host" | "portal") {
  // Main styles must not make even the independent static shell wait for a WAN transfer.
  const document = html.replace(/<link\b(?=[^>]*\brel="stylesheet")[^>]*>/g,
    tag => tag.replace(/>$/, ' media="print" data-stillon-styles>'))
  const shell = source("shell.html").replace('id="stillon-startup"', `id="stillon-startup" data-mode="${mode}"`)
  return document.replace("</head>", `<style>${source("shell.css")}</style></head>`)
    .replace('<div id="root"></div>', `${shell}<div id="root" inert aria-hidden="true"></div><script src="/${assetName}"></script>`)
}

/** Identical critical markup in each document; never inject new code into legacy host HTML. */
export function startupShellPlugin(mode: "host" | "portal"): Plugin {
  let building = false
  let entry = ""
  return {
    name: "stillon-startup-shell",
    configResolved(config) { building = config.command === "build"; entry = path.resolve(config.root, "index.html") },
    buildStart() { if (building) this.emitFile({ type: "asset", fileName: assetName, source: controller }) },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== `/${assetName}`) return next()
        response.setHeader("Content-Type", "text/javascript; charset=utf-8")
        response.setHeader("Cache-Control", "no-store")
        response.end(controller)
      })
    },
    transformIndexHtml: { order: "post", handler(html, context) {
      // Vite also serves isolated test fixtures and other HTML documents.
      // They do not implement the application's readiness contract.
      if (!isStartupDocument(context.filename, entry)) return html
      if (mode === "host" && context.bundle) {
        const bundle = context.bundle
        const workspace = Object.values(bundle).find(item => item.type === "chunk"
          && (item.name === "workspace" || item.facadeModuleId?.replaceAll("\\", "/").endsWith("/src/client/app/AppRoot.tsx")))
        const files = new Set<string>()
        const styles = new Set<string>()
        function visit(file: string) {
          if (files.has(file)) return
          files.add(file)
          const chunk = bundle[file]
          if (chunk?.type === "chunk") {
            for (const dependency of chunk.imports) visit(dependency)
            const metadata = (chunk as typeof chunk & { viteMetadata?: { importedCss?: Set<string> } }).viteMetadata
            for (const css of metadata?.importedCss ?? []) styles.add(css)
          }
        }
        if (workspace) visit(workspace.fileName)
        // Fetch required workspace code alongside the lean auth entry, without
        // making it an entry dependency or adding a new discovery round trip.
        const preloads = [...files].filter(file => file !== context.chunk?.fileName && !html.includes(`href="/${file}"`))
          .map(file => `<link rel="modulepreload" crossorigin href="/${file}" fetchpriority="low">`).join("")
          + [...styles].filter(file => !html.includes(`href="/${file}"`))
            .map(file => `<link rel="preload" as="style" href="/${file}">`).join("")
        html = html.replace("</head>", `${preloads}</head>`)
      }
      return injectStartupShell(html, mode)
    } },
  }
}
