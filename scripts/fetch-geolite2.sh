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
  # Use an isolated working directory per edition so `find` and `tar`
  # never walk shared `/tmp`. Linux runners (GitHub Actions) populate
  # `/tmp` with `systemd-private-*` directories that are mode 700, and
  # `find` returns exit 1 on permission-denied — under `set -e` that
  # would kill the whole script before our fallback branches fire.
  local work_dir
  work_dir="$(mktemp -d -t "${edition_id}.XXXXXX")"
  local tmp_tarball="${work_dir}/${edition_id}.tar.gz"

  echo "fetch-geolite2: downloading $edition_id ..." >&2
  # Use --fail-with-body so curl prints the response on failure; capture
  # the exit code without aborting the script. Any non-zero exit (401
  # EULA-pending, 403 throttled, 5xx, network timeout, etc.) flips the
  # build into the same fallback shape as the missing-key path: write
  # the `.empty` marker and let the runtime gate surface the issue to
  # the maintainer.
  local curl_exit=0
  curl --silent --show-error --fail-with-body --location \
    --output "$tmp_tarball" \
    "https://download.maxmind.com/app/geoip_download?edition_id=${edition_id}&license_key=${LICENSE_KEY}&suffix=tar.gz" || curl_exit=$?

  if [[ "$curl_exit" -ne 0 ]]; then
    echo "fetch-geolite2: $edition_id download failed (curl exit $curl_exit) — falling back to runtime ipwho.is." >&2
    rm -rf "$work_dir"
    # Reinstate the marker so partial state from a previous fetch does
    # not look like a healthy populated directory.
    touch "$OUT_DIR/.empty"
    return 0
  fi

  # The tarball ships under a date-stamped top-level directory
  # (`GeoLite2-City_YYYYMMDD/`). Extract the MMDB into a flat layout
  # so the Dockerfile COPY uses a stable path.
  if ! tar -xzf "$tmp_tarball" -C "$work_dir"; then
    echo "fetch-geolite2: $edition_id tarball extraction failed — falling back to runtime ipwho.is." >&2
    rm -rf "$work_dir"
    touch "$OUT_DIR/.empty"
    return 0
  fi
  local extracted
  extracted="$(find "$work_dir" -maxdepth 2 -name "${mmdb_basename}" -print -quit 2>/dev/null)"
  if [[ -z "$extracted" ]]; then
    echo "fetch-geolite2: expected ${mmdb_basename} inside the ${edition_id} tarball — falling back to runtime ipwho.is." >&2
    rm -rf "$work_dir"
    touch "$OUT_DIR/.empty"
    return 0
  fi
  mv "$extracted" "$OUT_DIR/$mmdb_basename"
  rm -rf "$work_dir"

  local sha
  sha="$(shasum -a 256 "$OUT_DIR/$mmdb_basename" | awk '{print $1}')"
  echo "fetch-geolite2: $mmdb_basename SHA256 $sha" >&2
}

# Track whether every edition landed cleanly. If any fetch fell back to
# the runtime path, leave the `.empty` marker so the runtime gate +
# admin notification fires; otherwise clear it so a healthy populated
# directory is not misread as the fallback state.
fetch_edition "GeoLite2-City" "GeoLite2-City.mmdb"
fetch_edition "GeoLite2-ASN" "GeoLite2-ASN.mmdb"

if [[ -f "$OUT_DIR/.empty" ]]; then
  echo "fetch-geolite2: at least one edition fell back; runtime resolver will use ipwho.is." >&2
else
  echo "fetch-geolite2: done. Files in $OUT_DIR." >&2
fi
