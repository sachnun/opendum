import { createHmac } from "node:crypto";
import { config } from "../config.js";
export function validateInternalSignature(c, path, rawBody) {
    if (!config.betterAuthSecret) {
        return false;
    }
    const timestamp = c.req.header("x-opendum-internal-timestamp")?.trim();
    const signature = c.req.header("x-opendum-internal-signature")?.trim();
    if (!timestamp || !signature) {
        return false;
    }
    const tsNumber = parseInt(timestamp, 10);
    if (isNaN(tsNumber)) {
        return false;
    }
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - tsNumber) > 120) {
        return false;
    }
    const expected = createHmac("sha256", config.betterAuthSecret)
        .update(`${timestamp}\n${path}\n${rawBody}`)
        .digest("hex");
    return signature === expected;
}
//# sourceMappingURL=internal.js.map