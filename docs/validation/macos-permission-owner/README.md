# Stable macOS permission owner validation

Automated validation on macOS Intel with Bun 1.3.14:

- Native helper compiled with `-Wall -Wextra -Werror`; missing command exits 64,
  child exit 23 propagates, child SIGTERM becomes 143, parent SIGTERM is forwarded.
  One hundred immediate child exits completed without a missed SIGCHLD wakeup.
- Service and updater tests check helper-first ordering, escaping, dotenv argument
  placement and byte-equivalent legacy generation with the field absent.
- Helper installation tests check idempotence, preserved old executable inode and
  bytes after replacement, staging cleanup, private directory mode and rejection
  of linked payloads.
- Runtime copy tests preserve nested app paths containing spaces, signature files,
  hashes and executable modes. Existing legacy runtime fixtures remain supported.
- An unsigned runtime-only desktop build completed. Strict codesign verification
  passed for the ad-hoc helper with identifier `com.bzbj.stillon.agent`; runtime
  manifest verification includes the executable and signature resources.

Pending interactive platform acceptance in a disposable macOS account:

| Scenario | Status |
| --- | --- |
| Documents/Desktop/Downloads prompt displays helper bundle attribution | Not run |
| Consent persists across new tasks, service restart and login | Not run |
| App-only update, controller handover and rollback preserve consent | Not run |
| Developer ID build and same-team helper rebuild | Not run |
| Denial produces actionable error without retry prompts | Not run |
| macOS 14+ and Apple Silicon | Not run |
| Authenticated Connect task through gateway/tunnel/adapter | Not run |

A scratch HOME does not isolate the logged-in account's TCC consent database.
The interactive matrix needs a disposable login account. Build and unit results
establish process mechanics and packaging; they do not establish TCC attribution.

QA follow-up regression coverage:

- Rejected Connect-origin preflight and failed transition journal writes leave the
  installed helper bytes unchanged. Journal recovery retries helper installation
  before registering the transition worker.
- Identical helper reinstalls prune retired bundles; successive changed installs
  retain only their immediate predecessor.
- A controller that ignores SIGTERM is killed and reaped after the helper deadline
  (production 20 seconds, test build 1 second). Helper-backed LaunchAgents set
  `ExitTimeOut=30`; legacy plist bytes remain unchanged.
- Helper-to-helper rollback intentionally retains the newly installed helper,
  including its ad-hoc identity-change limitation.
