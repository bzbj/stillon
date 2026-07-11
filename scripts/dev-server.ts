import process from "node:process"

process.env.STILLON_RUNTIME_PROFILE = "dev"
process.env.STILLON_DISABLE_SELF_UPDATE = "1"

await import("../src/server/cli")
