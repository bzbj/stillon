import { useState, useEffect } from "react"

export function useIsStandalone() {
  const [isStandalone, setIsStandalone] = useState(() => {
    if (typeof window === "undefined") return false
    const isIOSStandalone = (navigator as any).standalone === true
    const isDisplayStandalone = window.matchMedia("(display-mode: standalone)").matches
    return isIOSStandalone || isDisplayStandalone
  })

  useEffect(() => {
    const mediaQuery = window.matchMedia("(display-mode: standalone)")
    const handleChange = (e: MediaQueryListEvent) => {
      setIsStandalone(e.matches || (navigator as any).standalone === true)
    }
    mediaQuery.addEventListener("change", handleChange)
    return () => mediaQuery.removeEventListener("change", handleChange)
  }, [])

  return isStandalone
}
