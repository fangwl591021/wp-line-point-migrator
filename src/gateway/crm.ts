import type { GatewayEnv } from "./types.js";
import type { WetwMember, WetwPointEntry } from "./wetw.js";

export interface CrmMemberRow {
  channel_key: string;
  line_user_id: string;
  wp_user_id: string | null;
  display_name: string | null;
  line_display_name: string | null;
  phone: string | null;
  shop_id: number | null;
  synced_at: string;
  balances_json?: string;
}

function lineUserId(member: WetwMember): string | null {
  return String(member.LINE_user_id ?? member.user_login ?? "").trim() || null;
}

export async function upsertCrmMembers(
  env: GatewayEnv,
  channelKey: string,
  members: WetwMember[]
): Promise<number> {
  let count = 0;
  for (const member of members) {
    const lineId = lineUserId(member);
    if (!lineId) continue;
    await env.DB.prepare(
      `INSERT INTO crm_members (
        channel_key, line_user_id, wp_user_id, display_name, line_display_name,
        phone, shop_id, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_key, line_user_id)
      DO UPDATE SET
        wp_user_id = excluded.wp_user_id,
        display_name = excluded.display_name,
        line_display_name = excluded.line_display_name,
        phone = excluded.phone,
        shop_id = excluded.shop_id,
        raw_json = excluded.raw_json,
        synced_at = CURRENT_TIMESTAMP`
    )
      .bind(
        channelKey,
        lineId,
        member.ID == null ? null : String(member.ID),
        member.display_name == null ? null : String(member.display_name),
        member.LINE_display_name == null ? null : String(member.LINE_display_name),
        member.phone == null ? null : String(member.phone),
        member.shop_id == null ? null : Number(member.shop_id),
        JSON.stringify(member)
      )
      .run();
    count += 1;
  }
  return count;
}

export async function listCrmMembers(
  env: GatewayEnv,
  options: { channelKey: string; search?: string; limit?: number; offset?: number }
): Promise<CrmMemberRow[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const search = options.search?.trim();

  if (search) {
    const like = `%${search}%`;
    const rows = await env.DB.prepare(
      `SELECT m.channel_key, m.line_user_id, m.wp_user_id, m.display_name, m.line_display_name,
              m.phone, m.shop_id, m.synced_at,
              COALESCE(
                json_group_array(
                  CASE WHEN a.account_key IS NOT NULL THEN
                    json_object('point_type', a.point_type, 'balance', a.balance, 'updated_at', a.updated_at)
                  END
                ),
                '[]'
              ) AS balances_json
       FROM crm_members m
       LEFT JOIN point_accounts a
         ON a.channel_key = m.channel_key AND a.line_user_id = m.line_user_id
       WHERE m.channel_key = ?
         AND (m.line_user_id LIKE ? OR m.display_name LIKE ? OR m.line_display_name LIKE ? OR m.phone LIKE ?)
       GROUP BY m.channel_key, m.line_user_id
       ORDER BY m.synced_at DESC
       LIMIT ? OFFSET ?`
    )
      .bind(options.channelKey, like, like, like, like, limit, offset)
      .all<CrmMemberRow>();
    return rows.results ?? [];
  }

  const rows = await env.DB.prepare(
    `SELECT m.channel_key, m.line_user_id, m.wp_user_id, m.display_name, m.line_display_name,
            m.phone, m.shop_id, m.synced_at,
            COALESCE(
              json_group_array(
                CASE WHEN a.account_key IS NOT NULL THEN
                  json_object('point_type', a.point_type, 'balance', a.balance, 'updated_at', a.updated_at)
                END
              ),
              '[]'
            ) AS balances_json
     FROM crm_members m
     LEFT JOIN point_accounts a
       ON a.channel_key = m.channel_key AND a.line_user_id = m.line_user_id
     WHERE m.channel_key = ?
     GROUP BY m.channel_key, m.line_user_id
     ORDER BY m.synced_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(options.channelKey, limit, offset)
    .all<CrmMemberRow>();
  return rows.results ?? [];
}

export async function replaceBalancesFromWetwEntries(
  env: GatewayEnv,
  channelKey: string,
  lineUserId: string,
  entries: WetwPointEntry[]
): Promise<number> {
  const latestByPointType = new Map<string, WetwPointEntry>();
  for (const entry of entries) {
    const pointType = String(entry.point_type ?? "").trim();
    if (!pointType || entry.point_balance == null) continue;
    if (!latestByPointType.has(pointType)) latestByPointType.set(pointType, entry);
  }

  for (const [pointType, entry] of latestByPointType) {
    const accountKey = `${channelKey}:${lineUserId}:${pointType}`;
    await env.DB.prepare(
      `INSERT INTO point_accounts (
        account_key, master_member_ref, channel_key, line_user_id, point_type, balance, updated_at
      ) VALUES (?, NULL, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(account_key)
      DO UPDATE SET balance = excluded.balance, updated_at = CURRENT_TIMESTAMP`
    )
      .bind(accountKey, channelKey, lineUserId, pointType, Number(entry.point_balance))
      .run();
  }

  return latestByPointType.size;
}
