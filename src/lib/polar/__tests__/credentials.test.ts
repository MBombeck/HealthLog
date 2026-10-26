import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const getPolarCredentials = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

// decrypt() is the fail-closed AES-256-GCM reader; the resolver only needs it
// to round-trip the stored ciphertext, so a `dec(<x>)` shim is sufficient here.
vi.mock("@/lib/crypto", () => ({
  decrypt: (cipher: string) => `dec(${cipher})`,
  encrypt: (plain: string) => `enc(${plain})`,
}));

// The env fallback lives in ./client; stub it so the precedence is observable.
vi.mock("../oauth", () => ({
  getPolarCredentials: () => getPolarCredentials(),
}));

import { getPolarClientCredentials } from "../credentials";

describe("getPolarClientCredentials — DB-first then env", () => {
  beforeEach(() => {
    findUnique.mockReset();
    getPolarCredentials.mockReset();
  });

  it("returns the per-user BYO client id/secret when both columns are set", async () => {
    findUnique.mockResolvedValue({
      polarClientIdEncrypted: "enc-id",
      polarClientSecretEncrypted: "enc-secret",
    });
    const creds = await getPolarClientCredentials("user-1");
    expect(creds).toEqual({
      clientId: "dec(enc-id)",
      clientSecret: "dec(enc-secret)",
    });
    // DB hit must not consult the env fallback.
    expect(getPolarCredentials).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: {
        polarClientIdEncrypted: true,
        polarClientSecretEncrypted: true,
      },
    });
  });

  it("falls back to the shared env app when the user has no BYO pair", async () => {
    findUnique.mockResolvedValue({
      polarClientIdEncrypted: null,
      polarClientSecretEncrypted: null,
    });
    getPolarCredentials.mockReturnValue({
      clientId: "env-id",
      clientSecret: "env-secret",
    });
    const creds = await getPolarClientCredentials("user-1");
    expect(creds).toEqual({ clientId: "env-id", clientSecret: "env-secret" });
    expect(getPolarCredentials).toHaveBeenCalledOnce();
  });

  it("falls back to env when only one half of the BYO pair is present", async () => {
    findUnique.mockResolvedValue({
      polarClientIdEncrypted: "enc-id",
      polarClientSecretEncrypted: null,
    });
    getPolarCredentials.mockReturnValue({
      clientId: "env-id",
      clientSecret: "env-secret",
    });
    const creds = await getPolarClientCredentials("user-1");
    expect(creds).toEqual({ clientId: "env-id", clientSecret: "env-secret" });
  });

  it("returns null when neither the user nor the env is configured", async () => {
    findUnique.mockResolvedValue(null);
    getPolarCredentials.mockReturnValue(null);
    expect(await getPolarClientCredentials("ghost")).toBeNull();
  });
});
