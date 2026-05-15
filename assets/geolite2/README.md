# GeoLite2 databases

`GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb` are downloaded at build
time by `scripts/fetch-geolite2.sh` and copied into the Docker image
at `/opt/geolite2/`. The runtime resolver in `src/lib/geo.ts` reads
them via `mmdb-lib`.

Run before `docker build`:

```
MAXMIND_LICENSE_KEY=xxxx ./scripts/fetch-geolite2.sh
```

Without the key the script exits cleanly and the image builds without
the databases — the resolver falls back to the `ipwho.is` online
provider (the v1.4.26 behaviour).

This product includes GeoLite2 data created by MaxMind, available from
<https://www.maxmind.com>. The databases are licensed under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
