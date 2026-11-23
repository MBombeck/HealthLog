/**
 * The account seed the root layout writes into a page is an allowlist.
 *
 * The seed is a copy of the `/api/auth/me` payload inside the HTML, and HTML
 * is the thing every cache between the server and the screen keeps. 1.49.0
 * first shipped it whole, on every page including the public ones, so the
 * decrypted insurance number, the date of birth and the e-mail rode into the
 * service worker's page cache with `/about`. These tests pin the three
 * properties that keep that class closed:
 *
 *  1. `toAccountSeed` emits the allowlisted fields and nothing else; the
 *     identity and insurance fields are never among them, and a field a later
 *     payload adds is dropped until somebody classifies it (the module also
 *     refuses to type-check with an unclassified field).
 *  2. The layout writes only `toAccountSeed` output, and only on a page the
 *     proxy marked as session-gated.
 *  3. A component that reads a withheld field off the account waits for the
 *     full payload (`profileLoaded` / `isFullAccount`), because in the seed
 *     those fields are `null` for "not sent", and a form seeded from that
 *     would save them as cleared.
 */
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_SEED_FIELDS,
  ACCOUNT_SEED_WITHHELD,
  toAccountSeed,
} from "@/lib/auth/account-seed";

import { readSource, readSourceFolder } from "./helpers/source-files";

/** Never in a document, whatever else changes. */
const MUST_BE_WITHHELD = [
  "insuranceNumber",
  "insurerIkNumber",
  "insurerName",
  "fullName",
  "dateOfBirth",
] as const;

describe("account seed allowlist", () => {
  it("withholds the identity and insurance fields", () => {
    for (const field of MUST_BE_WITHHELD) {
      expect(ACCOUNT_SEED_WITHHELD as readonly string[]).toContain(field);
      expect(ACCOUNT_SEED_FIELDS as readonly string[]).not.toContain(field);
    }
  });

  it("copies allowlisted fields, nulls the withheld ones, drops the rest", () => {
    const payload = {
      id: "u1",
      username: "someone",
      role: "USER",
      timezone: "Europe/Berlin",
      email: "someone@example.test",
      dateOfBirth: "1980-01-01T00:00:00.000Z",
      fullName: "A Person",
      insurerName: "An Insurer",
      insurerIkNumber: "123456789",
      insuranceNumber: "A123456789",
      lastReportPracticeName: "A Practice",
      reportSelection: { v: 1 },
      someFieldAddedLater: "secret-ish",
    };
    const seed = toAccountSeed(payload) as Record<string, unknown>;

    expect(seed.accountSeed).toBe(true);
    expect(seed.id).toBe("u1");
    for (const field of ACCOUNT_SEED_WITHHELD) {
      expect(seed[field], field).toBeNull();
    }
    expect(seed).not.toHaveProperty("someFieldAddedLater");
    const allowed = new Set<string>([
      ...ACCOUNT_SEED_FIELDS,
      ...ACCOUNT_SEED_WITHHELD,
      "accountSeed",
    ]);
    for (const key of Object.keys(seed)) {
      expect(allowed.has(key), key).toBe(true);
    }
    const serialised = JSON.stringify(seed);
    for (const value of [
      "A123456789",
      "123456789",
      "An Insurer",
      "A Person",
      "1980-01-01",
      "A Practice",
      "secret-ish",
    ]) {
      expect(serialised).not.toContain(value);
    }
  });
});

describe("the root layout writes the seed only through the allowlist", () => {
  const layout = readSource("src/app/layout.tsx", ["<AuthMeSeed"]);

  it("projects the payload with toAccountSeed", () => {
    expect(layout).toMatch(/toAccountSeed\(/);
    // One builder call, and it is the one that feeds the projection.
    expect(layout.match(/buildAuthMePayload\(/g)?.length).toBe(1);
    expect(layout).not.toMatch(/as MePayload/);
  });

  it("asks for the account only on a page the proxy marked", () => {
    expect(layout).toMatch(/ACCOUNT_SEED_REQUEST_HEADER/);
    expect(layout).toMatch(/!seedAllowed \? null : serverAccount\(\)/);
  });
});

const WITHHELD_READ = new RegExp(
  String.raw`\b(?:user|me|account)\??\.(?:${ACCOUNT_SEED_WITHHELD.join("|")})\b`,
);

/**
 * Readers that may see the seed's `null` without harm, each with the reason.
 */
const EXEMPT: Record<string, string> = {
  // The dashboard's client bands are the fallback while the snapshot (which
  // carries the record's own bands) loads; a null date of birth draws the
  // same age-free bands every cold load drew before the seed existed.
  "src/components/dashboard/tiles/tile-context.ts": "band fallback",
};

describe("readers of withheld fields wait for the full account", () => {
  const sources = new Map(
    ["src/components", "src/app", "src/hooks"].flatMap((dir) =>
      readSourceFolder(dir, {
        floor: 20,
        include: (rel) => !rel.includes("__tests__") && !rel.startsWith("api/"),
      }).map(([rel, text]) => [`${dir}/${rel}`, text] as const),
    ),
  );
  const readers = [...sources.keys()].filter((f) =>
    WITHHELD_READ.test(sources.get(f) ?? ""),
  );

  it("finds the readers (the matcher is not blind)", () => {
    expect(readers).toContain(
      "src/components/settings/account-section/index.tsx",
    );
    expect(readers.length).toBeGreaterThanOrEqual(4);
  });

  it.each(readers.filter((f) => !(f in EXEMPT)))(
    "%s gates on profileLoaded or isFullAccount",
    (file) => {
      expect(sources.get(file)).toMatch(/\bprofileLoaded\b|\bisFullAccount\(/);
    },
  );

  it("keeps the exemption list to files that still read a withheld field", () => {
    for (const file of Object.keys(EXEMPT)) {
      expect(readers, file).toContain(file);
    }
  });
});
