import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { strToU8, zipSync } from "fflate";

import { classifyEcgRhythm } from "@/lib/apple-health/ecg-csv";

type ArchiveLimits = {
  maxMembers: number;
  maxEcgMembers: number;
  maxMemberBytes: number;
  maxTotalEcgBytes: number;
  maxCompressionRatio: number;
};

type ArchiveMember = {
  name: string;
  stream: Readable;
  refused?: "too_large" | "unsupported";
};

type NormalizedEcg = {
  recordedAt: Date;
  samplingFrequency: number;
  samples: number[];
  lead: string | null;
  averageHeartRate: number | null;
  rhythmClassification: "IRREGULAR" | "NOT_DETECTED" | "INCONCLUSIVE" | null;
};

type ArchiveSubject = {
  streamAppleHealthEcgMembers(input: {
    archivePath: string;
    limits: ArchiveLimits;
  }): AsyncIterable<ArchiveMember>;
};

type ParserSubject = {
  parseAppleHealthEcgCsv(input: {
    memberName: string;
    stream: Readable;
    maxSamples: number;
  }): Promise<NormalizedEcg>;
};

const tempDirs: string[] = [];

const LIMITS: ArchiveLimits = {
  maxMembers: 8,
  maxEcgMembers: 2,
  maxMemberBytes: 2_048,
  maxTotalEcgBytes: 3_000,
  maxCompressionRatio: 100,
};

function loadArchiveSubject(): Promise<ArchiveSubject> {
  return vi.importActual<ArchiveSubject>("@/lib/apple-health/archive-stream");
}

function loadParserSubject(): Promise<ParserSubject> {
  return vi.importActual<ParserSubject>("@/lib/apple-health/ecg-csv");
}

function archivePath(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "healthlog-ecg-contract-"));
  tempDirs.push(dir);
  const path = join(dir, "export.zip");
  writeFileSync(
    path,
    zipSync(
      Object.fromEntries(
        Object.entries(files).map(([name, text]) => [name, strToU8(text)]),
      ),
      { level: 6 },
    ),
  );
  return path;
}

function replaceSameLengthName(
  archive: Buffer,
  from: string,
  to: string,
): Buffer {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
  const out = Buffer.from(archive);
  const needle = Buffer.from(from);
  const replacement = Buffer.from(to);
  let cursor = 0;
  while ((cursor = out.indexOf(needle, cursor)) !== -1) {
    replacement.copy(out, cursor);
    cursor += replacement.length;
  }
  return out;
}

function mutateZipHeaders(
  archive: Buffer,
  memberName: string,
  mutate: (header: Buffer, central: boolean) => void,
): Buffer {
  const out = Buffer.from(archive);
  for (let cursor = 0; cursor <= out.length - 46; cursor += 1) {
    const signature = out.readUInt32LE(cursor);
    const central = signature === 0x02014b50;
    const local = signature === 0x04034b50;
    if (!central && !local) continue;
    const nameLength = out.readUInt16LE(cursor + (central ? 28 : 26));
    const nameStart = cursor + (central ? 46 : 30);
    if (
      out.subarray(nameStart, nameStart + nameLength).toString("utf8") ===
      memberName
    ) {
      mutate(out.subarray(cursor), central);
    }
  }
  return out;
}

function validCsv(overrides: Partial<Record<string, string>> = {}): string {
  const metadata = {
    "Recorded Date": "2026-07-18 08:14:03 +0200",
    Classification: "Sinus Rhythm",
    "Average Heart Rate": "64 bpm",
    "Sample Rate": "512 Hz",
    ...overrides,
  };
  return [
    "Name,Private Patient Name",
    ...Object.entries(metadata).map(([key, value]) => `${key},${value}`),
    "Lead,Voltage",
    "I,0.001",
    "I,-0.002",
    "I,0.003",
  ].join("\n");
}

function singleColumnCsv(
  overrides: Partial<Record<string, string>> = {},
): string {
  const metadata = {
    "Recorded Date": "2026-07-18 08:14:03 +0200",
    Classification: "Sinus Rhythm",
    "Average Heart Rate": "64 bpm",
    "Sample Rate": "512 Hz",
    Lead: "Lead I",
    Unit: "µV",
    ...overrides,
  };
  return [
    "Name,Private Patient Name",
    ...Object.entries(metadata).map(([key, value]) => `${key},${value}`),
    "",
    "1.5",
    "-2.4",
    "3",
  ].join("\n");
}

