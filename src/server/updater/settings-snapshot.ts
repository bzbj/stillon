import { readFile } from "node:fs/promises"
import path from "node:path"
import { readAppSettingsSnapshot } from "../app-settings"
import type { UpdateDeployment } from "./model"

/** Read-only disk evidence, available while the application verification gate is closed. */
export async function readUpdateSettingsSnapshot(deployment: Pick<UpdateDeployment, "dataRoot">) {
  const file = path.join(deployment.dataRoot, "data", "settings.json")
  let present = true
  try {
    const text = await readFile(file, "utf8")
    // The application's tolerant reader supplies defaults for corrupt files. An
    // upgrade verifier must report unavailable evidence instead of comparing them.
    JSON.parse(text)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") present = false
    else throw new Error("Settings snapshot unavailable: the settings file could not be read or parsed.", { cause: error })
  }
  try {
    const settings = await readAppSettingsSnapshot(file)
    if (settings.warning) throw new Error("The settings reader reported a warning.")
    return { present, settings }
  } catch (error) {
    throw new Error("Settings snapshot unavailable: the settings reader could not provide evidence.", { cause: error })
  }
}
