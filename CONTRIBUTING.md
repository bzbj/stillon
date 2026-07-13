# Contributing to StillOn

Thanks for helping improve StillOn.

## Development

Install Bun 1.3.5 or newer, then run:

~~~bash
bun install
bun run check
bun run test
bun run audit
~~~

Open a focused pull request with a clear description, user impact, and validation notes.
Release versions are chosen explicitly after merge; follow the [release guide](docs/releasing.md).

## Public-repository hygiene

- Never commit real usernames, home-directory paths, hostnames, tunnel URLs, tokens, credentials, or private project names.
- Use placeholders such as **/Users/example/Projects/sample-app**, **C:\\Users\\example\\Projects\\sample-app**, and **stillon.example.com**.
- Capture screenshots with a generic **STILLON_MACHINE_NAME**.
- Add platform-specific tests when changing paths, process launching, terminals, or desktop integrations.
- Preserve the upstream copyright and license notice.

Security reports belong in a [private GitHub security advisory](https://github.com/bzbj/stillon/security/advisories/new), not a public issue.
