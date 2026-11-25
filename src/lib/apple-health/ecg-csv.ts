/**
 * Incremental parser for Apple Health HKElectrocardiogram CSV exports.
 *
 * Only normalized descriptors and integer microvolt samples leave this
 * module. Patient/source labels are ignored, failures use fixed messages, and
 * the input stream is destroyed as soon as a resource or validation bound is
 * crossed.
 */
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { RhythmClassification } from "@/generated/prisma/client";
import { foldForMatch } from "@/lib/i18n/fold-for-match";
import { ownValue } from "@/lib/own-key";

export interface NormalizedAppleHealthEcg {
  recordedAt: Date;
  samplingFrequency: number;
  samples: number[];
  lead: string | null;
  averageHeartRate: number | null;
  rhythmClassification: RhythmClassification | null;
}

function parserError(reason: string): Error {
  return new Error(`Invalid Apple Health ECG CSV: ${reason}`);
}

function parseRecordedAt(value: string | undefined): Date {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(
      value?.trim() ?? "",
    );
  if (!match) throw parserError("recorded date is malformed");
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[7]}${match[8]}:${match[9]}`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw parserError("recorded date is invalid");
  }
  return parsed;
}

/**
 * Split a measured quantity into its magnitude and its unit word.
 *
 * The unit is matched loosely on purpose. A real export writes the sampling
 * rate as "511,422 hertz" — the word spelled out, lower case, and separated by
 * a NO-BREAK space in the German files — where the fixtures had always assumed
 * "512 Hz". The magnitude is read through the shared decimal helper, so a
 * comma-region watch's "511,562" is the same rate as "511.422".
 *
 * `\s` covers U+00A0, so the no-break space needs no special case.
 */
function splitQuantity(
  raw: string,
  unit: RegExp,
): { magnitude: number; ok: boolean } {
  const match = /^([+-]?[\d.,]+)\s*([^\s\d]+)$/.exec(raw.trim());
  if (!match) return { magnitude: Number.NaN, ok: false };
  const magnitude = parseDecimal(match[1]);
  if (magnitude === null) return { magnitude: Number.NaN, ok: false };
  return { magnitude, ok: unit.test(match[2]) };
}

/** "Hz", "hz", "hertz", "Hertz" — the same unit, spelled as the region does. */
const HERTZ = /^(?:hz|hertz)$/i;

/** "bpm" and the spelled-out forms a localised export may carry. */
const BEATS_PER_MINUTE = /^(?:bpm|spm)$/i;

function parseRate(value: string | undefined): number {
  const { magnitude, ok } = splitQuantity(value ?? "", HERTZ);
  if (
    !ok ||
    !Number.isFinite(magnitude) ||
    magnitude <= 0 ||
    magnitude > 10_000
  ) {
    throw parserError("sample rate is invalid");
  }
  return Math.round(magnitude);
}

function parseHeartRate(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const { magnitude, ok } = splitQuantity(value, BEATS_PER_MINUTE);
  if (!ok || !Number.isFinite(magnitude) || magnitude <= 0 || magnitude > 300) {
    throw parserError("average heart rate is invalid");
  }
  return Math.round(magnitude);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Localised exports.
 *
 * The CSV is written in the device's language, and not only in its values —
 * the metadata KEYS are translated too. A German watch writes
 * `Klassifizierung,Sinusrhythmus` and `Aufzeichnungsdatum,…`, so a parser
 * indexing on the English keys found none of them, never crossed into the
 * waveform, and rejected the whole recording.
 *
 * Both maps below are OBSERVED, from real exports: nine keys and two verdicts,
 * consistent across every German file seen. The other four shipped languages
 * are deliberately ABSENT rather than guessed. A wrong key silently mis-files a
 * value and a wrong clinical verdict is worse than no verdict, so a localised
 * file this parser cannot place is refused — which is visible — instead of
 * being read into the wrong column, which is not.
 *
 * Adding a language is a data addition to these two maps and nothing else.
 *
 * Two gaps worth naming. No observed file carries an average-heart-rate row in
 * any language, so there is no localised key for it here. And every observed
 * localised file uses the single-column layout, so the paired layout's
 * `Lead,Voltage` column header has only ever been seen in English; its
 * translated form is unknown and is not invented here.
 * ────────────────────────────────────────────────────────────────────────── */

/** Folded localised metadata key → the canonical English key we index on. */
const METADATA_KEY_ALIASES: Readonly<Record<string, string>> = {
  // de — observed across real exports
  geburtstag: "Date of Birth",
  aufzeichnungsdatum: "Recorded Date",
  klassifizierung: "Classification",
  symptome: "Symptoms",
  softwareversion: "Software Version",
  gerat: "Device",
  messrate: "Sample Rate",
  ableitung: "Lead",
  einheit: "Unit",
};

/**
 * Folded localised verdict → its English wording.
 *
 * Deliberately an indirection onto the English vocabulary rather than a second
 * verdict-to-enum table: one place decides what a verdict MEANS, and
 * translations only feed it.
 */
const CLASSIFICATION_ALIASES: Readonly<Record<string, string>> = {
  // de — observed across real exports
  sinusrhythmus: "Sinus Rhythm",
  uneindeutig: "Inconclusive",
};

/** Resolve a metadata key to the English one this parser indexes on. */
function canonicalMetadataKey(raw: string): string {
  return ownValue(METADATA_KEY_ALIASES, foldForMatch(raw)) ?? raw;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Rhythm classification.
 *
 * The map used to hold three verdicts. Apple's documented set is larger, so a
 * real verdict was being dropped on English devices: "Heart Rate Over 120" and
 * "Heart Rate Under 50" both landed on `null`, which the column cannot tell
 * apart from "this recording carries no classification at all".
 *
 * The English wordings below are OBSERVED, from a corpus of real Apple Watch
 * exports rather than taken from the framework's case names — the CSV writes a
 * display string, and it does not match the `HKElectrocardiogram.Classification`
 * identifiers. `InconclusiveHighHeartRate` reaches the file as "Heart Rate Over
 * 120", not as "High Heart Rate". The threshold is part of the wording and it
 * tracks the watch generation, so the two heart-rate arms match the number
 * rather than pin it.
 *
 * The remaining wordings are Apple's own result names from the ECG
 * instructions-for-use document. They are verdicts the app can produce; a given
 * file may never carry one, but mapping a documented verdict is not the same as
 * leaving a branch in for a hypothetical caller.
 *
 * ## What is still unresolved, and why it is not guessed here
 *
 * The CSV is localised, and not only in this field — a German export writes
 * `Klassifizierung,Sinusrhythmus`, with the KEY translated too. A non-English
 * verdict therefore reaches the `unknown` arm below, and in practice it never
 * gets this far, because the localised metadata keys fail the parse earlier.
 * Translating a clinical verdict is not something to do from memory, so the
 * language half is deliberately left open and named rather than filled in.
 * ────────────────────────────────────────────────────────────────────────── */

/** What the parser was able to make of the `Classification` field. */
export type EcgClassificationOutcome =
  /** A verdict this repository's enum represents. */
  | { kind: "mapped"; value: RhythmClassification }
  /** No classification field, or an empty one — the recording carries no verdict. */
  | { kind: "absent" }
  /** A verdict Apple documents that this repository's enum cannot express. */
  | { kind: "unrepresentable"; verdict: string }
  /** A verdict this parser has never seen — including every non-English one. */
  | { kind: "unknown" };

/**
 * Apple's English verdicts, folded, to the enum member each one means.
 *
 * The inconclusive shapes collapse onto `INCONCLUSIVE` honestly: that member is
 * documented as "device could not classify (poor signal / out-of-range HR)",
 * which is exactly what Apple says each of them is.
 */
const RHYTHM_BY_VERDICT: ReadonlyMap<string, RhythmClassification> = new Map<
  string,
  RhythmClassification
>([
  // Observed in real exports.
  ["sinus rhythm", "NOT_DETECTED"],
  ["inconclusive", "INCONCLUSIVE"],
  // Documented in Apple's ECG instructions for use.
  ["atrial fibrillation", "IRREGULAR"],
  ["atrial fibrillation high heart rate", "IRREGULAR"],
  ["high heart rate no atrial fibrillation detected", "NOT_DETECTED"],
  ["poor recording", "INCONCLUSIVE"],
]);

/**
 * The heart-rate-bound verdicts, whose wording carries the threshold the watch
 * generation decides ("Heart Rate Over 120", "Heart Rate Over 150"). Apple's
 * framework documents both as inconclusive: the classifier could not check for
 * atrial fibrillation at that rate.
 */
const HEART_RATE_BOUND_VERDICT = /^heart rate (?:over|under) \d{2,3}$/;

/**
 * Verdicts Apple documents that this repository's enum has no honest member
 * for. `Unrecognized` is NOT `INCONCLUSIVE`: the device did not fail to
 * classify the waveform, it received a verdict it does not know. Storing it as
 * "could not classify" would assert something Apple did not say.
 */
const UNREPRESENTABLE_VERDICTS: ReadonlySet<string> = new Set(["unrecognized"]);

/**
 * Classify the `Classification` field.
 *
 * Split out from the column write so the parser can tell a verdict it has never
 * heard of from one it knows it cannot represent. Both still end as `null` in
 * the nullable enum column — that is the column's whole vocabulary — but they
 * are different facts, and the previous single `default: return null` could not
 * distinguish them. No column is added for the distinction: nothing reads one
 * yet, and a write-only column is the failure mode this repository keeps
 * rediscovering.
 */
export function classifyEcgRhythm(
  value: string | undefined,
): EcgClassificationOutcome {
  const folded = foldForMatch(value ?? "");
  if (folded === "") return { kind: "absent" };
  const mapped = RHYTHM_BY_VERDICT.get(folded);
  if (mapped) return { kind: "mapped", value: mapped };
  if (HEART_RATE_BOUND_VERDICT.test(folded)) {
    return { kind: "mapped", value: "INCONCLUSIVE" };
  }
  if (UNREPRESENTABLE_VERDICTS.has(folded)) {
    return { kind: "unrepresentable", verdict: folded };
  }
  return { kind: "unknown" };
}

function mapClassification(
  raw: string | undefined,
): RhythmClassification | null {
  // Translate first, classify second. The alias table maps an observed
  // localised verdict onto Apple's own English wording and stops there;
  // `classifyEcgRhythm` remains the single place that decides what a verdict
  // MEANS. A per-language verdict table would drift from this one the first
  // time Apple adds a case, and only one of them would get updated.
  const value =
    ownValue(CLASSIFICATION_ALIASES, foldForMatch(raw ?? "")) ?? raw;
  const outcome = classifyEcgRhythm(value);
  return outcome.kind === "mapped" ? outcome.value : null;
}

function resolveUnitScale(value: string | undefined): number | null {
  switch (value?.trim().toLowerCase()) {
    case "µv":
    case "μv":
    case "uv":
    case "microvolt":
    case "microvolts":
      return 1;
    case "mv":
    case "millivolt":
    case "millivolts":
      return 1_000;
    default:
      return null;
  }
}

function splitPair(line: string): [string, string] | null {
  const comma = line.indexOf(",");
  if (comma < 0) return null;
  return [line.slice(0, comma).trim(), line.slice(comma + 1).trim()];
}

/**
 * Which section of the file the reader is in.
 *
 * The two waveform layouts disagree about what a comma MEANS, so the parser
 * cannot decide that per line — it has to know which side of the boundary it is
 * on. Naming the mode is what makes the two readings safe to hold at once.
 */
type Section =
  /** Key/value metadata rows. A comma separates the key from the value. */
  | "header"
  /** One bare number per row. A comma is a decimal mark. */
  | "single-column"
  /** `lead,voltage` per row. A comma separates the two fields. */
  | "paired";

/**
 * Read one scalar written in either decimal dialect: "-180.596" and "-180,596"
 * are the same measurement, recorded by watches set to different regions.
 *
 * Accepts at most ONE separator. A number carrying thousands grouping
 * ("1.234,5") is refused rather than guessed at, because resolving it needs to
 * know the file's region and nothing in the file states it.
 *
 * The single ambiguous case is a lone separator followed by exactly three
 * digits, where "-180,596" could in principle be grouping rather than a
 * decimal. It is read as a decimal, for two reasons that agree. Observed
 * waveforms carry two- and three-digit fractions in the same file
 * ("-199,83" next to "-217,333"), and grouping is always three, so the
 * two-digit rows settle what the separator is. And a machine writing one bare
 * value per row has no reason to group thousands at all.
 */
function parseDecimal(raw: string): number | null {
  if (!/^[+-]?\d+(?:[.,]\d+)?$/.test(raw)) return null;
  const value = Number(raw.replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

export async function parseAppleHealthEcgCsv(input: {
  memberName: string;
  stream: Readable;
  maxSamples: number;
}): Promise<NormalizedAppleHealthEcg> {
  void input.memberName;
  if (!Number.isSafeInteger(input.maxSamples) || input.maxSamples <= 0) {
    throw parserError("sample limit is invalid");
  }

  const metadata = new Map<string, string>();
  const samples: number[] = [];
  let section: Section = "header";
  let unitScale = 1;
  let lead: string | null = null;
  const lines = createInterface({
    input: input.stream,
    crlfDelay: Infinity,
  });

  try {
    for await (const rawLine of lines) {
      const line = rawLine.replace(/^\uFEFF/, "").trim();
      if (line === "") {
        // THE CROSSING into the single-column waveform.
        //
        // Apple's single-column layout declares the lead and unit as metadata
        // rows and separates them from the waveform with a blank line; one
        // bare number per row follows. A blank line on its own does not mean
        // anything — real exports carry two of them mid-header — so the
        // boundary is "a blank line once Lead and Unit have both been
        // declared", and it is taken exactly once, from the header.
        //
        // Everything after this point reads a comma as a decimal mark rather
        // than as a field separator, which is why the parser tracks the
        // section instead of deciding line by line.
        if (
          section === "header" &&
          metadata.has("Lead") &&
          metadata.has("Unit")
        ) {
          const scale = resolveUnitScale(metadata.get("Unit"));
          if (scale === null) {
            throw parserError("sample unit is unsupported");
          }
          unitScale = scale;
          const declaredLead = metadata.get("Lead") ?? "";
          if (declaredLead.length > 0 && declaredLead.length <= 32) {
            lead = declaredLead;
          }
          section = "single-column";
        }
        continue;
      }
      if (section === "single-column") {
        if (samples.length >= input.maxSamples) {
          throw parserError("sample limit exceeded");
        }
        // One value per row, in whichever decimal dialect the watch was set to.
        const value = parseDecimal(line);
        if (value === null) {
          throw parserError("sample value is invalid");
        }
        const microvolts = Math.round(value * unitScale);
        if (
          !Number.isSafeInteger(microvolts) ||
          Math.abs(microvolts) > 100_000
        ) {
          throw parserError("sample value is invalid");
        }
        samples.push(microvolts);
        continue;
      }
      const pair = splitPair(line);
      if (!pair) {
        // A HEADER row whose value is empty is written without the trailing
        // comma. Every real export opens with a bare `Name` when the name
        // field is blank, which this parser used to reject on line 1 — before
        // it had read anything at all.
        //
        // Only the header section may do this. Inside the single-column
        // waveform a comma-less row is a sample and was handled above; inside
        // the paired waveform every row is `lead,voltage`, so a missing comma
        // there is still malformed.
        //
        // The row contributes NO metadata entry rather than an empty-string
        // one: `Lead` and `Unit` presence is what switches the parser into the
        // single-column mode below, and a valueless key must not be able to
        // trip that switch.
        if (section !== "header") {
          throw parserError("row is malformed");
        }
        continue;
      }
      const [key, value] = pair;
      if (section === "header") {
        // THE CROSSING into the paired waveform: the `Lead,Voltage` column
        // header. Unlike the single-column boundary this one is explicit in
        // the file, so there is nothing to infer.
        if (
          canonicalMetadataKey(key) === "Lead" &&
          value.toLowerCase() === "voltage"
        ) {
          section = "paired";
          continue;
        }
        if (key !== "Name") metadata.set(canonicalMetadataKey(key), value);
        continue;
      }

      if (samples.length >= input.maxSamples) {
        throw parserError("sample limit exceeded");
      }
      // `splitPair` cut on the FIRST comma, so a comma still inside the value
      // is this row's decimal mark, exactly as in the single-column layout.
      const voltage = parseDecimal(value);
      if (voltage === null || Math.abs(voltage) > 100) {
        throw parserError("sample value is invalid");
      }
      const microvolts = Math.round(voltage * 1_000);
      if (!Number.isSafeInteger(microvolts)) {
        throw parserError("sample value is invalid");
      }
      if (lead === null && key.length > 0 && key.length <= 32) lead = key;
      samples.push(microvolts);
    }

    if (section === "header" || samples.length === 0) {
      throw parserError("samples are missing");
    }
    return {
      recordedAt: parseRecordedAt(metadata.get("Recorded Date")),
      samplingFrequency: parseRate(metadata.get("Sample Rate")),
      samples,
      lead,
      averageHeartRate: parseHeartRate(metadata.get("Average Heart Rate")),
      rhythmClassification: mapClassification(metadata.get("Classification")),
    };
  } catch (error) {
    samples.fill(0);
    input.stream.destroy();
    lines.close();
    if (error instanceof Error && error.message.startsWith("Invalid Apple")) {
      throw error;
    }
    throw parserError("stream could not be parsed");
  }
}
