# v1.4.27 release summary

## Overview

v1.4.27 polishes the settings shell rhythm and lands the offline-first
geolocation pipeline that drives the `/admin/login-overview` table.
Two MaxMind GeoLite2 databases (`GeoLite2-City` + `GeoLite2-ASN`) are
now bundled into the runtime image; the resolver in
`src/lib/geo.ts` reads them with `mmdb-lib` and falls back to the
existing `ipwho.is` HTTPS path only when the local DB cannot resolve
the address.

## GeoLite2 attribution

This product includes GeoLite2 data created by MaxMind, available from
<https://www.maxmind.com>. The GeoLite2 databases (`GeoLite2-City`
and `GeoLite2-ASN`) are distributed under the
[Creative Commons Attribution-ShareAlike 4.0 International License][cc-by-sa-4].

The same attribution renders on the `/about` page so an end user can
discover it without inspecting the repository.

[cc-by-sa-4]: https://creativecommons.org/licenses/by-sa/4.0/

## Operating the offline databases

The MMDB files are too large to vendor in git. They are downloaded
outside the Docker build by `scripts/fetch-geolite2.sh`. The operator
runs the script before `docker build` with a free MaxMind license
key:

```
MAXMIND_LICENSE_KEY=xxxx ./scripts/fetch-geolite2.sh
```

The script writes `GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb` to
`assets/geolite2/`. The Dockerfile then copies the folder into
`/opt/geolite2/` so the runtime resolver finds the databases on disk.
If the script is skipped the image builds cleanly, and the resolver
falls back to the online `ipwho.is` provider — the v1.4.26 behaviour.

MaxMind reissues the databases on the first Tuesday of each month;
re-run the script before each release to pick up new ASN allocations
and city renames.

## Schema delta

`AuditLog` grows two nullable columns:

- `asn Int?` — the autonomous-system number resolved from the
  `GeoLite2-ASN` DB at audit-creation time.
- `carrier String?` — the matching `autonomous_system_organization`
  string (e.g. `"Deutsche Telekom AG"`).

Both columns are additive and `IF NOT EXISTS`-guarded so the
migration is idempotent on the demo server which may already carry
hand-edited columns from a prior partial run.

## Backfill helper

`src/lib/jobs/geo-backfill.ts` walks rows where `location IS NULL`
and `createdAt > now() - 30 days`, capped at 5 000 rows per pass, and
re-resolves them through the offline DB. Useful after a fresh
GeoLite2 DB roll so the historical rows that landed during an
`ipwho.is` outage finally pick up a city + carrier label.

## Image-size budget

The two MMDB files add ~80 MB to the production image. The
`tzdata`-bearing Alpine runner stage already sits at ~330 MB
compressed; the v1.4.27 image lands well under the 90 MB image-size
delta budget set out in the fix plan.
