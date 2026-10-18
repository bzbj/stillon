/** Shared by the loopback file origin and the authenticated Connect file origin. */
export function filePreviewCsp(parent: string) {
  const origin = new URL(parent).origin
  return `default-src 'none'; script-src 'self' 'unsafe-inline' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; manifest-src 'self'; connect-src 'self'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors ${origin}`
}
