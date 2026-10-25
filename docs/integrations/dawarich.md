# Dawarich integration

HealthLog can read daily movement context from a [Dawarich](https://dawarich.app)
instance: how far you moved, how much of it by car or by train, how many places
you visited, how long you were away from home, and whether a day was spent in
another country. It is part of the Environment module and runs only while that
module is on.

HealthLog never stores a coordinate, a track, a place name or a visit. It reads
the day summaries and keeps one row of numbers per day. The place list is read
live when you pick your home and is not saved.

## What is read

Once a night (03:20 Europe/Berlin) HealthLog fetches the last seven days, ending
yesterday. Connecting fetches the last 30 days. Each request carries your API
key as `Authorization: Bearer <key>`.

| Dawarich endpoint       | What HealthLog keeps                                                                   |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `GET /api/v1/timeline`  | total distance, distance by car (`driving`), distance by train, places visited         |
| `GET /api/v1/visits`    | minutes spent at your home place, to work out time away from home                      |
| `GET /api/v1/residency` | the country of each day, sealed at rest, and whether it differs from your home country |
| `GET /api/v1/places`    | nothing; the list is shown once so you can pick your home                              |
| `GET /api/v1/users/me`  | nothing; used to check the key                                                         |

Time away from home is the day's length minus the time a visit at your home
place covers. Without a home place, or on a day without a single visit, it is
left empty rather than shown as zero. Dawarich leaves out a mode that moved
less than half a kilometre; HealthLog then reads that mode as zero for the day.

Residency needs API access on a hosted Dawarich plan; a self-hosted instance
has it. Without it there are no travel days, and everything else still works.
Dawarich keys residency by UTC date, so on a day that crosses a border late in
the evening the country can be the next morning's.

## Connect

1. In Dawarich, open your account settings and copy the API key.
2. In HealthLog, turn on the Environment module, then open
   **Settings → Integrations → Dawarich**.
3. Enter the address of the instance and the key, and connect.
4. Pick your home place from the list, and set your home country if you like.
   Without one, the country you spent most days in over the last year counts.

Run Dawarich and HealthLog in the same time zone. Dawarich groups the
timeline by its own zone, HealthLog by yours; if they differ, a day can come
back without its distances.

## A Dawarich instance on your own network

A public instance works without any server setting. An instance on a private
network (a LAN address, a `.lan` name, a container on the same host) is refused
unless the operator lists its exact origin:

```env
DAWARICH_PRIVATE_ORIGINS="http://dawarich.lan:3000"
```

The grammar is the one `NIGHTSCOUT_PRIVATE_ORIGINS` uses
([Nightscout](./nightscout.md)): one `scheme://host[:port]` per entry, comma
separated, no path, no wildcard and no range. Listing a host does not open its
subdomains or another port. The unspecified address, link-local and the
cloud-metadata range can never be listed. Restart HealthLog after changing it.
The variable is on the `environment:` whitelist in `docker-compose.yml`.

## Where the values show up

- The day view has an **On the move** section with the day's figures.
- Time away from home and the distance travelled join the correlation scan as
  two more factors.
- Runs of at least two travel days that no trip covers yet are offered as
  trips under **Settings → Location & weather → Location periods**. Using one fills
  in the dates; you pick the place.
- The Coach and the MCP `get_day` tool see the figures and whether it was a
  travel day, never the country.

## Disconnect

Disconnecting stops the nightly fetch and keeps the stored days. **Disconnect
and delete days** removes them as well. The days are part of the backup; the
address and key are not, so a restored account connects again.
