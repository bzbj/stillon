#!/usr/bin/env bash
set -euo pipefail
: "${MACOS_CERTIFICATE_BASE64:?Configure the Apple Developer ID certificate secret}"
: "${MACOS_CERTIFICATE_PASSWORD:?Configure the certificate password secret}"
: "${MACOS_SIGN_IDENTITY:?Configure the signing identity secret}"
: "${APPLE_ID:?Configure the notarization Apple ID secret}"
: "${APPLE_TEAM_ID:?Configure the notarization team secret}"
: "${APPLE_APP_PASSWORD:?Configure the notarization app password secret}"
stillon_keychain="$RUNNER_TEMP/stillon-signing.keychain-db"
stillon_certificate="$RUNNER_TEMP/stillon-certificate.p12"
stillon_password="$(openssl rand -hex 32)"
trap 'rm -f "$stillon_certificate"' EXIT
printf '%s' "$MACOS_CERTIFICATE_BASE64" | /usr/bin/base64 --decode > "$stillon_certificate"
security create-keychain -p "$stillon_password" "$stillon_keychain"
security set-keychain-settings -lut 21600 "$stillon_keychain"
security unlock-keychain -p "$stillon_password" "$stillon_keychain"
security import "$stillon_certificate" -P "$MACOS_CERTIFICATE_PASSWORD" -k "$stillon_keychain" -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$stillon_password" "$stillon_keychain" >/dev/null
security list-keychains -d user -s "$stillon_keychain"
xcrun notarytool store-credentials stillon-ci --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --keychain "$stillon_keychain"
printf 'MACOS_NOTARY_KEYCHAIN=%s\n' "$stillon_keychain" >> "$GITHUB_ENV"
