# Public application and hosted service

This repository contains the local StillOn application, browser workspace,
agent integrations, device connector/adapter, wire contracts and reusable
utilities. The officially hosted Connect account service, login portal and
cloud gateway are maintained in a separate private repository.

## Public development

No private repository or hosted-service credentials are needed to install,
build, test or package StillOn:

```sh
bun install --frozen-lockfile
bun run check
bun run test
bun run audit
bun scripts/test-provider-cli-updates.ts
bun run test:previews:browser --local-only
```

The last command needs the documented browser prerequisites. Self-managed
remote ingress remains supported through [external ingress](external-ingress.md).
Managed Connect remains available in the client; moving its server source does
not change device identity, saved bindings, protocol version or public service
configuration. The desktop payload does not include the cloud server source.

## Shared code and compatibility

The hosted repository pins a public StillOn commit as a Git submodule. It imports
`src/shared/connect.ts`, `src/shared/connect-preview.ts`, host crypto/relay and
preview helpers, and selected public UI/build utilities from that revision.
There is one source of truth; maintainers update the pin explicitly after
reviewing and testing a public change.

Keep Connect protocol and authorization behavior compatible with installed
clients. Server and client deployments do not happen together. A protocol
change needs paired public/private changes, a recorded compatibility policy
and a compatible server rollout before new client behavior is required.

Public checks cover the local app, connector, adapter and shared contracts.
Maintainers also run the private integration suite with two real local clients,
synthetic accounts, frps/frpc, the gateway and adapters before accepting remote
behavior changes. Those checks retain account/host isolation, revocation,
streaming, file previews, CLI updates and paired-entry persistence coverage.
Public CI never receives private checkout credentials.

The public preview acceptance scripts default to local checks. The private
suite supplies `--connect-fixture-module=<absolute-test-module>` to exercise
the same UI/API checks through the real managed stack. This explicit test-only
extension point is not part of application runtime or product configuration.

## History and license

Public Git history, issues, stars, release tags and installer/update URLs stay
in this repository. Earlier Connect source remains in historical commits under
its existing license. Subsequent hosted implementation is developed privately;
there is no history rewrite or requirement to create a new repository for 1.0.

The inherited [LICENSE](../LICENSE) and attribution remain unchanged. Repository
visibility is separate from licensing and cannot withdraw copies already
published or remove upstream license conditions.
