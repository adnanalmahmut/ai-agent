"use client"

import { Label as LabelPrimitive } from "radix-ui"
import * as React from "react"

import { cn } from "@repo/ui/lib/utils"

/**
 * Form label.
 *
 * Radix rather than a bare `<label>` so clicking the text focuses the control
 * even when the control is a composite (a password field with a reveal
 * button, for example) — and so `peer-disabled` styling works without every
 * form re-deriving it.
 */
function Label({
  className,
  ...props
}: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        "flex items-center gap-2 text-sm leading-none font-medium select-none",
        "group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50",
        "peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
        className
      )}
      {...props}
    />
  )
}

export { Label }
