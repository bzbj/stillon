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
    description: "Build linked, source-backed knowledge from this workspace's materials.",
    prompt: `Turn this workspace's accumulated information and experience into a useful, source-backed knowledge base for future work. Read substantive materials, connect information across documents, and create or improve linked topic pages. Treat the workspace as a living knowledge wiki, using its existing organization and the user's habits.

${WORKSPACE_ENTRY_GUIDANCE}

Read the applicable instructions and respect each area's ownership and write boundaries. Reuse the user's language, naming, folder conventions, topic pages, and knowledge/support locations. If the workspace already has a wiki, maintain it. Otherwise, build the needed knowledge pages in its established agent support area; use .agent/ only when no suitable location exists. Creating substantive agent-maintained knowledge pages is part of this task. Keep human files and source materials in place. Choose topics from the actual work rather than imposing a fixed taxonomy, database, or metadata schema.

## Establish coverage before choosing what to study

Inspect the main work areas and their available sources, including relevant documents, reports, task inputs and outputs, decision records, and accessible conversation or tool records. Entry files, indexes, and old summaries are starting points for finding this material. Follow their references and read the underlying content. Use appropriate readers for relevant PDFs, presentations, spreadsheets, images, and other non-text materials when available; record extraction or access gaps.

Decide whether there is an established knowledge base with meaningful source coverage. A previous organization pass, a short knowledge.md, or a recent maintenance date does not establish that coverage. For an initial or shallow knowledge base, map the important information across the workspace, including older material, and develop a useful first set of topic pages. For an established base, process new evidence and feedback, revisit affected older sources and pages, and work through known coverage gaps. Do not limit an unprocessed collection to recently modified files.

Choose coherent topics that serve the workspace's purpose and likely future questions. Prioritize information that is costly to reconstruct, scattered across sources, repeatedly used, contradictory, or missing from existing knowledge. Briefly state the focus and proceed without a mode-selection question. For a large collection, complete a meaningful, bounded set of topics in this pass and record what remains for subsequent passes; do not stop after producing an inventory or claim exhaustive coverage from a sample.

## Compile information into connected knowledge

For each selected topic, read the relevant source content closely enough to explain what it establishes. Combine related evidence across documents when the topic requires it. Build a coherent account of the subject: important facts and relationships, decisions and their reasons, changes over time, constraints, and questions that remain. Derive useful comparisons, implications, and reusable methods where the evidence supports them, distinguishing your synthesis from what a source directly says. Preserve exact wording, units, periods, and qualifications when a summary would lose information that matters to future use.

Update the existing authoritative knowledge page for a topic or create a focused page when it is missing. Link related topics and the source locations supporting important claims, using document sections, pages, sheets, or other precise locators when available. Keep one current knowledge account per topic, with relevant history and conflicting evidence retained. Split an overloaded catch-all note when distinct topics justify their own pages, maintaining links and preserving useful content. Do not create one summary per file by default, duplicate the source collection, or make a large unstructured memory dump. The pages should help a future agent answer real questions without repeating the same multi-document investigation, while still allowing it to consult the originals.

Verify important conclusions against original materials, actual results, and explicit user decisions. Existing agent notes and transcripts are leads: they can show what was said or done, but an agent's claim is not independently verified because it appears there. Distinguish confirmed facts, reported claims, user decisions, inferences, hypotheses, and unresolved conflicts. Record relevant dates and applicability. Correct unsupported or stale knowledge with its reason and evidence; preserve uncertainty where the sources cannot settle it. Respect individual versus shared preferences and internal versus public disclosure boundaries. Promote a working method only when outcomes or feedback support it, with its conditions and known failure modes.

## Make the knowledge usable next time

Maintain a small linked index so the new knowledge can be discovered. Keep AGENTS.md and other root instructions short, pointing to substantive pages; put task progress and next steps in the existing continuation records. Knowledge compilation is the main result of this task. Editing instructions, fixing navigation, updating status, or writing a change log alone does not complete it when useful source material remains unprocessed. Do not add new policies to AGENTS.md merely to describe the work performed.

Check important claims back against their sources, verify links, and test whether the selected topic pages answer the questions they were built to support. Identify any material omissions or conflicting versions. Update a concise coverage record in the established support area: topics and source areas actually examined, pages created or materially changed, remaining gaps, and where the next pass should begin. Reuse the existing record rather than proliferating audit files. If sources add no supported knowledge, explain what you examined and why no substantive update was warranted; do not manufacture conclusions or empty pages to meet a quota.

## Preserve the user's work and authority

Create and maintain agent-owned knowledge within the permitted workspace scope. Preserve source files, human-authored content, official deliverables, existing instruction policies, pending approvals, and pauses. If an existing page cannot safely be edited, write a source-linked synthesis or proposed correction in the permitted agent support area rather than letting that uncertainty block independent knowledge work. If an explicit instruction prevents useful compilation, explain the specific restriction. Check resolved paths before writing, reread affected records, and reconcile concurrent changes.

This task does not authorize moving or deleting human files, executing business next steps, changing product code, publishing, sending messages, scheduling work, or modifying external systems. Read external references in place when accessible; do not copy external source collections or write outside the authorized scope. Keep sensitive information within its permitted audience and location. Use only records actually available to you and distinguish saved evidence from current online verification.

Finish with a short explanation of the substantive knowledge gained or corrected, links to the key pages, the coverage achieved, and the most useful remaining gaps. Use the user's established language or the workspace's usual language for replies, knowledge pages, filenames, and folder names, preserving existing conventions and fixed structural names.`,
  },

]
