import type { Database } from "../client.js";
import { insertUsageLog } from "../queries/index.js";

/**
 * Usage log writes. Delegates to the query layer with the database bound.
 */
export class UsageRepository {
  constructor(private readonly database: Database) {}

  insertUsageLog(params: Parameters<typeof insertUsageLog>[0]) {
    return insertUsageLog(params, this.database);
  }
}
