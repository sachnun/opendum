import type { Registry } from "@opendum/models/runtime";
import { numberFromAny, stringValue } from "#providers/lib/helpers.ts";
import type { Json } from "#providers/providers/kiro/constants.ts";
import { defaultAny, defaultThinkingBudget, lastModelSegment } from "#providers/providers/kiro/helpers.ts";

export function kiroExplicitThinkingBudget(body: Json): number {
  const direct = numberFromAny(body.thinking_budget);
  if (direct > 0) return direct;
  const reasoning = body.reasoning;
  if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    for (const key of ["max_tokens", "budget_tokens", "thinking_budget"]) {
      const budget = numberFromAny((reasoning as Json)[key]);
      if (budget > 0) return budget;
    }
  }
  return 0;
}

export function kiroReasoningEffort(body: Json): string {
  const reasoning = body.reasoning;
  if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const effort = stringValue((reasoning as Json).effort);
    if (effort) return effort;
  }
  return stringValue(body.reasoning_effort);
}

export function kiroIncludeThoughtsFalse(body: Json): boolean {
  if (body.include_thoughts === false) return true;
  const reasoning = body.reasoning;
  if (reasoning !== null && typeof reasoning === "object" && !Array.isArray(reasoning)) {
    const value = defaultAny((reasoning as Json).include_thoughts, (reasoning as Json).includeThoughts);
    if (value === false) return true;
  }
  return false;
}

export function kiroThinkingRequested(registry: Registry, body: Json): boolean {
  if (kiroIncludeThoughtsFalse(body) || kiroReasoningEffort(body) === "none") return false;
  if (kiroExplicitThinkingBudget(body) > 0) return true;
  const effort = kiroReasoningEffort(body);
  if (effort) return defaultThinkingBudget(effort) > 0;
  if (body.include_thoughts === true) return true;
  if (body._includeReasoning === true) return true;
  if (lastModelSegment(stringValue(body.model)).endsWith("-thinking")) return true;
  const model = stringValue(body.model);
  if (registry.isReasoningModel(model) || registry.isReasoningModel(lastModelSegment(model))) return true;
  for (const key of ["thinking_budget", "include_thoughts", "reasoning", "reasoning_effort"]) {
    if (body[key] !== undefined && body[key] !== null) return true;
  }
  return false;
}

export function kiroThinkingBudget(body: Json): number {
  const budget = kiroExplicitThinkingBudget(body);
  if (budget > 0) return budget;
  const effortBudget = defaultThinkingBudget(kiroReasoningEffort(body));
  if (effortBudget > 0) return effortBudget;
  return 20000;
}
