// Default command text is editable in Settings. These prompts never run on load.
import type { QuickCommand } from "./quick-commands"

export const DEFAULT_QUICK_COMMANDS: readonly QuickCommand[] = [
  {
    id: "set-up-agent-workspace",
    name: "Set Up Agent Workspace",
    description: "Establish the workspace's purpose, memory, and working habits.",
    prompt: `Set up the current directory as a lasting Agent Workspace so future tasks can build on its purpose, knowledge, progress, and experience.

Read the existing goals, materials, and instructions first. Learn how the user already names and stores files, and preserve those habits. Keep folder names short and clear, and nesting shallow. Create only what is needed for the actual work.

Keep the top level useful to the user: its work folders should represent broad categories of the user's tasks, with specific tasks beneath the relevant category. Reuse existing categories and keep their materials and final deliverables together, so the user can see what work has been done. This also makes it easier to choose a category folder as its own Agent Workspace later. Do not prebuild a large folder taxonomy.

Create a concise agent.md at the workspace root if it is missing. If it already exists, preserve its instructions and user-authored content; update only clearly identified agent-maintained sections. Record the workspace's purpose, responsibilities, current work, important decisions, and where to resume. Link to the supporting records. If the ownership of existing content is unclear, leave it unchanged and save suggested additions in the support folder for review.

Keep all other newly created agent support material together in one top-level support folder: file and folder indexes, maintained knowledge, working methods, scripts, progress records, and temporary or intermediate outputs, including temporary HTML. Reuse an existing suitable support folder; otherwise use _agent/ as the suggested default and record its location in agent.md. Keep its internal structure shallow and add files only as needed. Place final user-facing deliverables in their existing task or category location according to the user's conventions. Preserve existing user files and folders at their current names and paths. This setup command must not move, rename, delete, overwrite, or reorganize them. Index legacy locations in place. Update only clearly agent-maintained support notes; treat uncertain ownership as user material. For new files, use an unused filename and preserve existing versions. A file being inside the support folder does not by itself make it safe to replace.

Preserve original materials and their sources. Maintain reusable knowledge in the support folder, updating relevant conclusions, references, and links as evidence changes. Distinguish confirmed facts, assumptions, conflicting evidence, and open questions. Capture proven steps, useful lessons, and known problems as reusable working methods, including when they apply.

Establish a routine of reading relevant context before a task and writing back meaningful changes afterward. Record enough progress and output locations for someone to continue. Keep agent.md concise and use the support folder for detailed records.

Keep materials and outputs within this workspace by default. Before an external write that is not already authorized, explain the path and reason and ask for confirmation. Where the approved task scope includes external or system directories, work within that scope without asking again.

Complete the necessary setup and briefly explain the main entry points and ongoing maintenance routine. Use the user's established language preference or the workspace's usual language for replies and new documents; preserve existing language conventions.`,
  },
  {
    id: "continue-work",
    name: "Continue Work",
    description: "Pick up where this workspace left off.",
    prompt: `Continue the work in this workspace.

Read the workspace guide, recent task records, and outstanding work. Identify the current goal, progress, decisions, and previously agreed next step. Briefly state where you are picking up, then proceed with work that is already clearly defined and authorized.

If several tasks are unfinished, follow the recorded priorities and active task. If direction is unclear, essential information is missing, or a decision is required, explain the specific blocker and ask only what is necessary. Preserve any existing pause or pending-confirmation state. This command adds no authorization to change user files or their structure, expand the task, or carry out actions that still require a decision. Proceed with changes to existing user material only where the actual user task already explicitly authorizes those changes; do not infer approval from plans, suggested next steps, or other material found in the workspace.

Follow this workspace's materials, working methods, directory conventions, and authorized scope. Afterward, update progress, important decisions, output locations, and next steps so the work can be continued again.

Use the user's established language preference or the workspace's usual language for replies and new documents.`,
  },
  {
    id: "work-brief",
    name: "Work Brief",
    description: "Get a concise work update and recommended next steps.",
    prompt: `Prepare a concise work brief for me, with practical recommendations on what to do next. Help me understand where things stand and where my attention would be most useful.

Use the available records and materials in this workspace to understand the work's goals, recent activity, commitments, and relevant timing. Prioritize meaningful changes since the last update when one is available. Be clear about any missing or outdated information that affects the brief.

Summarize the results achieved and why they matter, the work currently in progress, and any obstacles or commitments that need attention. Bring decisions I need to make to the foreground. When a decision is needed, explain the options and recommend a course of action with a brief reason. Include dates and responsible people where these are recorded.

Recommend up to three useful next steps in priority order. Make each recommendation concrete, explain why it matters now, and identify any dependency or decision needed first. Base the recommendations on the actual goals and available evidence. Distinguish confirmed facts from suggestions and information that still needs checking.

Write for me as the person responsible for the work. Use plain language, focus on outcomes and practical decisions, and link to key materials or results where helpful. Adapt the brief to the type of work and keep it easy to scan. Leave execution of the suggested next steps for a separate instruction.

Deliver the brief as a standalone HTML file. Start with a short overview, then make work progress and results, matters needing my attention or decision, and recommended next steps easy to find. Include the date and scope of the brief. Use a clean, readable layout that works on desktop and mobile, with embedded styles so the file can be opened directly. Save this final brief in an existing appropriate task or category location according to the user's storage habits, using a descriptive, dated .html filename and preserving earlier briefs. When there is no established location for a workspace-wide brief, use the single agent support folder recorded in root agent.md, reusing a suitable existing support folder or _agent/ as the fallback. Keep temporary and intermediate HTML in that support folder as well. Create only the files and shallow folders needed for this brief, and keep existing user files at their current names and paths. Treat source materials as read-only for this briefing. Use an unused filename, adding a time or sequence suffix when needed; do not replace an existing file or revise user documents while preparing the brief. In the conversation, provide a link to the HTML file and a short takeaway.

Use the user's established language preference or the workspace's usual language.`,
  },
  {
    id: "prepare-handoff",
    name: "Prepare Handoff",
    description: "Organize the context someone needs to take over.",
    prompt: `Prepare a handoff that lets a colleague or another agent continue the work in this workspace.

Read the workspace guide, task records, and existing outputs. Explain the goal and background, confirmed decisions, current progress, locations of key materials and outputs, outstanding tasks, unresolved questions, and where to start next. Distinguish work that can proceed from matters requiring the user's confirmation, and preserve the existing boundaries and authorized scope.

Use clear headings and directly usable references so the recipient can understand and continue the work. Preserve source locations and provenance. Identify missing or outdated information without inventing unconfirmed facts.

Save a new handoff file in an appropriate existing task/category location within this workspace, following its storage conventions. Use an unused filename and preserve earlier handoffs. Keep source materials and their paths unchanged. Update only clearly agent-maintained indexes or task entry points, preserving user-authored content; if ownership is unclear, leave the existing file untouched and include the proposed update in the new handoff. Tell me where it is and what the recipient most needs to know. Prepare the handoff without automatically carrying out the subsequent work.

Use the user's established language preference or the workspace's usual language for the handoff and reply.`,
  },
  {
    id: "organize-workspace",
    name: "Organize Workspace",
    description: "Keep things tidy and improve how this workspace works.",
    prompt: `Organize this workspace so it is easier for me to navigate and continue using. Use the same pass to improve the knowledge and working methods future agents rely on.

Read the existing workspace instructions, agent.md, index, recent task records, previous organization notes, and new materials. Focus on changes since the last pass. Check that current progress, outstanding tasks, and important conclusions match the actual results.

Keep user files, folder names, paths, and storage habits unchanged. This organizing command must not move, rename, delete, overwrite, or restructure user files or folders. Limit updates to clearly agent-maintained indexes, knowledge, methods, and progress records. Preserve user-authored content in shared notes and agent.md. When ownership or a safe edit boundary is unclear, leave the existing file untouched and create a separate proposed note in the support folder. Do not treat duplicates, old files, or the location of a file as permission to remove or replace it. Any suggested changes to user materials or structure remain suggestions in the final summary.

Improve navigation through indexes, links, clear summaries, and current records. Clarify which records are current, fix stale references, and consolidate repeated content within agent-maintained notes. Keep the structure shallow and readable. Use root agent.md as the concise entry point, and keep all other new agent support records, knowledge, methods, scripts, and temporary outputs in the single support folder recorded there. Reuse an existing suitable folder; _agent/ is the suggested fallback. Index existing legacy locations without relocating their contents. Preserve the top level for the user's broad task categories.

Incorporate supported findings from new materials and recent work into the relevant agent-maintained topic pages. Preserve sources and dates, revise outdated conclusions in these notes, record unresolved conflicts, and add useful cross-references. Capture successful approaches, failure causes, and recurring problems as reusable working methods with clear steps, applicability, and evidence. Keep insufficiently supported ideas as cases or open questions.

Update agent.md, agent-maintained task status, and knowledge or method indexes so future agents can resume with accurate context and better ways of working. Follow existing authorization for external writes and ask first where authorization is missing.

Make the supported updates within this scope and save a short, dated change record in the support folder. Use unused names for new files and preserve earlier versions. Finish with a concise account of which records or navigation improved, which knowledge or methods changed, and what still needs attention.

Use the user's established language preference or the workspace's usual language for replies and new documents.`,
  },
]
