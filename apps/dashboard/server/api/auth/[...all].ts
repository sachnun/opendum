import { createAuth } from "../../../lib/auth";

export default defineEventHandler((event) => createAuth().handler(toWebRequest(event)));
