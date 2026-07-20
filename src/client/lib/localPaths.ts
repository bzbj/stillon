import type { ResolvedLocalPath } from "../../shared/protocol"

export function getLocalPathPrefix(location: ResolvedLocalPath) {
  return location.path.endsWith(location.separator)
    ? location.path
    : `${location.path}${location.separator}`
}

export function appendLocalPathSegment(location: ResolvedLocalPath, segment: string) {
  return `${getLocalPathPrefix(location)}${segment}`
}
