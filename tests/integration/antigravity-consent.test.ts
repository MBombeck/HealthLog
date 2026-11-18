/**
 * Antigravity and consent, against the real database.
 *
 * Antigravity sends data to Google, so a Coach turn that uses it needs an
 * active Coach consent receipt, the same as the other server-managed
 * providers. A revoked receipt does not count.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { AntigravityClient } from "@/lib/ai/antigravity-client";
import {
  assertConsentForChain,
  ConsentRequiredError,
  isExternalDocumentEgress,
} from "@/lib/ai/consent-guard";
import { isExternalProvider } from "@/lib/ai/provider-egress";
import { documentProviderRank } from "@/lib/documents/provider-rank";
import { supportsPdfForProvider } from "@/lib/ai/vision-capability";

import { getPrismaClient, truncateAllTables } from "./setup";

const PROFILE = { geminiDir: "/unused", appDataDir: "unused" };

function antigravityChain() {
  return [
    {
      providerType: "antigravity" as const,
      instance: new AntigravityClient({ profile: PROFILE }),
    },
  ];
}

let counter = 0;
async function makeUser() {
  const suffix = counter++;
  return getPrismaClient().user.create({
    data: {
      username: `agy-consent-${suffix}`,
      email: `agy-consent-${suffix}@example.test`,
      timezone: "UTC",
    },
  });
}

describe("Antigravity classification", () => {
  it("classifies Antigravity as an external provider", () => {
    expect(isExternalProvider("antigravity")).toBe(true);
    expect(isExternalProvider("local")).toBe(false);
    expect(isExternalProvider("codex")).toBe(true);
  });

  it("ranks Antigravity last for documents, with Codex", () => {
    expect(documentProviderRank("antigravity")).toBe(3);
    expect(documentProviderRank("local")).toBe(0);
    expect(documentProviderRank("codex")).toBe(
      documentProviderRank("antigravity"),
    );
    expect(documentProviderRank("openai-compatible")).toBeLessThan(
      documentProviderRank("antigravity"),
    );
  });

  it("reports PDF and image support for Antigravity", () => {
    // Antigravity does not take a PDF whole. Its PDFs go through the text layer.
    expect(supportsPdfForProvider("antigravity")).toBe(false);
    expect(supportsPdfForProvider("openai")).toBe(false);
    expect(supportsPdfForProvider("codex")).toBe(false);
  });

  it("counts a document read through Antigravity as external egress", () => {
    expect(isExternalDocumentEgress("antigravity")).toBe(true);
  });
});

describe("Antigravity Coach consent (database)", () => {
  beforeEach(async () => {
    await truncateAllTables(getPrismaClient());
  });

  it("refuses a Coach turn through Antigravity without an active Coach receipt", async () => {
    const user = await makeUser();

    await expect(
      assertConsentForChain({
        userId: user.id,
        chain: antigravityChain(),
        surface: "coach",
      }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });

  it("allows the same turn once the user has an active Coach receipt", async () => {
    const user = await makeUser();
    await getPrismaClient().consentReceipt.create({
      data: {
        userId: user.id,
        kind: "ai_coach",
        artefact: "test",
        signedAt: new Date(),
      },
    });

    await expect(
      assertConsentForChain({
        userId: user.id,
        chain: antigravityChain(),
        surface: "coach",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not count a revoked Coach receipt", async () => {
    const user = await makeUser();
    await getPrismaClient().consentReceipt.create({
      data: {
        userId: user.id,
        kind: "ai_coach",
        artefact: "test",
        signedAt: new Date(),
        revokedAt: new Date(),
      },
    });

    await expect(
      assertConsentForChain({
        userId: user.id,
        chain: antigravityChain(),
        surface: "coach",
      }),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
  });
});
