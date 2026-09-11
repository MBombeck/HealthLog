/**
 * Signing in must cost the same whether or not the account exists.
 *
 * The login route used to return the moment it found no account, or an
 * account with no password hash, before it reached the verifier. An account
 * that did have a password paid a full Argon2id verification. Same status,
 * same body, very different durations — so the clock answered "is this
 * address registered, and does it carry a password", which is the question
 * the removed discovery endpoint used to answer out loud.
 *
 * What this file pins is the work, not the wall clock: that the empty arms
 * reach the verifier at all, that the hash they verify against was minted at
 * the same cost parameters every real hash carries, and that no outcome on
 * those arms can be read as a successful verification. A unit test cannot
 * prove two durations are equal — it can only prove the same call is made.
 *
 * `@node-rs/argon2` is mocked so the assertions are about which calls happen
 * with which arguments, and so the suite does not spend real Argon2 time.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted so the mock is in place before `password.ts` is imported.
const { hashMock, verifyMock } = vi.hoisted(() => ({
  hashMock: vi.fn(async (input: string) => `hashed:${input}`),
  verifyMock: vi.fn(async (_hash: string, _password: string) => false),
}));

vi.mock("@node-rs/argon2", () => ({ hash: hashMock, verify: verifyMock }));

import { ARGON2_HASH_OPTIONS } from "@/lib/auth/argon2-params.mjs";

/**
 * The dummy hash is minted once per module instance, so each test gets a
 * fresh instance — otherwise the first successful mint is cached and the
 * mint-failure cases could never reach the mint at all.
 */
let verifyPasswordOrDummy: (
  storedHash: string | null | undefined,
  password: string,
) => Promise<boolean>;

beforeEach(async () => {
  verifyMock.mockReset();
  verifyMock.mockResolvedValue(false);
  hashMock.mockReset();
  hashMock.mockImplementation(async (input: string) => `hashed:${input}`);
  vi.resetModules();
  ({ verifyPasswordOrDummy } = await import("@/lib/auth/password"));
});

describe("verifyPasswordOrDummy", () => {
  it("mints the dummy hash under the same Argon2id parameters real hashes use", async () => {
    await verifyPasswordOrDummy(null, "anything");
    expect(hashMock).toHaveBeenCalledWith(
      expect.any(String),
      ARGON2_HASH_OPTIONS,
    );
  });

  it("mints once and reuses it for every later refusal", async () => {
    await verifyPasswordOrDummy(null, "anything");
    await verifyPasswordOrDummy(null, "anything");
    await verifyPasswordOrDummy(undefined, "anything");
    // Three refusals, three verifications, one mint.
    expect(verifyMock).toHaveBeenCalledTimes(3);
    expect(hashMock).toHaveBeenCalledTimes(1);
  });

  it("verifies against the stored hash when the account has one", async () => {
    verifyMock.mockResolvedValueOnce(true);
    await expect(
      verifyPasswordOrDummy("$argon2id$stored", "correct horse"),
    ).resolves.toBe(true);
    expect(verifyMock).toHaveBeenCalledTimes(1);
    expect(verifyMock).toHaveBeenCalledWith(
      "$argon2id$stored",
      "correct horse",
    );
  });

  it("still verifies when there is no account at all (null hash)", async () => {
    await expect(verifyPasswordOrDummy(null, "anything")).resolves.toBe(false);
    expect(verifyMock).toHaveBeenCalledTimes(1);
    // Against the dummy, not against nothing.
    expect(verifyMock.mock.calls[0][0]).toMatch(/^hashed:/);
  });

  it("still verifies for a passkey-only account (undefined hash)", async () => {
    // The passkey-only case is the one that matters most: if it took the
    // cheap path the channel would still answer "this account has no
    // password", which is half of what the removed endpoint published.
    await expect(verifyPasswordOrDummy(undefined, "anything")).resolves.toBe(
      false,
    );
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });

  it("never reports success from the dummy arm, whatever the verifier says", async () => {
    verifyMock.mockResolvedValue(true);
    await expect(verifyPasswordOrDummy(null, "anything")).resolves.toBe(false);
    await expect(verifyPasswordOrDummy(undefined, "anything")).resolves.toBe(
      false,
    );
  });

  it("swallows a throw from the dummy arm rather than answering differently", async () => {
    // A 500 only the unknown-account arm can produce is the same oracle in
    // a different field.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      verifyMock.mockRejectedValueOnce(new Error("malformed hash"));
      await expect(verifyPasswordOrDummy(null, "anything")).resolves.toBe(
        false,
      );
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("swallows a failed MINT too, not only a failed verify", async () => {
    // The mint is awaited as an argument to the verifier, so an unguarded
    // `await` on a rejected mint throws before the verifier is reached and
    // before any `.catch` on it can apply. That answers 500 on exactly the
    // arm that must look ordinary — and a passkey-only account could not
    // sign in at all.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      hashMock.mockRejectedValueOnce(new Error("out of memory"));
      await expect(verifyPasswordOrDummy(null, "anything")).resolves.toBe(
        false,
      );
      expect(verifyMock).not.toHaveBeenCalled();
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("re-mints after a failure instead of caching the rejection forever", async () => {
    // A rejected promise stays rejected for the life of the process. Caching
    // one would send every later refusal back down the cheap path with the
    // timing channel reopened and nothing to notice it by.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      hashMock.mockRejectedValueOnce(new Error("out of memory"));
      await verifyPasswordOrDummy(null, "anything");
      expect(verifyMock).not.toHaveBeenCalled();

      await expect(verifyPasswordOrDummy(null, "anything")).resolves.toBe(
        false,
      );
      expect(hashMock).toHaveBeenCalledTimes(2);
      expect(verifyMock).toHaveBeenCalledTimes(1);
    } finally {
      logged.mockRestore();
    }
  });
});