async function collectMembers(path: string, limits = LIMITS) {
  const subject = await loadArchiveSubject();
  const members: ArchiveMember[] = [];
  for await (const member of subject.streamAppleHealthEcgMembers({
    archivePath: path,
    limits,
  })) {
    members.push(member);
  }
  return members;
}

/** One member came back refused, and reading it fails. */
async function expectRefused(
  members: Promise<ArchiveMember[]>,
  reason: "too_large" | "unsupported",
) {
  const [member, ...rest] = await members;
  expect(rest).toEqual([]);
  expect(member.refused).toBe(reason);
  await expect(
    (async () => {
      for await (const chunk of member.stream) void chunk;
    })(),
  ).rejects.toThrow(/refused/);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("Apple Health ECG archive stream — path and resource bounds", () => {
  it("streams only recognized HKElectrocardiogram CSV members", async () => {
    const path = archivePath({
      "apple_health_export/export.xml": "<HealthData/>",
      "apple_health_export/electrocardiograms/ecg_2026-07-18.csv": validCsv(),
      "apple_health_export/clinical-records/private.json": "{}",
    });

    const members = await collectMembers(path);
    expect(members.map((member) => member.name)).toEqual([
      "apple_health_export/electrocardiograms/ecg_2026-07-18.csv",
    ]);
    expect(members[0].stream).toBeInstanceOf(Readable);
    expect(members[0]).not.toHaveProperty("path");
  });

  it.each([
    "../electrocardiograms/ecg.csv",
    "apple_health_export/electrocardiograms/../../ecg.csv",
    "/apple_health_export/electrocardiograms/ecg.csv",
    "C:\\apple_health_export\\electrocardiograms\\ecg.csv",
  ])("rejects traversal or absolute member name %s", async (name) => {
    await expect(
      collectMembers(
        archivePath({
          "apple_health_export/export.xml": "<HealthData/>",
          [name]: validCsv(),
        }),
      ),
    ).rejects.toThrow(/unsafe|path|member/i);
  });

  it("rejects duplicate normalized ECG member names", async () => {
    const first = "apple_health_export/electrocardiograms/ecg-recording-a.csv";
    const second = "apple_health_export/electrocardiograms/ecg-recording-b.csv";
    const path = archivePath({
      "apple_health_export/export.xml": "<HealthData/>",
      [first]: validCsv(),
      [second]: validCsv(),
    });
    const duplicated = replaceSameLengthName(
      Buffer.from(await import("node:fs").then((fs) => fs.readFileSync(path))),
      second,
      first,
    );
    writeFileSync(path, duplicated);

    await expect(collectMembers(path)).rejects.toThrow(/duplicate/i);
  });

  it.each([
    [
      "encrypted",
      (header: Buffer, central: boolean) =>
        header.writeUInt16LE(1, central ? 8 : 6),
    ],
    [
      "unsupported compression",
      (header: Buffer, central: boolean) =>
        header.writeUInt16LE(99, central ? 10 : 8),
    ],
  ] as const)("refuses %s ECG entries on their own", async (_label, mutate) => {
    const member = "apple_health_export/electrocardiograms/ecg_2026-07-18.csv";
    const path = archivePath({
      "apple_health_export/export.xml": "<HealthData/>",
      [member]: validCsv(),
    });
    const fs = await import("node:fs");
    writeFileSync(
      path,
      mutateZipHeaders(fs.readFileSync(path), member, mutate),
    );

    // The member fails; the pass, and any other strip in it, goes on.
    await expectRefused(collectMembers(path), "unsupported");
  });

  it("enforces member-count and ECG-count caps before parsing", async () => {
    const files: Record<string, string> = {
      "apple_health_export/export.xml": "<HealthData/>",
    };
    for (let index = 0; index < 4; index += 1) {
      files[
        `apple_health_export/electrocardiograms/ecg_2026-07-${18 + index}.csv`
      ] = validCsv();
    }

    await expect(
      collectMembers(archivePath(files), {
        ...LIMITS,
        maxMembers: 3,
        maxEcgMembers: 2,
      }),
    ).rejects.toThrow(/member|count|limit/i);
  });

  it("refuses declared compression-ratio bombs", async () => {
    const repetitive = `${"0,".repeat(2_000)}\n`;
    await expectRefused(
      collectMembers(
        archivePath({
          "apple_health_export/export.xml": "<HealthData/>",
          "apple_health_export/electrocardiograms/ecg_bomb.csv": repetitive,
        }),
        { ...LIMITS, maxMemberBytes: 10_000, maxCompressionRatio: 2 },
      ),
      "too_large",
    );
  });

  it("enforces actual decompressed member bytes even when metadata lies", async () => {
    const member =
      "apple_health_export/electrocardiograms/ecg_actual_bytes.csv";
    const path = archivePath({
      "apple_health_export/export.xml": "<HealthData/>",
      [member]: `${"1,0.001\n".repeat(100)}`,
    });
    const fs = await import("node:fs");
    const lied = mutateZipHeaders(
      fs.readFileSync(path),
      member,
      (header, central) => {
        if (central) header.writeUInt32LE(1, 24);
      },
    );
    writeFileSync(path, lied);

    await expectRefused(
      collectMembers(path, { ...LIMITS, maxMemberBytes: 64 }),
      "too_large",
    );
  });

  it("enforces the running total across otherwise valid ECG members", async () => {
    await expect(
      collectMembers(
        archivePath({
          "apple_health_export/export.xml": "<HealthData/>",
          "apple_health_export/electrocardiograms/ecg_a.csv": validCsv(),
          "apple_health_export/electrocardiograms/ecg_b.csv": validCsv(),
        }),
        { ...LIMITS, maxTotalEcgBytes: validCsv().length + 5 },
      ),
    ).rejects.toThrow(/total|byte|limit/i);
  });
});

describe("Apple Health HKElectrocardiogram CSV parser", () => {
  async function parse(csv: string, maxSamples = 8) {
    const subject = await loadParserSubject();
    return subject.parseAppleHealthEcgCsv({
      memberName: "apple_health_export/electrocardiograms/ecg_2026-07-18.csv",
      stream: Readable.from([Buffer.from(csv)]),
      maxSamples,
    });
  }

  it("normalizes a valid recording without returning patient/source labels", async () => {
    const parsed = await parse(validCsv());
    expect(parsed).toMatchObject({
      recordedAt: new Date("2026-07-18T06:14:03.000Z"),
      samplingFrequency: 512,
      samples: [1, -2, 3],
      lead: "I",
      averageHeartRate: 64,
      rhythmClassification: "NOT_DETECTED",
    });
    expect(JSON.stringify(parsed)).not.toMatch(/Private Patient|Apple|WHOOP/i);
  });

  it.each([
    ["Sinus Rhythm", "NOT_DETECTED"],
    ["Atrial Fibrillation", "IRREGULAR"],
    ["Inconclusive", "INCONCLUSIVE"],
    // Observed in real exports, and dropped to null until now.
    ["Heart Rate Over 120", "INCONCLUSIVE"],
    ["Heart Rate Under 50", "INCONCLUSIVE"],
    // The same verdict from a watch with a different threshold.
    ["Heart Rate Over 150", "INCONCLUSIVE"],
    // Named in Apple's ECG instructions for use.
    ["Poor Recording", "INCONCLUSIVE"],
    ["Atrial Fibrillation - High Heart Rate", "IRREGULAR"],
    ["High Heart Rate - No Atrial Fibrillation Detected", "NOT_DETECTED"],
    // Apple's own "this device does not know this verdict". Deliberately NOT
    // INCONCLUSIVE — the device did not fail to classify the waveform.
    ["Unrecognized", null],
    // A verdict from a German watch. This asserted `null` while the two
    // halves of the fix lived on separate branches: the classifier gained
    // Apple's full English set without knowing any German, so a German
    // verdict was still unreachable. Together they meet — the alias table
    // translates the wording, the classifier decides the meaning — and the
    // old expectation was pinning the gap rather than a decision.
    ["Sinusrhythmus", "NOT_DETECTED"],
    // Four of the six languages are still unmapped, so this stays true.
    ["Fibrillation auriculaire", null],
    ["Some verdict this parser has never seen", null],
  ])("passes through device classification %s only", async (raw, expected) => {
    await expect(
      parse(validCsv({ Classification: raw })),
    ).resolves.toMatchObject({ rhythmClassification: expected });
  });

  /**
   * The nullable column has one spelling for four different facts. The
   * classifier keeps them apart even though the column cannot, so a reader of
   * this code can see which nulls are honest and which are the unresolved
   * language half.
   *
   * The old table pinned `["Localized or unknown verdict", null]` as a single
   * row. That assertion is still true, but it fused a localised verdict with an
   * unknown one and with the two heart-rate verdicts that were being silently
   * dropped beside them — it read as "everything else is unknown" when two of
   * those were verdicts Apple documents. It is split apart here.
   */
  it.each([
    ["Sinus Rhythm", "mapped"],
    ["Heart Rate Under 50", "mapped"],
    ["", "absent"],
    [undefined, "absent"],
    ["Unrecognized", "unrepresentable"],
    ["Sinusrhythmus", "unknown"],
    ["Fibrillation auriculaire", "unknown"],
  ])("classifies %s as %s", (raw, kind) => {
    expect(classifyEcgRhythm(raw).kind).toBe(kind);
  });

  it("treats every heart-rate threshold the same way", () => {
    // The number is the watch generation's, not a value to enumerate.
    for (const n of [50, 100, 120, 150]) {
      expect(classifyEcgRhythm(`Heart Rate Over ${n}`)).toEqual({
        kind: "mapped",
        value: "INCONCLUSIVE",
      });
    }
    // Not a threshold verdict — no number, so it stays unknown rather than
    // being swept into INCONCLUSIVE by a loose pattern.
    expect(classifyEcgRhythm("Heart Rate Over").kind).toBe("unknown");
  });

  it.each([
    ["bad timestamp", validCsv({ "Recorded Date": "not-a-date" })],
    ["bad frequency", validCsv({ "Sample Rate": "not-a-rate" })],
    ["non-finite voltage", validCsv().replace("I,-0.002", "I,Infinity")],
    ["missing samples", validCsv().split("Lead,Voltage")[0]],
  ])("rejects malformed %s", async (_label, csv) => {
    await expect(parse(csv)).rejects.toThrow(/invalid|malformed|sample|date/i);
  });

  it("stops reading once the sample cap is exceeded", async () => {
    await expect(parse(validCsv(), 2)).rejects.toThrow(/sample|limit/i);
  });

  it("normalizes Apple's single-column waveform layout", async () => {
    const parsed = await parse(singleColumnCsv());
    expect(parsed).toMatchObject({
      recordedAt: new Date("2026-07-18T06:14:03.000Z"),
      samplingFrequency: 512,
      samples: [2, -2, 3],
      lead: "Lead I",
      averageHeartRate: 64,
      rhythmClassification: "NOT_DETECTED",
    });
    expect(JSON.stringify(parsed)).not.toMatch(/Private Patient/i);
  });

  it("converts millivolt single-column samples to microvolts", async () => {
    await expect(parse(singleColumnCsv({ Unit: "mV" }))).resolves.toMatchObject(
      { samples: [1500, -2400, 3000] },
    );
  });

  it.each([
    ["unsupported unit", singleColumnCsv({ Unit: "V" })],
    ["paired row after the blank separator", `${singleColumnCsv()}\nI,0.001`],
    ["out-of-bounds amplitude", singleColumnCsv().replace("-2.4", "999999")],
    ["non-numeric sample", singleColumnCsv().replace("-2.4", "waveform")],
  ])("rejects a single-column recording with %s", async (_label, csv) => {
    await expect(parse(csv)).rejects.toThrow(
      /invalid|malformed|unsupported|sample/i,
    );
  });

  it("stops single-column reading once the sample cap is exceeded", async () => {
    await expect(parse(singleColumnCsv(), 2)).rejects.toThrow(/sample|limit/i);
  });

  it("never logs or returns plaintext health values on failure", async () => {
    const subject = await loadParserSubject();
    const spies: MockInstance[] = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
    ];
    const secret = "patient-secret-waveform-0.123456";

    let message = "";
    try {
      await subject.parseAppleHealthEcgCsv({
        memberName: "apple_health_export/electrocardiograms/ecg_2026-07-18.csv",
        stream: Readable.from([Buffer.from(`${validCsv()}\nI,${secret}`)]),
        maxSamples: 8,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(secret);
    expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
  });
});

/**
 * The shapes real exports actually use.
 *
 * The fixtures above were written from the format's documentation rather than
 * from a file off a watch, and they drifted from it in four independent ways.
 * Each block below pins one of them, and — because the differences are dialect
 * rather than version — pins BOTH dialects side by side, so a later edit cannot
 * quietly trade one for the other.
 */
describe("Apple Health ECG CSV — real-export shapes", () => {
  async function parse(csv: string, maxSamples = 8) {
    const subject = await loadParserSubject();
    return subject.parseAppleHealthEcgCsv({
      memberName: "apple_health_export/electrocardiograms/ecg_2026-07-18.csv",
      stream: Readable.from([Buffer.from(csv)]),
      maxSamples,
    });
  }

  describe("a header row with no value", () => {
    it("accepts the bare `Name` row every observed export opens with", async () => {
      // The name field is blank and Apple omits the comma entirely, so the
      // parser used to fail on line 1, before reading anything.
      await expect(
        parse(validCsv().replace("Name,Private Patient Name", "Name")),
      ).resolves.toMatchObject({ samplingFrequency: 512 });
    });

    it("keeps a valueless header row out of the metadata", async () => {
      // `Lead` + `Unit` presence is what switches the parser into the
      // single-column mode; a valueless key must not be able to trip it.
      await expect(
        parse(`${singleColumnCsv().replace("Unit,µV", "Unit")}`),
      ).rejects.toThrow(/samples are missing|malformed/i);
    });

    it("still rejects a comma-less row inside the paired waveform", async () => {
      await expect(
        parse(validCsv().replace("I,-0.002", "-0.002")),
      ).rejects.toThrow(/malformed/i);
    });
  });

  describe("both decimal dialects", () => {
    /** The same three samples, written by a dot-region and a comma-region watch. */
    const DOT_SAMPLES = ["1.5", "-2.4", "3"];
    const COMMA_SAMPLES = ["1,5", "-2,4", "3"];

    function withSamples(rows: readonly string[]): string {
      return `${singleColumnCsv().split("\n").slice(0, -3).join("\n")}\n${rows.join("\n")}`;
    }

    it.each([
      ["dot", DOT_SAMPLES],
      ["comma", COMMA_SAMPLES],
    ])(
      "reads a %s-decimal waveform to the same microvolts",
      async (_d, rows) => {
        await expect(parse(withSamples(rows))).resolves.toMatchObject({
          samples: [2, -2, 3],
        });
      },
    );

    it("reads both dialects of the paired layout identically", async () => {
      // splitPair cuts on the first comma, so the value keeps its own mark.
      await expect(parse(validCsv())).resolves.toMatchObject({
        samples: [1, -2, 3],
      });
      const commaPaired = validCsv()
        .replace("I,0.001", "I,0,001")
        .replace("I,-0.002", "I,-0,002")
        .replace("I,0.003", "I,0,003");
      await expect(parse(commaPaired)).resolves.toMatchObject({
        samples: [1, -2, 3],
      });
    });

    it("refuses a grouped number rather than guessing its region", async () => {
      // "1.234,5" needs the file's region to resolve and the file never says.
      await expect(
        parse(withSamples(["1.234,5", "-2,4", "3"])),
      ).rejects.toThrow(/sample value is invalid/i);
    });

    it.each([
      ["512 Hz", 512],
      ["512 hz", 512],
      ["512 hertz", 512],
      ["511,422 hertz", 511],
      ["511.422 hertz", 511],
      ["511,562\u00a0Hertz", 512],
      ["512Hz", 512],
    ])("reads the sample rate written as %s", async (raw, expected) => {
      // Observed exports spell the unit out, lower-case it, and (in the German
      // files) separate it with a no-break space. The fixtures had only ever
      // used "512 Hz".
      await expect(
        parse(validCsv({ "Sample Rate": raw })),
      ).resolves.toMatchObject({ samplingFrequency: expected });
    });

    it.each([
      ["a missing unit", "512"],
      ["the wrong unit", "512 bpm"],
      ["a rate above the bound", "20000 hertz"],
      ["a grouped rate", "1.234,5 hertz"],
    ])("still rejects a sample rate with %s", async (_label, raw) => {
      await expect(parse(validCsv({ "Sample Rate": raw }))).rejects.toThrow(
        /sample rate is invalid/i,
      );
    });

    it("reads the average heart rate in both dialects", async () => {
      await expect(
        parse(validCsv({ "Average Heart Rate": "64 bpm" })),
      ).resolves.toMatchObject({ averageHeartRate: 64 });
      await expect(
        parse(validCsv({ "Average Heart Rate": "63,7 bpm" })),
      ).resolves.toMatchObject({ averageHeartRate: 64 });
    });

    it("still rejects a paired row that follows the single-column waveform", async () => {
      await expect(parse(`${singleColumnCsv()}\nI,0.001`)).rejects.toThrow(
        /sample value is invalid/i,
      );
    });
  });

  describe("a localised export", () => {
    /**
     * The header of a real German export, key for key. Every row here was
     * observed; nothing is translated by hand. The blank rows mid-header and
     * the no-break space before "Hertz" are the file's, not a typo.
     */
    function germanCsv(
      overrides: Partial<Record<string, string>> = {},
    ): string {
      const metadata: Record<string, string> = {
        Geburtstag: '"27.03.1987"',
        Aufzeichnungsdatum: "2020-07-31 22:48:19 +0200",
        Klassifizierung: "Sinusrhythmus",
        Symptome: "",
        Softwareversion: "1.13",
        Gerät: '"Watch4,2"',
        Messrate: "511,562\u00a0Hertz",
        ...overrides,
      };
      return [
        "Name",
        ...Object.entries(metadata).map(([k, v]) => `${k},${v}`),
        "",
        "",
        "Ableitung,Ableitung I",
        "Einheit,µV",
        "",
        "-180,596",
        "-199,83",
        "-217,333",
      ].join("\n");
    }

    it("reads a German export end to end", async () => {
      await expect(parse(germanCsv())).resolves.toMatchObject({
        recordedAt: new Date("2020-07-31T20:48:19.000Z"),
        samplingFrequency: 512,
        samples: [-181, -200, -217],
        lead: "Ableitung I",
        rhythmClassification: "NOT_DETECTED",
      });
    });

    it("reads the other observed German verdict", async () => {
      await expect(
        parse(germanCsv({ Klassifizierung: "Uneindeutig" })),
      ).resolves.toMatchObject({ rhythmClassification: "INCONCLUSIVE" });
    });

    it("returns no verdict for a language that is not mapped yet", async () => {
      // French is not in the alias map and is not guessed at. The recording
      // still imports; only the verdict is withheld.
      await expect(
        parse(germanCsv({ Klassifizierung: "Rythme sinusal" })),
      ).resolves.toMatchObject({ rhythmClassification: null });
    });

    it("refuses a file whose keys it cannot place, rather than mis-filing it", async () => {
      // An unmapped language's KEYS mean the parser never finds the waveform.
      // Refusing is visible; reading values into the wrong column is not.
      const french = germanCsv()
        .replace("Aufzeichnungsdatum,", "Date d'enregistrement,")
        .replace("Messrate,", "Fréquence d'échantillonnage,")
        .replace("Ableitung,Ableitung I", "Dérivation,Dérivation I")
        .replace("Einheit,µV", "Unité,µV");
      await expect(parse(french)).rejects.toThrow(/samples are missing/i);
    });

    it("leaves the English header working unchanged", async () => {
      await expect(parse(validCsv())).resolves.toMatchObject({
        samplingFrequency: 512,
        rhythmClassification: "NOT_DETECTED",
      });
    });
  });
});
