/**
 * Whose word a restored AI endpoint is taken on. An admin's own copy is the
 * operator's configuration, so the operator's wider endpoint policy applies;
 * a copy uploaded into an account other than the one that wrote it is the
 * word of whoever wrote it, whatever the receiving account's role.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Prisma } from "@/generated/prisma/client";
import { restoreAccountSettings } from "@/lib/export/account-settings-restore";

const PRIVATE_ENDPOINT = "http://10.20.30.40:11434";

function adminTx() {
  const update = vi.fn(async () => ({}));
  const tx = {
    user: {
      findUniqueOrThrow: vi.fn(async () => ({
        role: "ADMIN",
        aiProvider: null,
        unitPreference: "metric",
        glucoseUnit: "mg/dL",
      })),
      update,
    },
  } as unknown as Prisma.TransactionClient;
  return { tx, update };
}

const payload = {
  accountSettings: { aiProvider: "LOCAL", aiBaseUrl: PRIVATE_ENDPOINT },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("restoring an admin account's settings", () => {
  it("takes a private AI endpoint from the admin's own copy under the operator's policy", async () => {
    vi.stubEnv("AI_PRIVATE_ORIGINS", "");
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
    const { tx, update } = adminTx();
    const result = await restoreAccountSettings(tx, "admin-1", payload, {
      retargeted: false,
    });
    expect(result.refused).toEqual([]);
    expect(update).toHaveBeenCalledWith({
      where: { id: "admin-1" },
      data: { aiProvider: "LOCAL", aiBaseUrl: PRIVATE_ENDPOINT },
    });
  });

  it("refuses it from a copy that was uploaded into the account from someone else's file", async () => {
    vi.stubEnv("AI_PRIVATE_ORIGINS", "");
    vi.stubEnv("ALLOW_LOCAL_AI_PRIVATE_HOSTS", "true");
    const { tx, update } = adminTx();
    const result = await restoreAccountSettings(tx, "admin-1", payload, {
      retargeted: true,
    });
    expect(result.refused).toEqual(["aiBaseUrl"]);
    expect(update).toHaveBeenCalledWith({
      where: { id: "admin-1" },
      data: { aiProvider: "LOCAL" },
    });
  });
});
