import { ComponentPropsWithoutRef, CSSProperties, FC } from "react"

import { cn } from "../../lib/utils"

export interface AnimatedShinyTextProps extends ComponentPropsWithoutRef<"span"> {
  shimmerWidth?: number
  animate?: boolean
}

export const AnimatedShinyText: FC<AnimatedShinyTextProps> = ({
  children,
  className,
  shimmerWidth = 100,
  animate = true,
  ...props
}) => {
  return (
    <span
      style={
        {
          "--shiny-width": `${Math.min(shimmerWidth, 100)}px`,
        } as CSSProperties
      }
      className={cn(
        "mx-auto max-w-md text-foreground/50",

        // Only apply animation classes when animate is true
        animate ? [
          // Shine effect
          "animate-shiny-text [background-size:var(--shiny-width)_100%] bg-clip-text [background-position:0_0] bg-no-repeat [transition:background-position_1s_cubic-bezier(.6,.6,0,1)_infinite]",

          // Shine gradient
          "bg-gradient-to-r from-transparent via-black/80 via-50% to-transparent dark:via-white/80",
        ] : ["text-neutral"],

        className
      )}
      {...props}
    >
      {children}
    </span>
  )
}
