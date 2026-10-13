import { defineHandler } from "nitro";
import { jsonResponse } from "../handlers/errors.js";

export default defineHandler(() => jsonResponse({ status: "ok" }));
