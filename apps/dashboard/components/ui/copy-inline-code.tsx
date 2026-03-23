"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

interface CopyInlineCodeProps {
  value: string;
  className?: string;
}

export function CopyInlineCode({ value, className }: CopyInlineCodeProps) {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => setCopied(false), 1800);
    } catch {
      console.error("Failed to copy to clipboard");
    }
  };

  const Icon = copied ? Check : Copy;

  return (
    <code
      className={cn(
        "inline-flex items-center gap-1 rounded bg-muted px-1 py-0.5 text-xs",
        className,
      )}
    >
      {value}
      <button
        type="button"
        onClick={handleCopy}
        className="inline-flex shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        aria-label={copied ? "Copied" : "Copy to clipboard"}
      >
        <Icon className="size-3" />
      </button>
    </code>
  );
}
