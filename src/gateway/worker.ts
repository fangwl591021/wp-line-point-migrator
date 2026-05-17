import { getChannelConfig } from "./config.js";
import { listCrmMembers, replaceBalancesFromWetwEntries, upsertCrmMembers } from "./crm.js";
import { verifyLineSignature } from "./line-signature.js";
import { applyPointMutation, listBalances, listLedger } from "./points.js";
import { recordEvent, tryApplyBindingCode, upsertChannel } from "./storage.js";
import type { GatewayEnv, LineWebhookPayload } from "./types.js";
import { queryWetwMembers, queryWetwPointEntries } from "./wetw.js";

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
  const mlmForwarded = await forwardToMlmMonitor(env, channelKey, config.mlmForwardUrl, rawBody, request.headers.get("content-type"));

  return json({
    success: true,
    channel_key: channelKey,
    recorded_events: payload.events?.length ?? 0,
    checkin_events: checkinEvents,
    forwarded: {
      url: config.forwardUrl,
      status: forwardResponse.status,
      ok: forwardResponse.ok
    },
    mlm_forwarded: mlmForwarded
  });
}

async function forwardToMlmMonitor(
  env: GatewayEnv,
  channelKey: string,
  configuredUrl: string | undefined,
  rawBody: string,
  contentType: string | null
): Promise<{ enabled: boolean; url?: string; status?: number; ok?: boolean; error?: string }> {
  if (!env.MLM_FORWARD_TOKEN) return { enabled: false };
  const baseUrl = configuredUrl || env.MLM_FORWARD_URL || "https://mlm.fangwl591021.workers.dev/internal/line-webhook";
  const url = resolveMlmForwardUrl(baseUrl, channelKey, Boolean(configuredUrl));
  try {
    const signature = await signGatewayPayload(rawBody, env.MLM_FORWARD_TOKEN);
    const forwardedRequest = new Request(url, {
      method: "POST",
      headers: {
        "content-type": contentType ?? "application/json",
        "x-gateway-channel": channelKey,
        "x-gateway-signature": signature
      },
      body: rawBody
    });
    const response = env.MLM_WORKER ? await env.MLM_WORKER.fetch(forwardedRequest) : await fetch(forwardedRequest);
    const detail = response.ok ? "" : (await response.text()).slice(0, 300);
    return { enabled: true, url, status: response.status, ok: response.ok, error: detail || undefined };
  } catch (error) {
    return {
      enabled: true,
      url,
      status: 0,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function resolveMlmForwardUrl(baseUrl: string, channelKey: string, isConfiguredChannelUrl: boolean): string {
  const trimmed = baseUrl.replace(/\/$/, "");
  if (isConfiguredChannelUrl) return trimmed;
  if (trimmed.includes("{channel}")) return trimmed.replace("{channel}", encodeURIComponent(channelKey));
  if (/\/internal\/line-webhook\/[^/]+$/i.test(trimmed)) return trimmed;
  return `${trimmed}/${encodeURIComponent(channelKey)}`;
}

async function signGatewayPayload(rawBody: string, token: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", encoder.encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

function detectCheckinPointDelta(channelKey: string, text?: string): number | null {
  if (!text) return null;
  if (text.trim() === "簽到贈K點") return null;
  if (!/每日簽到贈點|會員打卡|打卡|簽到|checkin/i.test(text)) return null;
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
    channels: Object.keys(config),
    checks: {
      DB: Boolean(env.DB),
      CHANNEL_CONFIG_JSON: Boolean(env.CHANNEL_CONFIG_JSON),
      MLM_FORWARD_TOKEN: Boolean(env.MLM_FORWARD_TOKEN),
      MLM_WORKER: Boolean(env.MLM_WORKER)
    }
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

async function syncCrmMembersRoute(request: Request, env: GatewayEnv): Promise<Response> {
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  const body = await readJson<{
    channel_key?: string;
    shop_id?: number;
    line_user_id?: string;
    api_key?: string;
  }>(request);
  if (!body.channel_key || !body.shop_id) {
    return json({ success: false, message: "channel_key and shop_id are required" }, 400);
  }

  const members = await queryWetwMembers(env, {
    shopId: Number(body.shop_id),
    lineUserId: body.line_user_id,
    apiKey: body.api_key
  });
  const stored = await upsertCrmMembers(env, body.channel_key, members);
  return json({ success: true, channel_key: body.channel_key, shop_id: body.shop_id, fetched: members.length, stored });
}

async function listCrmMembersRoute(request: Request, env: GatewayEnv): Promise<Response> {
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const channelKey = url.searchParams.get("channel_key");
  if (!channelKey) return json({ success: false, message: "channel_key is required" }, 400);

  const members = await listCrmMembers(env, {
    channelKey,
    search: url.searchParams.get("search") ?? undefined,
    limit: Number(url.searchParams.get("limit") ?? 100),
    offset: Number(url.searchParams.get("offset") ?? 0)
  });
  return json({ success: true, members });
}

async function syncCrmMemberPointsRoute(request: Request, env: GatewayEnv): Promise<Response> {
  const unauthorized = requireAdmin(request, env);
  if (unauthorized) return unauthorized;

  const body = await readJson<{
    channel_key?: string;
    line_user_id?: string;
    shop_id?: number;
    api_key?: string;
  }>(request);
  if (!body.channel_key || !body.line_user_id) {
    return json({ success: false, message: "channel_key and line_user_id are required" }, 400);
  }

  const entries = await queryWetwPointEntries(env, {
    lineUserId: body.line_user_id,
    shopId: body.shop_id,
    apiKey: body.api_key
  });
  const balancesUpdated = await replaceBalancesFromWetwEntries(env, body.channel_key, body.line_user_id, entries);
  return json({
    success: true,
    channel_key: body.channel_key,
    line_user_id: body.line_user_id,
    entries: entries.length,
    balances_updated: balancesUpdated
  });
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

function crmToolHtml(): Response {
  return new Response(`<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OA CRM</title>
  <style>
    body{font-family:Arial,"Noto Sans TC",sans-serif;margin:0;background:#f5f6f8;color:#1f2937}
    main{max-width:1180px;margin:24px auto;padding:0 16px;display:grid;gap:14px}
    section{background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:16px}
    h1{font-size:22px;margin:0} h2{font-size:16px;margin:0 0 12px}
    label{display:block;font-size:13px;color:#667085;margin:10px 0 5px}
    input{width:100%;min-height:38px;border:1px solid #cfd7e3;border-radius:6px;padding:8px;box-sizing:border-box;background:#fff}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{border-bottom:1px solid #e5e7eb;padding:9px 8px;text-align:left;vertical-align:top}
    th{background:#f8fafc;color:#475467;font-weight:600}
    button{min-height:36px;border:0;border-radius:6px;background:#0f766e;color:#fff;padding:8px 12px;margin:10px 8px 0 0;cursor:pointer}
    button.secondary{background:#eef6f4;color:#0f766e;border:1px solid #b9d8d2}
    button.danger{background:#9f1239}
    pre{background:#111827;color:#e5e7eb;border-radius:8px;padding:14px;overflow:auto;max-height:260px}
    .grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
    .tabs{display:flex;gap:8px;flex-wrap:wrap}
    .tab{background:#e5e7eb;color:#111827}
    .tab.active{background:#0f766e;color:white}
    .toolbar{display:flex;gap:8px;align-items:end;flex-wrap:wrap}
    .toolbar>div{min-width:170px;flex:1}
    .muted{color:#667085;font-size:13px}
    .uid{font-family:Consolas,monospace;font-size:12px;word-break:break-all;white-space:pre-wrap}
    @media(max-width:880px){.grid{grid-template-columns:1fr}.toolbar{display:block}}
  </style>
</head>
<body>
<main>
  <h1>OA1 / OA2 CRM</h1>
  <section>
    <h2>連線設定</h2>
    <label>Admin Token</label>
    <input id="token" type="password" placeholder="輸入 Worker ADMIN_TOKEN">
    <p class="muted">Token 只存在你的瀏覽器 localStorage，不會寫入 D1。</p>
  </section>
  <section>
    <div class="tabs">
      <button class="tab active" data-channel="oa1">OA1 CRM</button>
      <button class="tab" data-channel="oa2">OA2 CRM</button>
    </div>
  </section>
  <section>
    <h2>會員名冊同步</h2>
    <div class="toolbar">
      <div><label>目前 OA</label><input id="channel" value="oa1"></div>
      <div><label>shop_id</label><input id="shopId" type="number" placeholder="母站提供的 shop_id"></div>
      <div><label>搜尋</label><input id="search" placeholder="姓名 / 手機 / UID"></div>
      <div><button id="syncMembers">同步會員</button><button id="loadMembers" class="secondary">讀取CRM</button></div>
    </div>
  </section>
  <section>
    <h2>會員列表</h2>
    <table>
      <thead><tr><th>會員</th><th>LINE UID</th><th>shop</th><th>餘額</th><th>操作</th></tr></thead>
      <tbody id="members"><tr><td colspan="5" class="muted">尚未讀取</td></tr></tbody>
    </table>
  </section>
  <section>
    <h2>贈點 / 扣點 / 核銷</h2>
    <div class="grid">
      <div><label>LINE User ID</label><input id="lineUserId" placeholder="從會員列表選取或輸入 U..."></div>
      <div><label>Point Type</label><input id="pointType" value="manual_point"></div>
      <div><label>點數</label><input id="points" type="number" value="10"></div>
      <div><label>備註</label><input id="note" placeholder="操作原因 / 核銷內容"></div>
    </div>
    <button id="syncPoints" class="secondary">同步母站點數</button>
    <button id="grant">贈點</button>
    <button id="deduct" class="danger">扣點</button>
    <button id="redeem" class="danger">核銷</button>
    <button id="balance" class="secondary">查餘額</button>
    <button id="ledger" class="secondary">查流水</button>
  </section>
  <section><h2>結果</h2><pre id="out">等待操作</pre></section>
</main>
<script>
const $ = id => document.getElementById(id);
const savedToken = localStorage.getItem("crm_admin_token");
if (savedToken) $("token").value = savedToken;
function headers(){
  localStorage.setItem("crm_admin_token", $("token").value);
  return {"content-type":"application/json","authorization":"Bearer " + $("token").value};
}
function esc(value){
  return String(value == null ? "" : value).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));
}
function channel(){ return $("channel").value.trim(); }
function shopId(){ const value = Number($("shopId").value); return Number.isFinite(value) && value > 0 ? value : undefined; }
function pointPayload(){
  return {
    channel_key: channel(),
    line_user_id: $("lineUserId").value.trim(),
    point_type: $("pointType").value.trim(),
    points: Number($("points").value),
    note: $("note").value.trim()
  };
}
async function call(path, opt = {}){
  const response = await fetch(path, {headers: headers(), ...opt});
  const data = await response.json();
  $("out").textContent = JSON.stringify(data, null, 2);
  return data;
}
function setChannel(next){
  $("channel").value = next;
  document.querySelectorAll(".tab").forEach(button => button.classList.toggle("active", button.dataset.channel === next));
  loadMembers();
}
function balancesText(row){
  try {
    return JSON.parse(row.balances_json || "[]").filter(Boolean).map(item => item.point_type + ": " + item.balance).join("\\n") || "-";
  } catch {
    return "-";
  }
}
function renderMembers(rows){
  $("members").innerHTML = (rows || []).map(row => "<tr>" +
    "<td>" + esc(row.display_name || row.line_display_name || "-") + "<br><span class='muted'>WP " + esc(row.wp_user_id || "-") + " / " + esc(row.phone || "-") + "</span></td>" +
    "<td class='uid'>" + esc(row.line_user_id) + "</td>" +
    "<td>" + esc(row.shop_id || "-") + "</td>" +
    "<td class='uid'>" + esc(balancesText(row)) + "</td>" +
    "<td><button class='secondary pick' data-uid='" + esc(row.line_user_id) + "'>選取</button><button class='secondary sync-one' data-uid='" + esc(row.line_user_id) + "' data-shop='" + esc(row.shop_id || "") + "'>同步點數</button></td>" +
  "</tr>").join("") || "<tr><td colspan='5' class='muted'>沒有資料</td></tr>";
  document.querySelectorAll(".pick").forEach(button => button.onclick = () => { $("lineUserId").value = button.dataset.uid || ""; });
  document.querySelectorAll(".sync-one").forEach(button => button.onclick = async () => {
    await syncPoints(button.dataset.uid || "", Number(button.dataset.shop || $("shopId").value));
    await loadMembers();
  });
}
async function loadMembers(){
  const params = new URLSearchParams({channel_key: channel(), limit: "200"});
  if ($("search").value.trim()) params.set("search", $("search").value.trim());
  const data = await call("/admin/crm/members?" + params.toString());
  renderMembers(data.members || []);
}
async function syncPoints(uid, sid){
  const body = {channel_key: channel(), line_user_id: uid || $("lineUserId").value.trim()};
  if (sid) body.shop_id = sid;
  return call("/admin/crm/sync-points", {method:"POST", body: JSON.stringify(body)});
}
document.querySelectorAll(".tab").forEach(button => button.onclick = () => setChannel(button.dataset.channel));
$("syncMembers").onclick = async () => {
  const body = {channel_key: channel(), shop_id: shopId()};
  if (!body.shop_id) { alert("請先輸入 shop_id"); return; }
  await call("/admin/crm/sync-members", {method:"POST", body: JSON.stringify(body)});
  await loadMembers();
};
$("loadMembers").onclick = loadMembers;
$("search").onkeydown = event => { if (event.key === "Enter") loadMembers(); };
$("syncPoints").onclick = () => syncPoints();
$("grant").onclick = () => call("/admin/points/grant", {method:"POST", body: JSON.stringify(pointPayload())});
$("deduct").onclick = () => call("/admin/points/deduct", {method:"POST", body: JSON.stringify(pointPayload())});
$("redeem").onclick = () => call("/admin/points/redeem", {method:"POST", body: JSON.stringify(pointPayload())});
$("balance").onclick = () => call("/admin/points/balance?channel_key=" + encodeURIComponent(channel()) + "&line_user_id=" + encodeURIComponent($("lineUserId").value));
$("ledger").onclick = () => call("/admin/points/ledger?channel_key=" + encodeURIComponent(channel()) + "&line_user_id=" + encodeURIComponent($("lineUserId").value));
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

    if (request.method === "GET" && (url.pathname === "/admin/tool" || url.pathname === "/admin/crm")) {
      return crmToolHtml();
    }

    if (request.method === "POST" && url.pathname === "/admin/crm/sync-members") {
      return syncCrmMembersRoute(request, env);
    }

    if (request.method === "GET" && url.pathname === "/admin/crm/members") {
      return listCrmMembersRoute(request, env);
    }

    if (request.method === "POST" && url.pathname === "/admin/crm/sync-points") {
      return syncCrmMemberPointsRoute(request, env);
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
