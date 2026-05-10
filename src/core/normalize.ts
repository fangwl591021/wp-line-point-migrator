import type { NormalizedIdentity, NormalizedPointEntry, PointBalance, SourceRef } from "./types.js";

export function identityKey(identity: NormalizedIdentity): string {
  if (identity.lineUserId) return `line:${identity.lineUserId}`;
  if (identity.wpUserId) return `wp:${identity.wpUserId}`;
  if (identity.email) return `email:${identity.email.toLowerCase()}`;
  if (identity.phone) return `phone:${identity.phone}`;
  return "unknown";
}

export function calculateBalances(entries: NormalizedPointEntry[]): PointBalance[] {
  const latest = new Map<string, NormalizedPointEntry>();
  const sums = new Map<string, { entry: NormalizedPointEntry; balance: number }>();

  for (const entry of entries) {
    const key = `${identityKey(entry.identity)}:${entry.pointType}:${sourceKey(entry.sourceRef)}`;
    const current = latest.get(key);
    if (entry.pointBalance !== undefined && (!current || compareDate(entry.createdAt, current.createdAt) >= 0)) {
      latest.set(key, entry);
    }

    const sum = sums.get(key) ?? { entry, balance: 0 };
    sum.balance += entry.pointDelta;
    sums.set(key, sum);
  }

  const balances: PointBalance[] = [];
  for (const [key, sum] of sums) {
    const latestEntry = latest.get(key);
    const entry = latestEntry ?? sum.entry;
    balances.push({
      identityKey: identityKey(entry.identity),
      identity: entry.identity,
      pointType: entry.pointType,
      balance: latestEntry?.pointBalance ?? sum.balance,
      sourceRef: entry.sourceRef,
      calculatedFromEntries: !latestEntry
    });
  }

  return balances.sort((a, b) => a.identityKey.localeCompare(b.identityKey) || a.pointType.localeCompare(b.pointType));
}

export function sourceKey(sourceRef: SourceRef): string {
  return [sourceRef.sourceType, sourceRef.sourceSite ?? "", sourceRef.providerKey ?? "", sourceRef.shopId ?? ""].join(":");
}

function compareDate(a?: string, b?: string): number {
  return Date.parse(a ?? "") - Date.parse(b ?? "");
}
