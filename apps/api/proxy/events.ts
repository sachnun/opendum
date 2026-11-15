export type UsageLoggedListener = (userId: string) => void;

export class ProxyEvents {
  private readonly usageLoggedListeners = new Set<UsageLoggedListener>();

  publishUsageLogged(userId: string): void {
    for (const listener of this.usageLoggedListeners) listener(userId);
  }

  onUsageLogged(listener: UsageLoggedListener): () => void {
    this.usageLoggedListeners.add(listener);
    return () => {
      this.usageLoggedListeners.delete(listener);
    };
  }
}

export const proxyEvents = new ProxyEvents();
