import { useRef, type ReactNode } from "react"

/** Only a confirmed auth change replaces an already visible workspace. */
export function AuthenticatedSessionBoundary({
  authenticated,
  checking,
  fallback,
  children,
}: {
  authenticated: boolean
  checking: boolean
  fallback: ReactNode
  children: ReactNode
}) {
  const privatePage = useRef<ReactNode>(null)
  if (authenticated) privatePage.current = children
  else if (!checking) privatePage.current = null

  return <>{authenticated || checking ? privatePage.current : fallback}</>
}
