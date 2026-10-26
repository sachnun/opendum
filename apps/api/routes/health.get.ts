import { defineHandler } from "nitro";
import { jsonResponse } from "@opendum/api/handlers/errors";

export default defineHandler(() => jsonResponse({ status: "ok" }));
