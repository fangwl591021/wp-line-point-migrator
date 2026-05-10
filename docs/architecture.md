# Architecture

`wp-line-point-migrator` is adapter-first.

Each source adapter reads client-specific data and emits normalized records:

```text
Source Adapter -> NormalizedPointEntry[] -> Balance Calculator -> Migration Plan -> Target Adapter
```

## Source Adapters

Planned adapters:

- `wetw-point-api`
- `wp-db`
- `wp-rest`
- `csv`
- `manual-paste`

## Target Adapters

Planned targets:

- WETW insert-user-point API
- CSV export
- dry-run report
- future WordPress direct writer

## Idempotency

Every migration output should include a stable key:

```text
source_site + provider_key + source_entry_id + target_point_type
```

For balance-only migration, use:

```text
source_site + provider_key + identity_key + point_type + balance_snapshot_time
```

## Why CLI First

Point migration is data work. CLI-first makes it easy to:

- run dry-runs,
- save JSON reports,
- version mapping configs,
- audit every migration result,
- add web UI later without rewriting the core.
