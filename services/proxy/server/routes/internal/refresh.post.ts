import { defineHandler } from "nitro";
import { getProxyContext } from "../../context.js";
import { handleRefresh } from "../../../src/routes/internal.js";

export default defineHandler(async (event) => handleRefresh(event, await getProxyContext()));
