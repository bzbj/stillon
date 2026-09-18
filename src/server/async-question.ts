import type { AsyncQuestionAnswerInput, AsyncQuestionContext, AsyncQuestionItem } from "../shared/types"
import {
  ASYNC_QUESTION_MAX_ANSWER_BYTES,
  ASYNC_QUESTION_MAX_OPTION_BYTES,
  ASYNC_QUESTION_MAX_QUESTIONS,
  ASYNC_QUESTION_MAX_TITLE_BYTES,
  asyncQuestionKey,
} from "../shared/types"

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

/**
 * Normalize a provider `questions` array. Anything malformed returns null so
 * the caller falls back to plain text instead of rendering an empty card.
 * Question identity is the array position, never the (possibly repeated) title.
 */
export function normalizeAsyncQuestions(value: unknown): AsyncQuestionItem[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > ASYNC_QUESTION_MAX_QUESTIONS) {
    return null
  }

  const questions: AsyncQuestionItem[] = []
  for (let index = 0; index < value.length; index += 1) {
    const raw = asRecord(value[index])
    if (!raw) return null
    const title = asString(raw.title)?.trim()
    if (!title || byteLength(title) > ASYNC_QUESTION_MAX_TITLE_BYTES) return null

    let options: string[] | null = null
    if (raw.options !== undefined && raw.options !== null) {
      if (!Array.isArray(raw.options)) return null
      const normalized: string[] = []
      for (const option of raw.options) {
        const label = asString(option)?.trim()
        if (!label || byteLength(label) > ASYNC_QUESTION_MAX_OPTION_BYTES) return null
        normalized.push(label)
      }
      options = normalized.length > 0 ? normalized : null
    }

    questions.push({ index, title, options })
  }
  return questions
}

/**
 * Build preserved metadata for an async agent message. Only
 * `delivery === "async"` with a valid, non-empty question list qualifies.
 */
export function asyncQuestionContextFromItem(
  item: Record<string, unknown>,
  threadId: string,
  originTurnId: string,
): AsyncQuestionContext | null {
  if (asString(item.delivery) !== "async") return null
  const providerItemId = asString(item.id)
  if (!providerItemId || !threadId || !originTurnId) return null
  const questions = normalizeAsyncQuestions(item.questions)
  if (!questions) return null
  return { threadId, originTurnId, providerItemId, questions }
}

export interface AsyncAnswerValidation {
  ok: boolean
  error?: string
  answers?: AsyncQuestionAnswerInput[]
}

/**
 * Validate a client's answers against the server-trusted question list.
 * Every question needs exactly one non-empty answer, in order, with no
 * duplicates or unknown indices. A custom answer does not have to be one of
 * the offered options.
 */
export function validateAsyncQuestionAnswers(
  questions: AsyncQuestionItem[],
  answers: unknown,
): AsyncAnswerValidation {
  if (!Array.isArray(answers) || answers.length === 0) {
    return { ok: false, error: "至少需要一个答案" }
  }
  const expected = new Set(questions.map((question) => question.index))
  const seen = new Set<number>()
  const normalized: AsyncQuestionAnswerInput[] = []
  let totalBytes = 0

  for (const candidate of answers) {
    const record = asRecord(candidate)
    if (!record) return { ok: false, error: "答案格式无效" }
    const index = typeof record.index === "number" && Number.isInteger(record.index) ? record.index : null
    if (index === null || !expected.has(index)) return { ok: false, error: "答案关联的问题不存在" }
    if (seen.has(index)) return { ok: false, error: "同一问题不能重复回答" }
    seen.add(index)
    const value = asString(record.value)?.trim()
    if (!value) return { ok: false, error: "答案不能为空" }
    const bytes = byteLength(value)
    totalBytes += bytes
    if (totalBytes > ASYNC_QUESTION_MAX_ANSWER_BYTES) return { ok: false, error: "答案过长" }
    normalized.push({ index, value })
  }

  if (seen.size !== expected.size) return { ok: false, error: "每个问题都需要回答" }
  normalized.sort((a, b) => a.index - b.index)
  return { ok: true, answers: normalized }
}

/**
 * Deterministic text handed to the provider. Every question is restated with
 * its answer so a multi-question message cannot be misread as a bare value.
 */
export function buildAsyncQuestionAnswerText(
  questions: AsyncQuestionItem[],
  answers: AsyncQuestionAnswerInput[],
): string {
  const byIndex = new Map(answers.map((answer) => [answer.index, answer.value]))
  return questions
    .map((question) => `回答问题：${question.title}\n答案：${byIndex.get(question.index) ?? ""}`)
    .join("\n\n")
}

export { asyncQuestionKey }
