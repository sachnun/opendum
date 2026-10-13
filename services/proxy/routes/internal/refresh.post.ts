import { defineHandler } from "nitro";
import { getProxyContext } from "../../context.js";
import { handleRefresh } from "../../handlers/internal.js";

export default defineHandler(async (event) => handleRefresh(event, await getProxyContext()));
