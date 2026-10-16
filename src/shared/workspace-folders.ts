/** Validate one folder name without converting names to an English slug. */
export function workspaceFolderNameError(name: string, separator: "/" | "\\") {
  if (!name.trim()) return "Enter a folder name."
  if (name === "." || name === ".." || /[\u0000-\u001f/]/u.test(name)) return "Enter a single folder name."
  if (separator === "\\" && (/[\\<>:"|?*]/u.test(name) || /[. ]$/u.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name))) {
    return "This folder name is not supported on Windows."
  }
  return null
}
