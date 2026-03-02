"use client"

import { HotkeysProvider as TanStackHotkeysProvider } from "@tanstack/react-hotkeys"
import type { ReactNode } from "react"

export function AppHotkeysProvider({ children }: { children: ReactNode }) {
  return (
    <TanStackHotkeysProvider
      defaultOptions={{
        hotkey: {
          preventDefault: true,
          stopPropagation: true,
        },
        hotkeySequence: {
          timeout: 800,
        },
      }}
    >
      {children}
    </TanStackHotkeysProvider>
  )
}
