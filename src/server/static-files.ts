import path from "node:path"
import { APP_NAME } from "../shared/branding"

export const SERVICE_WORKER_PATH = "/service-worker.js"

function isReservedStaticPath(pathname: string) {
  return pathname === SERVICE_WORKER_PATH
    || pathname === "/assets"
    || pathname.startsWith("/assets/")
}

export function getStaticHeaders(requestedPath: string): HeadersInit | undefined {
  if (requestedPath === SERVICE_WORKER_PATH) {
    return {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-store, must-revalidate, no-transform",
      "Service-Worker-Allowed": "/",
      "X-Content-Type-Options": "nosniff",
    }
  }

  if (requestedPath.endsWith(".html")) {
    return {
      "Cache-Control": "no-store, no-transform",
    }
  }

  return {
    "Cache-Control": "no-transform",
  }
}

export async function serveStatic(distDir: string, pathname: string) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname
  const filePath = path.join(distDir, requestedPath)
  const indexPath = path.join(distDir, "index.html")

  const file = Bun.file(filePath)
  if (await file.exists()) {
    return new Response(file, {
      headers: getStaticHeaders(requestedPath),
    })
  }

  if (isReservedStaticPath(pathname)) {
    return new Response("Static asset not found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Content-Type-Options": "nosniff",
      },
    })
  }

  const indexFile = Bun.file(indexPath)
  if (await indexFile.exists()) {
    return new Response(indexFile, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
      },
    })
  }

  return new Response(
    `${APP_NAME} client bundle not found. Run \`bun run build\` inside workbench/ first.`,
    { status: 503 },
  )
}
