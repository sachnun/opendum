"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, RotateCcw, ShieldCheck, X } from "lucide-react";
import { toast } from "sonner";
import { updateApiKeyAccountAccess, type ApiKeyAccountAccessMode } from "@/lib/actions/api-keys";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

export interface ProviderAccountOption {
  id: string;
  provider: string;
  name: string;
  email: string | null;
}

interface ApiKeyAccountAccessProps {
  apiKeyId: string;
  availableAccounts: ProviderAccountOption[];
  initialMode: ApiKeyAccountAccessMode;
  initialAccounts: string[];
}

function normalizeAccounts(accounts: string[]): string[] {
  return Array.from(new Set(accounts)).sort((a, b) => a.localeCompare(b));
}

function sameAccountList(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((id, index) => id === right[index]);
}

function getModeLabel(mode: ApiKeyAccountAccessMode): string {
  if (mode === "all") {
    return "All accounts";
  }

  if (mode === "whitelist") {
    return "Whitelist";
  }

  return "Blacklist";
}

function getAccountLabel(account: ProviderAccountOption): string {
  if (account.email) {
    return `${account.name} (${account.email})`;
  }
  return account.name;
}

export function ApiKeyAccountAccess({
  apiKeyId,
  availableAccounts,
  initialMode,
  initialAccounts,
}: ApiKeyAccountAccessProps) {
  const normalizedInitialAccounts = useMemo(() => normalizeAccounts(initialAccounts), [initialAccounts]);

  const [accountPickerOpen, setAccountPickerOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const [savedMode, setSavedMode] = useState<ApiKeyAccountAccessMode>(initialMode);
  const [savedAccounts, setSavedAccounts] = useState<string[]>(normalizedInitialAccounts);

  const [draftMode, setDraftMode] = useState<ApiKeyAccountAccessMode>(initialMode);
  const [draftAccounts, setDraftAccounts] = useState<string[]>(normalizedInitialAccounts);

  const normalizedDraftAccounts = useMemo(() => normalizeAccounts(draftAccounts), [draftAccounts]);
  const normalizedSavedAccounts = useMemo(() => normalizeAccounts(savedAccounts), [savedAccounts]);

  const accountsForSave = draftMode === "all" ? [] : normalizedDraftAccounts;
  const hasChanges =
    draftMode !== savedMode ||
    !sameAccountList(accountsForSave, draftMode === "all" ? [] : normalizedSavedAccounts);

  const accountMap = useMemo(() => {
    const map = new Map<string, ProviderAccountOption>();
    for (const account of availableAccounts) {
      map.set(account.id, account);
    }
    return map;
  }, [availableAccounts]);

  const resetDraftState = () => {
    setDraftMode(savedMode);
    setDraftAccounts(normalizedSavedAccounts);
    setAccountPickerOpen(false);
  };

  const toggleAccount = (accountId: string) => {
    setDraftAccounts((current) => {
      if (current.includes(accountId)) {
        return current.filter((id) => id !== accountId);
      }
      return [...current, accountId];
    });
  };

  const handleSave = async () => {
    if (draftMode !== "all" && accountsForSave.length === 0) {
      toast.error("Select at least one account");
      return;
    }

    setIsSaving(true);
    try {
      const result = await updateApiKeyAccountAccess(apiKeyId, draftMode, accountsForSave);
      if (!result.success) {
        throw new Error(result.error);
      }

      const nextAccounts = normalizeAccounts(result.data.accounts);
      setSavedMode(result.data.mode);
      setSavedAccounts(nextAccounts);
      setDraftMode(result.data.mode);
      setDraftAccounts(nextAccounts);
      setAccountPickerOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update account access");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="flex h-full flex-col rounded-xl border border-border/70 bg-muted/20 p-4 lg:border lg:border-border/70 lg:bg-muted/20 max-lg:border-0 max-lg:bg-transparent max-lg:p-0">
      <div className="hidden items-start justify-between gap-3 lg:flex">
        <div className="inline-flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <span>Account Access</span>
        </div>
        <Badge variant="outline" className="shrink-0">
          {getModeLabel(savedMode)}
        </Badge>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs lg:mt-4">
        <div className="rounded-lg border border-border/60 bg-background/80 px-3 py-2">
          <p className="text-[11px] text-muted-foreground">Mode</p>
          <p className="mt-1 font-medium">{getModeLabel(savedMode)}</p>
        </div>
        <div className="rounded-lg border border-border/60 bg-background/80 px-3 py-2">
          <p className="text-[11px] text-muted-foreground">Selected</p>
          <p className="mt-1 font-medium">
            {savedMode === "all" ? "All accounts" : `${normalizedSavedAccounts.length} account`}
            {savedMode !== "all" && normalizedSavedAccounts.length !== 1 ? "s" : ""}
          </p>
        </div>
      </div>

      <div className="space-y-3 flex-1 lg:mt-4">
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Mode</p>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={draftMode}
            onValueChange={(value) => {
              if (value === "all" || value === "whitelist" || value === "blacklist") {
                setDraftMode(value);
              }
            }}
            className="w-full justify-start"
          >
            <ToggleGroupItem value="all" className="flex-1">All</ToggleGroupItem>
            <ToggleGroupItem value="whitelist" className="flex-1">Whitelist</ToggleGroupItem>
            <ToggleGroupItem value="blacklist" className="flex-1">Blacklist</ToggleGroupItem>
          </ToggleGroup>
        </div>

        {draftMode !== "all" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium">Accounts</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => setDraftAccounts([])}
                disabled={normalizedDraftAccounts.length === 0 || isSaving}
              >
                Clear
              </Button>
            </div>

            <Popover open={accountPickerOpen} onOpenChange={setAccountPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className="h-9 w-full justify-between px-3 text-xs"
                  disabled={isSaving}
                >
                  <span className="truncate">
                    {normalizedDraftAccounts.length > 0
                      ? `${normalizedDraftAccounts.length} account selected`
                      : "Select accounts"}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-[min(90vw,28rem)] p-0">
                <Command>
                  <CommandInput placeholder="Search account..." />
                  <CommandList>
                    <CommandEmpty>No account found.</CommandEmpty>
                    <CommandGroup>
                      {availableAccounts.map((account) => {
                        const selected = normalizedDraftAccounts.includes(account.id);
                        return (
                          <CommandItem
                            key={account.id}
                            value={`${account.provider} ${account.name} ${account.email ?? ""}`}
                            onSelect={() => toggleAccount(account.id)}
                            className="gap-2"
                          >
                            <Check
                              className={cn(
                                "h-3.5 w-3.5",
                                selected ? "opacity-100" : "opacity-0"
                              )}
                            />
                            <div className="flex min-w-0 flex-col">
                              <span className="truncate text-xs font-medium">{account.name}</span>
                              <span className="truncate text-[11px] text-muted-foreground">
                                {account.provider}
                                {account.email ? ` - ${account.email}` : ""}
                              </span>
                            </div>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            <div className="max-h-40 overflow-y-auto rounded-lg border border-border/60 bg-background/80 p-2">
              {normalizedDraftAccounts.length === 0 ? (
                <p className="px-1 text-[11px] text-muted-foreground">No accounts selected</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {normalizedDraftAccounts.map((accountId) => {
                    const account = accountMap.get(accountId);
                    const label = account ? getAccountLabel(account) : accountId;
                    return (
                      <Badge
                        key={accountId}
                        variant="secondary"
                        className="max-w-full gap-1 pr-1 font-normal text-[10px]"
                      >
                        <span className="min-w-0 truncate">{label}</span>
                        <button
                          type="button"
                          className="inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                          onClick={() => toggleAccount(accountId)}
                          aria-label={`Remove ${label}`}
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </Badge>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border/60 pt-3 lg:mt-4">
        <Button
          variant="outline"
          size="sm"
          onClick={resetDraftState}
          disabled={isSaving || !hasChanges}
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </Button>
        <Button size="sm" onClick={handleSave} disabled={isSaving || !hasChanges}>
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>
    </section>
  );
}
