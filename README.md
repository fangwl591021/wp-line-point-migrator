# wp-line-point-migrator

Toolkit for detecting, normalizing, and migrating WordPress LINE-linked point systems.

This project is meant for repeated client work where each WordPress site may use different LINEOA providers, point plugins, or custom point tables.

## Goals

- Read point records from WordPress-related sources.
- Detect LINE UID and WordPress user identity fields.
- Normalize points into a stable internal format.
- Plan migrations with dry-run reports.
- Execute migrations through target adapters.
- Prevent duplicate point transfers.

## First Supported Source

The first adapter targets the WETW point API:

```text
POST /wp-json/wetw-point/v1/query-user-point-list
POST /wp-json/wetw-point/v1/insert-user-point
```

## Commands

```bash
npm install
npm run check
npm run build
```

Example:

```bash
npm run cli -- sync wetw ^
  --base-url "https://aiwe.cc/index.php/wp-json/wetw-point/v1" ^
  --api-key "%POINT_API_KEY%" ^
  --shop-id 1086 ^
  --provider-key oa1 ^
  --out ./out/oa1-points.json
```

If the real `shop_id` is unknown, query by a known LINE UID:

```bash
npm run cli -- sync wetw ^
  --base-url "https://aiwe.cc/index.php/wp-json/wetw-point/v1" ^
  --api-key "%POINT_API_KEY%" ^
  --line-user-id "U012e2380deb2d5815f6b6bda6bef35a6" ^
  --provider-key probe ^
  --out ./out/probe-user.json
```

## Design Principle

Every client site becomes configuration, not a one-off rewrite.
