import type { GatewayEnv } from "./types.js";

const DEFAULT_MEMBER_API_URL = "https://k-link.cc/index.php/wp-json/wetw/v1/query-line-user-list";
const DEFAULT_POINT_API_BASE_URL = "https://k-link.cc/index.php/wp-json/wetw-point/v1";

export interface WetwMember {
  ID?: string | number;
  user_login?: string;
  display_name?: string;
  shop_id?: string | number;
  LINE_user_id?: string;
  LINE_display_name?: string;
  phone?: string;
  [key: string]: unknown;
}

export interface WetwPointEntry {
  id?: string | number;
  user_id?: string | number;
  LINE_user_id?: string;
  shop_id?: string | number;
  event_name?: string;
  event_content?: string;
  point_type?: string;
  get_point?: string | number;
  point_balance?: string | number;
  created_at?: string;
  [key: string]: unknown;
}

function apiKey(env: GatewayEnv, override?: string): string {
  const key = override ?? env.WETW_API_KEY ?? env.POINT_API_KEY;
  if (!key) throw new Error("WETW_API_KEY or POINT_API_KEY is not configured");
  return key;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`WETW API returned non-JSON (${response.status}): ${text.slice(0, 160)}`);
  }
  if (!response.ok) {
    const message = typeof data === "object" && data && "message" in data ? String(data.message) : response.statusText;
    throw new Error(`WETW API failed (${response.status}): ${message}`);
  }
  return data as T;
}

export async function queryWetwMembers(
  env: GatewayEnv,
  input: { shopId: number; lineUserId?: string; apiKey?: string }
): Promise<WetwMember[]> {
  const data = await postJson<{
    success?: boolean;
    code?: string;
    message?: string;
    data?: { total?: number; list?: WetwMember[] };
  }>(env.WETW_MEMBER_API_URL ?? DEFAULT_MEMBER_API_URL, {
    api_key: apiKey(env, input.apiKey),
    shop_id: input.shopId,
    ...(input.lineUserId ? { LINE_user_id: input.lineUserId } : {})
  });

  if (data.success === false) throw new Error(`WETW member query failed: ${data.code ?? "unknown"} ${data.message ?? ""}`);
  return data.data?.list ?? [];
}

export async function queryWetwPointEntries(
  env: GatewayEnv,
  input: { lineUserId: string; shopId?: number; apiKey?: string; page?: number; perPage?: number }
): Promise<WetwPointEntry[]> {
  const baseUrl = env.WETW_POINT_API_BASE_URL ?? DEFAULT_POINT_API_BASE_URL;
  const data = await postJson<{
    success?: boolean;
    code?: string;
    message?: string;
    data?: { list?: WetwPointEntry[] };
  }>(`${baseUrl.replace(/\/$/, "")}/query-user-point-list`, {
    api_key: apiKey(env, input.apiKey),
    LINE_user_id: input.lineUserId,
    ...(input.shopId ? { shop_id: input.shopId } : {}),
    page: input.page ?? 1,
    per_page: input.perPage ?? 100
  });

  if (data.success === false) throw new Error(`WETW point query failed: ${data.code ?? "unknown"} ${data.message ?? ""}`);
  return data.data?.list ?? [];
}
