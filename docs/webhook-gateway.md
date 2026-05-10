# Webhook Gateway

The gateway records LINE user IDs per LINEOA channel and forwards the original webhook body to the existing WordPress endpoint.

## Flow

```text
LINEOA1 -> Gateway /line-webhook/oa1 -> existing https://k-link.cc/index.php/line_login/1086/
LINEOA2 -> Gateway /line-webhook/oa2 -> existing https://k-link.cc/index.php/line_login/1584/
```

The gateway stores:

- channel key,
- LINE user ID,
- event type,
- message text,
- timestamp,
- raw event JSON.

## D1 Setup

Create a D1 database and run:

```bash
npx wrangler d1 execute wp-line-point-gateway --remote --file=./schema/gateway.sql
```

## Channel Config

Copy `wrangler.gateway.example.toml` to `wrangler.gateway.toml` and set:

```toml
CHANNEL_CONFIG_JSON = '''
{
  "oa1": {
    "label": "LINEOA 1086",
    "channelSecret": "YOUR_OA1_CHANNEL_SECRET",
    "forwardUrl": "https://k-link.cc/index.php/line_login/1086/"
  },
  "oa2": {
    "label": "LINEOA 1584",
    "channelSecret": "YOUR_OA2_CHANNEL_SECRET",
    "forwardUrl": "https://k-link.cc/index.php/line_login/1584/"
  }
}
'''
```

For production, prefer storing config via Cloudflare secrets or a private deployment config that is not committed.

## LINE Developer Console

Set LINEOA webhook URLs:

```text
https://YOUR-GATEWAY.workers.dev/line-webhook/oa1
https://YOUR-GATEWAY.workers.dev/line-webhook/oa2
```

## Binding Codes

The gateway recognizes text messages:

```text
綁定 839201
bind 839201
```

When a valid code exists in `binding_codes`, it links:

```text
master_member_ref + channel_key + line_user_id
```

This is how different LINE Provider user IDs become one master member.

## Admin API

Set `ADMIN_TOKEN` in the private Wrangler config or as a Cloudflare secret.

Create a binding code:

```bash
curl -X POST "https://YOUR-GATEWAY.workers.dev/admin/binding-codes" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "master_member_ref": "wp:534",
    "ttl_minutes": 60
  }'
```

Response:

```json
{
  "success": true,
  "code": "AB12CD34",
  "instructions": ["綁定 AB12CD34", "bind AB12CD34"]
}
```

List collected LINE identities:

```bash
curl "https://YOUR-GATEWAY.workers.dev/admin/observations" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

List member links:

```bash
curl "https://YOUR-GATEWAY.workers.dev/admin/member-links?master_member_ref=wp:534" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

## OA Point Tools

Open the built-in admin tool:

```text
https://YOUR-GATEWAY.workers.dev/admin/tool
```

Paste `ADMIN_TOKEN`, choose `OA1` or `OA2`, enter the LINE user ID, then grant or deduct points.

Admin APIs:

```bash
curl -X POST "https://YOUR-GATEWAY.workers.dev/admin/points/grant" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_key": "oa1",
    "line_user_id": "U...",
    "point_type": "manual_point",
    "points": 100,
    "note": "活動贈點"
  }'
```

```bash
curl -X POST "https://YOUR-GATEWAY.workers.dev/admin/points/deduct" \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "channel_key": "oa2",
    "line_user_id": "U...",
    "point_type": "manual_point",
    "points": 50,
    "note": "核銷扣點"
  }'
```

Check balance:

```bash
curl "https://YOUR-GATEWAY.workers.dev/admin/points/balance?channel_key=oa1&line_user_id=U..." \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

Check ledger:

```bash
curl "https://YOUR-GATEWAY.workers.dev/admin/points/ledger?channel_key=oa1&line_user_id=U..." \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

Check-in messages such as `會員打卡` are recorded automatically as `checkin_point`.
Current defaults:

```text
OA1 check-in: +10
OA2 check-in: +5
```

## Important

Webhook observation alone can collect UID per OA, but it cannot prove that two different UIDs are the same human.

The proof requires one of:

- binding code,
- login session plus binding action,
- phone/email match,
- manual operator confirmation.
