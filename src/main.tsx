import { Component, lazy, StrictMode, Suspense, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource-variable/bricolage-grotesque"
import { useAppAuthState } from "./client/app/useAppAuthState"
import { getStartupController } from "./client/lib/startup"
import "./index.css"

// Auth starts in the small entry while the workspace module downloads in parallel.
const AppRoot = lazy(() => import("./client/app/AppRoot"))
class StartupErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { getStartupController()?.fail() }
  render() {
    return this.state.failed ? <main role="alert" className="p-8">We couldn’t open Still On. <a href="" className="underline">Reload page</a></main> : this.props.children
  }
}

function Bootstrap() {
  const auth = useAppAuthState()
  return <StartupErrorBoundary><Suspense fallback={null}><AppRoot auth={auth} /></Suspense></StartupErrorBoundary>
}

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root")
}

createRoot(container).render(
  <StrictMode>
    <Bootstrap />
  </StrictMode>
)
