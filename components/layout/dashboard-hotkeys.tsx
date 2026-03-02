"use client"

import { useRouter, usePathname } from "next/navigation"
import { useCallback } from "react"
import { useHotkeySequence, useHotkey } from "@tanstack/react-hotkeys"

export function DashboardHotkeys() {
  const router = useRouter()
  const pathname = usePathname()

  const navigate = useCallback(
    (href: string) => {
      if (pathname !== href) {
        router.push(href)
      }
    },
    [router, pathname]
  )

  // ── Navigation sequences (G then <key>) ──────────────────────────

  // G D → Dashboard / Analytics
  useHotkeySequence(["G", "D"], () => {
    navigate("/dashboard")
  })

  // G A → Accounts
  useHotkeySequence(["G", "A"], () => {
    navigate("/dashboard/accounts")
  })

  // G K → API Keys
  useHotkeySequence(["G", "K"], () => {
    navigate("/dashboard/api-keys")
  })

  // G M → Models
  useHotkeySequence(["G", "M"], () => {
    navigate("/dashboard/models")
  })

  // G U → Usage
  useHotkeySequence(["G", "U"], () => {
    navigate("/dashboard/usage")
  })

  // G P → Playground
  useHotkeySequence(["G", "P"], () => {
    navigate("/dashboard/playground")
  })

  // ── Quick actions ─────────────────────────────────────────────────

  // C → Create new API key (navigates to api-keys page and triggers dialog)
  useHotkey("C", () => {
    if (pathname === "/dashboard/api-keys") {
      window.dispatchEvent(new CustomEvent("opendum:create-api-key"))
    } else {
      router.push("/dashboard/api-keys")
      setTimeout(() => {
        window.dispatchEvent(new CustomEvent("opendum:create-api-key"))
      }, 300)
    }
  })

  // / → Show keyboard shortcuts help (opens command palette)
  useHotkey("/", () => {
    window.dispatchEvent(new CustomEvent("opendum:toggle-command-palette"))
  })

  return null
}
