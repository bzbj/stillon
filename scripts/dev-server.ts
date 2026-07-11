import process from "node:process"

process.env.HUSKY_RUNTIME_PROFILE = "dev"
process.env.HUSKY_DISABLE_SELF_UPDATE = "1"

await import("../src/server/cli")
