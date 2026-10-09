/**
 * v1.42 (#615) — the sealed environment location.
 *
 * Round trip, rounding to the privacy floor before sealing, the label that
 * keeps a location from opening as any other sealed value, and the reader's
 * order: the sealed value first, the readable columns only without one, and
 * a value that does not open read as no location rather than replaced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";

import { decryptBytes, encryptBytes } from "@/lib/crypto";
import { ENVIRONMENT_LOCATION_AAD } from "@/lib/crypto/encrypted-columns";
import { openLocation, readLocation, sealLocation } from "../location-cipher";

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", "b".repeat(64));
});
afterEach(() => vi.unstubAllEnvs());

describe("sealLocation / openLocation", () => {
  it("round-trips a location and rounds it to one decimal first", () => {
    const sealed = sealLocation({
      lat: 51.48165,
      lon: 7.21648,
      label: "Bochum, Germany",
    });
    expect(openLocation(sealed)).toEqual({
      lat: 51.5,
      lon: 7.2,
      label: "Bochum, Germany",
    });
    // The bytes are ciphertext, not the JSON.
    expect(Buffer.from(sealed).toString("utf8")).not.toContain("Bochum");
  });

  it("is labelled: the value does not open under another label", () => {
    const sealed = sealLocation({ lat: 1, lon: 2, label: "x" });
    expect(() =>
      decryptBytes(Buffer.from(sealed), "healthlog/workout-route-geometry/v1"),
    ).toThrow();
    expect(() =>
      decryptBytes(Buffer.from(sealed), ENVIRONMENT_LOCATION_AAD),
    ).not.toThrow();
  });

  it("refuses a sealed value that is not a location", () => {
    const other = encryptBytes(
      Buffer.from(JSON.stringify({ lat: "51" })),
      ENVIRONMENT_LOCATION_AAD,
    );
    expect(() => openLocation(new Uint8Array(other))).toThrow();
  });
});

describe("readLocation", () => {
  it("prefers the sealed value over readable columns", () => {
    const sealed = sealLocation({ lat: 48.1, lon: 11.6, label: "Munich" });
    expect(
      readLocation({ sealed, lat: 52.5, lon: 13.4, label: "Berlin" }),
    ).toEqual({ lat: 48.1, lon: 11.6, label: "Munich" });
  });

  it("falls back to the readable columns for a row the backfill has not reached", () => {
    expect(
      readLocation({ sealed: null, lat: 52.5, lon: 13.4, label: "Berlin" }),
    ).toEqual({ lat: 52.5, lon: 13.4, label: "Berlin" });
    expect(
      readLocation({ sealed: null, lat: 52.5, lon: null, label: "Berlin" }),
    ).toBeNull();
  });

  it("reads a value that does not open as no location, never as the readable columns", () => {
    const sealed = sealLocation({ lat: 48.1, lon: 11.6, label: "Munich" });
    vi.stubEnv("ENCRYPTION_KEY", "c".repeat(64));
    expect(
      readLocation({ sealed, lat: 52.5, lon: 13.4, label: "Berlin" }),
    ).toBeNull();
  });
});
