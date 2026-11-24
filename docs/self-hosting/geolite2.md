# Offline geolocation (GeoLite2)

The admin login overview shows a coarse `City, CC` location and a carrier
next to every sign-in. Two tiers can produce that:

- **Offline.** MaxMind's GeoLite2-City and GeoLite2-ASN databases read
  from a local directory. The ASN database is the authoritative source
  for the carrier and the AS number. The resolver reads these first: an
  address the local databases can place never leaves the host.
- **Online.** A third-party lookup, `https://ipwho.is` by default. Free,
  keyless, and the only tier on a host without the databases — which
  means every login IP address of every account on that instance leaves
  the host. With the databases mounted it sees only the addresses they
  could not place, and you can switch it off entirely (below).

The offline tier is optional and absent by default. The published image
only carries the databases when the image build had a MaxMind licence key
(`scripts/fetch-geolite2.sh`, run from the release workflow), which is a
build-time decision you do not control when you pull `:latest`. Two ways
get the offline tier onto a stock `:latest` self-host, and both are on this
page: let the app **fetch the databases itself** at runtime (simplest, one
env var), or **bring your own** copy and mount it.

## Runtime fetch (one env var)

Set a MaxMind licence key and the app downloads the databases itself — no
rebuild, no mount, no `geoipupdate` on the host.

1. Create a free MaxMind account at
   <https://www.maxmind.com/en/geolite2/signup>, then a licence key under
   **My Account > Manage License Keys**. GeoLite2 is free; the account and
   key exist because MaxMind requires them for the download.

2. Put the key in your `.env`:

   ```env
   MAXMIND_LICENSE_KEY="your-licence-key"
   ```

   `MAXMIND_LICENSE_KEY` is on the compose `environment:` whitelist, so a
   value in `.env` reaches the container. Leave `GEOLITE2_DIR` unset to use
   the default `/opt/geolite2`, which the image already owns as the app
   user for exactly this write.

3. `docker compose up -d`. On the next worker boot the app fetches
   `GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb` into `GEOLITE2_DIR` and
   starts reading them — no restart needed beyond the one that picks up the
   new env var. It refreshes once a month afterwards (MaxMind reissues on
   the first Tuesday), so a keyed host stays current on its own.

The fetch is fail-soft: if the key is wrong or MaxMind is unreachable, the
previous state stands (the online provider keeps answering) and the worker
log carries the reason. It never writes a partial database. Confirm it
landed under **Admin > System status** (`Geo data: Offline (GeoLite2)`) or
from the host: `docker compose exec app ls -l /opt/geolite2`.

If you would rather not have the app reach MaxMind on its own schedule —
for example you keep a curated database copy — skip the key and use
**bring your own** below instead. The two do not conflict: a read-only
bind mount wins, because the runtime fetch cannot write over it and just
fails soft.

## Bring your own (mount a copy)

### What you need

- A free MaxMind account. Sign up at
  <https://www.maxmind.com/en/geolite2/signup>, then create a licence key
  under **My Account > Manage License Keys**. GeoLite2 is free; the
  account and key exist because MaxMind requires them for the download.
- `geoipupdate` (MaxMind's own downloader) or any other way to fetch the
  two `.mmdb` files onto the host. Most distributions package
  `geoipupdate`; there is also an official container image.

### Setup

1. Pick a directory on the host and fetch both databases into it. With
   `geoipupdate`, `/etc/GeoIP.conf` looks like this:

   ```conf
   AccountID <your-account-id>
   LicenseKey <your-licence-key>
   EditionIDs GeoLite2-City GeoLite2-ASN
   DatabaseDirectory /srv/healthlog/geolite2
   ```

   Then run `geoipupdate`. The directory should end up holding
   `GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb`. The City database is the
   one the readiness check looks for; the ASN database is what fills the
   carrier and AS number.

2. Mount the directory into the app container read-only. In
   `docker-compose.yml` the `app` service carries a commented `volumes:`
   block for exactly this:

   ```yaml
   volumes:
     - ./geolite2:/opt/geolite2:ro
   ```

   Swap the host side (`./geolite2`) for your directory, e.g.
   `/srv/healthlog/geolite2`.

3. `/opt/geolite2` is the default value of `GEOLITE2_DIR`, so mounting
   at that container path needs no env var at all. Only if you mount at
   a different container path do you set it:

   ```env
   GEOLITE2_DIR="/var/lib/geolite2"
   ```

   `GEOLITE2_DIR` is on the compose `environment:` whitelist, so a value
   in your `.env` reaches the container. Variables that are not on that
   whitelist never do, even when compose substitutes them elsewhere in
   the file.

4. `docker compose up -d` and sign in once. **Admin > System status**
   shows `Geo data: Offline (GeoLite2)` when the databases are being
   read, and names the online provider when they are not.

## Turning the online lookup off entirely

With the databases mounted, the third-party lookup already only sees
addresses they could not place. To remove that remainder too:

```env
IP_GEO_LOOKUP_DISABLED="1"
```

`true` and `yes` work as well. Any other value, including an empty one, leaves
the lookup on.

The resolver then uses only the local databases and returns nothing when
they miss, rather than asking anyone. An instance handling other people's
health data is a reasonable place to make that trade.

## Keeping the databases current

MaxMind reissues GeoLite2 on its own schedule, and a stale city database
is quietly wrong rather than loudly broken — it keeps answering, with
last month's allocations.

The **runtime fetch** handles this for you: it re-downloads both databases
once a month and resets the reader in place, so a keyed host stays current
with no cron of your own and no restart.

The **bring-your-own** path is yours to keep fresh. Run `geoipupdate` on a
schedule (a weekly cron or systemd timer is enough) against the same
directory. The reader loads each database once per worker process and holds
it, so a refreshed file on the host is picked up at the next container
restart, not immediately. A weekly `geoipupdate` followed by
`docker compose restart app` keeps the two in step.

## Licence and attribution

The databases are downloaded under your own MaxMind account, so their
terms are between you and MaxMind — read what your account agrees to at
<https://www.maxmind.com/en/geolite/eula>. That agreement, the GeoLite
End User License Agreement, incorporates CC BY-SA 4.0 by reference and
controls wherever the two disagree; both require you to attribute the
data to MaxMind if you make it available to anyone else.

HealthLog's own attribution ("This product includes GeoLite2 data
created by MaxMind, available from https://www.maxmind.com") is already
on the `/about` page and covers an instance that uses them. Keep that
page reachable — it is what carries the attribution for your deployment,
and it is served without a session for exactly that reason.

## Troubleshooting

**System status still says the online provider.** The readiness check
requires `GeoLite2-City.mmdb` to exist in `GEOLITE2_DIR` and no `.empty`
marker file beside it. Check the path from inside the container:
`docker compose exec app ls -l /opt/geolite2` (or your `GEOLITE2_DIR`
value). An empty listing means
the bind mount did not land; a `.empty` file means the image was built
without a licence key and you are still reading the baked-in directory
rather than your own.

**The variable has no effect.** Confirm it actually reached the process:
`docker compose exec app printenv GEOLITE2_DIR`. If it prints nothing,
the value is in `.env` but not on the `environment:` whitelist — compare
against `docker-compose.yml`.

**The carrier column is empty.** The carrier also comes from the online
provider's ISP field, but the online lookup only runs for an address the
City database could not place. On a host with `GeoLite2-City.mmdb` and no
`GeoLite2-ASN.mmdb`, a location that resolves locally has no carrier to
go with it — mount the ASN database too. With neither database, the
online provider fills both, unless `IP_GEO_LOOKUP_DISABLED="1"` is set.
