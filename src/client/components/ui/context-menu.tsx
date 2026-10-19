import * as React from "react"
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu"
import { cn } from "../../lib/utils"

const ContextMenuTriggerRefContext = React.createContext<React.RefObject<HTMLElement | null> | null>(null)
const ContextMenuCloseContext = React.createContext<(() => void) | null>(null)

function ContextMenu({
  onOpenChange,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Root>) {
  const [resetKey, setResetKey] = React.useState(0)
  const [open, setOpen] = React.useState(false)
  const triggerRef = React.useRef<HTMLElement | null>(null)

  const close = React.useCallback(() => {
    setOpen(false)
    setResetKey((current) => current + 1)
    onOpenChange?.(false)
    window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }, [onOpenChange])

  React.useEffect(() => {
    if (!open) return
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !(event.target instanceof Element) || !event.target.closest('[role="menu"]')) return
      // Submenus retain their own Escape handling; this reset is for a flat root.
      if (document.querySelectorAll('[data-radix-menu-content][data-state="open"]').length > 1) return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    window.addEventListener("keydown", escape, true)
    return () => window.removeEventListener("keydown", escape, true)
  }, [open, close])

  return (
    <ContextMenuCloseContext.Provider value={close}>
    <ContextMenuTriggerRefContext.Provider value={triggerRef}>
      <ContextMenuPrimitive.Root
        key={resetKey}
        onOpenChange={value => { setOpen(value); onOpenChange?.(value) }}
        {...props}
      />
    </ContextMenuTriggerRefContext.Provider>
    </ContextMenuCloseContext.Provider>
  )
}

const ContextMenuTrigger = React.forwardRef<React.ComponentRef<typeof ContextMenuPrimitive.Trigger>, React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Trigger>>((props, forwardedRef) => {
  const triggerRef = React.useContext(ContextMenuTriggerRefContext)
  return <ContextMenuPrimitive.Trigger {...props} ref={node => {
    if (triggerRef) triggerRef.current = node
    if (typeof forwardedRef === "function") forwardedRef(node)
    else if (forwardedRef) forwardedRef.current = node
  }} />
})
ContextMenuTrigger.displayName = ContextMenuPrimitive.Trigger.displayName
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
