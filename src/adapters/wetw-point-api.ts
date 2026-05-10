import { z } from "zod";
import type { NormalizedPointEntry, ProviderKey, SourceRef } from "../core/types.js";

const pointListItemSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  user_id: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => (value === undefined ? undefined : String(value))),
  LINE_user_id: z.string().optional(),
  shop_id: z.union([z.string(), z.number()]).transform(Number),
  event_name: z.string().optional(),
  event_content: z.string().optional(),
  point_type: z.string(),
  get_point: z.union([z.string(), z.number()]).transform(Number),
  point_balance: z
    .union([z.string(), z.number()])
    .optional()
    .transform((value) => (value === undefined ? undefined : Number(value))),
  created_at: z.string().optional()
});

const queryResponseSchema = z.object({
  success: z.boolean(),
  code: z.string(),
  message: z.string(),
  data: z
    .object({
      pagination: z.object({
        page: z.number(),
        per_page: z.number(),
        total: z.number(),
        total_pages: z.number()
      }),
      list: z.array(pointListItemSchema)
    })
    .optional()
});

class WetwApiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WetwApiResponseError";
  }
}

export interface WetwPointApiConfig {
  baseUrl: string;
  apiKey: string;
  shopId?: number;
  lineUserId?: string;
  providerKey: ProviderKey;
  sourceSite?: string;
  perPage?: number;
  maxPages?: number;
}

export async function fetchWetwPointEntries(config: WetwPointApiConfig): Promise<NormalizedPointEntry[]> {
  if (!config.shopId && !config.lineUserId) {
    throw new Error("Either shopId or lineUserId is required");
  }

  const entries: NormalizedPointEntry[] = [];
  const perPage = Math.min(config.perPage ?? 100, 100);
  const maxPages = config.maxPages ?? 500;
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages && page <= maxPages) {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/query-user-point-list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: config.apiKey,
        shop_id: config.shopId,
        LINE_user_id: config.lineUserId,
        page,
        per_page: perPage
      })
    });

    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new WetwApiResponseError(
        [
          "WETW query did not return JSON.",
          `HTTP status: ${response.status}`,
          `Content-Type: ${response.headers.get("content-type") ?? "unknown"}`,
          `Body preview: ${text.slice(0, 500)}`
        ].join("\n")
      );
    }

    const parsedResult = queryResponseSchema.safeParse(json);
    if (!parsedResult.success) {
      throw new WetwApiResponseError(
        [
          "WETW query returned an unexpected JSON shape.",
          `HTTP status: ${response.status}`,
          `Content-Type: ${response.headers.get("content-type") ?? "unknown"}`,
          `Validation errors: ${JSON.stringify(parsedResult.error.issues, null, 2)}`,
          `Body preview: ${JSON.stringify(json).slice(0, 800)}`
        ].join("\n")
      );
    }
    const parsed = parsedResult.data;
    if (!response.ok || !parsed.success) {
      throw new Error(`WETW query failed: ${parsed.code} ${parsed.message}`);
    }

    totalPages = Math.max(parsed.data?.pagination.total_pages ?? 1, 1);
    for (const item of parsed.data?.list ?? []) {
      entries.push(toNormalizedEntry(config, item));
    }

    if (!(parsed.data?.list.length)) break;
    page += 1;
  }

  return entries;
}

function toNormalizedEntry(
  config: WetwPointApiConfig,
  item: z.infer<typeof pointListItemSchema>
): NormalizedPointEntry {
  const sourceRef: SourceRef = {
    sourceType: "wetw-point-api",
    sourceSite: config.sourceSite,
    providerKey: config.providerKey,
    shopId: config.shopId
  };

  return {
    sourceRef,
    sourceEntryId: item.id,
    identity: {
      wpUserId: item.user_id,
      lineUserId: item.LINE_user_id
    },
    pointType: item.point_type,
    pointDelta: item.get_point,
    pointBalance: item.point_balance,
    eventName: item.event_name,
    eventContent: item.event_content,
    createdAt: item.created_at,
    raw: item
  };
}
