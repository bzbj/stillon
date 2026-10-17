# StillOn repository instructions

Read [CONTRIBUTING.md](CONTRIBUTING.md) before making changes and follow
[the release guide](docs/releasing.md) for explicitly requested releases.

## Public collaboration language

- Write every pull request title and description in English.
- Write every GitHub Release title and its release notes in English.
- Preserve identifiers, commands and quoted source text when needed for accuracy.
- These rules apply to human-authored and agent-generated PRs and releases.
- Merging a PR does not authorize creating a release or upgrading a running instance.

## Local and Connect feature acceptance

- Every feature must work through both the local loopback entry and the
  authenticated managed Connect workspace. A feature or fix is complete only
  after both entry paths have been checked.
- For persisted changes, verify saving through each entry, reading the result
  through the other entry, reloading, and failure handling without losing data.
- Remote integration checks must exercise the login gateway, tunnel, adapter
  and StillOn server. Keep origin checks, session authorization and account/host
  isolation intact. Track missing remote capabilities as product gaps.
