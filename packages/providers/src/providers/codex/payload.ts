import {
  cloneAnyMap,
  extractInstructions,
  filterKeys,
  normalizeToolChoice,
  stringSlice,
  stringValue,
  uniqueStrings,
} from "#providers/lib/helpers.ts";
import {
  convertToolsForResponses,
  messagesToResponsesInput,
  normalizeResponsesInput,
} from "#providers/transform/responses.ts";

type Json = Record<string, unknown>;

export const SUPPORTED_CODEX = new Set([
  "model", "instructions", "store", "input", "stream", "tools", "tool_choice",
  "parallel_tool_calls", "reasoning", "include", "previous_response_id", "prompt_cache_key",
  "client_metadata", "service_tier",
]);

export function buildCodexPayload(body: Json, modelName: string, upstreamStream: boolean): Json {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const payload: Json = { model: modelName, store: false, stream: upstreamStream };
  const instructions = stringValue(body.instructions);
  if (instructions) {
    payload.instructions = instructions;
  } else {
    const derived = extractInstructions(messages);
    payload.instructions = derived || "You are Codex, an expert coding assistant.";
  }
  if (Array.isArray(body._responsesInput) && body._responsesInput.length > 0) {
    payload.input = normalizeResponsesInput(body._responsesInput);
  } else {
    payload.input = messagesToResponsesInput(messages);
  }
  const tools = convertToolsForResponses(body.tools);
  if (tools.length > 0) {
    payload.tools = tools;
    if (body.tool_choice === undefined || body.tool_choice === null) payload.tool_choice = "auto";
  }
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    payload.tool_choice = normalizeToolChoice(body.tool_choice);
  }
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== null) {
    payload.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.reasoning !== null && typeof body.reasoning === "object" && !Array.isArray(body.reasoning)) {
    payload.reasoning = cloneAnyMap(body.reasoning as Json);
  } else {
    const effort = stringValue(body.reasoning_effort);
    if (effort) payload.reasoning = { effort };
  }
  const reasoning = payload.reasoning;
  if (
    reasoning !== null &&
    typeof reasoning === "object" &&
    !Array.isArray(reasoning) &&
    body._includeReasoning === true &&
    (reasoning as Json).summary === undefined
  ) {
    (reasoning as Json).summary = "auto";
  }
  const include = stringSlice(body.include);
  if (body._includeReasoning === true || tools.length > 0) {
    include.push("reasoning.encrypted_content");
  }
  if (include.length > 0) payload.include = uniqueStrings(include);
  for (const key of ["previous_response_id", "service_tier"]) {
    if (body[key] !== undefined && body[key] !== null) payload[key] = body[key];
  }
  const sessionId = stringValue(body._sessionId);
  if (sessionId) {
    payload.prompt_cache_key = sessionId;
    payload.client_metadata = { session_id: sessionId };
  }
  return filterKeys(payload, SUPPORTED_CODEX);
}
