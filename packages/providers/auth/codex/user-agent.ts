import os from "node:os";

export const OPENCODE_VERSION = "1.19.4";

export const USER_AGENT = `opencode/${OPENCODE_VERSION} (${os.platform()} ${os.release()}; ${os.arch()})`;
