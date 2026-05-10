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

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return handleHealth(env);
    }

    const match = url.pathname.match(/^\/line-webhook\/([^/]+)$/);
    if (request.method === "POST" && match) {
      return handleWebhook(request, env, match[1]);
    }

    return json({ success: false, message: "Not found" }, 404);
  }
};
