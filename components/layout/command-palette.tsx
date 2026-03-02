"use client"

import { useState, useCallback, useEffect } from "react"
import { useRouter, usePathname } from "next/navigation"
import { useHotkey } from "@tanstack/react-hotkeys"
import { formatForDisplay } from "@tanstack/react-hotkeys"
import {
  TrendingUp,
  User,
  Key,
  Cpu,
  BookOpen,
  FlaskConical,
  Plus,
  Moon,
  Sun,
  Monitor,
} from "lucide-react"
import { useTheme } from "next-themes"
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
  CommandSeparator,
} from "@/components/ui/command"

interface CommandPaletteItem {
  id: string
  label: string
  icon: React.ReactNode
  shortcutHint?: string
  onSelect: () => void
  group: string
}

export function CommandPalette() {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const pathname = usePathname()
  const { setTheme } = useTheme()

  useHotkey("Mod+K", () => {
    setOpen((prev) => !prev)
  })

  // Listen for custom event from dashboard hotkeys (/ key)
  useEffect(() => {
    const handler = () => setOpen(true)
    window.addEventListener("opendum:toggle-command-palette", handler)
    return () => window.removeEventListener("opendum:toggle-command-palette", handler)
  }, [])

  const navigate = useCallback(
    (href: string) => {
      setOpen(false)
      if (pathname !== href) {
        router.push(href)
      }
    },
    [router, pathname]
  )

  const items: CommandPaletteItem[] = [
    // Navigation
    {
      id: "nav-analytics",
      label: "Go to Analytics",
      icon: <TrendingUp className="size-4" />,
      shortcutHint: "G then D",
      onSelect: () => navigate("/dashboard"),
      group: "Navigation",
    },
    {
      id: "nav-accounts",
      label: "Go to Accounts",
      icon: <User className="size-4" />,
      shortcutHint: "G then A",
      onSelect: () => navigate("/dashboard/accounts"),
      group: "Navigation",
    },
    {
      id: "nav-api-keys",
      label: "Go to API Keys",
      icon: <Key className="size-4" />,
      shortcutHint: "G then K",
      onSelect: () => navigate("/dashboard/api-keys"),
      group: "Navigation",
    },
    {
      id: "nav-models",
      label: "Go to Models",
      icon: <Cpu className="size-4" />,
      shortcutHint: "G then M",
      onSelect: () => navigate("/dashboard/models"),
      group: "Navigation",
    },
    {
      id: "nav-usage",
      label: "Go to Usage",
      icon: <BookOpen className="size-4" />,
      shortcutHint: "G then U",
      onSelect: () => navigate("/dashboard/usage"),
      group: "Navigation",
    },
    {
      id: "nav-playground",
      label: "Go to Playground",
      icon: <FlaskConical className="size-4" />,
      shortcutHint: "G then P",
      onSelect: () => navigate("/dashboard/playground"),
      group: "Navigation",
    },
    // Quick Actions
    {
      id: "action-new-api-key",
      label: "Create New API Key",
      icon: <Plus className="size-4" />,
      shortcutHint: "C",
      onSelect: () => {
        setOpen(false)
        router.push("/dashboard/api-keys")
        // Small delay to allow page to render, then dispatch custom event
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent("opendum:create-api-key"))
        }, 100)
      },
      group: "Actions",
    },
    // Theme
    {
      id: "theme-light",
      label: "Switch to Light Theme",
      icon: <Sun className="size-4" />,
      onSelect: () => {
        setTheme("light")
        setOpen(false)
      },
      group: "Theme",
    },
    {
      id: "theme-dark",
      label: "Switch to Dark Theme",
      icon: <Moon className="size-4" />,
      onSelect: () => {
        setTheme("dark")
        setOpen(false)
      },
      group: "Theme",
    },
    {
      id: "theme-system",
      label: "Switch to System Theme",
      icon: <Monitor className="size-4" />,
      onSelect: () => {
        setTheme("system")
        setOpen(false)
      },
      group: "Theme",
    },
  ]

  const groups = Array.from(new Set(items.map((item) => item.group)))

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command Palette"
      description="Search for commands, navigate pages, or perform actions"
    >
      <CommandInput placeholder="Type a command or search..." />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {groups.map((group, groupIndex) => (
          <div key={group}>
            {groupIndex > 0 && <CommandSeparator />}
            <CommandGroup heading={group}>
              {items
                .filter((item) => item.group === group)
                .map((item) => (
                  <CommandItem
                    key={item.id}
                    value={item.label}
                    onSelect={item.onSelect}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                    {item.shortcutHint && (
                      <CommandShortcut>{item.shortcutHint}</CommandShortcut>
                    )}
                  </CommandItem>
                ))}
            </CommandGroup>
          </div>
        ))}
        <CommandSeparator />
        <CommandGroup heading="Help">
          <CommandItem disabled>
            <span className="text-muted-foreground text-xs">
              Open palette: <kbd className="bg-muted rounded px-1.5 py-0.5 font-mono text-[10px]">{formatForDisplay("Mod+K")}</kbd>
            </span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
