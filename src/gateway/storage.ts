import type { ChannelConfig, GatewayEnv, LineWebhookEvent } from "./types.js";

export async function upsertChannel(env: GatewayEnv, channelKey: string, config: ChannelConfig): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO line_channels (channel_key, label, forward_url)
     VALUES (?, ?, ?)
     ON CONFLICT(channel_key)
     DO UPDATE SET label = excluded.label, forward_url = excluded.forward_url`
  )
    .bind(channelKey, config.label ?? channelKey, config.forwardUrl)
    .run();
}

export async function recordEvent(env: GatewayEnv, channelKey: string, event: LineWebhookEvent): Promise<void> {
  const lineUserId = event.source?.userId ?? null;
  const messageType = event.message?.type ?? null;
  const messageText = event.message?.type === "text" ? event.message.text ?? null : null;

  await env.DB.prepare(
    `INSERT INTO webhook_events (
      channel_key, line_user_id, event_type, message_type, message_text,
      reply_token, line_timestamp, raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      channelKey,
      lineUserId,
      event.type ?? null,
      messageType,
      messageText,
      event.replyToken ?? null,
      event.timestamp ?? null,
      JSON.stringify(event)
    )
    .run();

  if (lineUserId) {
    await env.DB.prepare(
      `INSERT INTO line_identity_observations (channel_key, line_user_id)
       VALUES (?, ?)
       ON CONFLICT(channel_key, line_user_id)
       DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP, event_count = event_count + 1`
    )
      .bind(channelKey, lineUserId)
      .run();
  }
}

export async function tryApplyBindingCode(
  env: GatewayEnv,
  channelKey: string,
  lineUserId: string | undefined,
  text: string | undefined
): Promise<void> {
  if (!lineUserId || !text) return;

  const match = text.trim().match(/^(綁定|bind)\s+([A-Za-z0-9_-]{4,32})$/i);
  if (!match) return;

  const code = match[2];
  const row = await env.DB.prepare(
    `SELECT code, master_member_ref
     FROM binding_codes
     WHERE code = ? AND used_at IS NULL AND expires_at > CURRENT_TIMESTAMP`
  )
    .bind(code)
    .first<{ code: string; master_member_ref: string }>();

  if (!row) return;

  await env.DB.prepare(
    `INSERT INTO member_line_links (master_member_ref, channel_key, line_user_id, binding_code)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(master_member_ref, channel_key)
     DO UPDATE SET line_user_id = excluded.line_user_id, binding_code = excluded.binding_code, linked_at = CURRENT_TIMESTAMP`
  )
    .bind(row.master_member_ref, channelKey, lineUserId, code)
    .run();
}
