"use client";

import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Cpu, Zap, Eye, Code, Database, Copy, Check } from "lucide-react";

type ModelCategory = "Chat" | "Thinking" | "Coding" | "Vision" | "Large" | "Other";

interface ModelCardProps {
  id: string;
  category: ModelCategory;
  usage: number;
}

function getCategoryIcon(category: ModelCategory) {
  switch (category) {
    case "Chat":
      return <Zap className="h-4 w-4" />;
    case "Thinking":
      return <Database className="h-4 w-4" />;
    case "Coding":
      return <Code className="h-4 w-4" />;
    case "Vision":
      return <Eye className="h-4 w-4" />;
    case "Large":
      return <Cpu className="h-4 w-4" />;
    default:
      return <Cpu className="h-4 w-4" />;
  }
}

function getCategoryColor(category: ModelCategory) {
  switch (category) {
    case "Chat":
      return "default";
    case "Thinking":
      return "secondary";
    case "Coding":
      return "outline";
    case "Vision":
      return "default";
    case "Large":
      return "secondary";
    default:
      return "outline";
  }
}

export function ModelCard({ id, category, usage }: ModelCardProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-lg font-mono truncate">{id}</CardTitle>
            <CardDescription className="mt-1 flex items-center">
              {getCategoryIcon(category)}
              <span className="ml-1">{category} Model</span>
            </CardDescription>
          </div>
          <Badge variant={getCategoryColor(category) as "default" | "secondary" | "outline"}>
            {usage} {usage === 1 ? "request" : "requests"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <Button
          variant="outline"
          size="sm"
          className="w-full"
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