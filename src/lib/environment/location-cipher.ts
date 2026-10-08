/**
 * The environment module's coarse locations, sealed at rest (v1.42, #615).
 *
 * Three places held a location in readable columns: the home on the user row
 * (`homeLat` / `homeLon` / `homeLabel`), each dated location period
 * (`EnvironmentTravelLocation.lat` / `lon` / `label`), and each stored day
 * (`EnvironmentContext.lat` / `lon` / `locationLabel`). Coarse as they are
 * (one decimal, about 11 km), a home city and a dated list of trips are still
 * a movement profile. From v1.42 each row stores ONE sealed value instead, the
 * JSON `{ lat, lon, label }` under AES-256-GCM with the associated-data label
 * {@link ENVIRONMENT_LOCATION_AAD}: one decrypt per row, and the three parts
 * can never drift apart.
 *
 * Writers seal through {@link sealLocation}; the readable columns are written
 * as null. Readers go through {@link readLocation}: the sealed value when a
 * row has one, the readable columns only for a row the boot-time encryption
 * backfill (`free-text-encryption-backfill.ts`) has not reached yet. A sealed
 * value that does not open reads as no location, with a warning on the
 * request's event, and is never replaced by the readable columns.
 *
 * The coordinates are rounded to the privacy floor BEFORE sealing, so the
 * sealed value never carries more precision than the readable column did,
 * and nothing that leaves the host (the weather and air-quality requests) is
 * ever finer than that.
 */
import { Buffer } from "node:buffer";

import { decryptBytes, encryptBytes } from "@/lib/crypto";
import { ENVIRONMENT_LOCATION_AAD } from "@/lib/crypto/encrypted-columns";
import { roundCoarse } from "@/lib/environment/open-meteo";
import { getEvent } from "@/lib/logging/context";

/** A coarse location as the module uses it. */
export interface CoarseLocation {
  lat: number;
  lon: number;
  label: string;
}

/** Seal a location for one of the three `*Encrypted` location columns. */
export function sealLocation(
  location: CoarseLocation,
): Uint8Array<ArrayBuffer> {
  const sealed = encryptBytes(
    Buffer.from(
      JSON.stringify({
        lat: roundCoarse(location.lat),
        lon: roundCoarse(location.lon),
        label: location.label,
      }),
      "utf8",
    ),
    ENVIRONMENT_LOCATION_AAD,
  );
  const out = new Uint8Array(new ArrayBuffer(sealed.byteLength));
  out.set(sealed);
  return out;
}

/**
 * Open a sealed location. Throws on a bad key id, a tampered value, or a
 * payload that is not a location.
 */
export function openLocation(sealed: Uint8Array): CoarseLocation {
  const plain = decryptBytes(Buffer.from(sealed), ENVIRONMENT_LOCATION_AAD);
  const parsed = JSON.parse(plain.toString("utf8")) as unknown;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof (parsed as CoarseLocation).lat !== "number" ||
    typeof (parsed as CoarseLocation).lon !== "number" ||
    typeof (parsed as CoarseLocation).label !== "string"
  ) {
    throw new Error("sealed environment location has an unexpected shape");
  }
  const { lat, lon, label } = parsed as CoarseLocation;
  return { lat, lon, label };
}

/**
 * The location a row holds: the sealed value first, the legacy readable
 * columns only when there is no sealed value. Null when the row holds
 * neither (or only part of the readable triple), and null with a warning when
 * the sealed value does not open.
 *
 * `fallbackLabel` stands in for a missing readable label, which the home has
 * always allowed (`homeLabel` was nullable from the start).
 */
export function readLocation(
  row: {
    sealed: Uint8Array | null | undefined;
    lat: number | null | undefined;
    lon: number | null | undefined;
    label: string | null | undefined;
  },
  fallbackLabel?: string,
): CoarseLocation | null {
  if (row.sealed && row.sealed.byteLength > 0) {
    try {
      return openLocation(row.sealed);
    } catch (err) {
      getEvent()?.addWarning(
        `environment location decrypt failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }
  if (row.lat == null || row.lon == null) return null;
  const label = row.label ?? fallbackLabel;
  if (label == null) return null;
  return { lat: row.lat, lon: row.lon, label };
}
