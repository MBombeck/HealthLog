/**
 * The medication's own note (#1371): what the create and update bodies accept,
 * and the one seal / read boundary every writer and reader goes through.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  readMedicationNote,
  sealMedicationNote,
  withMedicationNote,
} from "../medication-note";
import {
  MEDICATION_NOTE_MAX_CHARS,
  createMedicationSchema,
  updateMedicationSchema,
} from "@/lib/validations/medication";

beforeEach(() => {
  vi.stubEnv("ENCRYPTION_KEYS", "");
  vi.stubEnv("ENCRYPTION_ACTIVE_KEY_ID", "");
  vi.stubEnv("ENCRYPTION_KEY", "c".repeat(64));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const CREATE_BASE = {
  name: "Levothyroxine",
  dose: "50 µg",
  schedules: [{ windowStart: "07:00", windowEnd: "08:00" }],
};

describe("the note on the create and update bodies", () => {
  it("accepts a note and trims it", () => {
    const parsed = createMedicationSchema.safeParse({
      ...CREATE_BASE,
      note: "  30 to 60 minutes before food  ",
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.note).toBe("30 to 60 minutes before food");
  });

  it("leaves the note out when the body does not name it", () => {
    const parsed = updateMedicationSchema.safeParse({ name: "Renamed" });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.note).toBeUndefined();
  });

  it("accepts null and an empty string, both of which clear it", () => {
    expect(updateMedicationSchema.safeParse({ note: null }).data?.note).toBe(
      null,
    );
    expect(updateMedicationSchema.safeParse({ note: "   " }).data?.note).toBe(
      "",
    );
  });

  it(`refuses a note longer than ${MEDICATION_NOTE_MAX_CHARS} characters after trimming`, () => {
    const atLimit = "x".repeat(MEDICATION_NOTE_MAX_CHARS);
    expect(
      updateMedicationSchema.safeParse({ note: `  ${atLimit}  ` }).success,
    ).toBe(true);
    const over = updateMedicationSchema.safeParse({ note: `${atLimit}x` });
    expect(over.success).toBe(false);
    expect(over.error?.issues[0]?.path).toEqual(["note"]);
  });

  it("refuses a note that is not text", () => {
    expect(updateMedicationSchema.safeParse({ note: 42 }).success).toBe(false);
  });
});

describe("sealMedicationNote / readMedicationNote", () => {
  it("leaves an absent note untouched", () => {
    expect(sealMedicationNote(undefined)).toBeUndefined();
  });

  it("clears on NULL and on a blank string", () => {
    expect(sealMedicationNote(null)).toBeNull();
    expect(sealMedicationNote("")).toBeNull();
    expect(sealMedicationNote("  \n ")).toBeNull();
  });

  it("seals a note so the column never holds the plaintext", () => {
    const sealed = sealMedicationNote("Before breakfast, with water");
    expect(sealed).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(sealed!).toString("utf8")).not.toContain("breakfast");
    expect(readMedicationNote(sealed)).toBe("Before breakfast, with water");
  });

  it("reads no note as null", () => {
    expect(readMedicationNote(null)).toBeNull();
    expect(readMedicationNote(undefined)).toBeNull();
  });

  it("refuses to read a ciphertext under a key it does not hold", () => {
    const sealed = sealMedicationNote("Before breakfast");
    vi.stubEnv("ENCRYPTION_KEY", "d".repeat(64));
    expect(() => readMedicationNote(sealed)).toThrow();
  });
});

describe("withMedicationNote", () => {
  it("swaps the ciphertext column for the decrypted note", () => {
    const row = {
      id: "m1",
      name: "Levothyroxine",
      noteEncrypted: sealMedicationNote("Before breakfast") ?? null,
    };
    const shaped = withMedicationNote(row);
    expect(shaped).toEqual({
      id: "m1",
      name: "Levothyroxine",
      note: "Before breakfast",
    });
    expect("noteEncrypted" in shaped).toBe(false);
  });

  it("serves null for a medication without a note", () => {
    expect(withMedicationNote({ id: "m1", noteEncrypted: null })).toEqual({
      id: "m1",
      note: null,
    });
  });
});
