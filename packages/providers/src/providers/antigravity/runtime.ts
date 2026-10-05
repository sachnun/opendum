import type { Registry } from "@opendum/models/runtime";
import type { OpendumRedis } from "@opendum/redis";
import { ANTIGRAVITY_GOOGLE_OAUTH_TOKEN_ENDPOINT } from "#providers/api/endpoints.ts";
import type { UpstreamTransport } from "#providers/api/http.ts";

export type AntigravityRuntime = {
  name: string;
  registry: Registry;
  transport: UpstreamTransport;
  redis: OpendumRedis | null;
  persistAccountInfo?: (accountId: string, info: { projectId: string; tier: string; email: string }) => void;
};

export const GOOGLE_OAUTH_TOKEN_ENDPOINT = ANTIGRAVITY_GOOGLE_OAUTH_TOKEN_ENDPOINT;
export const MIN_THINKING_BUDGET = 1024;
export const DEFAULT_MAX_OUTPUT_TOKENS = 64000;
export const SIGNATURE_CACHE_PREFIX = "opendum:thought-signature";
export const SIGNATURE_CACHE_TTL_SECONDS = 24 * 60 * 60;
export const CLAUDE_BETA_HEADER = "interleaved-thinking-2025-05-14";
export const ANTIGRAVITY_SYSTEM_INSTRUCTION =
  "You are Antigravity, a powerful agentic AI coding assistant designed by the Google Deepmind team working on Advanced Agentic Coding.You are pair programming with a USER to solve their coding task. The task may require creating a new codebase, modifying or debugging an existing codebase, or simply answering a question.**Absolute paths only****Proactiveness**";
export const TOOL_ARTIFACT_MARKER = /^\s*(Tool:\s*\w+|(?:thought|think)\s*:)/i;

export const ANTIGRAVITY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const ANTIGRAVITY_CLIENT_SECRET = "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";
export const ANTIGRAVITY_ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://autopush-cloudcode-pa.sandbox.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];
export const ANTIGRAVITY_LOAD_ENDPOINTS = [
  "https://cloudcode-pa.googleapis.com",
  "https://daily-cloudcode-pa.googleapis.com",
];
export const ANTIGRAVITY_ONBOARD_ENDPOINTS = [
  "https://daily-cloudcode-pa.googleapis.com",
  "https://cloudcode-pa.googleapis.com",
];
export const ANTIGRAVITY_DEFAULT_PROJECT = "rising-fact-p41fc";
export const ANTIGRAVITY_USER_AGENT = `antigravity/2.19.1 ${process.platform}/${process.arch}`;
export const ANTIGRAVITY_API_CLIENT = "google-cloud-sdk vscode_cloudshelleditor/0.1";
export const ANTIGRAVITY_CLIENT_METADATA =
  '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}';
