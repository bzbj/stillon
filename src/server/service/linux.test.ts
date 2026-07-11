import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  linuxServiceBackend,
  renderSystemdUnit,
  SYSTEMD_UNIT_NAME,
  systemdUnitPath,
} from "./linux"
import type {
  ServiceBackendContext,
  ServiceCommandResult,
  ServiceLaunchSpec,
} from "./types"

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  )
})

async function temporaryHome() {
  const directory = await mkdtemp(join(tmpdir(), "stillon-linux-service-"))
  temporaryDirectories.push(directory)
  return directory
}

function launchSpec(homeDirectory: string): ServiceLaunchSpec {
  return {
    executable: "/home/test user/.bun/bin/stillon",
    args: ["--no-open", "--port", "3210", "--strict-port"],
    workingDirectory: "/home/test user/project",
    homeDirectory,
    pathEnvironment: "/home/test user/.bun/bin:/usr/local/bin:/usr/bin:/bin",
  }
}

function result(overrides: Partial<ServiceCommandResult> = {}): ServiceCommandResult {
  return {
    code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    ...overrides,
  }
}

function context(
  launch: ServiceLaunchSpec,
  responses: ServiceCommandResult[] = [],
) {
  const calls: Array<{ command: string; args: string[] }> = []
  const messages: string[] = []
  const warnings: string[] = []

  const value: ServiceBackendContext = {
    launch,
    run: async (command, args) => {
      calls.push({ command, args })
      return responses.shift() ?? result()
    },
    log: (message) => messages.push(message),
    warn: (message) => warnings.push(message),
  }

  return { calls, context: value, messages, warnings }
}

describe("renderSystemdUnit", () => {
  test("renders a deterministic user service with bounded restart behavior", () => {
    expect(renderSystemdUnit(launchSpec("/home/test user"))).toBe(`[Unit]
Description=StillOn background service
StartLimitIntervalSec=60s
StartLimitBurst=5

[Service]
Type=simple
WorkingDirectory="/home/test user/project"
Environment="HOME=/home/test user"
Environment="PATH=/home/test user/.bun/bin:/usr/local/bin:/usr/bin:/bin"
ExecStart="/home/test user/.bun/bin/stillon" "--no-open" "--port" "3210" "--strict-port"
Restart=always
RestartSec=5s

[Install]
WantedBy=default.target
`)
  })

  test("quotes executable arguments and environment values for systemd", () => {
    const unit = renderSystemdUnit({
      executable: '/home/a name/still"on$%',
      args: ["", ";", "line 1\nline 2", 'quote" slash\\ $HOME %n'],
      workingDirectory: '/home/work "area"/100%\\done',
      homeDirectory: "/home/$cash/100%",
      pathEnvironment: "/opt/$tools/%p:/usr/bin",
    })

    expect(unit).toContain('WorkingDirectory="/home/work \\"area\\"/100%%\\\\done"')
    expect(unit).toContain('Environment="HOME=/home/$cash/100%%"')
    expect(unit).toContain('Environment="PATH=/opt/$tools/%%p:/usr/bin"')
    expect(unit).toContain(
      'ExecStart="/home/a name/still\\"on$$%%" "" \\; "line 1\\nline 2" "quote\\" slash\\\\ $$HOME %%n"',
    )
  })

  test("rejects NUL bytes instead of emitting an invalid unit", () => {
    const launch = launchSpec("/home/test")
    expect(() => renderSystemdUnit({ ...launch, args: ["bad\0argument"] })).toThrow(
      "systemd unit values cannot contain NUL characters",
    )
  })
})

