import process from "node:process"

process.env.STILLON_RUNTIME_PROFILE = "dev"

await import("../src/server/cli")
