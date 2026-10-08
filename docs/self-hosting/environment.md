# Weather, air quality and pollen

The environment module stores, for each day, the weather and the outdoor air
at a coarse location: temperature, sunshine, daylight, rain, pressure,
humidity, and since v1.42 fine particles, ozone, nitrogen dioxide, the
European and US air-quality indices, UV, Saharan dust and six kinds of
pollen. Those days sit beside the person's own data: the correlations look
for patterns between them and sleep, heart-rate variability, blood pressure,
mood and symptoms, the Coach and connected MCP clients can read them, and the
dashboard shows a quiet note on a day with high pollen, a warm night or very
poor air.

The module is on by default. Nothing leaves the host until a person sets a
home location in Settings → Location & weather.

## What leaves the host

Three hosted Open-Meteo APIs, all keyless:

| Host                             | What for                             | Variable to self-host it    |
| -------------------------------- | ------------------------------------ | --------------------------- |
| `archive-api.open-meteo.com`     | daily weather (ERA5 reanalysis)      | `OPENMETEO_BASE_URL`        |
| `air-quality-api.open-meteo.com` | hourly air quality and pollen (CAMS) | `OPENMETEO_AIR_QUALITY_URL` |
| `geocoding-api.open-meteo.com`   | the city search in settings          | `OPENMETEO_GEOCODING_URL`   |

A request carries the coordinates rounded to one decimal (about 11 km, the
size of a town), a date range and a timezone. No account id, no name, no
health value. Open-Meteo is open source; an operator who wants no egress at
all can run it and point the three variables at their own instance (a host
on the LAN is allowed).

## The data, and what it is not

- Weather comes from the ERA5 reanalysis on a grid of 9 to 25 kilometres. It
  settles over a few days, so the newest stored day is usually yesterday or
  the day before. Nothing here is a forecast.
- Air quality comes from the CAMS models: hourly on about 11 kilometres in
  Europe, about 45 kilometres elsewhere. The feed starts in 2013; pollen, UV,
  dust and aerosol depth only from about mid 2022, and pollen only in Europe.
  A value the feed did not cover is stored as empty, never as zero.
- Hourly values become a day by fixed rules: means and maxima only for a day
  with at least 18 of 24 hours, ozone as the highest 8-hour running mean,
  UV only when the midday hours are all there.
- These are modelled outdoor conditions for an area, not anyone's personal
  exposure. Every surface that shows them says so, and none of them says the
  weather caused anything: a pattern is described as something that occurred
  together.

## Switches

- **Per account:** Settings → Location & weather → Air quality and pollen.
  On by default. Off stops the air-quality requests for that account and
  leaves the air-quality values out of every surface; the days already
  stored keep theirs.
- **For the whole instance:** `ENVIRONMENT_AIR_QUALITY_DISABLED=1` turns the
  air-quality part off for every account (`1`, `true`, `yes` or `on`). The
  weather keeps working. Settings then says the operator turned it off.
- The whole module is a normal module switch (Settings → Modules), and an
  operator can make it unavailable like any other module.

All four variables are on the compose `environment:` whitelist.

## Request budget

The hosted APIs are free for non-commercial use up to 600 calls a minute,
5,000 an hour and 10,000 a day per instance, where a request for many
variables or many days counts as several calls. HealthLog keeps its own
counter in Postgres, shared by the web process and the worker, and stays
below 500 a minute, 4,000 an hour and 8,000 a day. A request the counter
refuses is not sent; the nightly run ends early and continues the next night.

For scale: a full two-year backfill of one account is about 150 calls, the
nightly refresh about 3 per account.

## Nightly fetch and catching up

The `environment-fetch` job runs at 02:10. For each account with a home it
refreshes the last seven days (weather and air quality together), then fills
up to 90 stored days that do not have air quality yet, newest first. An
instance that upgrades to v1.42 with two years of weather per account
catches up on air quality in about nine nights without any action. The
backfill button in settings fetches both for the range it is given.

## Locations are encrypted

Since v1.42 the home, each dated location period and each stored day keep
their coarse location sealed with the instance's encryption key (one value
per row, `{ lat, lon, label }`, under the label
`healthlog/environment-location/v1`). The boot-time encryption backfill seals
rows written by older releases and clears their readable columns; the
readable columns are dropped in a later release once the backfill reports
zero rows everywhere. Key rotation (`scripts/rotate-encryption-key.ts`, or the
in-app rotation) covers all three.

What the person sees is unchanged: the settings page and
`GET /api/environment` answer with the readable location, opened on the
server. The Coach and MCP read (`get_environment`) carry no coordinate and no
place name at all, only how many days were spent away from home.

Backups follow the usual split: a portable export carries the location
readable, a disaster-recovery backup carries it sealed, and a restore of
either seals it under the receiving host's key.

## Attribution

Open-Meteo data is CC BY 4.0, and CAMS data asks for the notice "Contains
modified Copernicus Atmosphere Monitoring Service information" (modified,
because the hourly values are folded into days). The settings page lists
both lines under the values, and the Coach and MCP read return them with
every result.
