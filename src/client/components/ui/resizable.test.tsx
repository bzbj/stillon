import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "./resizable"

describe("ResizableHandle", () => {
  test("forwards disabled state to the separator", () => {
    const html = renderToStaticMarkup(
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel id="left" defaultSize="50%">
          <div>left</div>
        </ResizablePanel>
        <ResizableHandle orientation="horizontal" disabled />
        <ResizablePanel id="right" defaultSize="50%">
          <div>right</div>
        </ResizablePanel>
      </ResizablePanelGroup>
    )

    expect(html).toContain('data-separator="disabled"')
    expect(html).toContain('aria-disabled="true"')
  })

  test("omits the divider line when withHandle is not set", () => {
    const html = renderToStaticMarkup(
      <ResizablePanelGroup orientation="horizontal">
        <ResizablePanel id="left" defaultSize="50%">
          <div>left</div>
        </ResizablePanel>
        <ResizableHandle orientation="horizontal" />
        <ResizablePanel id="right" defaultSize="50%">
          <div>right</div>
        </ResizablePanel>
      </ResizablePanelGroup>
    )

    expect(html).not.toContain("before:bg-border")
  })
})
