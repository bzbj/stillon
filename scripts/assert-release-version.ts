import pkg from "../package.json"

const tagName = process.argv[2]
const expectedTag = `v${pkg.version}`

if (!tagName) {
  console.error(`Expected a release tag argument matching ${expectedTag}.`)
  process.exit(1)
}

if (tagName !== expectedTag) {
  console.error(`Release tag ${tagName} does not match package.json version ${pkg.version}. Expected ${expectedTag}.`)
  process.exit(1)
}

console.log(`Verified release tag ${tagName} matches package.json version ${pkg.version}.`)
