# WordPress Exporter Plugin

This plugin is read-only. It exposes WordPress users and likely LINE/point-related user meta through protected REST endpoints.

## Install

Upload:

```text
wordpress-plugin/wp-line-point-exporter
```

to:

```text
wp-content/plugins/wp-line-point-exporter
```

Then enable **WP LINE Point Exporter** in WordPress admin.

## Settings

Open:

```text
Settings -> WP LINE Point Exporter
```

Copy the API key.

## Endpoints

List users:

```bash
curl "https://k-link.cc/wp-json/wp-line-point/v1/users?role=wetw_ai_vip&per_page=100&include_meta=1" \
  -H "x-wplpm-api-key: YOUR_API_KEY"
```

Read one user:

```bash
curl "https://k-link.cc/wp-json/wp-line-point/v1/users/534?include_all_meta=1" \
  -H "x-wplpm-api-key: YOUR_API_KEY"
```

Detect relevant user meta keys:

```bash
curl "https://k-link.cc/wp-json/wp-line-point/v1/detect-meta" \
  -H "x-wplpm-api-key: YOUR_API_KEY"
```

## Purpose

Use this plugin to discover:

- LINE UID meta keys,
- user roles,
- membership expiry fields,
- card count fields,
- renewal fields,
- point/balance-like user meta keys.

It does not write points or modify members.
