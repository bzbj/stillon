/** Classify only launch errors, never cloud failures or arbitrary process output.
 * Return fixed codes: OS errors can contain command lines, paths and secrets. */
export function connectorLaunchError(error: unknown, platform: string = process.platform) {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {}
  const codes = [value.code, value.errno, value.win32Error]
  if (platform === "win32" && codes.some(code =>
    code === 1260 || code === 4551 || code === "ERROR_ACCESS_DISABLED_BY_POLICY" || code === "ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION")) {
    return "CONNECTOR_POLICY_BLOCKED"
  }
  if (codes.includes("ENOENT")) return "CONNECTOR_NOT_INSTALLED"
  // EACCES/EPERM alone do not establish that Smart App Control caused the denial.
  if (codes.some(code => code === "EACCES" || code === "EPERM")) return "CONNECTOR_ACCESS_DENIED"
  return "CONNECTOR_BLOCKED"
}
