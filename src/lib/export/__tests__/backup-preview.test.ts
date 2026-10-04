/**
 * The preview worked out while a copy is written has to say what the preview
 * route used to derive by reading the stored copy: the same counts, the same
 * key uses. Held here against that derivation over the same file; the
 * integration round trip holds the writer's real counts to it on an account
 * with a row in every model.
 */
import { afterEach, describe, expect, it } from "vitest";

import { _resetCryptoCacheForTests, encrypt } from "@/lib/crypto";

import {
  BackupKeyIdCollector,
  assessBackupKeys,
} from "@/lib/export/backup-key-ids";
import {
  buildBackupPreview,
  createBackupPreviewCollector,
  storedCopyIdentity,
  storedPreviewFor,
} from "@/lib/export/backup-preview";
import type { FullBackupCounts } from "@/lib/export/full-backup-payload";
import { backupPayloadSchema } from "@/lib/validations/backup";
import { summarizeBackup } from "@/lib/validations/backup-summary";

const ts = "2026-07-19T07:00:00.000Z";
/** A bytes-column value holding the string codec under key id `v3`. */
const sealedV3 = Buffer.from(`v3.${"QUJD".repeat(20)}`, "utf8").toString(
  "base64",
);

const FILE = {
  schemaVersion: "2",
  exportedAt: ts,
  userId: "u1",
  measurements: [1, 2, 3].map((i) => ({
    id: `m${i}`,
    type: "WEIGHT",
    value: 70 + i,
    unit: "kg",
    measuredAt: ts,
    source: "MANUAL",
    notes: "Grüße, ☕",
    ...(i === 2 ? { notesEncrypted: sealedV3 } : {}),
  })),
  intakeEvents: [
    { medication: "Example", scheduledFor: ts, source: "WEB" },
    { medication: "Example", scheduledFor: ts, source: "WEB" },
  ],
  moodEntries: [
    {
      date: "2026-05-08",
      mood: "GUT",
      score: 4,
      source: "MOODLOG",
      loggedAt: ts,
    },
  ],
  labResults: [{ analyte: "HbA1c", unit: "%", takenAt: ts, source: "MANUAL" }],
  illnessEpisodes: [
    {
      id: "ep-1",
      label: "Cold",
      type: "INFECTION",
      lifecycle: "ACUTE",
      onsetAt: ts,
      dayLogs: [
        { date: "2026-04-01", symptoms: [] },
        { date: "2026-04-02", symptoms: [] },
      ],
    },
  ],
};

/** What the weekly writer shows the collector, member by member. */
const BULK = new Set(["measurements", "intakeEvents", "moodEntries"]);
function observeAsTheWriterDoes(
  file: Record<string, unknown>,
  observe: (member: string, value: unknown) => void,
) {
  for (const [member, value] of Object.entries(file)) {
    if (BULK.has(member))
      for (const row of value as unknown[]) observe(member, row);
    else observe(member, value);
  }
}

/** The writer's counts for FILE: every count the summary reads, and more. */
function countsOf(file: typeof FILE): FullBackupCounts {
  const summary = summarizeBackup(backupPayloadSchema.parse(file));
  const { schemaVersion, userId, exportedAt, ...counts } = summary;
  void schemaVersion;
  void userId;
  void exportedAt;
  return { ...counts, medicationPauseEras: 0 } as unknown as FullBackupCounts;
}

describe("createBackupPreviewCollector", () => {
  // What the preview route derives from a stored copy.
  const expected = summarizeBackup(backupPayloadSchema.parse(FILE));
  const expectedKeys = new BackupKeyIdCollector();
  expectedKeys.visit(FILE);

  it("says what a full read of the copy says", () => {
    const collector = createBackupPreviewCollector();
    observeAsTheWriterDoes(FILE, collector.observe);
    const result = collector.finish(countsOf(FILE));
    expect(result).not.toBeNull();
    expect(result!.summary).toEqual(expected);
    expect(result!.summary.illnessDayLogs).toBe(2);
    expect(result!.keys.toStored()).toEqual(expectedKeys.toStored());
    expect(result!.keys.keyIds()).toEqual(["v3"]);
  });

  it("answers null for a copy that does not name its version, owner and date", () => {
    const collector = createBackupPreviewCollector();
    const { userId, ...rest } = FILE;
    void userId;
    observeAsTheWriterDoes(rest, collector.observe);
    expect(collector.finish(countsOf(FILE))).toBeNull();
  });
});

