# Research Notes

## Existing Tool Landscape

There are WordPress point systems and migration add-ons, but they are usually tied to a target plugin:

- WPLoyalty Migration
- GamiPress CSV tools
- myCred
- generic usermeta export plugins

The gap this project targets:

- LINE UID identity extraction,
- different LINE Provider identity reconciliation,
- WETW-style API sources and targets,
- dry-run and audit-friendly point transfer,
- repeated agency/client usage.

## Common Identity Signals

- `wp_users.ID`
- `wp_users.user_login`
- `wp_usermeta` LINE UID values like `U012e2380deb2d5815f6b6bda6bef35a6`
- email
- phone
- external member IDs

## Common Point Signals

Field names:

- `point`
- `points`
- `balance`
- `credit`
- `wallet`
- `money`
- `reward`

Record fields:

- `user_id`
- `line_user_id`
- `point_type`
- `get_point`
- `point_balance`
- `created_at`

## First Migration Rule

Prefer migrating balances as a new event into the target system unless the target explicitly supports importing historical logs.

Recommended event:

```text
event_name: Legacy balance migration
event_content: Imported from {source_site} at {timestamp}
```
