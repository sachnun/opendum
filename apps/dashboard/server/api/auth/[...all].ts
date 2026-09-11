import { createAuth } from "../../../lib/auth";
import { createRequestDb } from "@opendum/database";

export default defineEventHandler(async (event) => {
  const { db, close } = await createRequestDb();

  try {
    return await createAuth(db).handler(toWebRequest(event));
  } finally {
    await close();
  }
});