describe("linuxServiceBackend", () => {
  test("installs and starts a systemd user service without invoking a shell", async () => {
    const home = await temporaryHome()
    const state = context(launchSpec(home))

    await linuxServiceBackend.install(state.context)

    expect(state.calls).toEqual([
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      {
        command: "systemctl",
        args: ["--user", "enable", "--now", SYSTEMD_UNIT_NAME],
      },
    ])
    expect(await readFile(systemdUnitPath(home), "utf8")).toBe(
      renderSystemdUnit(launchSpec(home)),
    )
    expect(state.messages.some((message) => message.includes("loginctl enable-linger"))).toBe(true)
  })

  test("fails installation when a mutating systemctl command fails", async () => {
    const home = await temporaryHome()
    const state = context(launchSpec(home), [result({ code: 1, stderr: "manager unavailable" })])

    await expect(linuxServiceBackend.install(state.context)).rejects.toThrow(
      "systemctl --user daemon-reload failed (exit code 1): manager unavailable",
    )
    expect(state.calls).toHaveLength(1)
  })

  test("prints inactive status without treating it as an operation failure", async () => {
    const home = await temporaryHome()
    const state = context(launchSpec(home), [
      result({ code: 3, stdout: "○ stillon.service - StillOn\n   Active: inactive (dead)\n" }),
    ])

    await linuxServiceBackend.status(state.context)

    expect(state.calls).toEqual([
      {
        command: "systemctl",
        args: ["--user", "status", SYSTEMD_UNIT_NAME, "--no-pager", "--full"],
      },
    ])
    expect(state.messages).toEqual(["○ stillon.service - StillOn\n   Active: inactive (dead)"])
    expect(state.warnings).toEqual([])
  })

  test("prints recent journal entries without following indefinitely", async () => {
    const home = await temporaryHome()
    const state = context(launchSpec(home), [
      result({ stdout: "Jul 11 10:00:00 host stillon[123]: Listening on 127.0.0.1:3210\n" }),
    ])

    await linuxServiceBackend.logs(state.context)

    expect(state.calls).toEqual([
      {
        command: "journalctl",
        args: ["--user", "--unit", SYSTEMD_UNIT_NAME, "--lines", "200", "--no-pager"],
      },
    ])
    expect(state.messages).toEqual([
      "Jul 11 10:00:00 host stillon[123]: Listening on 127.0.0.1:3210",
    ])
  })

  test("uninstalls a present unit and reloads the user manager", async () => {
    const home = await temporaryHome()
    const unitPath = systemdUnitPath(home)
    await mkdir(dirname(unitPath), { recursive: true })
    await writeFile(unitPath, "old unit")
    const state = context(launchSpec(home))

    await linuxServiceBackend.uninstall(state.context)

    expect(state.calls).toEqual([
      {
        command: "systemctl",
        args: ["--user", "disable", "--now", SYSTEMD_UNIT_NAME],
      },
      { command: "systemctl", args: ["--user", "daemon-reload"] },
    ])
    await expect(readFile(unitPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    expect(state.messages).toEqual([`Uninstalled StillOn user service from ${unitPath}`])
  })

  test("keeps uninstall idempotent when the unit is already absent", async () => {
    const home = await temporaryHome()
    const state = context(launchSpec(home), [
      result({ code: 1, stderr: `Failed to disable unit: Unit ${SYSTEMD_UNIT_NAME} does not exist.` }),
      result(),
    ])

    await linuxServiceBackend.uninstall(state.context)

    expect(state.calls).toEqual([
      {
        command: "systemctl",
        args: ["--user", "disable", "--now", SYSTEMD_UNIT_NAME],
      },
      { command: "systemctl", args: ["--user", "daemon-reload"] },
    ])
    expect(state.messages).toEqual(["StillOn user service is already uninstalled"])
  })

  test("does not remove a present unit after an unexpected disable failure", async () => {
    const home = await temporaryHome()
    const unitPath = systemdUnitPath(home)
    await mkdir(dirname(unitPath), { recursive: true })
    await writeFile(unitPath, "keep me")
    const state = context(launchSpec(home), [
      result({ code: 1, stderr: "Failed to connect to bus: Permission denied" }),
    ])

    await expect(linuxServiceBackend.uninstall(state.context)).rejects.toThrow(
      "systemctl --user disable --now stillon.service failed (exit code 1)",
    )
    expect(await readFile(unitPath, "utf8")).toBe("keep me")
  })
})
