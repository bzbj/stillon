import { expect, test } from "bun:test"
import { connectorLaunchError } from "./launch-error"

test("Windows policy errors are distinct from generic permission failures", () => {
  for (const code of [1260, 4551, "ERROR_ACCESS_DISABLED_BY_POLICY", "ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION"]) {
    expect(connectorLaunchError({ code, message: "private path and credentials" }, "win32")).toBe("CONNECTOR_POLICY_BLOCKED")
  }
  expect(connectorLaunchError({ win32Error: 4551 }, "win32")).toBe("CONNECTOR_POLICY_BLOCKED")
  for (const code of ["EACCES", "EPERM"]) expect(connectorLaunchError({ code }, "win32")).toBe("CONNECTOR_ACCESS_DENIED")
  expect(connectorLaunchError({ code: "ENOENT" }, "win32")).toBe("CONNECTOR_NOT_INSTALLED")
})

test("unrecognized errors stay sanitized without guessing from text or exit status", () => {
  for (const error of [null, "private command", { message: "Smart App Control private path" }, { code: -1 }, { code: 1 }]) {
    expect(connectorLaunchError(error, "win32")).toBe("CONNECTOR_BLOCKED")
  }
  expect(connectorLaunchError({ errno: 4551 }, "linux")).toBe("CONNECTOR_BLOCKED")
})
