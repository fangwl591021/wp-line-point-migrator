import { getChannelConfig } from "./config.js";
import { verifyLineSignature } from "./line-signature.js";
import { applyPointMutation, listBalances, listLedger } from "./points.js";
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
  let checkinEvents = 0;
  for (const event of payload.events ?? []) {
    await recordEvent(env, channelKey, event);
    await tryApplyBindingCode(env, channelKey, event.source?.userId, event.message?.text);
    const checkinDelta = detectCheckinPointDelta(channelKey, event.message?.text);
    if (event.source?.userId && checkinDelta !== null) {
      await applyPointMutation(env, {
        channelKey,
        lineUserId: event.source.userId,
        pointType: "checkin_point",
        pointDelta: checkinDelta,
        action: "checkin",
        source: "webhook",
        sourceEventId: event.replyToken,
        businessKey: `checkin:${channelKey}:${event.source.userId}:${taipeiDate()}`
      }).catch((error) => {
        if (!(error instanceof Error) || !String(error.message).includes("UNIQUE")) throw error;
      });
      checkinEvents += 1;
    }
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
    checkin_events: checkinEvents,
    forwarded: {
      url: config.forwardUrl,
      status: forwardResponse.status,
      ok: forwardResponse.ok
    }
  });
}

function detectCheckinPointDelta(channelKey: string, text?: string): number | null {
  if (!text) return null;
  if (!/會員打卡|打卡|簽到|checkin/i.test(text)) return null;
  return channelKey === "oa2" ? 5 : 10;
}

function taipeiDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
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

async function pointMutationRoute(request: Request, env: GatewayEnv, action: "grant" | "deduct" | "redeem"): Promise<Response> {
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  const body = await readJson<{
    channel_key?: string;
    line_user_id?: string;
    point_type?: string;
    points?: number;
    business_key?: string;
    note?: string;
  }>(request);
  if (!body.channel_key || !body.line_user_id || !body.points) {
    return json({ success: false, message: "channel_key, line_user_id, and points are required" }, 400);
  }

  const absPoints = Math.abs(Number(body.points));
  const delta = action === "grant" ? absPoints : -absPoints;
  const result = await applyPointMutation(env, {
    channelKey: body.channel_key,
    lineUserId: body.line_user_id,
    pointType: body.point_type ?? "manual_point",
    pointDelta: delta,
    action,
    source: "admin",
    businessKey: body.business_key,
    note: body.note
  });

  return json({ success: true, ...result });
}

async function balancesRoute(request: Request, env: GatewayEnv): Promise<Response> {
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const balances = await listBalances(env, {
    channelKey: url.searchParams.get("channel_key") ?? undefined,
    lineUserId: url.searchParams.get("line_user_id") ?? undefined,
    masterMemberRef: url.searchParams.get("master_member_ref") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 100)
  });
  return json({ success: true, balances });
}

async function ledgerRoute(request: Request, env: GatewayEnv): Promise<Response> {
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const ledger = await listLedger(env, {
    channelKey: url.searchParams.get("channel_key") ?? undefined,
    lineUserId: url.searchParams.get("line_user_id") ?? undefined,
    masterMemberRef: url.searchParams.get("master_member_ref") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 100)
  });
  return json({ success: true, ledger });
}

function adminToolHtml(): Response {
  return new Response(`<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OA Points Tool</title>
  <style>
    body{font-family:Arial,"Noto Sans TC",sans-serif;margin:0;background:#f6f7f4;color:#1f2933}
    main{max-width:980px;margin:28px auto;padding:0 16px;display:grid;gap:16px}
    section{background:#fff;border:1px solid #d9ded6;border-radius:8px;padding:16px}
    h1{font-size:22px;margin:0} h2{font-size:16px;margin:0 0 12px}
    label{display:block;font-size:13px;color:#667085;margin:10px 0 5px}
    input,select{width:100%;min-height:38px;border:1px solid #d9ded6;border-radius:6px;padding:8px;box-sizing:border-box}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    button{min-height:38px;border:0;border-radius:6px;background:#116466;color:#fff;padding:8px 12px;margin:10px 8px 0 0;cursor:pointer}
    button.secondary{background:#e7f1ee;color:#0b4f51;border:1px solid #c8ddd7}
    pre{background:#101828;color:#e5e7eb;border-radius:8px;padding:14px;overflow:auto}
    @media(max-width:720px){.grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
<main>
  <h1>OA1 / OA2 贈扣點工具</h1>
  <section>
    <h2>連線</h2>
    <label>Admin Token</label>
    <input id="token" type="password" placeholder="貼上 ADMIN_TOKEN">
  </section>
  <section>
    <h2>會員與點數</h2>
    <div class="grid">
      <div><label>OA</label><select id="channel"><option value="oa1">OA1</option><option value="oa2">OA2</option></select></div>
      <div><label>LINE User ID</label><input id="lineUserId" placeholder="U..."></div>
      <div><label>Point Type</label><input id="pointType" value="manual_point"></div>
      <div><label>點數</label><input id="points" type="number" value="10"></div>
    </div>
    <label>備註</label><input id="note" placeholder="例：活動補點 / 商品核銷">
    <button id="grant">贈點</button>
    <button id="deduct" class="secondary">扣點</button>
    <button id="balance" class="secondary">查餘額</button>
    <button id="ledger" class="secondary">查紀錄</button>
  </section>
  <section><h2>結果</h2><pre id="out">等待操作</pre></section>
</main>
<script>
const $=id=>document.getElementById(id);
function headers(){return {"content-type":"application/json","authorization":"Bearer "+$("token").value};}
function payload(){return {channel_key:$("channel").value,line_user_id:$("lineUserId").value,point_type:$("pointType").value,points:Number($("points").value),note:$("note").value};}
async function call(path,opt={}){const r=await fetch(path,{headers:headers(),...opt});const j=await r.json();$("out").textContent=JSON.stringify(j,null,2);}
$("grant").onclick=()=>call("/admin/points/grant",{method:"POST",body:JSON.stringify(payload())});
$("deduct").onclick=()=>call("/admin/points/deduct",{method:"POST",body:JSON.stringify(payload())});
$("balance").onclick=()=>call("/admin/points/balance?channel_key="+encodeURIComponent($("channel").value)+"&line_user_id="+encodeURIComponent($("lineUserId").value));
$("ledger").onclick=()=>call("/admin/points/ledger?channel_key="+encodeURIComponent($("channel").value)+"&line_user_id="+encodeURIComponent($("lineUserId").value));
</script>
</body>
</html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export default {
  async fetch(request: Request, env: GatewayEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return handleHealth(env);
    }

    if (request.method === "GET" && url.pathname === "/admin/tool") {
      return adminToolHtml();
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

    if (request.method === "POST" && url.pathname === "/admin/points/grant") {
      return pointMutationRoute(request, env, "grant");
    }

    if (request.method === "POST" && url.pathname === "/admin/points/deduct") {
      return pointMutationRoute(request, env, "deduct");
    }

    if (request.method === "POST" && url.pathname === "/admin/points/redeem") {
      return pointMutationRoute(request, env, "redeem");
    }

    if (request.method === "GET" && url.pathname === "/admin/points/balance") {
      return balancesRoute(request, env);
    }

    if (request.method === "GET" && url.pathname === "/admin/points/ledger") {
      return ledgerRoute(request, env);
    }

    const match = url.pathname.match(/^\/line-webhook\/([^/]+)$/);
    if (request.method === "POST" && match) {
      return handleWebhook(request, env, match[1]);
    }

    return json({ success: false, message: "Not found" }, 404);
  }
};
