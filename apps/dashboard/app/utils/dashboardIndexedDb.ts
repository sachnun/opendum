type DashboardIndexedDbStore = <T>(txMode: IDBTransactionMode, callback: (store: IDBObjectStore) => T | PromiseLike<T>) => Promise<T>;

const openDatabases = new Map<string, IDBDatabase>();
const databaseQueues = new Map<string, Promise<unknown>>();

function openDatabase(dbName: string, storeName: string, version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = version === undefined ? indexedDB.open(dbName) : indexedDB.open(dbName, version);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        if (openDatabases.get(dbName) === db) openDatabases.delete(dbName);
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
  });
}

async function withDatabaseQueue<T>(dbName: string, task: () => Promise<T>): Promise<T> {
  const previous = databaseQueues.get(dbName) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const queued = next.finally(() => {
    if (databaseQueues.get(dbName) === queued) databaseQueues.delete(dbName);
  });
  databaseQueues.set(dbName, queued);
  return next;
}

async function ensureObjectStore(dbName: string, storeName: string): Promise<IDBDatabase> {
  return withDatabaseQueue(dbName, async () => {
    const currentDb = openDatabases.get(dbName);
    if (currentDb?.objectStoreNames.contains(storeName)) return currentDb;

    if (currentDb) {
      currentDb.close();
      openDatabases.delete(dbName);
    }

    const db = await openDatabase(dbName, storeName);
    if (db.objectStoreNames.contains(storeName)) {
      openDatabases.set(dbName, db);
      return db;
    }

    const nextVersion = db.version + 1;
    db.close();
    const upgradedDb = await openDatabase(dbName, storeName, nextVersion);
    openDatabases.set(dbName, upgradedDb);
    return upgradedDb;
  });
}

export function createDashboardIndexedDbStore(dbName: string, storeName: string): DashboardIndexedDbStore | null {
  if (!import.meta.client) return null;

  return async (txMode, callback) => {
    const db = await ensureObjectStore(dbName, storeName);
    return callback(db.transaction(storeName, txMode).objectStore(storeName));
  };
}

export async function warmDashboardIndexedDbStore(dbName: string, storeName: string): Promise<void> {
  if (!import.meta.client) return;
  await ensureObjectStore(dbName, storeName);
}
