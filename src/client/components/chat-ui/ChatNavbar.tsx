import { Globe, Menu, MessageCirclePlus } from "lucide-react"
import { Button } from "../ui/button"
import { CardHeader } from "../ui/card"
import { cn } from "../../lib/utils"

interface Props {
  sidebarCollapsed: boolean
  onOpenSidebar: () => void
  onNewChat: () => void
  localPath?: string
  rightPanel?: "hidden" | "browser"
  onToggleBrowserPanel?: () => void
}

export function ChatNavbar({
  sidebarCollapsed,
  onOpenSidebar,
  onNewChat,
  localPath,
  rightPanel = "hidden",
  onToggleBrowserPanel,
}: Props) {
  const browserPanelVisible = rightPanel === "browser"

  return (
    <CardHeader
      className={cn(
        "absolute top-0 left-0 right-0 z-10 md:pt-[9px]  pl-1 pr-2 border-border/0 flex items-center justify-center",
        "bg-gradient-to-b from-background lg:from-background/0"
      )}
    >
      <div className="absolute top-0 left-0 right-0 z-0 h-[100px] bg-gradient-to-b from-background via-background/50 pointer-events-none block"></div>
      <div className="relative flex items-center gap-2 w-full">
        <div className={cn("h-[30px] flex items-center gap-0 flex-shrink-0 border border-border/0 rounded-[9px] px-[2px]", sidebarCollapsed && "md:hidden")}>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden !h-[auto] hover:!border-border/0 hover:!bg-transparent"
            onClick={onOpenSidebar}
          >
            <Menu className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className={cn("hover:!border-border/0 hover:!bg-transparent", !sidebarCollapsed && "md:hidden")}
            onClick={onNewChat}
            title="New conversation"
            aria-label="New conversation"
          >
            <MessageCirclePlus className="size-5" />
          </Button>
        </div>

        <div className="flex-1 min-w-0" />

        {localPath && onToggleBrowserPanel ? (
          <div className="flex items-center flex-shrink-0 rounded-[9px] h-[30px]">
            <Button
              variant="ghost"
              size="none"
              onClick={onToggleBrowserPanel}
              title="Browser"
              aria-label="Browser"
              aria-pressed={browserPanelVisible}
              className={cn(
                "border border-border/0 hover:!border-border/0 px-1.5 h-9 hover:!bg-transparent",
                browserPanelVisible && "text-foreground"
              )}
            >
              <Globe strokeWidth={2.25} className="h-4" />
            </Button>
          </div>
        ) : null}
      </div>
    </CardHeader>
  )
}
