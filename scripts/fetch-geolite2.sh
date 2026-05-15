#!/usr/bin/env bash
# v1.4.27 B3 — GeoLite2-City + GeoLite2-ASN download helper.
#
# The MMDB files are too large (~80 MB combined) to vendor in git.
# Instead, an operator runs this script before `docker build` so the
# files land at `assets/geolite2/` where the Dockerfile picks them up
# and copies them into `/opt/geolite2/` inside the image.
#
# The MaxMind GeoLite2 databases require a free MaxMind account and
# a licence key. The key is taken from the `MAXMIND_LICENSE_KEY`
# environment variable. Without the key, the script writes an `.empty`
# marker into the output directory and exits 0 — the Docker image
# still builds (the COPY in `Dockerfile` has a non-empty source) and
# the runtime resolver in `src/lib/geo.ts` detects the marker, falls
# back to the online `ipwho.is` provider, and emits a one-shot admin
# notification so the maintainer can wire the secret when convenient.
#
# Licence: the databases are distributed under
# Creative Commons Attribution-ShareAlike 4.0
# (https://creativecommons.org/licenses/by-sa/4.0/). The attribution
# lives in `docs/audit/v1427-summary.md` and on the `/about` page.
#
# Usage:
#   MAXMIND_LICENSE_KEY=xxxx ./scripts/fetch-geolite2.sh
#
# Refresh schedule: re-run before each release. The MMDB layout is
# stable; MaxMind reissues the databases on the first Tuesday of each
# month.
set -euo pipefail

OUT_DIR="${GEOLITE2_OUT_DIR:-assets/geolite2}"
LICENSE_KEY="${MAXMIND_LICENSE_KEY:-}"

if [[ -z "$LICENSE_KEY" ]]; then
  echo "fetch-geolite2: MAXMIND_LICENSE_KEY is not set — skipping download." >&2
  echo "fetch-geolite2: the runtime resolver will fall back to ipwho.is." >&2
  mkdir -p "$OUT_DIR"
  touch "$OUT_DIR/.empty"
  exit 0
fi

mkdir -p "$OUT_DIR"
# Clear any stale marker from a previous keyless run so the runtime
# resolver does not mistake a freshly populated directory for the
# fallback state.
rm -f "$OUT_DIR/.empty"

fetch_edition() {
  local edition_id="$1"
  local mmdb_basename="$2"
  local tmp_tarball
  tmp_tarball="$(mktemp -t "${edition_id}.tar.gz.XXXXXX")"

  echo "fetch-geolite2: downloading $edition_id ..." >&2
  curl --silent --show-error --fail --location \
    --output "$tmp_tarball" \
    "https://download.maxmind.com/app/geoip_download?edition_id=${edition_id}&license_key=${LICENSE_KEY}&suffix=tar.gz"

  # The tarball ships under a date-stamped top-level directory
  # (`GeoLite2-City_YYYYMMDD/`). Extract the MMDB into a flat layout
  # so the Dockerfile COPY uses a stable path.
  tar -xzf "$tmp_tarball" -C "$(dirname "$tmp_tarball")"
  local extracted
  extracted="$(find "$(dirname "$tmp_tarball")" -maxdepth 2 -name "${mmdb_basename}" -print -quit)"
  if [[ -z "$extracted" ]]; then
    echo "fetch-geolite2: expected ${mmdb_basename} inside the ${edition_id} tarball" >&2
    rm -f "$tmp_tarball"
    exit 1
  fi
  mv "$extracted" "$OUT_DIR/$mmdb_basename"
  rm -f "$tmp_tarball"
  # Clean up the date-stamped extraction directory.
  find "$(dirname "$tmp_tarball")" -maxdepth 1 -type d -name "${edition_id}_*" \
    -exec rm -rf {} +

  local sha
  sha="$(shasum -a 256 "$OUT_DIR/$mmdb_basename" | awk '{print $1}')"
  echo "fetch-geolite2: $mmdb_basename SHA256 $sha" >&2
}

fetch_edition "GeoLite2-City" "GeoLite2-City.mmdb"
fetch_edition "GeoLite2-ASN" "GeoLite2-ASN.mmdb"

echo "fetch-geolite2: done. Files in $OUT_DIR." >&2
