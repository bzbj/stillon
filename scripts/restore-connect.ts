import path from "node:path"
import { restoreConnectBackup } from "../src/connect/restore"
const [source, destination] = process.argv.slice(2)
if (!source || !destination) throw new Error("Usage: bun scripts/restore-connect.ts <checkpointed-backup> <new-data-directory>")
await restoreConnectBackup(path.resolve(source), path.resolve(destination))
console.log("Restored into a new directory. All old sessions and device identities are retired; bind computers again before enabling remote access.")
