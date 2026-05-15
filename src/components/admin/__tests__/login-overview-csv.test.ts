import { describe, it, expect } from "vitest";
import {
  auditLogCsvHeaderLabels,
  buildAuditLogCsvRecords,
  carrierShortLabel,
  type AuditCsvEntry,
  type AuditCsvLabels,
} from "../_shared";
import { toCSV } from "@/lib/export";

/**
 * v1.4.25 W8b — Login-Übersicht CSV export contract.
 *
 * The previous CSV emitted snake_case English headers and the raw UTC
 * `createdAt` string, which Excel/LibreOffice misread once the `Z`
 * suffix was stripped. This test pins:
 *
 *   - The column order Marc requested:
 *     `timestamp → user → IP → location → provider → outcome` (email
 *     is absent from the audit-log API so it's intentionally skipped)
 *     followed by `action` + `details` for triage completeness.
 *   - The header row uses the translated labels from the active
 *     locale, not the structural keys.
 *   - The timestamp formatter is honoured (production passes
 *     `formatInUserTz` with `iso-with-offset`).
 *   - CSV special characters in `details` are RFC 4180-escaped.
 */

const LABELS_EN: AuditCsvLabels = {
  timestamp: "Time",
  user: "Users",
  ip: "IP",
  location: "Location",
  // v1.4.27 B3 — `admin.carrier` is shipped by bucket B6; the test
  // pins the English literal so the column order is locked.
  carrier: "Carrier",
  provider: "Provider",
  outcome: "Outcome",
  action: "Action",
  details: "Details",
  outcomeFailed: "Failed",
  outcomeSuccess: "Success",
  unknownUser: "Unknown",
  providerLabels: {
    password: "Password",
    passkey: "Passkey",
    api_token: "API token",
    withings: "Withings",
    unknown: "Unknown",
  },
};

const LABELS_DE: AuditCsvLabels = {
  ...LABELS_EN,
  timestamp: "Zeitpunkt",
  user: "Benutzer",
  ip: "IP",
  location: "Standort",
  carrier: "Mobilfunkanbieter",
  provider: "Anbieter",
  outcome: "Ergebnis",
  action: "Aktion",
  details: "Details",
  outcomeFailed: "Fehlgeschlagen",
  outcomeSuccess: "Erfolgreich",
  unknownUser: "Unbekannt",
  providerLabels: {
    password: "Passwort",
    passkey: "Passkey",
    api_token: "API-Token",
    withings: "Withings",
    unknown: "Unbekannt",
  },
};

function deterministicFormatter(iso: string): string {
  // Strip milliseconds, swap `Z` for `+00:00` so the test asserts the
  // ISO-with-offset shape without being coupled to a specific zone.
  return iso.replace(/\.\d{3}Z$/, "+00:00").replace(/Z$/, "+00:00");
}

