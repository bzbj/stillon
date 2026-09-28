import { buildLocalFileContentUrl, isLocalImagePath } from "../../shared/local-file-urls"
import { buildProjectFileContentUrl } from "../../shared/project-file-urls"
import {
  appendLocalFileLinkLocation,
  getProjectRelativeFilePath,
  parseLocalFileLink,
  parseProjectRelativeFileLink,
} from "./pathUtils"

export function resolveMarkdownImageSrc(
  src: string | undefined,
  projectId?: string | null,
  localPath?: string | null,
) {
  // Already served resources and protocol-relative web URLs are not host files.
  if (!src || /^(?:\/\/|\/(?:api|assets|editor-icons)\/)/i.test(src)) return src
  const target = parseLocalFileLink(src) ?? parseProjectRelativeFileLink(src, localPath)
  if (!target || !isLocalImagePath(target.path)) return src

  const projectPath = getProjectRelativeFilePath(target.path, localPath)
  // Keep bundled root-level icons/screenshots working as ordinary web resources.
  if (!projectPath && /^\/[^/]+$/.test(target.path)) return src
  const contentUrl = projectId && projectPath
    ? buildProjectFileContentUrl(projectId, projectPath)
    : buildLocalFileContentUrl(target.path)
  return appendLocalFileLinkLocation(contentUrl, target)
}
