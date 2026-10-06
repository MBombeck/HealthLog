import { beforeEach, describe, expect, it, vi } from "vitest";

// Hermetic codec: round-trip through a UTF-8 buffer, no real crypto keys
// needed. Mirrors the bytes-codec contract (string ↔ Uint8Array).
vi.mock("../bytes-codec", () => ({
  encryptToBytes: (s: string) => new TextEncoder().encode(s),
  decryptFromBytes: (b: Uint8Array) => new TextDecoder().decode(b),
}));

// Avoid importing the real Prisma client; opts injection supplies the fake.
vi.mock("@/lib/db", () => ({ prisma: {} }));

const annotateMock = vi.fn();
vi.mock("@/lib/logging/context", () => ({
  annotate: (...args: unknown[]) => annotateMock(...args),
}));

vi.mock("@/lib/insights/status-provider", () => ({
  runStatusCompletion: vi.fn(),
}));

import {
  DETERMINISTIC_FACT_CONFIDENCE,
  extractDeterministicFacts,
  storeDeterministicFacts,
} from "../facts";

function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeFakePrisma(activeTexts: string[] = []) {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    db: {
      coachFact: {
        findMany: vi.fn(async () =>
          activeTexts.map((text, i) => ({
            id: `fact-${i}`,
            factEncrypted: bytes(text),
            category: "condition",
            confidence: 90,
          })),
        ),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          created.push(data);
          return { id: `new-${created.length}` };
        }),
      },
      coachConversation: { findFirst: vi.fn() },
    },
  };
}

beforeEach(() => {
  annotateMock.mockClear();
});

describe("extractDeterministicFacts", () => {
  it.each([
    ["ich habe eine Erdnussallergie", "Erdnuss"],
    ["Ich hab eine Erdnuss-Allergie, seit Jahren.", "Erdnuss"],
    ["übrigens: ich bin allergisch gegen Penicillin.", "Penicillin"],
    ["ich habe eine Allergie gegen Hausstaubmilben", "Hausstaubmilben"],
    // v1.16.8 — conversational fillers no longer defeat the pass.
    ["Ich habe übrigens eine Erdnussallergie.", "Erdnuss"],
    ["Ich habe seit Jahren eine Pollenallergie.", "Pollen"],
    ["Ich habe auch eine Allergie gegen Nüsse.", "Nüsse"],
    ["Übrigens, ich habe noch eine Allergie gegen Penicillin.", "Penicillin"],
    ["Ich habe eine starke Erdnussallergie.", "Erdnuss"],
    ["Ich bin leider allergisch auf Erdnüsse.", "Erdnüsse"],
    // v1.16.8 — first-person possessive.
    ["Meine Erdnussallergie macht mir zu schaffen.", "Erdnuss"],
    ["Wegen meiner Pollenallergie schlafe ich schlecht.", "Pollen"],
  ])("matches the German allergy statement %j", (message, subject) => {
    const facts = extractDeterministicFacts(message, "de");
    expect(facts).toHaveLength(1);
    expect(facts[0].category).toBe("condition");
    expect(facts[0].confidence).toBe(DETERMINISTIC_FACT_CONFIDENCE);
    expect(facts[0].fact).toContain(subject);
    expect(facts[0].fact).toContain("Allergie");
    expect(facts[0].fact).toContain("eigene Angabe");
  });

  it("matches German intolerance statements", () => {
    expect(
      extractDeterministicFacts(
        "ich habe eine Laktoseunverträglichkeit",
        "de",
      )[0]?.fact,
    ).toContain("Laktose");
    expect(
      extractDeterministicFacts("ich bin laktoseintolerant", "de")[0]?.fact,
    ).toContain("laktose");
    // v1.16.8 — fillers + possessive.
    expect(
      extractDeterministicFacts(
        "ich habe übrigens eine Laktoseintoleranz",
        "de",
      )[0]?.fact,
    ).toContain("Laktose");
    expect(
      extractDeterministicFacts(
        "wegen meiner Histaminunverträglichkeit",
        "de",
      )[0]?.fact,
    ).toContain("Histamin");
  });

  it("matches a German self-reported diagnosis", () => {
    const facts = extractDeterministicFacts(
      "bei mir wurde Asthma diagnostiziert",
      "de",
    );
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toContain("Asthma");
    expect(facts[0].fact).toContain("eigener Angabe");
  });

  it.each([
    ["I'm allergic to peanuts", "peanuts"],
    ["I am allergic to penicillin, sadly.", "penicillin"],
    ["I have a peanut allergy", "peanut"],
    ["I have a lactose intolerance", "lactose"],
    ["I was diagnosed with asthma", "asthma"],
    // v1.16.8 — fillers + possessive no longer defeat the pass.
    ["By the way, I also have a severe peanut allergy.", "peanut"],
    ["I'm also allergic to penicillin.", "penicillin"],
    ["My peanut allergy is acting up again.", "peanut"],
    ["I was recently diagnosed with asthma.", "asthma"],
  ])("matches the English statement %j", (message, subject) => {
    const facts = extractDeterministicFacts(message, "en");
    expect(facts).toHaveLength(1);
    expect(facts[0].fact.toLowerCase()).toContain(subject);
    expect(facts[0].fact).toMatch(/self-reported/i);
  });

  it("returns nothing for unrelated prose or third-party statements", () => {
    expect(extractDeterministicFacts("wie war mein Blutdruck?", "de")).toEqual(
      [],
    );
    expect(
      extractDeterministicFacts(
        "meine Schwester hat eine Katzenhaarallergie",
        "de",
      ),
    ).toEqual([]);
    expect(
      extractDeterministicFacts("what is an allergy exactly?", "en"),
    ).toEqual([]);
    // v1.16.8 — the filler tolerance is a closed list: open third-party
    // clauses still never match.
    expect(
      extractDeterministicFacts(
        "ich habe gehört dass seine Erdnussallergie schlimm ist",
        "de",
      ),
    ).toEqual([]);
    expect(
      extractDeterministicFacts(
        "ich habe eine Frage zu einer Erdnussallergie",
        "de",
      ),
    ).toEqual([]);
    expect(
      extractDeterministicFacts("my friend has a peanut allergy", "en"),
    ).toEqual([]);
  });
});

