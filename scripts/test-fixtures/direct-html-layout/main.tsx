import { createRoot } from "react-dom/client"
import { DirectHtmlPreview } from "../../../src/client/components/chat-ui/DirectHtmlPreview"
import "../../../src/index.css"

createRoot(document.getElementById("root")!).render(<div style={{ position: "absolute", right: 0, top: 49, width: 419, height: 700 }}>
  <DirectHtmlPreview targetId="fixture" target={{ kind: "project-file", address: "/api/projects/workspace/files/preview/index.html",
    projectId: "workspace", filePath: "index.html", markdown: false }} projectId="workspace" refreshVersion={0} zoom={1} onNavigate={() => {}} />
</div>)
