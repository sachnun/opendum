import { Hono } from "hono";
import { createAuth } from "../../lib/auth.js";
import { createRequestDb } from "../../lib/db/index.js";

const app = new Hono();
app.all("*", async (c) => {
  const { db, close } = await createRequestDb();
  try {
    return await createAuth(db).handler(c.req.raw);
  } finally {
    await close();
  }
});
export default app;
