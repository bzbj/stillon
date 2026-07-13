export const DEFAULT_DEV_CLIENT_PORT = 5174

export function getDefaultDevServerPort(clientPort = DEFAULT_DEV_CLIENT_PORT) {
  return clientPort + 1
}

export interface DevArgResolution {
  clientPort: number
  serverPort: number
  clientHost: string
  backendTargetHost: string
  allowedHosts: true | string[]
  serverArgs: string[]
}

function isRemovedTunnelOption(arg: string) {
  return arg === "--share"
    || arg.startsWith("--share=")
    || arg === "--cloudflared"
    || arg.startsWith("--cloudflared=")
}

function removedTunnelOptionError(arg: string): Error {
  const option = arg.startsWith("--cloudflared") ? "--cloudflared" : "--share"
  return new Error(
    `${option} is no longer built in. Use a separately managed reverse proxy or tunnel, or --host/--remote for direct listening.`
  )
}

function readOptionValue(args: string[], index: number, option: "--host" | "--port") {
  const arg = args[index]
  if (arg !== option && !arg.startsWith(`${option}=`)) return null

  const inlineValue = arg.startsWith(`${option}=`) ? arg.slice(option.length + 1) : null
  const value = inlineValue ?? args[index + 1]
  if (!value || (inlineValue === null && value.startsWith("-"))) {
    throw new Error(`Missing value for ${option}`)
  }

  return { value, consumedNextArg: inlineValue === null }
}

export function resolveDevPorts(args: string[]) {
  let clientPort = DEFAULT_DEV_CLIENT_PORT

  for (let index = 0; index < args.length; index += 1) {
    const portOption = readOptionValue(args, index, "--port")
    if (!portOption) continue

    clientPort = Number(portOption.value)
    if (portOption.consumedNextArg) index += 1
  }

  return {
    clientPort,
    serverPort: getDefaultDevServerPort(clientPort),
  }
}

export function stripPortArg(args: string[]) {
  const stripped: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const portOption = readOptionValue(args, index, "--port")
    if (portOption) {
      if (portOption.consumedNextArg) index += 1
      continue
    }

    stripped.push(args[index])
  }

  return stripped
}

export function parseDevArgs(args: string[], localHostname: string): DevArgResolution {
  const { clientPort, serverPort } = resolveDevPorts(args)
  const serverArgs = stripPortArg(args)
  let clientHost = "127.0.0.1"
  let backendTargetHost = "127.0.0.1"
  let allowAllHosts = false
  let trustProxy = false
  const hosts = new Set<string>(["localhost", "127.0.0.1", localHostname])

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (isRemovedTunnelOption(arg)) {
      throw removedTunnelOptionError(arg)
    }
    if (arg === "--remote") {
      clientHost = "0.0.0.0"
      backendTargetHost = "127.0.0.1"
      allowAllHosts = true
      continue
    }
    if (arg === "--trust-proxy") {
      trustProxy = true
      continue
    }
    const hostOption = readOptionValue(args, index, "--host")
    if (!hostOption) continue

    clientHost = hostOption.value
    hosts.add(hostOption.value)
    backendTargetHost = hostOption.value === "0.0.0.0" ? "127.0.0.1" : hostOption.value
    allowAllHosts = hostOption.value === "0.0.0.0"
    if (hostOption.consumedNextArg) index += 1
  }

  return {
    clientPort,
    serverPort,
    clientHost,
    backendTargetHost,
    allowedHosts: allowAllHosts || trustProxy ? true : [...hosts],
    serverArgs,
  }
}
