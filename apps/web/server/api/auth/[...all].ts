import { createAuth } from "~~/server/lib/auth";

export default defineEventHandler((event) => createAuth().handler(toWebRequest(event)));
