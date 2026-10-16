import { defineHandler } from "nitro";
import { getProxyContext } from "../../context.js";
import { handleQuota } from "../../handlers/internal.js";

export default defineHandler(async (event) => handleQuota(event, await getProxyContext()));
