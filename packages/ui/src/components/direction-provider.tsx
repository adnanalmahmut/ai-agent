"use client";

import { Direction as DirectionPrimitive } from "radix-ui";
import * as React from "react";

export type Direction = "rtl" | "ltr";

export type DirectionProviderProps = {
  direction: Direction;
  children?: React.ReactNode;
};

export function DirectionProvider({
  direction,
  children,
}: DirectionProviderProps) {
  return (
    <DirectionPrimitive.DirectionProvider dir={direction}>
      {children}
    </DirectionPrimitive.DirectionProvider>
  );
}

export function useDirection(localDirection?: Direction): Direction {
  return DirectionPrimitive.useDirection(localDirection);
}
