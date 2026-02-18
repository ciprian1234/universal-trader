export class GlobalDataStore {
  // In-memory store for pool states, indexed by chainId and pool address.
  private pools: Map<number, Map<string, any>> = new Map();
  size = 0;
}