describe("buildAuditLogCsvRecords", () => {
  it("emits Marc's column order: timestamp → user → ip → location → provider → outcome (+ action, details)", () => {
    const entries: AuditCsvEntry[] = [
      {
        createdAt: "2026-05-11T09:05:00.000Z",
        action: "auth.login.passkey",
        ipAddress: "203.0.113.7",
        location: "Berlin, DE",
        details: null,
        user: { id: "u1", username: "marc" },
      },
    ];
    const [record] = buildAuditLogCsvRecords(
      entries,
      LABELS_EN,
      deterministicFormatter,
    );
    // Object.keys preserves insertion order in V8 / every modern JS engine
    // — the column order is therefore guaranteed by `Object.keys(record)`.
    expect(Object.keys(record)).toEqual([
      "timestamp",
      "user",
      "ip",
      "location",
      "carrier",
      "provider",
      "outcome",
      "action",
      "details",
    ]);
  });

  it("maps the action to a coarse provider label using the i18n labels", () => {
    const entries: AuditCsvEntry[] = [
      {
        createdAt: "2026-05-11T09:05:00.000Z",
        action: "auth.login.passkey",
        ipAddress: null,
        location: null,
        details: null,
        user: { id: "u1", username: "marc" },
      },
      {
        createdAt: "2026-05-11T09:06:00.000Z",
        action: "auth.bearer.success",
        ipAddress: null,
        location: null,
        details: null,
        user: { id: "u2", username: "ios" },
      },
      {
        createdAt: "2026-05-11T09:07:00.000Z",
        action: "auth.login.failed",
        ipAddress: null,
        location: null,
        details: null,
        user: null,
      },
    ];
    const records = buildAuditLogCsvRecords(
      entries,
      LABELS_EN,
      deterministicFormatter,
    );
    expect(records[0].provider).toBe("Passkey");
    expect(records[1].provider).toBe("API token");
    expect(records[2].provider).toBe("Password");
    // Failed login records the failed outcome.
    expect(records[0].outcome).toBe("Success");
    expect(records[2].outcome).toBe("Failed");
    // No user → unknown placeholder.
    expect(records[2].user).toBe("Unknown");
  });

  it("uses the German label set when the active locale is German", () => {
    const entries: AuditCsvEntry[] = [
      {
        createdAt: "2026-05-11T09:05:00.000Z",
        action: "auth.login.passkey",
        ipAddress: null,
        location: null,
        details: null,
        user: null,
      },
    ];
    const [record] = buildAuditLogCsvRecords(
      entries,
      LABELS_DE,
      deterministicFormatter,
    );
    expect(record.provider).toBe("Passkey");
    expect(record.outcome).toBe("Erfolgreich");
    expect(record.user).toBe("Unbekannt");
  });

  it("applies the injected timestamp formatter (production uses formatInUserTz)", () => {
    const entries: AuditCsvEntry[] = [
      {
        createdAt: "2026-05-11T09:05:00.000Z",
        action: "auth.login.password",
        ipAddress: null,
        location: null,
        details: null,
        user: null,
      },
    ];
    const records = buildAuditLogCsvRecords(
      entries,
      LABELS_EN,
      (iso) => `formatted:${iso}`,
    );
    expect(records[0].timestamp).toBe("formatted:2026-05-11T09:05:00.000Z");
  });
});

describe("auditLogCsvHeaderLabels", () => {
  it("returns translated headers keyed by the record-key contract", () => {
    const headers = auditLogCsvHeaderLabels(LABELS_EN);
    expect(headers).toEqual({
      timestamp: "Time",
      user: "Users",
      ip: "IP",
      location: "Location",
      carrier: "Carrier",
      provider: "Provider",
      outcome: "Outcome",
      action: "Action",
      details: "Details",
    });
  });
});

