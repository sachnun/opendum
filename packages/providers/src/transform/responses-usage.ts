import { numberFromAny } from "#providers/lib/helpers.ts";

type Json = Record<string, unknown>;

export function responseUsageToChatUsage(raw: unknown): Json {
  const usage = (raw ?? {}) as Json;
  let input = numberFromAny(usage.input_tokens);
  if (input === 0) input = numberFromAny(usage.prompt_tokens);
  let output = numberFromAny(usage.output_tokens);
  if (output === 0) output = numberFromAny(usage.completion_tokens);
  const out: Json = { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };

  let cached = 0;
  let write = 0;
  const details = usage.input_tokens_details;
  if (details !== null && typeof details === "object") {
    cached = numberFromAny((details as Json).cached_tokens);
    write = numberFromAny((details as Json).cache_write_tokens);
  }
  if (cached === 0 || write === 0) {
    const promptDetails = usage.prompt_tokens_details;
    if (promptDetails !== null && typeof promptDetails === "object") {
      const pd = promptDetails as Json;
      if (cached === 0) cached = numberFromAny(pd.cached_tokens);
      if (write === 0) write = numberFromAny(pd.cache_write_tokens);
    }
  }
  if (cached > 0 || write > 0) {
    out.prompt_tokens_details = { cached_tokens: cached, cache_write_tokens: write };
  }

  let reasoning = 0;
  const outputDetails = usage.output_tokens_details;
  if (outputDetails !== null && typeof outputDetails === "object") {
    reasoning = numberFromAny((outputDetails as Json).reasoning_tokens);
  }
  if (reasoning === 0) {
    const completionDetails = usage.completion_tokens_details;
    if (completionDetails !== null && typeof completionDetails === "object") {
      reasoning = numberFromAny((completionDetails as Json).reasoning_tokens);
    }
  }
  if (reasoning > 0) out.completion_tokens_details = { reasoning_tokens: reasoning };
  return out;
}
