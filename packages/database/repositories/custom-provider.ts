import type { Database } from "../client.js";
import {
  getCustomProvider,
  listCustomProviderModels,
  listCustomProviders,
} from "../queries/index.js";

/**
 * User-defined custom providers and their model catalogs.
 * Delegates to the query layer with the database bound.
 */
export class CustomProviderRepository {
  constructor(private readonly database: Database) {}

  listCustomProviders(userId: string) {
    return listCustomProviders(userId, this.database);
  }

  getCustomProvider(userId: string, slug: string) {
    return getCustomProvider(userId, slug, this.database);
  }

  listCustomProviderModels(providerId: string) {
    return listCustomProviderModels(providerId, this.database);
  }
}
