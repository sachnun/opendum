export interface UsageExtraction {
  inputTokens: number;
  outputTokens: number;
}

export function createSSEUsageTracker() {
  let inputTokens = 0;
  let outputTokens = 0;
  let buffer = "";

  return {
    processChunk(chunkText: string): void {
      buffer += chunkText;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;

        try {
          const parsed = JSON.parse(payload);
          const usage = parsed.usage;
          if (usage) {
            if (typeof usage.prompt_tokens === "number") {
              inputTokens = usage.prompt_tokens;
            } else if (typeof usage.input_tokens === "number") {
              inputTokens = usage.input_tokens;
            }

            if (typeof usage.completion_tokens === "number") {
              outputTokens = usage.completion_tokens;
            } else if (typeof usage.output_tokens === "number") {
              outputTokens = usage.output_tokens;
            }
          }
        } catch {
          // ignore chunk JSON error
        }
      }
    },

    getUsage(): UsageExtraction {
      return { inputTokens, outputTokens };
    },
  };
}
