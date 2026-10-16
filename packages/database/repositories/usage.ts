import type { DbExecutor } from "../client.js";
import { insertUsageLog } from "../queries/index.js";

/**
 * Usage log writes. Delegates to the query layer with the database bound.
 */
export class Usage {
  constructor(private readonly database: DbExecutor) {}

  insertUsageLog(params: Parameters<typeof insertUsageLog>[0]) {
    return insertUsageLog(params, this.database);
  }
}
