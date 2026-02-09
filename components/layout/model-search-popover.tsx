"use client";

import { useState } from "react";
import { ChevronDown, Copy, Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface ModelSearchItem {
  id: string;
  providers: string[];
}

interface ModelSearchPopoverProps {
  models: ModelSearchItem[];
  className?: string;
}

export function ModelSearchPopover({ models, className }: ModelSearchPopoverProps) {
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleSelect = async (modelId: string, close: () => void) => {
    try {
      await navigator.clipboard.writeText(modelId);
      close();
      toast.success(`Model copied: ${modelId}`);
    } catch {
      toast.error("Failed to copy model ID");
    }
  };

  const renderCommandContent = (close: () => void) => (
    <>
      <CommandInput placeholder="Search model ID or provider..." />
      <CommandList>
        <CommandEmpty>No model found.</CommandEmpty>
        <CommandGroup heading="Models">
          {models.map((model) => (
            <CommandItem
              key={model.id}
              value={`${model.id} ${model.providers.join(" ")}`}
              onSelect={() => {
                void handleSelect(model.id, close);
              }}
              className="items-start gap-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-xs sm:text-sm">{model.id}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {model.providers.map((provider) => (
                    <Badge key={`${model.id}-${provider}`} variant="outline" className="text-[10px]">
                      {provider}
                    </Badge>
                  ))}
                </div>
              </div>
              <Copy className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </>
  );

  const triggerClassName = cn(
    "h-9 w-full justify-between rounded-lg border-border bg-background px-2.5 text-xs font-normal sm:px-3 sm:text-sm",
    className
  );

  return (
    <>
      <div className="hidden md:block">
        <Popover open={desktopOpen} onOpenChange={setDesktopOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              role="combobox"
              aria-expanded={desktopOpen}
              className={triggerClassName}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Search className="h-4 w-4 text-muted-foreground" />
                <span className="truncate text-muted-foreground">Search models...</span>
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(92vw,30rem)] p-0">
            <Command>{renderCommandContent(() => setDesktopOpen(false))}</Command>
          </PopoverContent>
        </Popover>
      </div>

      <div className="md:hidden">
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={mobileOpen}
          onClick={() => setMobileOpen(true)}
          className={triggerClassName}
        >
          <span className="flex min-w-0 items-center gap-2">
            <Search className="h-4 w-4 text-muted-foreground" />
            <span className="truncate text-muted-foreground">Search models...</span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </Button>
        <CommandDialog
          open={mobileOpen}
          onOpenChange={setMobileOpen}
          title="Search Models"
          description="Find a model and tap to copy model ID"
          className="p-0"
        >
          {renderCommandContent(() => setMobileOpen(false))}
        </CommandDialog>
      </div>
    </>
  );
}
