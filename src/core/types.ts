export type ProviderKey = string;

export interface SourceRef {
  sourceType: "wetw-point-api" | "wp-db" | "csv" | "manual";
  sourceSite?: string;
  providerKey?: ProviderKey;
  shopId?: number;
}

export interface NormalizedIdentity {
  wpUserId?: string;
  userLogin?: string;
  lineUserId?: string;
  email?: string;
  phone?: string;
  displayName?: string;
}

export interface NormalizedPointEntry {
  sourceRef: SourceRef;
  sourceEntryId: string;
  identity: NormalizedIdentity;
  pointType: string;
  pointDelta: number;
  pointBalance?: number;
  eventName?: string;
  eventContent?: string;
  createdAt?: string;
  raw: unknown;
}

export interface PointBalance {
  identityKey: string;
  identity: NormalizedIdentity;
  pointType: string;
  balance: number;
  sourceRef: SourceRef;
  calculatedFromEntries: boolean;
}

export interface SyncReport {
  sourceRef: SourceRef;
  fetchedEntries: number;
  normalizedEntries: number;
  identities: number;
  balances: PointBalance[];
  entries: NormalizedPointEntry[];
}
