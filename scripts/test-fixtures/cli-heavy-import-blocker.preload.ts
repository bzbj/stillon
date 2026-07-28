import { plugin } from "bun"

const serviceEntryModule = /[\\/]src[\\/]server[\\/]service[\\/]index\.ts$/
const blockedModule = /(?:[\\/]src[\\/]server[\\/](?:server|agent|discovery)\.ts$|[\\/]src[\\/]server[\\/]service[\\/](?:index|linux|macos|windows)\.ts$|[\\/]node_modules[\\/](?:@anthropic-ai[\\/](?:claude-agent-sdk|sdk)|openai)(?:[\\/]|$))/
const serviceStubMode = process.env.STILLON_TEST_CLI_SERVICE_STUB

plugin({
  name: "block-heavy-cli-imports",
  setup(builder) {
    builder.onLoad({ filter: blockedModule, namespace: "file" }, ({ path }) => {
      if (serviceStubMode && serviceEntryModule.test(path)) {
        return {
          contents: `
            export async function manageService(_action, options) {
              if (${JSON.stringify(serviceStubMode)} === "failure") {
                throw new Error("STILLON_TEST_SERVICE_FAILURE")
              }
              options.log("STILLON_TEST_SERVICE_CALLED")
            }
          `,
          loader: "ts",
        }
      }
      return {
        contents: `
          throw new Error("STILLON_TEST_BLOCKED_HEAVY_CLI_IMPORT")
          export const startStillOnServer = undefined
          export const manageService = undefined
        `,
        loader: "ts",
      }
    })
  },
})
