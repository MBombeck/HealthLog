/**
 * Editing a life event (v1.42, #613): the merged event is checked against
 * the create rules, and only what the edit carries is written.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/ai/coach/bytes-codec", () => ({
  encryptToBytes: (s: string) => new TextEncoder().encode(`enc:${s}`),
  decryptFromBytes: (b: Uint8Array) =>
    new TextDecoder().decode(b).replace(/^enc:/, ""),
}));

import type { LifeEvent } from "@/generated/prisma/client";

import { mergeLifeEventEdit, toLifeEventDTO } from "../service";

const stored: LifeEvent = {
  id: "le1",
  userId: "u1",
  category: "HOME",
  startDate: "2023-09-01",
  endDate: null,
  precision: "MONTH",
  titleEncrypted: new TextEncoder().encode("enc:Moved") as never,
  noteEncrypted: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  deletedAt: null,
};

describe("life event edit", () => {
  it("refuses a precision change that misaligns the stored date", () => {
    const merged = mergeLifeEventEdit(stored, { precision: "YEAR" });
    expect(merged.ok).toBe(false);
  });

  it("accepts the precision with a matching date and writes only those keys", () => {
    const merged = mergeLifeEventEdit(stored, {
      precision: "YEAR",
      startDate: "2023-01-01",
    });
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(Object.keys(merged.data).sort()).toEqual([
        "precision",
        "startDate",
      ]);
    }
  });

  it("refuses an end before the stored start", () => {
    expect(mergeLifeEventEdit(stored, { endDate: "2023-08-01" }).ok).toBe(
      false,
    );
  });

  it("encrypts a new title and clears a note", () => {
    const merged = mergeLifeEventEdit(stored, {
      title: "Moved out",
      note: null,
    });
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(merged.data.noteEncrypted).toBeNull();
      expect(
        new TextDecoder().decode(merged.data.titleEncrypted as Uint8Array),
      ).toBe("enc:Moved out");
    }
  });

  it("decrypts for the response", () => {
    expect(toLifeEventDTO(stored)).toMatchObject({
      title: "Moved",
      note: null,
      startDate: "2023-09-01",
    });
  });
});