describe("storedPreviewFor", () => {
  const chunked = { data: null, chunkCount: 4, chunkStreamId: "s1" };
  const preview = () =>
    buildBackupPreview(
      storedCopyIdentity(chunked)!,
      summarizeBackup(backupPayloadSchema.parse(FILE)),
      new BackupKeyIdCollector(),
    );

  it("reads a preview of the copy the row holds", () => {
    const stored = JSON.parse(JSON.stringify(preview()));
    expect(storedPreviewFor(stored, chunked)?.summary.measurements).toBe(3);
  });

  it("ignores a preview of another copy", () => {
    expect(
      storedPreviewFor(preview(), { ...chunked, chunkStreamId: "s2" }),
    ).toBeNull();
    expect(
      storedPreviewFor(preview(), { ...chunked, chunkCount: 5 }),
    ).toBeNull();
  });

  it("describes nothing on a row holding both forms, or none", () => {
    expect(storedPreviewFor(preview(), { ...chunked, data: "x" })).toBeNull();
    expect(
      storedPreviewFor(preview(), {
        data: null,
        chunkCount: null,
        chunkStreamId: null,
      }),
    ).toBeNull();
  });

  it("ignores a malformed preview", () => {
    expect(storedPreviewFor({ version: 1 }, chunked)).toBeNull();
    expect(storedPreviewFor(null, chunked)).toBeNull();
  });

  it("names a single stored value by its length and head", () => {
    const a = storedCopyIdentity({
      data: "v1.aaaa",
      chunkCount: null,
      chunkStreamId: null,
    });
    const b = storedCopyIdentity({
      data: "v1.aaab",
      chunkCount: null,
      chunkStreamId: null,
    });
    expect(a).toMatch(/^value:[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("BackupKeyIdCollector.toStored / fromStored", () => {
  const saved = {
    key: process.env.ENCRYPTION_KEY,
    keys: process.env.ENCRYPTION_KEYS,
    active: process.env.ENCRYPTION_ACTIVE_KEY_ID,
  };
  function useKeys(keys: Record<string, string>, active: string) {
    delete process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEYS = JSON.stringify(keys);
    process.env.ENCRYPTION_ACTIVE_KEY_ID = active;
    _resetCryptoCacheForTests();
  }
  afterEach(() => {
    for (const [name, value] of [
      ["ENCRYPTION_KEY", saved.key],
      ["ENCRYPTION_KEYS", saved.keys],
      ["ENCRYPTION_ACTIVE_KEY_ID", saved.active],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    _resetCryptoCacheForTests();
  });

  it("keeps what the verdict needs, so it can be taken again later", () => {
    // Written under `old` and `other` on the host that made the copy.
    useKeys({ old: "11".repeat(32), other: "22".repeat(32) }, "old");
    const collector = new BackupKeyIdCollector();
    collector.add("moodEntries", encrypt("a note"));
    process.env.ENCRYPTION_ACTIVE_KEY_ID = "other";
    _resetCryptoCacheForTests();
    collector.add("labResults", encrypt("another note"));
    collector.add("appSettings", encrypt("a setting"));
    const stored = JSON.parse(JSON.stringify(collector.toStored()));
    const options = { ignoreSections: new Set(["appSettings"]) };

    // Later, on a host that dropped `old` and holds different material
    // under `other`.
    useKeys({ other: "33".repeat(32) }, "other");
    const back = BackupKeyIdCollector.fromStored(stored);
    const verdict = assessBackupKeys(back, options);
    expect(verdict.missing).toEqual(["old"]);
    expect(verdict.unreadable).toEqual(["other"]);
    expect(verdict).toEqual(assessBackupKeys(collector, options));
    expect(back.toStored()).toEqual(collector.toStored());
  });
});
