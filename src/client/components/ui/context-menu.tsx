import * as React from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"
import { cn } from "../../lib/utils"

const ContextMenuCloseContext = React.createContext<(() => void) | null>(null)

function ContextMenu({
  onOpenChange,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Root>) {
  const [resetKey, setResetKey] = React.useState(0)

  const close = React.useCallback(() => {
    setResetKey((current) => current + 1)
    onOpenChange?.(false)
  }, [onOpenChange])

  return (
    <ContextMenuCloseContext.Provider value={close}>
      <ContextMenuPrimitive.Root
        key={resetKey}
        onOpenChange={onOpenChange}
        {...props}
      />
    </ContextMenuCloseContext.Provider>
  )
}

const ContextMenuTrigger = ContextMenuPrimitive.Trigger
const ContextMenuSub = ContextMenuPrimitive.Sub
const ContextMenuSubTrigger = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger>
>(({ className, ...props }, ref) => <ContextMenuPrimitive.SubTrigger ref={ref} className={cn("flex cursor-default select-none items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium outline-hidden focus:bg-muted data-[state=open]:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50", className)} {...props} />)
ContextMenuSubTrigger.displayName = "ContextMenuSubTrigger"
const ContextMenuSubContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(({ className, ...props }, ref) => <ContextMenuPrimitive.Portal><ContextMenuPrimitive.SubContent ref={ref} className={cn("z-50 max-h-[var(--radix-context-menu-content-available-height)] min-w-56 max-w-[calc(100vw-16px)] overflow-y-auto rounded-xl border border-border bg-background p-1 text-foreground shadow-lg outline-hidden", className)} {...props} /></ContextMenuPrimitive.Portal>)
ContextMenuSubContent.displayName = "ContextMenuSubContent"

const ContextMenuContent = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Portal>
    <ContextMenuPrimitive.Content
      ref={ref}
      className={cn(
        "z-50 min-w-[170px] overflow-hidden rounded-xl border border-border bg-background p-1 shadow-lg outline-hidden animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        className
      )}
      {...props}
    />
  </ContextMenuPrimitive.Portal>
))
ContextMenuContent.displayName = ContextMenuPrimitive.Content.displayName

const ContextMenuItem = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & { closeOnSelect?: boolean }
>(({ className, onSelect, closeOnSelect = true, ...props }, ref) => {
  const closeContextMenu = React.useContext(ContextMenuCloseContext)

  return (
    <ContextMenuPrimitive.Item
      ref={ref}
      className={cn(
        "relative flex cursor-default select-none items-center gap-2.5 rounded-lg px-3 py-2 text-xs font-medium text-foreground outline-hidden transition-colors hover:bg-muted focus:bg-muted data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
        className
      )}
      onSelect={(event) => {
        onSelect?.(event)
        if (closeOnSelect) closeContextMenu?.()
      }}
      {...props}
    />
  )
})
ContextMenuItem.displayName = ContextMenuPrimitive.Item.displayName

const ContextMenuSeparator = React.forwardRef<
  React.ComponentRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <ContextMenuPrimitive.Separator
    ref={ref}
    className={cn("-mx-1 my-1 h-px bg-border", className)}
    {...props}
  />
))
ContextMenuSeparator.displayName = ContextMenuPrimitive.Separator.displayName

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
}
