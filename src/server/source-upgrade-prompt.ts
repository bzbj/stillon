import type { AppSettingsSnapshot } from "../shared/types"
import type { GenerateCodexExecStructuredArgs } from "./codex-exec"

const SOURCE_REPOSITORY_URL = "https://github.com/bzbj/stillon.git"
const MAX_GENERATED_PROMPT_LENGTH = 1_800
const DEFAULT_ANALYSIS_TIMEOUT_MS = 240_000
const RELEASE_TAG_PATTERN = /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

type CodexPreference = AppSettingsSnapshot["providerDefaults"]["codex"]

interface CodexUpgradeAnalyzer {
  generateStructured(args: GenerateCodexExecStructuredArgs): Promise<string | null>
}

export interface SourceUpgradePromptResult {
  prompt: string
}

export interface SourceUpgradePromptGenerator {
  generate(args: { targetTag: string }): Promise<SourceUpgradePromptResult>
}

export function normalizeSourceReleaseTag(value: string) {
  const targetTag = value.trim()
  if (!RELEASE_TAG_PATTERN.test(targetTag)) {
    throw new Error("The target StillOn release tag is invalid.")
  }
  return targetTag
}

export function buildSourceUpgradeAnalysisRequest(targetTag: string) {
  const normalizedTargetTag = normalizeSourceReleaseTag(targetTag)
  const releaseUrl = `https://github.com/bzbj/stillon/releases/tag/${encodeURIComponent(normalizedTargetTag)}`

  return `Analyze the StillOn installation in your current working directory and prepare a tailored upgrade prompt for ${normalizedTargetTag}.

This is analysis only. Do not edit files, install packages, stop or restart services, or change configuration. Use read-only inspection to determine the current version and commit, Git state and local customizations, runtime/release layout, service manager and launch command, host and port wiring, environment-file locations, reverse proxy or supervisor integration, and the safest way to upgrade from ${SOURCE_REPOSITORY_URL}. Read docs/production-runtime.md when present. Inspect only relevant StillOn deployment files and process/service metadata; do not reveal secret values. Use at most 12 focused local commands and do not browse the web or inspect the target release contents.

Return only the final prompt, written in concise Chinese for a coding agent that will perform the upgrade later. Keep it to 6–12 short lines and no more than 1,200 Chinese characters. It must name ${normalizedTargetTag} and ${releaseUrl}, preserve every detected local customization, give the exact update/build and service restart commands supported by the evidence, include a brief health check and rollback instruction, and tell the agent to discover and retain any value that could not be confirmed. Do not include your analysis, background explanation, generic warnings, multiple alternative procedures, or markdown code fences.`
}

export function normalizeGeneratedSourceUpgradePrompt(value: string | null) {
  let prompt = value?.trim() ?? ""
  const fenced = prompt.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i)
  if (fenced?.[1]) prompt = fenced[1].trim()

  if (!prompt) {
    throw new Error("Codex did not return an upgrade prompt.")
  }
  if (prompt.length > MAX_GENERATED_PROMPT_LENGTH) {
    throw new Error("Codex returned an upgrade prompt that was too long. Try the analysis again.")
  }
  return prompt
}

export function createSourceUpgradePromptGenerator(options: {
  runtimeDirectory: string
  codex: CodexUpgradeAnalyzer
  getCodexPreference: () => CodexPreference
  timeoutMs?: number
}): SourceUpgradePromptGenerator {
  let inFlight: { targetTag: string; promise: Promise<SourceUpgradePromptResult> } | null = null

  return {
    generate(args) {
      const targetTag = normalizeSourceReleaseTag(args.targetTag)
      if (inFlight) {
        if (inFlight.targetTag === targetTag) return inFlight.promise
        throw new Error("Codex is already analyzing another StillOn release.")
      }

      const preference = options.getCodexPreference()
      const promise = options.codex.generateStructured({
        cwd: options.runtimeDirectory,
        prompt: buildSourceUpgradeAnalysisRequest(targetTag),
        model: preference.model,
        effort: preference.modelOptions.reasoningEffort,
        serviceTier: preference.modelOptions.fastMode ? "fast" : undefined,
        permissionMode: "read-only",
        ephemeral: true,
        timeoutMs: options.timeoutMs ?? DEFAULT_ANALYSIS_TIMEOUT_MS,
      }).then((prompt) => ({
        prompt: normalizeGeneratedSourceUpgradePrompt(prompt),
      })).finally(() => {
        if (inFlight?.promise === promise) inFlight = null
      })

      inFlight = { targetTag, promise }
      return promise
    },
  }
}
