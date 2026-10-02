import { AsyncQuestionDeliveryContext } from "../../app/asyncQuestionDeliveryContext"
import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
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

const noSubscription = () => () => {}
const noDelivery = () => 0

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

type DraftState = {
  selections: Record<number, string>
  customMode: Record<number, boolean>
  customValues: Record<number, string>
}

/**
 * A question without options is always free text; one with options uses the
 * typed value only after the user picks "other".
 */
export function asyncQuestionAnswerValue(
  question: { index: number; options: string[] | null },
  draft: DraftState,
) {
  const hasOptions = Boolean(question.options && question.options.length > 0)
  if (!hasOptions) return draft.customValues[question.index] ?? ""
  return draft.customMode[question.index]
    ? (draft.customValues[question.index] ?? "")
    : (draft.selections[question.index] ?? "")
}

export function isAsyncQuestionComplete(
  questions: Array<{ index: number; options: string[] | null }>,
  draft: DraftState,
) {
  return questions.length > 0
    && questions.every((question) => asyncQuestionAnswerValue(question, draft).trim().length > 0)
}

function statusLabel(status: AsyncQuestionDeliveryStatus) {
  switch (status) {
    case "submitting":
      return "发送中…"
    case "queued":
      return "已排队"
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

function StatusPill({ status, label: override }: { status: AsyncQuestionDeliveryStatus; label?: string }) {
  const label = override ?? statusLabel(status)
  if (!label) return null
  const icon =
    status === "accepted" ? <Check className="h-3.5 w-3.5" />
      : (status === "failed" || status === "delivery_unknown") ? <CircleAlert className="h-3.5 w-3.5" />
        : status === "submitting" ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
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
export function AsyncQuestionMessage({ message, response: serverResponse, readOnly = false, onSubmit }: Props) {
  const transport = useContext(AsyncQuestionDeliveryContext)
  useSyncExternalStore(transport?.delivery.subscribe ?? noSubscription, transport?.delivery.getVersion ?? noDelivery, noDelivery)
  const submitting = useRef(false)
  const card = useRef<HTMLDivElement>(null)
  const [ack, setAck] = useState<AsyncQuestionAnswerResult | null>(null)
  const context = message.asyncQuestion
  const [selections, setSelections] = useState<Record<number, string>>({})
  const [customMode, setCustomMode] = useState<Record<number, boolean>>({})
  const [customValues, setCustomValues] = useState<Record<number, string>>({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const questions = context?.questions ?? []
  const key = useMemo(() => (context ? questionKeyOf(context) : ""), [context])

  useEffect(() => {
    if (transport && serverResponse && !readOnly) transport.delivery.observe(transport.chatId, serverResponse)
  }, [transport?.delivery, transport?.chatId, serverResponse, readOnly])
  const local = !readOnly && transport ? transport.delivery.get(transport.chatId, key) : undefined
  const response = readOnly ? serverResponse : local ?? serverResponse ?? ack
  const inFlight = pending || response?.status === "submitting"
  const waiting = (inFlight || response?.status === "delivery_unknown") && transport && transport.delivery.connection !== "connected"
  const status = response?.status ?? (pending ? "submitting" : undefined)
  const label = waiting ? "等待连接恢复…" : inFlight && local?.overdue ? "尚未确认送达" : undefined
  useEffect(() => {
    if (response?.status === "failed") {
      if (Object.keys(selections).length === 0 && Object.keys(customValues).length === 0) {
        const values = Object.fromEntries(response.answers.map((answer) => [answer.index, answer.value]))
        setCustomValues(values)
        setSelections(values)
        setCustomMode(Object.fromEntries(response.answers.map((answer) => [answer.index,
          !questions.find((question) => question.index === answer.index)?.options?.includes(answer.value),
        ])))
      }
      submitting.current = false
    }
  }, [response?.submissionId, response?.status])

  const settled = response?.status === "accepted"
    || response?.status === "queued"
    || response?.status === "delivery_unknown"

  useEffect(() => {
    if (settled && submitting.current && document.activeElement === document.body) card.current?.focus()
  }, [settled])

  // A question without options is always free text; one with options uses the
  // typed value only after the user picks "other".
  const draft = { selections, customMode, customValues }
  const answersFor = (question: { index: number; options: string[] | null }) => (
    asyncQuestionAnswerValue(question, draft)
  )

  const complete = isAsyncQuestionComplete(questions, draft)
  const canSend = complete && !inFlight && !settled

  if (!context || questions.length === 0) {
    return null
  }

  const handleSubmit = async () => {
    if (!canSend || submitting.current) return
    submitting.current = true
    const answers: AsyncQuestionAnswerInput[] = questions.map((question) => ({
      index: question.index,
      value: answersFor(question).trim(),
    }))
    const submissionId = crypto.randomUUID()
    if (transport) {
      transport.delivery.submit(transport.chatId, key, answers, submissionId)
      return
    }
    setPending(true)
    setError(null)
    try {
      setAck(await onSubmit(key, answers, submissionId))
    } catch {
      setAck({ questionKey: key, submissionId, answers, status: "delivery_unknown" })
      setError("发送结果需要核对，请恢复连接后重试核对。")
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  const sentAnswers = response?.status === "failed" && !readOnly ? null : response?.answers ?? null

  return (
    <div ref={card} tabIndex={-1} className="min-w-0 [overflow-wrap:anywhere] rounded-2xl border border-border overflow-hidden bg-card">
      <div className="flex flex-row flex-wrap items-center gap-2 p-3 px-4 border-b border-border bg-card">
        <MessageCircleQuestion className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">需要你的回答</span>
        {status ? <span className="ml-auto"><StatusPill status={status} label={label} /></span> : null}
      </div>

      <div className="p-3 px-4 space-y-4">
        {questions.map((question) => {
          const locked = settled || inFlight || readOnly
          const sentValue = sentAnswers?.find((answer) => answer.index === question.index)?.value
          return (
            <fieldset key={question.index} className="space-y-2" disabled={locked}>
              <legend className="text-sm text-foreground font-medium">
                {questions.length > 1 ? `${question.index + 1}. ` : ""}{question.title}
              </legend>
              {sentValue !== undefined ? (
                <div className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">答案：{sentValue}</div>
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
                        <span className="text-foreground break-words [overflow-wrap:anywhere] min-w-0">{option}</span>
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

        {response?.status === "failed" ? (
          <p className="text-xs text-destructive">{"回答未被接收，可编辑答案后重新发送。"}</p>
        ) : null}
        {response?.status === "delivery_unknown" ? (
          <p className="text-xs text-muted-foreground">发送结果待核实，请核对状态。</p>
        ) : null}
        {response?.status === "queued" ? <p className="text-xs text-muted-foreground">当前任务结束后发送</p> : null}
        {local?.overdue && inFlight ? <p className="text-xs text-muted-foreground">正在核对发送状态…</p> : null}
        {local?.error && response?.status !== "failed" ? <p className="text-xs text-destructive">{local.error}</p> : null}
        {(response?.status === "delivery_unknown" || (inFlight && local?.overdue)) && !readOnly ? (
          <Button size="sm" disabled={local?.checking} onClick={() => {
            if (transport) void transport.delivery.check(transport.chatId, key)
            else setError("暂时无法核对，请恢复连接后重试核对。")
          }}>{local?.checking ? "核对中…" : "核对状态"}</Button>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {!settled && !readOnly ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={!canSend} onClick={() => void handleSubmit()}>
              <Send className="h-3.5 w-3.5" />
              {waiting ? "等待连接…" : inFlight ? "发送中…" : response?.status === "failed" ? "重新发送" : "发送"}
            </Button>
            <span className="text-xs text-muted-foreground">{inFlight ? "答案已锁定，正在等待送达确认。" : "选择与发送分开，未点击发送不会回复。"}</span>
          </div>
        ) : null}
        {readOnly && !settled ? (
          <p className="text-xs text-muted-foreground">只读导出，无法在此回复。</p>
        ) : null}
      </div>
    </div>
  )
}
