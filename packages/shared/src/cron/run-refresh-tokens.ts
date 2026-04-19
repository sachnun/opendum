import { closeDb } from "../db/index.js";
import { refreshTokens } from "./refresh-tokens.js";

try {
  const result = await refreshTokens();
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeDb();
}
