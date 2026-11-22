// Default command text is editable in Settings. These prompts never run on load.
import type { QuickCommand } from "./quick-commands"

const WORKSPACE_ENTRY_GUIDANCE = `Use AGENTS.md as the workspace entry point. Read it first when present, and also read any existing Agent.md or agent.md for context. If only a legacy entry exists, use it in place until migration is authorized; do not create a second root entry or a redirect file. Preserve existing instructions and human-authored content.`

export const DEFAULT_QUICK_COMMANDS: readonly QuickCommand[] = [
  {
    id: "organize-workspace",
    name: "Organize Workspace",
    description: "Set up or tidy this folder for ongoing work with agents.",
    prompt: `Organize this workspace so people can find and use its materials and agents can understand how to work here. Set up missing essentials on a first visit and maintain the existing organization on later visits.

${WORKSPACE_ENTRY_GUIDANCE}

Inspect the actual materials, purpose, existing entry points, indexes, and folder conventions first. Briefly explain what is already in place and what would help. Infer the appropriate scope from the workspace and the user's request; do not require a setup-versus-maintenance or quick-versus-deep choice. Ask a focused question only when the purpose, ownership, or a necessary decision cannot be established from the available context.

Follow the user's established language, filenames, storage habits, and directory structure. Reuse existing knowledge and support locations, including research wikis and task records. Keep directories shallow and organize by actual function or responsibility, adding other dimensions only when useful. Do not impose a fixed template, prebuild empty folders, or create child workspaces automatically. Reference shared and external material in place rather than duplicating it.

Establish missing essentials
Create AGENTS.md only when no canonical or legacy entry exists. Keep the entry concise: purpose, responsibilities, human directory conventions, essential boundaries, links to key materials and records, current work, and where to resume. Preserve existing instructions and human-authored content. Use established support locations for detailed records; if none exists and supporting material is needed, use .agent/. Create only what the actual workspace needs. Explain a simple routine of reading relevant records before work and updating meaningful progress and decisions afterward.

When a legacy entry needs migration, propose its exact rename or merge into AGENTS.md, a recoverable backup under .agent/, and the affected links. Execute only an already authorized concrete migration. Preserve originals until the approved merge and links have been verified; do not create a second root entry or a redirect file.

Maintain organization and navigation
Improve clearly agent-maintained indexes, directory maps, links, and continuation sections. Check that they lead to the actual materials and outputs and reflect validated task status. Preserve useful history, pending decisions, approvals, and pauses. Reuse existing topic records rather than creating parallel summaries. Leave substantive synthesis, cross-session memory correction, and experience extraction to Dreaming; this command establishes and maintains the structure in which that knowledge lives.

Preserve human material and review concrete changes
Human-authored files, source materials, and official deliverables retain their existing names and paths unless a concrete change is approved. Material inside an agent support folder may still be human-owned. If ownership or a safe edit boundary is unclear, leave the original untouched and save a proposed amendment in the existing support location.

If moving, renaming, replacing, archiving, or deleting human files would help, inventory the affected materials and present the proposed directory structure and every file's exact current and destination paths in chat. Explain conflicts, replacements, archive locations, and any proposed deletion. Wait for confirmation of that concrete plan before executing it; selecting this preset does not approve file migration. Continue independent, clearly agent-owned setup and navigation maintenance while the plan is pending. Honor approval already given for the same unchanged concrete operation. If the mapping or scope changes, obtain confirmation for the affected changes. Preserve recoverable originals, reread affected files to avoid overwriting concurrent edits, verify destinations, and repair relevant links after approved operations.

Keep agent drafts and candidate deliverables in the established support area. Before adopting a candidate as an official deliverable in a human business folder, present the reviewable file, exact destination, and any replacement or predecessor archive for confirmation. Do not infer publication approval from organization approval or successful validation. Preserve existing official versions until the approved replacement has been verified.

Respect workspace boundaries
Follow existing instructions and authorized scope. Resolve actual paths, including links, before writing. Writes outside the workspace require explicit authorization covering the target and change; honor authorization already given without asking again. Read external sources in place and record references with their original path or identifier, purpose, and relevant date or version when needed. This command does not authorize deployment, sending messages, scheduling work, or executing unrelated tasks.

Verify the resulting entry points and links. Record substantive organization changes and continuation state briefly in the existing support location, without creating empty maintenance records. Finish with the main entry points, actual improvements, and any concrete plan or decision still awaiting confirmation. When the workspace already works well, say so and keep changes minimal.

Use the user's established language preference or the workspace's usual language for replies, new documents, filenames, and folder names. Preserve established language conventions and fixed structural names.`,
  },
  {
    id: "prepare-handoff",
    name: "Prepare Handoff",
    description: "Organize the context someone needs to take over.",
    prompt: `Prepare a handoff that lets a colleague or another agent continue the work in this workspace.

${WORKSPACE_ENTRY_GUIDANCE}

Read the workspace guide, task records, and existing outputs. Explain the goal and background, confirmed decisions, current progress, locations of key materials and outputs, outstanding tasks, unresolved questions, and where to start next. Distinguish work that can proceed from matters requiring the user's confirmation, and preserve the existing boundaries and authorized scope.

Use clear headings and directly usable references so the recipient can understand and continue the work. Preserve source locations and provenance. Identify missing or outdated information without inventing unconfirmed facts.

Save a new handoff file in an appropriate existing task/category location within this workspace, following its storage conventions. Use an unused filename and preserve earlier handoffs. Keep source materials and their paths unchanged. Update only clearly agent-maintained indexes or task entry points, preserving user-authored content; if ownership is unclear, leave the existing file untouched and include the proposed update in the new handoff. Tell me where it is and what the recipient most needs to know. Prepare the handoff without automatically carrying out the subsequent work.

Use the user's established language preference or the workspace's usual language for the handoff and reply.`,
  },
  {
    id: "dreaming",
    name: "Dreaming",
    description: "Reflect on recent work, correct memory, and preserve useful knowledge.",
    prompt: `Reflect on this workspace's recent work and maintain the knowledge that will help future sessions continue accurately and work more effectively.

${WORKSPACE_ENTRY_GUIDANCE}

Follow the user's established working habits, language, filenames, directory structure, and knowledge-maintenance conventions. Reuse existing topic pages, task records, indexes, and support locations, including a research wiki when present. Keep existing records in place. If no support location exists and a new record is useful, use .agent/. Create only what the work needs; do not impose a new taxonomy, database, or memory format.

Read relevant task and decision records, previous maintenance notes, and recent materials. Focus on meaningful changes since the last recorded pass, following references back to older knowledge when affected. Use only conversations and tool results actually available to you; identify important gaps rather than implying that you reviewed inaccessible sessions. Proceed with clearly agent-maintained knowledge updates without a preliminary scope-selection question.

Check important claims against original sources, actual outputs, validation results, and explicit user decisions. A transcript records what was said; it does not by itself verify an agent's claim. Distinguish confirmed facts, user decisions, tested methods, hypotheses, conflicting evidence, and open questions. Preserve source references, relevant dates, applicability, and reasons for corrections. Do not infer completion or authority from a newer timestamp alone. Keep unresolved contradictions visible when evidence cannot settle them.

Integrate supported findings into the existing authoritative topic records instead of adding parallel summaries. Correct outdated conclusions, consolidate repeated agent notes, repair links, and preserve useful evidence and revision history. Separate current task state from durable knowledge: update goals, progress, blockers, and next steps in continuation records; retain reusable findings and methods in their appropriate topic records. Capture methods supported by outcomes or feedback, including when they apply and known failure conditions. Keep untested ideas as hypotheses rather than general rules.

Keep the root entry short, with essential constraints, current orientation, and links to details. Put detailed knowledge in the established supporting records. Respect explicit user preferences and their scope. In shared workspaces, distinguish an individual's preference or suggestion from a confirmed project decision; do not promote it into a rule for everyone.

Maintain only clearly agent-owned records and sections. Preserve human-authored content, source materials, official deliverables, and existing instruction policies. If ownership or authority is unclear, save a proposed amendment in the established support area and ask only about the specific unresolved decision. Respect pending approvals and pauses. This reflection does not authorize executing next steps, changing product code, reorganizing human files, publishing, sending messages, scheduling work, or changing external systems. Read external references in place; writes outside this workspace require existing explicit authorization. Check resolved paths before writing. Reread affected records before saving and reconcile concurrent edits instead of overwriting them.

Verify updated references and continuation state. When substantive changes were made, save a short dated maintenance record in the existing support location with the reviewed scope, evidence, corrections, and unresolved items so a later pass can resume incrementally. If nothing merits an update, say so without creating empty records. Finish with a concise account of what knowledge changed, what became easier to continue, and any remaining evidence gaps or decisions.

Use the user's established language preference or the workspace's usual language for replies, new records, filenames, and folder names. Preserve existing language conventions and fixed structural names.`,
  },

]
