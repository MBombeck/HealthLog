import { beforeEach, describe, expect, it, vi } from "vitest";

const findUnique = vi.fn();
const getOuraCredentials = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: { user: { findUnique: (...args: unknown[]) => findUnique(...args) } },
}));

vi.mock("@/lib/crypto", () => ({
  decrypt: (cipher: string) => `dec(${cipher})`,
  encrypt: (plain: string) => `enc(${plain})`,
}));

// The env fallback lives in ./client; stub it so the precedence is observable.
vi.mock("../oauth", () => ({
  getOuraCredentials: () => getOuraCredentials(),
}));

import { getOuraClientCredentials } from "../credentials";

describe("getOuraClientCredentials — DB-first then env", () => {
  beforeEach(() => {
    findUnique.mockReset();
    getOuraCredentials.mockReset();
  });

  it("returns the per-user BYO client id/secret when both columns are set", async () => {
    findUnique.mockResolvedValue({
      ouraClientIdEncrypted: "enc-id",
      ouraClientSecretEncrypted: "enc-secret",
    });
    const creds = await getOuraClientCredentials("user-1");
    expect(creds).toEqual({
      clientId: "dec(enc-id)",
      clientSecret: "dec(enc-secret)",
    });
    expect(getOuraCredentials).not.toHaveBeenCalled();
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: {
        ouraClientIdEncrypted: true,
        ouraClientSecretEncrypted: true,
      },
    });
  });

  it("falls back to the shared env app when the user has no BYO pair", async () => {
    findUnique.mockResolvedValue({
      ouraClientIdEncrypted: null,
      ouraClientSecretEncrypted: null,
    });
    getOuraCredentials.mockReturnValue({
      clientId: "env-id",
      clientSecret: "env-secret",
    });
    const creds = await getOuraClientCredentials("user-1");
    expect(creds).toEqual({ clientId: "env-id", clientSecret: "env-secret" });
    expect(getOuraCredentials).toHaveBeenCalledOnce();
  });

  it("falls back to env when only one half of the BYO pair is present", async () => {
    findUnique.mockResolvedValue({
      ouraClientIdEncrypted: null,
      ouraClientSecretEncrypted: "enc-secret",
    });
    getOuraCredentials.mockReturnValue({
      clientId: "env-id",
      clientSecret: "env-secret",
    });
    const creds = await getOuraClientCredentials("user-1");
    expect(creds).toEqual({ clientId: "env-id", clientSecret: "env-secret" });
  });

  it("returns null when neither the user nor the env is configured", async () => {
    findUnique.mockResolvedValue(null);
    getOuraCredentials.mockReturnValue(null);
    expect(await getOuraClientCredentials("ghost")).toBeNull();
  });
});
