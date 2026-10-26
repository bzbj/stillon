const fs = require("node:fs")
process.stdout.write("x".repeat(2 * 1024 * 1024))
setTimeout(() => fs.writeFileSync(process.argv[2], "complete"), 100)
