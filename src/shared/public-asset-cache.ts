export const PUBLIC_BUILD_ASSET_HEADER = "X-StillOn-Public-Build-Asset"
export const PRIVATE_BUILD_ASSET_CACHE = "private, max-age=31536000, immutable"
export function isGeneratedBuildAssetPath(pathname: string) {
  return /^\/?assets\/[^/]+-[a-f0-9]{12}\.[^/]+$/u.test(pathname)
}
/** A proof is emitted only after host-side build-manifest/content verification. */
export function canCacheBuildAsset(request: Request, status: number, headers: Headers, applicationCookies: boolean) {
  return !applicationCookies && ["GET", "HEAD"].includes(request.method) && [200, 304].includes(status)
    && isGeneratedBuildAssetPath(new URL(request.url).pathname)
    && /^[a-f0-9]{64}:[a-f0-9]{64}$/u.test(headers.get(PUBLIC_BUILD_ASSET_HEADER) ?? "")
    && !headers.has("set-cookie") && !headers.has("set-cookie2")
    && /^(?:public|private), max-age=31536000, immutable$/u.test(headers.get("cache-control") ?? "")
}
