import type { GatewayEnv } from "./types.js";

export interface PointMutationInput {
  channelKey: string;
  lineUserId: string;
  pointType: string;
  pointDelta: number;
  action: "checkin" | "grant" | "deduct" | "redeem" | "adjust";
  source: "webhook" | "admin" | "migration";
  sourceEventId?: string;
  businessKey?: string;
  note?: string;
}

export async function applyPointMutation(env: GatewayEnv, input: PointMutationInput): Promise<{
  account_key: string;
  master_member_ref: string | null;
  balance_after: number;
}> {
  const pointType = input.pointType || "system_point";
  const accountKey = `${input.channelKey}:${input.lineUserId}:${pointType}`;
  const businessKey = input.businessKey ?? `${input.source}:${input.action}:${crypto.randomUUID()}`;
  const link = await env.DB.prepare(
    `SELECT master_member_ref
     FROM member_line_links
     WHERE channel_key = ? AND line_user_id = ?`
  )
    .bind(input.channelKey, input.lineUserId)
    .first<{ master_member_ref: string }>();
  const masterMemberRef = link?.master_member_ref ?? null;

  const existing = await env.DB.prepare(
    `SELECT balance FROM point_accounts WHERE account_key = ?`
  )
    .bind(accountKey)
    .first<{ balance: number }>();
  const balanceAfter = Number(existing?.balance ?? 0) + input.pointDelta;

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO point_accounts (
        account_key, master_member_ref, channel_key, line_user_id, point_type, balance, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(account_key)
      DO UPDATE SET
        master_member_ref = excluded.master_member_ref,
        balance = excluded.balance,
        updated_at = CURRENT_TIMESTAMP`
    ).bind(accountKey, masterMemberRef, input.channelKey, input.lineUserId, pointType, balanceAfter),
    env.DB.prepare(
      `INSERT INTO point_ledger (
        account_key, master_member_ref, channel_key, line_user_id, action, point_type,
        point_delta, balance_after, source, source_event_id, business_key, note
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      accountKey,
      masterMemberRef,
      input.channelKey,
      input.lineUserId,
      input.action,
      pointType,
      input.pointDelta,
      balanceAfter,
      input.source,
      input.sourceEventId ?? null,
      businessKey,
      input.note ?? null
    )
  ]);

  return {
    account_key: accountKey,
    master_member_ref: masterMemberRef,
    balance_after: balanceAfter
  };
}

export async function listBalances(
  env: GatewayEnv,
  options: { channelKey?: string; lineUserId?: string; masterMemberRef?: string; limit?: number }
): Promise<unknown[]> {
  const limit = Math.min(options.limit ?? 100, 500);

  if (options.channelKey && options.lineUserId) {
    const rows = await env.DB.prepare(
      `SELECT account_key, master_member_ref, channel_key, line_user_id, point_type, balance, updated_at
       FROM point_accounts
       WHERE channel_key = ? AND line_user_id = ?
       ORDER BY point_type
       LIMIT ?`
    ).bind(options.channelKey, options.lineUserId, limit).all();
    return rows.results ?? [];
  }

  if (options.masterMemberRef) {
    const rows = await env.DB.prepare(
      `SELECT account_key, master_member_ref, channel_key, line_user_id, point_type, balance, updated_at
       FROM point_accounts
       WHERE master_member_ref = ?
       ORDER BY channel_key, point_type
       LIMIT ?`
    ).bind(options.masterMemberRef, limit).all();
    return rows.results ?? [];
  }

  if (options.channelKey) {
    const rows = await env.DB.prepare(
      `SELECT account_key, master_member_ref, channel_key, line_user_id, point_type, balance, updated_at
       FROM point_accounts
       WHERE channel_key = ?
       ORDER BY updated_at DESC
       LIMIT ?`
    ).bind(options.channelKey, limit).all();
    return rows.results ?? [];
  }

  const rows = await env.DB.prepare(
    `SELECT account_key, master_member_ref, channel_key, line_user_id, point_type, balance, updated_at
     FROM point_accounts
     ORDER BY updated_at DESC
     LIMIT ?`
  ).bind(limit).all();
  return rows.results ?? [];
}

export async function listLedger(
  env: GatewayEnv,
  options: { channelKey?: string; lineUserId?: string; masterMemberRef?: string; limit?: number }
): Promise<unknown[]> {
  const limit = Math.min(options.limit ?? 100, 500);

  if (options.channelKey && options.lineUserId) {
    const rows = await env.DB.prepare(
      `SELECT id, master_member_ref, channel_key, line_user_id, action, point_type,
              point_delta, balance_after, source, business_key, note, created_at
       FROM point_ledger
       WHERE channel_key = ? AND line_user_id = ?
       ORDER BY id DESC
       LIMIT ?`
    ).bind(options.channelKey, options.lineUserId, limit).all();
    return rows.results ?? [];
  }

  if (options.masterMemberRef) {
    const rows = await env.DB.prepare(
      `SELECT id, master_member_ref, channel_key, line_user_id, action, point_type,
              point_delta, balance_after, source, business_key, note, created_at
       FROM point_ledger
       WHERE master_member_ref = ?
       ORDER BY id DESC
       LIMIT ?`
    ).bind(options.masterMemberRef, limit).all();
    return rows.results ?? [];
  }

  const rows = await env.DB.prepare(
    `SELECT id, master_member_ref, channel_key, line_user_id, action, point_type,
            point_delta, balance_after, source, business_key, note, created_at
     FROM point_ledger
     ORDER BY id DESC
     LIMIT ?`
  ).bind(limit).all();
  return rows.results ?? [];
}
