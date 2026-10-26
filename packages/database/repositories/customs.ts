import type { DbExecutor } from "../client.js";
import {
  getCustomProvider,
  customModels,
  listCustomProviders,
} from "../queries/index.js";

export class Customs {
  constructor(private readonly database: DbExecutor) {}

  listCustomProviders(userId: string) {
    return listCustomProviders(userId, this.database);
  }

  getCustomProvider(userId: string, slug: string) {
    return getCustomProvider(userId, slug, this.database);
  }

  customModels(providerId: string) {
    return customModels(providerId, this.database);
  }
}
