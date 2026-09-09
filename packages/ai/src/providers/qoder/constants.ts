export const QODER_OPENAPI_BASE = "https://openapi.qoder.sh";
export const QODER_INFERENCE_BASE = "https://api3.qoder.sh";
export const QODER_INFERENCE_PATH =
    "/algo/api/v2/service/pro/sse/agent_chat_generation";
export const QODER_INFERENCE_QUERY =
    "?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
export const QODER_DEVICE_REFRESH_PATH = "/api/v1/deviceToken/refresh";
export const QODER_JOB_REFRESH_PATH = "/api/v1/jobToken/refresh";
export const QODER_USER_INFO_PATH = "/api/v1/userinfo";

export const QODER_PAT_REFRESH_PREFIX = "jrt-";
export const QODER_IDE_VERSION = "1.0.0";
export const QODER_CLIENT_TYPE = "5";
export const QODER_MACHINE_TYPE = "5";
export const QODER_MACHINE_OS = "x86_64_windows";
export const QODER_DATA_POLICY = "disagree";
export const QODER_LOGIN_VERSION = "v2";
export const QODER_DEFAULT_MODEL = "qmodel_latest";
export const QODER_DEFAULT_MAX_TOKENS = 32768;
export const QODER_ACCESS_TTL_MS = 24 * 60 * 60 * 1000;
export const QODER_REFRESH_BUFFER_SECONDS = 5 * 60;
export const QODER_SESSION_TYPE = "qodercli";
export const QODER_AGENT_ID = "agent_common";
export const QODER_TASK_ID = "common";

export const QODER_STANDARD_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export const QODER_CUSTOM_ALPHABET =
    "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";

export const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
