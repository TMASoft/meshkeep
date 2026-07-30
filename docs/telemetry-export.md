# Telemetry export format

Documents the existing telemetry export contract for GitHub issue #73. This is
a documentation-only change; it does not alter runtime behavior. Addresses the
sole unmet criterion from #52.

## Endpoint

`GET /api/v1/telemetry/export` — requires the same bearer-token auth as other
`/api/v1` routes.

Query parameters:

| Param | Type | Default | Notes |
| --- | --- | --- | --- |
| `format` | `csv` \| `json` | `csv` | Response body shape. |
| `hours` | integer | `720` | Export window size, looking back from now. Min `1`, max `720` (30 days) — the maximum is also the default, so a bare request already returns the full 30-day window. |
| `contactKey` | 64-char hex string | (none) | Restricts export to one contact's readings. Matches exactly, and excludes the own-radio battery row (which has no contact key). Omit to get own-radio battery plus every contact's numeric readings. |
| `radioId` | integer | current radio | Standard read-scoping param shared with other endpoints. An explicit value that doesn't match a known radio returns `404`. |

Invalid `format`, `hours`, or `contactKey` returns the standard `400`
`{ "error": "invalid request", "details": [...] }` shape described in the
[API section](../README.md#api).

## What's included

Each row is one telemetry sample:

- **Own-radio battery** — included whenever a battery voltage has been
  recorded, reported as metric `battery_mv`.
- **Contact readings** — every numeric sensor reading (temperature, voltage,
  etc.) attached to a contact.
- **Non-numeric readings are omitted.** Readings whose value is not a plain
  number — for example GPS coordinates, which are stored as an object — are
  dropped from the export entirely rather than serialized in any partial form.

## CSV format (`format=csv`, default)

Header row, exact column order:

```
ts_utc,contact_key,contact_name,metric,label,value,unit
```

- `ts_utc` — UTC ISO-8601 timestamp (`toISOString()`, e.g.
  `2026-07-27T10:20:30.123Z`).
- `contact_key` / `contact_name` — empty for the own-radio battery row.
- `metric` — `battery_mv` for own-radio battery; `<channel>:<type>` for
  contact readings.
- `label` / `unit` — human-readable label and unit string; empty if unset.
- `value` — a plain numeric cell (not quoted), so negative numbers render as
  e.g. `-5`.

Text fields are CSV-escaped and quoted when they contain a comma, quote, or
newline. A leading `=`, `+`, `-`, `@`, tab, or CR in a text field is prefixed
with `'` to neutralize spreadsheet formula injection; this does not apply to
the numeric `value` column, which is never quoted.

## JSON format (`format=json`)

```json
{
  "exportedAt": 1785225600,
  "samples": [
    {
      "ts": 1785225600,
      "contactKey": null,
      "contactName": null,
      "metric": "battery_mv",
      "label": "Battery",
      "value": 4123,
      "unit": "mV"
    }
  ]
}
```

- `exportedAt` — epoch seconds when the export was generated (not an ISO
  string — differs from the CSV `ts_utc` convention).
- `samples[]` — one entry per row, with `ts` also in epoch seconds.
  `contactKey`/`contactName` are `null` for the own-radio battery sample.
