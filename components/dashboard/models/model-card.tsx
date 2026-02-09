"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Eye, Copy, Check, Brain, Wrench, Calendar } from "lucide-react";
import type { ModelMeta } from "@/lib/proxy/models";

interface ModelCardProps {
  id: string;
  providers: string[];
  meta?: ModelMeta;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(1)}M`;
  }
  if (tokens >= 1000) {
    return `${Math.round(tokens / 1000)}K`;
  }
  return tokens.toString();
}

function formatDate(dateStr: string): string {
  // Format: "2025-04" or "2025-04-29"
  const parts = dateStr.split("-");
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const year = parts[0];
  const month = months[parseInt(parts[1], 10) - 1];
  return `${month} ${year}`;
}

export function ModelCard({ id, providers, meta }: ModelCardProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card className="flex flex-col bg-card py-4">
      <CardHeader className="px-4 pb-2 sm:px-5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-mono truncate" title={id}>{id}</CardTitle>
            {/* Provider Badges */}
            <div className="flex flex-wrap gap-1 mt-1.5">
              {providers.map((provider) => (
                <Badge key={provider} variant="secondary" className="text-xs">
                  {provider}
                </Badge>
              ))}
            </div>
          </div>
          {/* Pricing - top right */}
          {meta?.pricing && (
            <div className="text-xs text-muted-foreground whitespace-nowrap">
              ${meta.pricing.input} · ${meta.pricing.output}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col px-4 sm:px-5">
        {/* Metadata Section - only show if meta exists */}
        {meta && (
          <div className="space-y-2 text-xs text-muted-foreground mb-3">
            {/* Context & Output */}
            {(meta.contextLength || meta.outputLimit) && (
              <div className="flex items-center gap-2 flex-wrap">
                {meta.contextLength && (
                  <span>{formatTokens(meta.contextLength)} in</span>
                )}
                {meta.contextLength && meta.outputLimit && <span>·</span>}
                {meta.outputLimit && (
                  <span>{formatTokens(meta.outputLimit)} out</span>
                )}
                {meta.knowledgeCutoff && (
                  <>
                    <span>·</span>
                    <span className="flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {formatDate(meta.knowledgeCutoff)}
                    </span>
                  </>
                )}
              </div>
            )}

            {/* Capability Badges */}
            {(meta.reasoning || meta.toolCall || meta.vision) && (
              <div className="flex flex-wrap gap-1">
                {meta.reasoning && (
                  <Badge variant="outline" className="text-xs py-0 h-5">
                    <Brain className="h-3 w-3 mr-1" />
                    Reasoning
                  </Badge>
                )}
                {meta.toolCall && (
                  <Badge variant="outline" className="text-xs py-0 h-5">
                    <Wrench className="h-3 w-3 mr-1" />
                    Tools
                  </Badge>
                )}
                {meta.vision && (
                  <Badge variant="outline" className="text-xs py-0 h-5">
                    <Eye className="h-3 w-3 mr-1" />
                    Vision
                  </Badge>
                )}
              </div>
            )}
          </div>
        )}

        <Button
          variant="outline"
          size="sm"
          className="mt-auto w-full"
          onClick={handleCopy}
        >
          {copied ? (
            <>
              <Check className="h-4 w-4 mr-2" />
              Copied!
            </>
          ) : (
            <>
              <Copy className="h-4 w-4 mr-2" />
              Copy Model ID
            </>
          )}
        </Button>
      </CardContent>
    </Card>
  );
}
