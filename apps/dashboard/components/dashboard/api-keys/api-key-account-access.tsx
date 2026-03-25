"use client";

import { useMemo, useState } from "react";
import { Check, ChevronDown, ShieldCheck, X } from "lucide-react";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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

  const [open, setOpen] = useState(false);
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

  const modeLabel =
    savedMode === "all"
      ? "All accounts"
      : savedMode === "whitelist"
        ? "Whitelist"
        : "Blacklist";

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

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      resetDraftState();
    }
    setOpen(nextOpen);
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
      setOpen(false);
      setAccountPickerOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update account access");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground cursor-pointer"
        >
          <ShieldCheck className="h-3 w-3" />
          <span>{modeLabel}</span>
          {savedMode !== "all" && (
            <span className="text-muted-foreground/70">({normalizedSavedAccounts.length})</span>
          )}
        </button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Account Access Rules</DialogTitle>
          <DialogDescription className="sr-only">
            Control which provider accounts can be used with this API key.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
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
              <ToggleGroupItem value="all">All</ToggleGroupItem>
              <ToggleGroupItem value="whitelist">Whitelist</ToggleGroupItem>
              <ToggleGroupItem value="blacklist">Blacklist</ToggleGroupItem>
            </ToggleGroup>
          </div>

          {draftMode !== "all" && (
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium">Accounts</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-[11px]"
                  onClick={() => setDraftAccounts([])}
                  disabled={normalizedDraftAccounts.length === 0}
                >
                  Clear
                </Button>
              </div>

              <Popover open={accountPickerOpen} onOpenChange={setAccountPickerOpen}>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="h-8 w-full justify-between px-2.5 text-xs"
                    disabled={isSaving}
                  >
                    <span className="truncate">
                      {normalizedDraftAccounts.length > 0
                        ? `${normalizedDraftAccounts.length} account selected`
                        : "Select accounts"}
                    </span>
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
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
                                  "h-3 w-3",
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

              <div className="max-h-28 overflow-y-auto rounded-md border border-border bg-muted/20 p-1.5">
                {normalizedDraftAccounts.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground px-1">No accounts selected</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {normalizedDraftAccounts.map((accountId) => {
                      const account = accountMap.get(accountId);
                      const label = account
                        ? getAccountLabel(account)
                        : accountId;
                      return (
                        <Badge key={accountId} variant="secondary" className="max-w-full gap-0.5 pr-0.5 font-normal text-[10px] py-0">
                          <span className="min-w-0 truncate">{label}</span>
                          <button
                            type="button"
                            className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-sm text-muted-foreground cursor-pointer hover:text-foreground"
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

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={isSaving || !hasChanges}>
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
