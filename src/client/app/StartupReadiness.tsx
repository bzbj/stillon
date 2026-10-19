import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react"
import { useStartupReveal } from "../lib/startup"

type Part = "route" | "composer" | "transcript"
type Report = (part: Part, token: symbol, ready: boolean) => void
const Readiness = createContext<Report | null>(null)

export function StartupReadiness({ scope, ready, required, children }: {
  scope: string
  ready: boolean
  required: readonly Part[]
  children: ReactNode
}) {
  const [parts, setParts] = useState<Partial<Record<Part, { scope: string; token: symbol }>>>({})
  const report = useCallback<Report>((part, token, available) => {
    setParts(previous => {
      if (available) {
        if (previous[part]?.scope === scope && previous[part]?.token === token) return previous
        return { ...previous, [part]: { scope, token } }
      }
      if (previous[part]?.scope !== scope || previous[part]?.token !== token) return previous
      const next = { ...previous }; delete next[part]; return next
    })
  }, [scope])
  useStartupReveal(ready && required.every(part => parts[part]?.scope === scope), scope)
  return <Readiness.Provider value={report}>{children}</Readiness.Provider>
}

/** Place inside the same Suspense boundary as the required component. */
export function StartupPart({ name, ready = true }: { name: Part; ready?: boolean }) {
  const report = useContext(Readiness)
  const token = useMemo(() => Symbol(name), [name])
  useLayoutEffect(() => {
    if (!report) return
    report(name, token, ready)
    return () => report(name, token, false)
  }, [name, ready, report, token])
  return null
}
