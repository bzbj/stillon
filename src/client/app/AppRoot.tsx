import { BrowserRouter } from "react-router-dom"
import { AppearanceProvider } from "../hooks/useAppearance"
import { ThemeProvider } from "../hooks/useTheme"
import { App } from "./App"
import type { useAppAuthState } from "./useAppAuthState"

export default function AppRoot({ auth }: { auth: ReturnType<typeof useAppAuthState> }) {
  return <BrowserRouter><ThemeProvider><AppearanceProvider><App auth={auth} /></AppearanceProvider></ThemeProvider></BrowserRouter>
}
