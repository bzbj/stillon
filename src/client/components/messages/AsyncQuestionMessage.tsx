import { useMemo, useState } from "react"
import { Check, CircleAlert, Clock, Loader2, MessageCircleQuestion, Send } from "lucide-react"
import type {
  AsyncQuestionAnswerInput,
  AsyncQuestionContext,
  AsyncQuestionDeliveryStatus,
  AsyncQuestionResponse,
  HydratedTranscriptMessage,
} from "../../../shared/types"
import { asyncQuestionKey } from "../../../shared/types"
import type { AsyncQuestionAnswerResult } from "../../../shared/protocol"
import { Button } from "../ui/button"
import { cn } from "../../lib/utils"

type AssistantTextMessage = Extract<HydratedTranscriptMessage, { kind: "assistant_text" }>

interface Props {
  message: AssistantTextMessage
  response?: AsyncQuestionResponse
  readOnly?: boolean
  onSubmit: (
    questionKey: string,
    answers: AsyncQuestionAnswerInput[],
    submissionId: string,
  ) => Promise<AsyncQuestionAnswerResult>
}

function questionKeyOf(context: AsyncQuestionContext) {
  return asyncQuestionKey(context)
}

function statusLabel(status: AsyncQuestionDeliveryStatus) {
  switch (status) {
    case "submitting":
      return "发送中…"
    case "queued":
      return "待发送（已进入队列，当前任务结束后发送）"
    case "accepted":
      return "已发送"
    case "delivery_unknown":
      return "发送结果待核实"
    case "failed":
      return "发送失败"
    default:
      return ""
  }
}

function StatusPill({ status }: { status: AsyncQuestionDeliveryStatus }) {
  const label = statusLabel(status)
  if (!label) return null
  const icon =
    status === "accepted" ? <Check className="h-3.5 w-3.5" />
      : status === "failed" ? <CircleAlert className="h-3.5 w-3.5" />
        : status === "submitting" ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <Clock className="h-3.5 w-3.5" />
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        status === "accepted" ? "text-emerald-600 dark:text-emerald-400"
          : status === "failed" ? "text-destructive"
            : "text-muted-foreground",
      )}
    >
      {icon}
      {label}
    </span>
  )
}

/**
 * A Codex asynchronous question. The user picks one option per question or
 * types a free-form answer; nothing is submitted until the send button is
 * pressed. A closed card shows what was sent and the known delivery state.
 */
export function AsyncQuestionMessage({ message, response, readOnly = false, onSubmit }: Props) {
  const context = message.asyncQuestion
  const [selections, setSelections] = useState<Record<number, string>>({})
  const [customMode, setCustomMode] = useState<Record<number, boolean>>({})
  const [customValues, setCustomValues] = useState<Record<number, string>>({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const questions = context?.questions ?? []
  const key = useMemo(() => (context ? questionKeyOf(context) : ""), [context])

  const settled = response?.status === "accepted"
    || response?.status === "queued"
    || response?.status === "delivery_unknown"

  const answersFor = (index: number) => (
    customMode[index] ? (customValues[index] ?? "") : (selections[index] ?? "")
  )

  const complete = questions.length > 0 && questions.every((question) => answersFor(question.index).trim().length > 0)
  const canSend = complete && !pending && !settled

  if (!context || questions.length === 0) {
    return null
  }

  const handleSubmit = async () => {
    if (!canSend) return
    const answers: AsyncQuestionAnswerInput[] = questions.map((question) => ({
      index: question.index,
      value: answersFor(question.index).trim(),
    }))
    setPending(true)
    setError(null)
    try {
      await onSubmit(key, answers, crypto.randomUUID())
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError))
    } finally {
      setPending(false)
    }
  }

  const sentAnswers = response?.status === "failed" ? null : response?.answers ?? null

  return (
    <div className="rounded-2xl border border-border overflow-hidden bg-card">
      <div className="flex flex-row items-center gap-2 p-3 px-4 border-b border-border bg-card">
        <MessageCircleQuestion className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">需要你的回答</span>
        {response ? <span className="ml-auto"><StatusPill status={response.status} /></span> : null}
      </div>

      <div className="p-3 px-4 space-y-4">
        {questions.map((question) => {
          const locked = settled
          const sentValue = sentAnswers?.find((answer) => answer.index === question.index)?.value
          return (
            <fieldset key={question.index} className="space-y-2" disabled={locked}>
              <legend className="text-sm text-foreground font-medium">
                {questions.length > 1 ? `${question.index + 1}. ` : ""}{question.title}
              </legend>
              {sentValue !== undefined ? (
                <div className="text-sm text-muted-foreground">答案：{sentValue}</div>
              ) : question.options && question.options.length > 0 ? (
                <div role="radiogroup" aria-label={question.title} className="space-y-1">
                  {question.options.map((option) => {
                    const selected = !customMode[question.index] && selections[question.index] === option
                    return (
                      <label
                        key={option}
                        className={cn(
                          "flex items-start gap-2 rounded-lg border p-2 text-sm cursor-pointer",
                          selected ? "border-foreground/40 bg-accent" : "border-border hover:bg-accent/50",
                        )}
                      >
                        <input
                          type="radio"
                          className="mt-0.5"
                          name={`async-question-${message.id}-${question.index}`}
                          value={option}
                          checked={selected}
                          onChange={() => {
                            setSelections((current) => ({ ...current, [question.index]: option }))
                            setCustomMode((current) => ({ ...current, [question.index]: false }))
                          }}
                        />
                        <span className="text-foreground">{option}</span>
                      </label>
                    )
                  })}
                  <label
                    className={cn(
                      "flex items-start gap-2 rounded-lg border p-2 text-sm cursor-pointer",
                      customMode[question.index] ? "border-foreground/40 bg-accent" : "border-border hover:bg-accent/50",
                    )}
                  >
                    <input
                      type="radio"
                      className="mt-0.5"
                      name={`async-question-${message.id}-${question.index}`}
                      checked={Boolean(customMode[question.index])}
                      onChange={() => setCustomMode((current) => ({ ...current, [question.index]: true }))}
                    />
                    <span className="text-foreground">其他（自行填写）</span>
                  </label>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">请自由填写答案。</p>
              )}
              {(!question.options || question.options.length === 0 || customMode[question.index]) && !sentValue ? (
                <input
                  type="text"
                  aria-label={`${question.title} 的答案`}
                  placeholder="输入答案"
                  value={customValues[question.index] ?? ""}
                  onChange={(event) => setCustomValues((current) => ({ ...current, [question.index]: event.target.value }))}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-foreground/40"
                />
              ) : null}
            </fieldset>
          )
        })}

        {response?.status === "failed" && response.error ? (
          <p className="text-xs text-destructive">{response.error}</p>
        ) : null}
        {response?.status === "delivery_unknown" ? (
          <p className="text-xs text-muted-foreground">发送结果无法确认，请核对聊天记录后再决定是否重发。</p>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {!settled && !readOnly ? (
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!canSend} onClick={() => void handleSubmit()}>
              <Send className="h-3.5 w-3.5" />
              {response?.status === "failed" ? "重新发送" : "发送"}
            </Button>
            <span className="text-xs text-muted-foreground">选择与发送分开，未点击发送不会回复。</span>
          </div>
        ) : null}
        {readOnly && !settled ? (
          <p className="text-xs text-muted-foreground">只读导出，无法在此回复。</p>
        ) : null}
      </div>
    </div>
  )
}
