"use client"

import { Direction as DirectionPrimitive } from "radix-ui"
import * as React from "react"

/**
 * The only i18n concept this package is allowed to know about.
 *
 * `@repo/ui` must never learn about locales (`ar`, `en`), locale prefixes,
 * cookies, or any routing library. The consuming application resolves the
 * locale and hands down a plain reading direction.
 */
export type Direction = "rtl" | "ltr"

export type DirectionProviderProps = {
  direction: Direction
  children?: React.ReactNode
}

/**
 * Project-level direction boundary.
 *
 * Radix primitives that render through a Portal (Dialog, DropdownMenu,
 * Select, Popover, Tooltip, …) mount outside the subtree that carries
 * `<html dir>`, so they cannot infer direction from the DOM ancestor chain.
 * They read it from this context instead — which is why setting `dir` on
 * `<html>` alone is not sufficient.
 *
 * Radix is an implementation detail here: consumers depend on this component,
 * never on `radix-ui`'s own provider.
 */
export function DirectionProvider({
  direction,
  children,
}: DirectionProviderProps) {
  return (
    <DirectionPrimitive.DirectionProvider dir={direction}>
      {children}
    </DirectionPrimitive.DirectionProvider>
  )
}

/**
 * Reads the current direction inside `@repo/ui` components.
 *
 * Use this when a component genuinely needs to branch on direction. Never
 * branch on a locale — `direction === "rtl"` is the only allowed condition.
 */
export function useDirection(localDirection?: Direction): Direction {
  return DirectionPrimitive.useDirection(localDirection)
}
