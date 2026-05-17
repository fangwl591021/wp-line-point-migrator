# OA CRM

The gateway now exposes a small CRM for each LINE official account.

## Pages

- `/admin/crm`
- `/admin/tool` redirects to the same CRM UI for convenience.

Both pages require the `ADMIN_TOKEN` value in the browser UI.

## Environment variables

Keep real secrets in `wrangler.gateway.toml` or Cloudflare secrets.

```toml
WETW_API_KEY = "" # POINT_API_KEY is also supported
WETW_MEMBER_API_URL = "https://k-link.cc/index.php/wp-json/wetw/v1/query-line-user-list"
WETW_POINT_API_BASE_URL = "https://k-link.cc/index.php/wp-json/wetw-point/v1"
```

## Admin APIs

### Sync members from the mother WordPress site

```http
POST /admin/crm/sync-members
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json
```

```json
{
  "channel_key": "oa1",
  "shop_id": 216
}
```

The response stores members in `crm_members` keyed by `channel_key + LINE_user_id`.

### List CRM members

```http
GET /admin/crm/members?channel_key=oa1&search=Tony&limit=200
Authorization: Bearer <ADMIN_TOKEN>
```

### Sync one member's point balances from the mother point API

```http
POST /admin/crm/sync-points
Authorization: Bearer <ADMIN_TOKEN>
Content-Type: application/json
```

```json
{
  "channel_key": "oa1",
  "line_user_id": "Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "shop_id": 216
}
```

This reads `query-user-point-list` and updates local `point_accounts` with the latest returned balance per `point_type`.

### Local point operations

Existing local point operations remain available:

- `POST /admin/points/grant`
- `POST /admin/points/deduct`
- `POST /admin/points/redeem`
- `GET /admin/points/balance`
- `GET /admin/points/ledger`

These currently mutate the gateway's D1 ledger. Mirroring mutations back to the mother WordPress point API should be enabled only after a controlled insert test.
