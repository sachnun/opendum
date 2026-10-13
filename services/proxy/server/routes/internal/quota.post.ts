import { defineHandler } from "nitro";
import { getProxyContext } from "../../context.js";
import { handleQuota } from "../../../src/routes/internal.js";

export default defineHandler(async (event) => handleQuota(event, await getProxyContext()));
