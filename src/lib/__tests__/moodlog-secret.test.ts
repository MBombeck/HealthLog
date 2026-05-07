import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  encryptMoodLogSecret,
  readMoodLogSecret,
  isLegacyPlaintext,
  rotateLegacyMoodLogSecrets,
} from "../moodlog-secret";

const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

beforeEach(() => {
  process.env.ENCRYPTION_KEY = "a".repeat(64);
});

afterEach(() => {
  if (ORIGINAL_ENCRYPTION_KEY === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
});

// V3 audit STILL-V2-C-2: mood_log_webhook_secret was stored in plaintext.
// The new contract encrypts at rest with AES-256-GCM and tolerates legacy
// plaintext rows during the transition window.
describe("moodLog secret encrypt-at-rest", () => {
  it("encrypts and decrypts a generated secret round-trip", () => {
    const plaintext = "mb_" + "f".repeat(64);
    const encrypted = encryptMoodLogSecret(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(readMoodLogSecret(encrypted)).toBe(plaintext);
  });

  it("treats unrecognised values as legacy plaintext (transitional grace)", () => {
    expect(readMoodLogSecret("mb_legacyplaintextsecret")).toBe(
      "mb_legacyplaintextsecret",
    );
  });

  it("returns null for null/empty stored values", () => {
    expect(readMoodLogSecret(null)).toBeNull();
    expect(readMoodLogSecret("")).toBeNull();
  });

  it("isLegacyPlaintext detects rotation status correctly", () => {
    const enc = encryptMoodLogSecret("mb_test");
    expect(isLegacyPlaintext(enc)).toBe(false);
    expect(isLegacyPlaintext("mb_test")).toBe(true);
    expect(isLegacyPlaintext(null)).toBe(false);
  });

  it("rotateLegacyMoodLogSecrets encrypts only legacy rows and is idempotent", async () => {
    const enc = encryptMoodLogSecret("mb_alreadyencrypted");
    const rows = [
      { id: "u1", moodLogWebhookSecret: "mb_legacy1" },
      { id: "u2", moodLogWebhookSecret: enc },
      { id: "u3", moodLogWebhookSecret: "mb_legacy3" },
      { id: "u4", moodLogWebhookSecret: null },
    ];
    const updates: Array<{ id: string; encrypted: string }> = [];

    const rotated = await rotateLegacyMoodLogSecrets({
      findLegacy: async () => rows,
      rotate: async (id, encrypted) => {
        updates.push({ id, encrypted });
      },
    });

    expect(rotated).toBe(2);
    expect(updates.map((u) => u.id).sort()).toEqual(["u1", "u3"]);
    for (const update of updates) {
      // Each rotation must produce a value that decrypts back to the
      // original legacy plaintext — no data loss.
      const original = rows.find((r) => r.id === update.id)!.moodLogWebhookSecret;
      expect(readMoodLogSecret(update.encrypted)).toBe(original);
    }

    // Re-running on the now-encrypted store rotates nothing.
    const next = await rotateLegacyMoodLogSecrets({
      findLegacy: async () => [
        { id: "u1", moodLogWebhookSecret: updates[0].encrypted },
        { id: "u2", moodLogWebhookSecret: enc },
      ],
      rotate: async () => {
        throw new Error("should not be called");
      },
    });
    expect(next).toBe(0);
  });
});
