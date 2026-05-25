import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90",
        // Solid emerald — forward progression (Resume, Start queue, Add to queue at detail level)
        success:
          "bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 dark:bg-emerald-500 dark:text-emerald-950 dark:hover:bg-emerald-400",
        // Solid amber — pause / hold (Pause queue, Pause at detail level)
        warning:
          "bg-amber-500 text-amber-50 shadow-sm hover:bg-amber-600 dark:bg-amber-400 dark:text-amber-950 dark:hover:bg-amber-300",
        // Solid sky — recovery / retry
        info:
          "bg-sky-600 text-white shadow-sm hover:bg-sky-700 dark:bg-sky-500 dark:text-sky-950 dark:hover:bg-sky-400",
        // Soft tints — row-level companions to the solid variants. Same hue,
        // less visual weight, so a queue full of rows stays scannable.
        successSoft:
          "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-500/30 dark:hover:bg-emerald-500/20",
        warningSoft:
          "bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-200 hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/30 dark:hover:bg-amber-500/20",
        destructiveSoft:
          "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200 hover:bg-red-100 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/30 dark:hover:bg-red-500/20",
        infoSoft:
          "bg-sky-50 text-sky-800 ring-1 ring-inset ring-sky-200 hover:bg-sky-100 dark:bg-sky-500/10 dark:text-sky-200 dark:ring-sky-500/30 dark:hover:bg-sky-500/20",
        accentSoft:
          "bg-violet-50 text-violet-800 ring-1 ring-inset ring-violet-200 hover:bg-violet-100 dark:bg-violet-500/10 dark:text-violet-200 dark:ring-violet-500/30 dark:hover:bg-violet-500/20",
        secondarySoft:
          "bg-zinc-100 text-zinc-700 ring-1 ring-inset ring-zinc-200 hover:bg-zinc-200 dark:bg-zinc-500/10 dark:text-zinc-300 dark:ring-zinc-500/30 dark:hover:bg-zinc-500/20",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9",
        iconSm: "h-8 w-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
