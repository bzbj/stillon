import type { ComponentType } from "react"
import { Monitor } from "lucide-react"
import { cn } from "../lib/utils"

interface PageHeaderProps {
  narrow?: boolean
  title: string
  subtitle?: string
  icon?: ComponentType<{ className?: string }>
}

export function PageHeader({
  narrow = false,
  title,
  subtitle,
  icon: Icon = Monitor,
}: PageHeaderProps) {
  return (
    <div className={cn("w-full", narrow ? "max-w-2xl px-6 pt-16 mx-auto" : "px-6 pt-16 mb-10")}>
      <div className={cn("flex items-center gap-1 mb-2", narrow && "justify-center")}>
        <div className="p-2 pl-0 rounded-lg">
          <Icon className="h-6 w-6 text-muted-foreground" />
        </div>
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
      </div>
      {subtitle && <p className={cn("text-muted-foreground", narrow && "mb-10 text-center")}>{subtitle}</p>}
    </div>
  )
}
