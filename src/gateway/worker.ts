import { getChannelConfig } from "./config.js";
import { verifyLineSignature } from "./line-signature.js";
import { recordEvent, tryApplyBindingCode, upsertChannel } from "./storage.js";
import type { GatewayEnv, LineWebhookPayload } from "./types.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function requireAdmin(request: Request, env: GatewayEnv): Response | null {
  if (!env.ADMIN_TOKEN) return null;

  const authorization = request.headers.get("authorization");
  if (authorization !== `Bearer ${env.ADMIN_TOKEN}`) {
    return json({ success: false, message: "Unauthorized" }, 401);
  }

  return null;
}

async function readJson<T>(request: Request): Promise<T> {
  return (await request.json()) as T;
}

async function handleWebhook(request: Request, env: GatewayEnv, channelKey: string): Promise<Response> {
  const config = getChannelConfig(env, channelKey);
  if (!config) return json({ success: false, message: `Unknown channel: ${channelKey}` }, 404);

  const rawBody = await request.text();
  const signature = request.headers.get("x-line-signature");
  const valid = await verifyLineSignature(rawBody, signature, config.channelSecret);
  if (!valid) return json({ success: false, message: "Invalid LINE signature" }, 403);

  await upsertChannel(env, channelKey, config);

  const payload = JSON.parse(rawBody) as LineWebhookPayload;
  for (const event of payload.events ?? []) {
    await recordEvent(env, channelKey, event);
    await tryApplyBindingCode(env, channelKey, event.source?.userId, event.message?.text);
  }

  const forwardResponse = await fetch(config.forwardUrl, {
    method: "POST",
    headers: {
      "content-type": request.headers.get("content-type") ?? "application/json",
      "x-line-signature": signature ?? ""
    },
    body: rawBody
  });

  return json({
    success: true,
    channel_key: channelKey,
    recorded_events: payload.events?.length ?? 0,
    forwarded: {
      url: config.forwardUrl,
      status: forwardResponse.status,
      ok: forwardResponse.ok
    }
  });
}

async function handleHealth(env: GatewayEnv): Promise<Response> {
  const config = JSON.parse(env.CHANNEL_CONFIG_JSON || "{}") as Record<string, unknown>;
  return json({
    success: true,
    service: "wp-line-point-gateway",
    channels: Object.keys(config)
  });
}

async function createBindingCode(request: Request, env: GatewayEnv): Promise<Response> {
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  const body = await readJson<{
    master_member_ref?: string;
    code?: string;
    ttl_minutes?: number;
  }>(request);
  if (!body.master_member_ref) {
    return json({ success: false, message: "master_member_ref is required" }, 400);
  }

  const code = body.code ?? crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const ttlMinutes = Math.max(1, Math.min(body.ttl_minutes ?? 60, 10080));
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();

  await env.DB.prepare(
    `INSERT OR REPLACE INTO binding_codes (code, master_member_ref, expires_at)
     VALUES (?, ?, ?)`
  )
    .bind(code, body.master_member_ref, expiresAt)
    .run();

  return json({
    success: true,
    code,
    master_member_ref: body.master_member_ref,
    expires_at: expiresAt,
    instructions: [`綁定 ${code}`, `bind ${code}`]
  });
}

async function listObservations(request: Request, env: GatewayEnv): Promise<Response> {
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const channelKey = url.searchParams.get("channel_key");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

  if (channelKey) {
    const rows = await env.DB.prepare(
      `SELECT channel_key, line_user_id, first_seen_at, last_seen_at, event_count
       FROM line_identity_observations
       WHERE channel_key = ?
       ORDER BY last_seen_at DESC
       LIMIT ?`
    )
      .bind(channelKey, limit)
      .all();
    return json({ success: true, observations: rows.results ?? [] });
  }

  const rows = await env.DB.prepare(
    `SELECT channel_key, line_user_id, first_seen_at, last_seen_at, event_count
     FROM line_identity_observations
     ORDER BY last_seen_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();
  return json({ success: true, observations: rows.results ?? [] });
}

async function listMemberLinks(request: Request, env: GatewayEnv): Promise<Response> {
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const masterMemberRef = url.searchParams.get("master_member_ref");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

  if (masterMemberRef) {
    const rows = await env.DB.prepare(
      `SELECT master_member_ref, channel_key, line_user_id, binding_code, linked_at
       FROM member_line_links
       WHERE master_member_ref = ?
       ORDER BY linked_at DESC`
    )
      .bind(masterMemberRef)
      .all();
    return json({ success: true, links: rows.results ?? [] });
  }

  const rows = await env.DB.prepare(
    `SELECT master_member_ref, channel_key, line_user_id, binding_code, linked_at
     FROM member_line_links
     ORDER BY linked_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all();
  return json({ success: true, links: rows.results ?? [] });
}

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return handleHealth(env);
    }

    if (request.method === "POST" && url.pathname === "/admin/binding-codes") {
      return createBindingCode(request, env);
    }

    if (request.method === "GET" && url.pathname === "/admin/observations") {
      return listObservations(request, env);
    }

    if (request.method === "GET" && url.pathname === "/admin/member-links") {
      return listMemberLinks(request, env);
    }

    const match = url.pathname.match(/^\/line-webhook\/([^/]+)$/);
    if (request.method === "POST" && match) {
      return handleWebhook(request, env, match[1]);
    }

    return json({ success: false, message: "Not found" }, 404);
  }
};