describe("storeDeterministicFacts", () => {
  it("persists a fresh allergy as a proposal with the always-remember confidence", async () => {
    const fake = makeFakePrisma();
    const stored = await storeDeterministicFacts({
      conversationId: "conv-1",
      userId: "user-1",
      message: "ich habe eine Erdnussallergie",
      locale: "de",
      prisma: fake.db as never,
    });
    expect(stored).toBe(1);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({
      userId: "user-1",
      category: "condition",
      confidence: DETERMINISTIC_FACT_CONFIDENCE,
      sourceConversationId: "conv-1",
      // v1.41 — a health fact waits for the person's "Yes, remember it":
      // kept, offered once, never used before it is confirmed.
      source: "proposed",
    });
    expect(annotateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: { name: "coach.facts.deterministic_stored" },
      }),
    );
  });

  it("dedupes against an existing near-identical fact", async () => {
    const fake = makeFakePrisma(["Allergie: Erdnuss (eigene Angabe)"]);
    const stored = await storeDeterministicFacts({
      conversationId: "conv-2",
      userId: "user-1",
      message: "ich habe eine Erdnuss-Allergie",
      locale: "de",
      prisma: fake.db as never,
    });
    expect(stored).toBe(0);
    expect(fake.created).toHaveLength(0);
  });

  it("is a no-op when the message carries no pattern", async () => {
    const fake = makeFakePrisma();
    const stored = await storeDeterministicFacts({
      conversationId: "conv-3",
      userId: "user-1",
      message: "Wie sieht mein Schlaf diese Woche aus?",
      locale: "de",
      prisma: fake.db as never,
    });
    expect(stored).toBe(0);
    expect(fake.db.coachFact.findMany).not.toHaveBeenCalled();
  });
});
