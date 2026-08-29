import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

const MIN_PROGRESS_VALUE = 0
const MAX_PROGRESS_VALUE = 100

/**
 * shadcn-style wrapper around the Radix Progress primitive, mirroring
 * `slider.tsx`'s house style (Root + one filled child, semantic theme tokens,
 * `data-slot` naming). Radix supplies `role="progressbar"` and
 * `aria-valuenow` automatically — do not hand-roll either.
 */
function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  const clamped = Math.min(Math.max(value ?? MIN_PROGRESS_VALUE, MIN_PROGRESS_VALUE), MAX_PROGRESS_VALUE)

  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn("bg-muted relative h-2 w-full overflow-hidden rounded-full", className)}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="bg-toggle-active h-full w-full flex-1 transition-transform"
        style={{ transform: `translateX(-${MAX_PROGRESS_VALUE - clamped}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
