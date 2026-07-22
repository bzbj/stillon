# StillOn release roadmap

StillOn uses semantic versions for compatibility and working-dog edition names
for product maturity. The number answers "which build is this?"; the edition
answers "what kind of StillOn is this?"

This is a direction document, not a delivery calendar. Scope and sequencing may
change as the project learns from real installations. An edition advances only
after an explicit project decision; patch and minor releases do not advance it
automatically.

## Why working dogs

StillOn is a personal agent outpost that remains with a computer while its owner
is away. Working dogs fit that idea: they stay alert, keep watch, help with real
work, and become more capable through training and trust.

The metaphor also preserves the project's history. An early prototype used
**Husky** as the product name before the permanent **StillOn** brand was chosen.
Rather than discard that history, StillOn keeps Husky as the name of its first
public development era.

The names describe temperament and maturity, not mascots or separate products.
StillOn remains the product name, and dog imagery does not replace the StillOn
mark. See the [brand guide](brand.md).

## Confirmed edition map

| Product stage | Version range | Edition | Meaning |
| --- | --- | --- | --- |
| Early prototypes | Before the public StillOn line | **Pup** | Small, fresh, and just starting out |
| Public beta | All `0.x` releases | **Husky** | Energetic, curious, useful, and still learning discipline |
| Stable product | `1.0.0` and the `1.x` line | **Corgi** | Compact, quick, and surprisingly capable |

Pup is a retrospective name for the prototype period, not a Git tag. Existing
releases will not be renamed or retagged. Husky covers the entire `0.x` journey;
Corgi begins only when StillOn is ready to make a stable `1.0` commitment.

## Husky roadmap: the `0.x` journey

Husky is the current edition. Its job is to turn a fast-moving beta into a
dependable personal agent outpost while preserving room to change interfaces,
storage, and operating assumptions before `1.0`.

The remaining Husky work is organized around six outcomes:

1. **Data integrity** — define data compatibility, migrations, backup, restore,
   compaction recovery, and rollback behavior.
2. **Agent lifecycle parity** — make authenticated Claude Code and Codex
   sessions predictable across start, resume, interrupt, restart, and shutdown.
3. **Cross-platform operation** — validate the declared macOS, Linux, and
   Windows support matrix, including services, paths, terminals, discovery, and
   native openers.
4. **Security boundaries** — harden authentication, secrets, uploads, local
   previews, and operator-managed ingress around the single-user threat model.
5. **Installation and upgrades** — provide a documented, repeatable install,
   upgrade, validation, and rollback path without silently taking control of a
   user's machine.
6. **Operational clarity** — improve onboarding, diagnostics, changelogs,
   support boundaries, and recovery guidance so failures are understandable and
   actionable.

Minor releases such as `0.3.0` may deliver substantial parts of this work, but
they remain Husky releases. Patch releases continue to carry the same edition.

## Graduation gates for Corgi `1.0`

StillOn becomes Corgi when the project can support a stable product contract,
not merely because a date or feature count has been reached. Before publishing
`v1.0.0`, the project should be able to demonstrate:

- a documented data compatibility policy with tested migration and rollback;
- a supported install and upgrade path for every platform declared stable;
- reliable Claude Code and Codex lifecycle behavior on the supported matrix;
- explicit security and trust boundaries for local and remote access;
- repeatable releases with cross-platform CI, security analysis, and no known
  high-severity production dependency findings;
- manual acceptance on the operating systems and access paths claimed by the
  release;
- documented backup, restore, diagnostics, and recovery procedures; and
- a clear public statement of supported behavior, limitations, and compatibility.

These gates complement the more detailed
[public-release readiness checklist](public-release-readiness.md). If a gate is
not met, StillOn remains Husky even if the numeric `0.x` line grows longer.

## Corgi roadmap: the `1.x` era

Corgi is the first stable StillOn edition. Its emphasis is not size or novelty;
it is a compact product that reliably performs its core job.

During `1.x`, the project should favor:

- backward-compatible improvements and conservative defaults;
- predictable upgrades and recovery over one-off migration advice;
- lower operational overhead for everyday personal use;
- performance and reliability work backed by real-world measurements; and
- well-defined integration surfaces that do not weaken the local-first model.

Breaking product contracts should be exceptional in Corgi and reserved for a
deliberate future edition or major-version decision.

## Reserved future sequence

The original working-dog sequence is preserved below. Only Pup, Husky, and
Corgi currently have assigned product stages. Later names express a possible
direction of maturity; they do not promise version numbers, features, or dates.

| Order | Edition | Original character | Possible maturity theme |
| ---: | --- | --- | --- |
| 1 | Pup | A newborn puppy | Prototype and discovery |
| 2 | Husky | An energetic young sled dog | Exploration and rapid learning |
| 3 | Corgi | A compact, capable herder | Stable core product |
| 4 | Samoyed | A warm, steady working dog | Trust, recovery, and calm operation |
| 5 | Shiba | An alert, independent companion | Policy-bound autonomy |
| 6 | Labrador | A practical, loyal helper | Dependable everyday workflows |
| 7 | Golden | A thoughtful, cooperative retriever | Collaboration and handoffs |
| 8 | Shepherd | A focused, disciplined working dog | Secure execution and supervision |
| 9 | Collie | A perceptive, organized herder | Complex multi-project orchestration |
| 10 | Border | An intensely smart, responsive Border Collie | Advanced, mature agent work |

The sequence is intentionally slow. Edition names should remain meaningful
eras, not decorative labels consumed by every minor release.

## Release naming

Edition names supplement semantic versions; they never replace them.

| Surface | Husky example | Corgi example |
| --- | --- | --- |
| Git tag | `v0.3.0` | `v1.0.0` |
| GitHub Release title | `StillOn Husky · v0.3.0` | `StillOn Corgi · v1.0.0` |
| Product display | `StillOn 0.3 “Husky”` | `StillOn 1.0 “Corgi”` |

Do not create tags such as `husky` or rename the application to a dog name.
The canonical version remains `package.json` plus its matching `vX.Y.Z` tag, as
defined in the [release guide](releasing.md).

## Changing this roadmap

Roadmap changes should arrive through normal pull requests and explain the
evidence behind a changed priority or graduation gate. Advancing to a new
edition requires an explicit decision in release notes and an update to this
document and the [brand guide](brand.md).
