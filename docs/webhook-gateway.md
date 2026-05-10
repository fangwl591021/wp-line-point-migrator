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

## Important

Webhook observation alone can collect UID per OA, but it cannot prove that two different UIDs are the same human.

The proof requires one of:

- binding code,
- login session plus binding action,
- phone/email match,
- manual operator confirmation.
