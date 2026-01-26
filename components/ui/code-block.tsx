"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import type { BundledLanguage } from "shiki";

interface CodeBlockProps {
  code: string;
  language: BundledLanguage;
  className?: string;
}

export function CodeBlock({ code, language, className = "" }: CodeBlockProps) {
  const { resolvedTheme } = useTheme();
  const [html, setHtml] = React.useState<string>("");
  const [loading, setLoading] = React.useState(true);

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
      <pre className={`rounded bg-muted p-3 text-sm overflow-x-auto ${className}`}>
        <code>{code}</code>
      </pre>
    );
  }

  return (
    <div
      className={`shiki rounded bg-muted p-3 text-sm overflow-x-auto ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}