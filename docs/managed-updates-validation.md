# Managed updater validation

The updater remains opt-in while native lifecycle coverage is completed. This
record distinguishes process recovery from login/reboot testing.

## Review findings addressed

- First-time adoption originally ran in the initiating CLI. It now has a durable
  setup journal and runs in the independent worker. Interrupted adoption restores
  the original service; failed recovery remains retryable.
- A real Windows rehearsal found that Task Scheduler `/End` left PowerShell/Bun
  children holding the old logs open. Adoption and recovery now stop the owned
  watchdog process tree. The original encoded command is saved before service
  replacement, so cleanup does not depend on regenerating an older launcher.
- Windows registration checks the live scheduled-task definition in addition
  to the saved XML. Changes made through Task Scheduler fail preflight.
- Backups now retain empty directories. Nested custom assets such as
  `public/dist/custom.png` are retained as source inputs.

## Windows x64 results

The native rehearsal uses two uniquely named, temporary scheduled tasks and
fixture runtimes with a disposable home. It exercises the production controller,
worker, transaction engines and native service backend; its command runner maps
only task names to the rehearsal namespace. Fixture source preparation is a
no-op because Git/build is validated separately.

The successful runs verified:

1. Terminating the worker during first-time service verification allows the
   periodic task to restore the original service without a manual recovery call.
2. Retrying adoption then enables the managed controller successfully.
3. Terminating the worker after a new runtime writes its fixture migration causes
   the controller to pause it, followed by automatic old-runtime/data recovery.
4. The failed-version data is retained in quarantine.
5. Both temporary tasks and their owned processes are removed afterward.

The complete native sequence took approximately 126–127 seconds on the test
machine, including waits for the periodic scheduler. This is a recovery-test
duration, not an upgrade-time guarantee.

Separately, real source preparation fetched the release tag, applied the branch's
source customizations, installed fresh dependencies, rebuilt both clients and
probed the real StillOn app with a disposable home. The deployed and prepared
build manifests matched. Runs took approximately 94–156 seconds.

Local validation also passed type/build checks, the dependency audit and the
full test suite. Focused tests cover setup interruption phases, retryable recovery,
live-task fingerprint changes, empty-directory rollback and process cleanup that
leaves an unrelated sibling process alive. PR CI runs the tests on Mac Intel,
Apple Silicon, Windows x64, Windows ARM64 and Linux.
The Windows x64 and ARM64 jobs also run the native task rehearsal as a required
step; the PR's latest checks report its result for each revision.

## Mac Intel source-link fix and adoption

A real first-time setup on Intel macOS 13.7.8 / Bun 1.3.14 found that the
repository's own `.claude/skills/shadcn` symlink was rejected by source
preparation. Source manifests now retain safe internal relative links without
traversing them. Data/build manifests still reject links, and source preparation
rejects external, absolute, dangling, cyclic, generated-file and user-data links.
Extra source entries cannot write through linked destination directories.

On the original PR base plus this link fix (`4bf177e`), validation passed:

- 35 focused tests, typechecking and both frontend builds.
- Complete official-tag source preparation, patching, fresh dependency install,
  build and isolated real-app/resource probe, with matching build manifests and
  the skill link preserved.
- Full native service installation and first-time setup using isolated
  LaunchAgent labels, home and port; both test jobs were unloaded afterward.
- First-time adoption of an existing production source service after an idle
  check and verified stopped-server backup. Controller/worker ownership,
  application resources, history, existing ingress and actual environment
  inheritance were verified. Old runtime and backups were retained.

These production results predate the newer independent setup-journal/Windows
recovery changes. The combined code was subsequently tested in another isolated
Mac installation: the CLI requested setup, the independent worker reached the
`enabled` phase, both native jobs and managed application health were verified,
and the fixture jobs were cleaned up. This covers successful worker-owned setup,
not native interruption recovery, Apple Silicon adoption, login/reboot or a
subsequent production release-to-release upgrade. The running production runtime
was not replaced during PR integration; platform CI checks the combined revision.

## Remaining lifecycle acceptance

| Scenario | Windows x64 | Windows ARM64 | Mac Intel / Apple Silicon |
| --- | --- | --- | --- |
| Controller/worker interruption tests | Automated + native tasks | CI | CI |
| First-time native adoption and recovery | Rehearsed + CI task rehearsal | CI task rehearsal | Intel production adoption + combined-code isolated setup passed; native interruption recovery / Apple Silicon pending |
| Logout/login after interrupted update | Pending | Pending | Pending |
| Reboot after interrupted update | Pending | Pending | Pending |
| Physical power loss / filesystem failure | Not certified | Not certified | Not certified |

Login/reboot acceptance must use a disposable installation and verify both the
selected runtime and history after recovery, then remove its test services.
Custom launchers require their own integration; this PR does not adopt them or
replace an existing custom local startup method.
