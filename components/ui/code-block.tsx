"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { useTheme } from "next-themes";
import type { BundledLanguage } from "shiki";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  language: BundledLanguage;
  className?: string;
  showCopyButton?: boolean;
  copyButtonLabel?: string;
}

export function CodeBlock({
  code,
  language,
  className = "",
  showCopyButton = false,
  copyButtonLabel = "snippet",
}: CodeBlockProps) {
  const { resolvedTheme } = useTheme();
  const [html, setHtml] = React.useState<string>("");
  const [loading, setLoading] = React.useState(true);
  const [copied, setCopied] = React.useState(false);
  const resetCopyTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const codeSurfaceClassName = cn(
    "rounded bg-muted p-3 text-sm overflow-x-auto",
    showCopyButton && "pt-10",
    className,
  );

  const handleCopy = React.useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);

      if (resetCopyTimeoutRef.current) {
        clearTimeout(resetCopyTimeoutRef.current);
      }

      resetCopyTimeoutRef.current = setTimeout(() => {
        setCopied(false);
      }, 1800);
    } catch (error) {
      console.error("Failed to copy code snippet", error);
    }
  }, [code]);

  React.useEffect(() => {
    return () => {
      if (resetCopyTimeoutRef.current) {
        clearTimeout(resetCopyTimeoutRef.current);
      }
    };
  }, []);

  React.useEffect(() => {
    const highlightCode = async () => {
      const shiki = await import("shiki");
      const highlighter = await shiki.createHighlighter({
        themes: ["github-light", "github-dark"],
        langs: [language],
      });

      const theme = resolvedTheme === "dark" ? "github-dark" : "github-light";
      const highlighted = highlighter.codeToHtml(code, {
        lang: language,
        theme,
      });

      setHtml(highlighted);
      setLoading(false);
    };

    highlightCode().catch(console.error);
  }, [code, language, resolvedTheme]);

  if (loading) {
    return (
      <div className="relative">
        {showCopyButton ? (
          <Button
            type="button"
            variant="secondary"
            size="xs"
            className="absolute top-2 right-2 z-10"
            onClick={handleCopy}
            aria-label={copied ? `Copied ${copyButtonLabel}` : `Copy ${copyButtonLabel}`}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            {copied ? "Copied" : "Copy"}
          </Button>
        ) : null}

        <pre className={codeSurfaceClassName}>
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="relative">
      {showCopyButton ? (
        <Button
          type="button"
          variant="secondary"
          size="xs"
          className="absolute top-2 right-2 z-10"
          onClick={handleCopy}
          aria-label={copied ? `Copied ${copyButtonLabel}` : `Copy ${copyButtonLabel}`}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      ) : null}

      <div className={cn("shiki", codeSurfaceClassName)} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
