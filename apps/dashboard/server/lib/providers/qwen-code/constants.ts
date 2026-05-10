// Qwen Code OAuth and API Constants
// Based on https://github.com/Mirrowel/LLM-API-Key-Proxy

// OAuth Configuration (Device Code Flow)
// Client ID from https://api.kilocode.ai/extension-config.json
export const CLIENT_ID = "f0304373b74a44d2b584a3fb70ca9e56";
export const SCOPE = "openid profile email model.completion";

// OAuth Endpoints
export const TOKEN_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/token";
export const DEVICE_CODE_ENDPOINT = "https://chat.qwen.ai/api/v1/oauth2/device/code";
