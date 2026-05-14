import { describe, it, expect } from "vitest";
import {
  auditLogCsvHeaderLabels,
  buildAuditLogCsvRecords,
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
      "Zeitpunkt,Benutzer,IP,Standort,Anbieter,Ergebnis,Aktion,Details",
    );
    expect(lines[1]).toBe(
      '2026-05-11T09:05:00+00:00,marc,203.0.113.7,"Berlin, DE",Passkey,Erfolgreich,auth.login.passkey,',
    );
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