describe("toCSV(records, headerLabels) — audit-log integration", () => {
  it("writes a translated header row + correct column order", () => {
    const entries: AuditCsvEntry[] = [
      {
        createdAt: "2026-05-11T09:05:00.000Z",
        action: "auth.login.passkey",
        ipAddress: "203.0.113.7",
        location: "Berlin, DE",
        details: null,
        user: { id: "u1", username: "marc" },
      },
    ];
    const records = buildAuditLogCsvRecords(
      entries,
      LABELS_DE,
      deterministicFormatter,
    );
    const csv = toCSV(records, auditLogCsvHeaderLabels(LABELS_DE));
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "Zeitpunkt,Benutzer,IP,Standort,Mobilfunkanbieter,Anbieter,Ergebnis,Aktion,Details",
    );
    expect(lines[1]).toBe(
      '2026-05-11T09:05:00+00:00,marc,203.0.113.7,"Berlin, DE",,Passkey,Erfolgreich,auth.login.passkey,',
    );
  });

  it("folds the GeoLite2 organisation string to the short DACH carrier label", () => {
    // Marc's spec: the verbose MMDB org strings get a glanceable chip.
    // The CSV column carries the same folded text so a downstream
    // spreadsheet matches what the admin overview screen renders.
    const entries: AuditCsvEntry[] = [
      {
        createdAt: "2026-05-11T09:05:00.000Z",
        action: "auth.login.password",
        ipAddress: "84.131.0.1",
        location: "Berlin, DE",
        carrier: "Deutsche Telekom AG",
        asn: 3320,
        details: null,
        user: { id: "u1", username: "marc" },
      },
      {
        createdAt: "2026-05-11T09:06:00.000Z",
        action: "auth.login.password",
        ipAddress: "139.7.0.1",
        location: "Hamburg, DE",
        carrier: "Vodafone GmbH",
        asn: 3209,
        details: null,
        user: { id: "u2", username: "marc" },
      },
      {
        createdAt: "2026-05-11T09:07:00.000Z",
        action: "auth.login.password",
        ipAddress: "212.7.0.1",
        location: "Köln, DE",
        carrier: "1&1 Versatel GmbH",
        asn: 8881,
        details: null,
        user: { id: "u3", username: "marc" },
      },
      {
        createdAt: "2026-05-11T09:08:00.000Z",
        action: "auth.login.password",
        ipAddress: "92.7.0.1",
        location: "Frankfurt, DE",
        carrier: "Telefónica Germany GmbH & Co. OHG",
        asn: 6805,
        details: null,
        user: { id: "u4", username: "marc" },
      },
      {
        createdAt: "2026-05-11T09:09:00.000Z",
        action: "auth.login.password",
        ipAddress: "8.8.8.8",
        location: "Mountain View, US",
        carrier: "Google LLC",
        asn: 15169,
        details: null,
        user: { id: "u5", username: "marc" },
      },
    ];
    const records = buildAuditLogCsvRecords(
      entries,
      LABELS_EN,
      deterministicFormatter,
    );
    expect(records.map((r) => r.carrier)).toEqual([
      "Telekom",
      "Vodafone",
      "1&1",
      "O2",
      // Unknown organisations carry the raw GeoLite2 string through.
      "Google LLC",
    ]);
  });

  it("emits an empty carrier cell when the row has no ASN data", () => {
    const entries: AuditCsvEntry[] = [
      {
        createdAt: "2026-05-11T09:05:00.000Z",
        action: "auth.login.password",
        ipAddress: "192.0.2.1",
        location: null,
        carrier: null,
        asn: null,
        details: null,
        user: null,
      },
    ];
    const [record] = buildAuditLogCsvRecords(
      entries,
      LABELS_EN,
      deterministicFormatter,
    );
    expect(record.carrier).toBe("");
  });

  it("escapes commas, quotes, and newlines in the details column", () => {
    const entries: AuditCsvEntry[] = [
      {
        createdAt: "2026-05-11T09:05:00.000Z",
        action: "auth.login.failed",
        ipAddress: null,
        location: null,
        // Three RFC 4180 escape triggers in one value: a comma, a
        // double quote, and a newline.
        details: 'reason="invalid_password", attempts: 3\nfollowup: lock',
        user: null,
      },
    ];
    const records = buildAuditLogCsvRecords(
      entries,
      LABELS_EN,
      deterministicFormatter,
    );
    const csv = toCSV(records, auditLogCsvHeaderLabels(LABELS_EN));
    // The cell is wrapped in double quotes and embedded `"` is doubled.
    expect(csv).toContain(
      '"reason=""invalid_password"", attempts: 3\nfollowup: lock"',
    );
  });
});

describe("carrierShortLabel — DACH carrier folding (v1.4.27 B3)", () => {
  it("folds 'Deutsche Telekom AG' down to 'Telekom'", () => {
    expect(carrierShortLabel("Deutsche Telekom AG")).toBe("Telekom");
  });

  it("folds the standalone Vodafone variants down to 'Vodafone'", () => {
    expect(carrierShortLabel("Vodafone GmbH")).toBe("Vodafone");
    expect(carrierShortLabel("Vodafone Kabel Deutschland GmbH")).toBe(
      "Vodafone",
    );
  });

  it("folds the 1&1 sub-brands down to '1&1'", () => {
    expect(carrierShortLabel("1&1 Telecom GmbH")).toBe("1&1");
    expect(carrierShortLabel("1&1 Versatel GmbH")).toBe("1&1");
  });

  it("folds Telefónica + O2 variants down to 'O2'", () => {
    expect(
      carrierShortLabel("Telefónica Germany GmbH & Co. OHG"),
    ).toBe("O2");
    expect(carrierShortLabel("Telefonica Germany Online Services")).toBe("O2");
    expect(carrierShortLabel("O2 Deutschland")).toBe("O2");
  });

  it("returns the raw organisation string for unknown carriers", () => {
    expect(carrierShortLabel("Google LLC")).toBe("Google LLC");
    expect(carrierShortLabel("Amazon.com, Inc.")).toBe("Amazon.com, Inc.");
    expect(carrierShortLabel("Hetzner Online GmbH")).toBe("Hetzner Online GmbH");
  });
});
