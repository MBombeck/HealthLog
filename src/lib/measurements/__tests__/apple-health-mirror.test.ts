/**
 * The Apple Health write-back rule (#1272), over every source the enum has.
 *
 * WITHINGS, IMPORT and MANUAL are true whatever the row's token says, the
 * app's own rule as it stood; EXTERNAL follows its token; everything else is
 * false. The Prisma filter the list's `appleHealthMirror=true` uses is the
 * same rule written as a `where`, checked here against the resolver for each
 * source and token state (the database agrees in
 * `tests/integration/apple-health-mirror.test.ts`).
 */
import { describe, expect, it } from "vitest";

import { MEASUREMENT_SOURCES } from "@/lib/measurements/sources";
import {
  APPLE_HEALTH_MIRROR_WHERE,
  resolveAppleHealthMirror,
  withAppleHealthMirror,
} from "../apple-health-mirror";

const TOKEN_STATES = [
  undefined,
  null,
  { mirrorToAppleHealth: false },
  { mirrorToAppleHealth: true },
] as const;

/** The filter's two arms, evaluated against one row. */
function matchesWhere(row: {
  source: string;
  ingestToken?: { mirrorToAppleHealth: boolean } | null;
}): boolean {
  const [always, external] = APPLE_HEALTH_MIRROR_WHERE.OR;
  return (
    (always.source.in as readonly string[]).includes(row.source) ||
    (row.source === external.source &&
      row.ingestToken?.mirrorToAppleHealth ===
        external.ingestToken.mirrorToAppleHealth)
  );
}

describe("resolveAppleHealthMirror", () => {
  it("is true for WITHINGS, IMPORT and MANUAL and an opted-in EXTERNAL", () => {
    const truthy = MEASUREMENT_SOURCES.flatMap((source) =>
      TOKEN_STATES.filter((ingestToken) =>
        resolveAppleHealthMirror({ source, ingestToken }),
      ).map((ingestToken) => `${source}:${JSON.stringify(ingestToken)}`),
    );
    expect(truthy.sort()).toEqual(
      [
        ...["IMPORT", "MANUAL", "WITHINGS"].flatMap((source) =>
          TOKEN_STATES.map((s) => `${source}:${JSON.stringify(s)}`),
        ),
        'EXTERNAL:{"mirrorToAppleHealth":true}',
      ].sort(),
    );
  });

  it("agrees with the list filter for every source and token state", () => {
    for (const source of MEASUREMENT_SOURCES) {
      for (const ingestToken of TOKEN_STATES) {
        expect(
          matchesWhere({ source, ingestToken }),
          `${source} ${JSON.stringify(ingestToken)}`,
        ).toBe(resolveAppleHealthMirror({ source, ingestToken }));
      }
    }
  });
});

describe("withAppleHealthMirror", () => {
  it("adds the decision and drops the token and its id", () => {
    const row = withAppleHealthMirror({
      id: "m1",
      source: "EXTERNAL",
      ingestTokenId: "tok-1",
      ingestToken: { mirrorToAppleHealth: true },
    });
    expect(row).toEqual({
      id: "m1",
      source: "EXTERNAL",
      appleHealthMirror: true,
    });
  });
});
