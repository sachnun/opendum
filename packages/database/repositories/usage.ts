import type { DbExecutor } from "../client.js";
import { insertUsageLog } from "../queries/index.js";

export class Usage {
  constructor(private readonly database: DbExecutor) {}

  insertUsageLog(params: Parameters<typeof insertUsageLog>[0]) {
    return insertUsageLog(params, this.database);
  }
}
