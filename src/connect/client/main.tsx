import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ConnectApp } from "./ConnectApp"
import "./styles.css"

createRoot(document.getElementById("root")!).render(<StrictMode><ConnectApp /></StrictMode>)
