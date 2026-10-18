// All in-process StillOn servers and adapters, including temporary listeners.
// The installed application's default listener is reserved as well.
const ports = new Map<number, number>([[3210, 1]])
export const protectedPreviewPorts = () => ports.keys()
export function protectPreviewPort(port: number) { ports.set(port, (ports.get(port) ?? 0) + 1) }
export function releasePreviewPort(port: number) {
  const count = ports.get(port) ?? 0
  if (count > 1) ports.set(port, count - 1)
  else if (port !== 3210) ports.delete(port)
}
