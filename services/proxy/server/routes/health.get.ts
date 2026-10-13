import { defineHandler } from "nitro";
import { jsonResponse } from "../../src/routes/errors.js";

export default defineHandler(() => jsonResponse({ status: "ok" }));
