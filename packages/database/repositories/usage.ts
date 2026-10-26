import type { DbExecutor } from "@opendum/database/client";
import { insertUsageLog } from "@opendum/database/queries/index";

export class Usage {
  constructor(private readonly database: DbExecutor) {}

  insertUsageLog(params: Parameters<typeof insertUsageLog>[0]) {
    return insertUsageLog(params, this.database);
  }
}
