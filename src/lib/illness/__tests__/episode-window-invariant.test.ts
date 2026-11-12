/**
 * v1.18.1 — the `resolvedAt >= onsetAt` window invariant on the illness
 * episode schemas. An episode can never resolve before it began; the schema
 * `superRefine` rejects an inverted window when both instants are supplied
 * (a partial edit touching only one is checked against the stored row in the
 * route). Instants are compared as parsed timestamps, supporting mixed Z/offset
 * forms and fractional seconds while preserving strict future-time bounds.
 */
import { describe, expect, it } from "vitest";
import {
  illnessEpisodeCreateSchema,
  illnessEpisodeUpdateSchema,
  refineEpisodeWindow,
} from "@/lib/validations/illness";
import { ENTRY_INSTANT_CLOCK_SKEW_MS } from "@/lib/validations/entry-instant";

const ONSET = "2026-01-10T08:00:00Z";
const BEFORE = "2026-01-08T08:00:00Z";
const AFTER = "2026-01-15T08:00:00Z";

describe("illnessEpisodeCreateSchema — window invariant", () => {
  it("rejects resolvedAt earlier than onsetAt", () => {
    const out = illnessEpisodeCreateSchema.safeParse({
      label: "Cold",
      type: "INFECTION",
      onsetAt: ONSET,
      resolvedAt: BEFORE,
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(out.error.issues.some((i) => i.path.includes("resolvedAt"))).toBe(
        true,
      );
    }
  });

  it("accepts resolvedAt on/after onsetAt", () => {
    const out = illnessEpisodeCreateSchema.safeParse({
      label: "Cold",
      type: "INFECTION",
      onsetAt: ONSET,
      resolvedAt: AFTER,
    });
    expect(out.success).toBe(true);
  });

  it("accepts a create with only onsetAt (no resolvedAt)", () => {
    const out = illnessEpisodeCreateSchema.safeParse({
      label: "Cold",
      type: "INFECTION",
      onsetAt: ONSET,
    });
    expect(out.success).toBe(true);
  });
});

describe("illnessEpisodeUpdateSchema — window invariant", () => {
  it("rejects a both-in-body inverted window", () => {
    const out = illnessEpisodeUpdateSchema.safeParse({
      onsetAt: ONSET,
      resolvedAt: BEFORE,
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(out.error.issues.some((i) => i.path.includes("resolvedAt"))).toBe(
        true,
      );
    }
  });

  it("accepts a partial edit touching only resolvedAt (route merges vs stored)", () => {
    const out = illnessEpisodeUpdateSchema.safeParse({ resolvedAt: AFTER });
    expect(out.success).toBe(true);
  });

  it("accepts a partial edit touching only onsetAt (route merges vs stored)", () => {
    const out = illnessEpisodeUpdateSchema.safeParse({ onsetAt: ONSET });
    expect(out.success).toBe(true);
  });

  it("accepts an update with both onsetAt and resolvedAt in valid order", () => {
    const out = illnessEpisodeUpdateSchema.safeParse({
      onsetAt: ONSET,
      resolvedAt: AFTER,
    });
    expect(out.success).toBe(true);
  });
});

describe("parsed instant comparison — mixed Z/offset forms and fractional seconds", () => {
  // 19:00:00+09:00 is 10:00:00Z; 11:00:00Z is after onset.
  // Lexically "11:00:00Z" < "19:00:00+09:00" would falsely fail.
  const onsetJst = "2026-01-10T19:00:00+09:00"; // 10:00 UTC
  const resolvedUtc = "2026-01-10T11:00:00Z"; // 11:00 UTC

  it("accepts mixed Z/offset where resolvedAt is chronologically after onsetAt (create)", () => {
    const out = illnessEpisodeCreateSchema.safeParse({
      label: "Cold",
      type: "INFECTION",
      onsetAt: onsetJst,
      resolvedAt: resolvedUtc,
    });
    expect(out.success).toBe(true);
  });

  it("accepts mixed Z/offset where resolvedAt is chronologically after onsetAt (update)", () => {
    const out = illnessEpisodeUpdateSchema.safeParse({
      onsetAt: onsetJst,
      resolvedAt: resolvedUtc,
    });
    expect(out.success).toBe(true);
  });

  it("rejects reversed mixed Z/offset where resolvedAt is chronologically before onsetAt (create)", () => {
    // onset at 11:00 UTC, resolved at 10:00 UTC (19:00+09:00).
    // Lexically "19:00:00+09:00" > "11:00:00Z" would falsely pass.
    const out = illnessEpisodeCreateSchema.safeParse({
      label: "Cold",
      type: "INFECTION",
      onsetAt: resolvedUtc,
      resolvedAt: onsetJst,
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(
        out.error.issues.some((i) =>
          i.message.includes("resolvedAt must be on or after onsetAt"),
        ),
      ).toBe(true);
    }
  });

  it("rejects reversed mixed Z/offset where resolvedAt is chronologically before onsetAt (update)", () => {
    const out = illnessEpisodeUpdateSchema.safeParse({
      onsetAt: resolvedUtc,
      resolvedAt: onsetJst,
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(
        out.error.issues.some((i) =>
          i.message.includes("resolvedAt must be on or after onsetAt"),
        ),
      ).toBe(true);
    }
  });

  // Negative offset vs Z:
  // 10:00:00-05:00 is 15:00:00Z; 14:00:00Z is 14:00 UTC.
  const onsetEst = "2026-01-10T10:00:00-05:00"; // 15:00 UTC
  const resolvedLaterUtc = "2026-01-10T16:00:00Z"; // 16:00 UTC
  const resolvedEarlierUtc = "2026-01-10T14:00:00Z"; // 14:00 UTC

  it("accepts negative offset when chronologically ordered (create & update)", () => {
    const createOut = illnessEpisodeCreateSchema.safeParse({
      label: "Sprain",
      type: "INJURY",
      onsetAt: onsetEst,
      resolvedAt: resolvedLaterUtc,
    });
    expect(createOut.success).toBe(true);

    const updateOut = illnessEpisodeUpdateSchema.safeParse({
      onsetAt: onsetEst,
      resolvedAt: resolvedLaterUtc,
    });
    expect(updateOut.success).toBe(true);
  });

  it("rejects negative offset when reversed (onset 15:00 UTC, resolved 14:00 UTC) (create & update)", () => {
    const createOut = illnessEpisodeCreateSchema.safeParse({
      label: "Sprain",
      type: "INJURY",
      onsetAt: onsetEst,
      resolvedAt: resolvedEarlierUtc,
    });
    expect(createOut.success).toBe(false);
    if (!createOut.success) {
      expect(
        createOut.error.issues.some((i) =>
          i.message.includes("resolvedAt must be on or after onsetAt"),
        ),
      ).toBe(true);
    }

    const updateOut = illnessEpisodeUpdateSchema.safeParse({
      onsetAt: onsetEst,
      resolvedAt: resolvedEarlierUtc,
    });
    expect(updateOut.success).toBe(false);
    if (!updateOut.success) {
      expect(
        updateOut.error.issues.some((i) =>
          i.message.includes("resolvedAt must be on or after onsetAt"),
        ),
      ).toBe(true);
    }
  });

  // Fractional seconds
  const onsetMs = "2026-01-10T12:00:00.100Z";
  const resolvedMs = "2026-01-10T12:00:00.500Z";

  it("accepts correctly ordered fractional seconds (create & update)", () => {
    const createOut = illnessEpisodeCreateSchema.safeParse({
      label: "Migraine",
      type: "OTHER",
      onsetAt: onsetMs,
      resolvedAt: resolvedMs,
    });
    expect(createOut.success).toBe(true);

    const updateOut = illnessEpisodeUpdateSchema.safeParse({
      onsetAt: onsetMs,
      resolvedAt: resolvedMs,
    });
    expect(updateOut.success).toBe(true);
  });

  it("rejects reversed fractional seconds (create & update)", () => {
    const createOut = illnessEpisodeCreateSchema.safeParse({
      label: "Migraine",
      type: "OTHER",
      onsetAt: resolvedMs,
      resolvedAt: onsetMs,
    });
    expect(createOut.success).toBe(false);
    if (!createOut.success) {
      expect(
        createOut.error.issues.some((i) =>
          i.message.includes("resolvedAt must be on or after onsetAt"),
        ),
      ).toBe(true);
    }

    const updateOut = illnessEpisodeUpdateSchema.safeParse({
      onsetAt: resolvedMs,
      resolvedAt: onsetMs,
    });
    expect(updateOut.success).toBe(false);
    if (!updateOut.success) {
      expect(
        updateOut.error.issues.some((i) =>
          i.message.includes("resolvedAt must be on or after onsetAt"),
        ),
      ).toBe(true);
    }
  });

  // Whole seconds vs fractional seconds
  it("accepts whole-second onset followed by fractional-second resolved instant (create & update)", () => {
    const createOut = illnessEpisodeCreateSchema.safeParse({
      label: "Cold",
      type: "INFECTION",
      onsetAt: "2026-01-10T12:00:00Z",
      resolvedAt: "2026-01-10T12:00:00.050Z",
    });
    expect(createOut.success).toBe(true);

    const updateOut = illnessEpisodeUpdateSchema.safeParse({
      onsetAt: "2026-01-10T12:00:00Z",
      resolvedAt: "2026-01-10T12:00:00.050Z",
    });
    expect(updateOut.success).toBe(true);
  });

  it("rejects fractional-second onset followed by earlier whole-second resolved instant (create & update)", () => {
    const createOut = illnessEpisodeCreateSchema.safeParse({
      label: "Cold",
      type: "INFECTION",
      onsetAt: "2026-01-10T12:00:00.050Z",
      resolvedAt: "2026-01-10T12:00:00Z",
    });
    expect(createOut.success).toBe(false);

    const updateOut = illnessEpisodeUpdateSchema.safeParse({
      onsetAt: "2026-01-10T12:00:00.050Z",
      resolvedAt: "2026-01-10T12:00:00Z",
    });
    expect(updateOut.success).toBe(false);
  });

  // Mixed offset and fractional seconds
  it("accepts mixed offset + fractional seconds when chronologically valid (create & update)", () => {
    // 21:00:00.100+09:00 is 12:00:00.100Z; resolved is 12:00:00.250Z
    const createOut = illnessEpisodeCreateSchema.safeParse({
      label: "Fever",
      type: "INFECTION",
      onsetAt: "2026-01-10T21:00:00.100+09:00",
      resolvedAt: "2026-01-10T12:00:00.250Z",
    });
    expect(createOut.success).toBe(true);

    const updateOut = illnessEpisodeUpdateSchema.safeParse({
      onsetAt: "2026-01-10T21:00:00.100+09:00",
      resolvedAt: "2026-01-10T12:00:00.250Z",
    });
    expect(updateOut.success).toBe(true);
  });

  it("rejects mixed offset + fractional seconds when reversed (create & update)", () => {
    // onset is 12:00:00.250Z; resolved is 21:00:00.100+09:00 (12:00:00.100Z)
    const createOut = illnessEpisodeCreateSchema.safeParse({
      label: "Fever",
      type: "INFECTION",
      onsetAt: "2026-01-10T12:00:00.250Z",
      resolvedAt: "2026-01-10T21:00:00.100+09:00",
    });
    expect(createOut.success).toBe(false);
    if (!createOut.success) {
      expect(
        createOut.error.issues.some((i) =>
          i.message.includes("resolvedAt must be on or after onsetAt"),
        ),
      ).toBe(true);
    }

    const updateOut = illnessEpisodeUpdateSchema.safeParse({
      onsetAt: "2026-01-10T12:00:00.250Z",
      resolvedAt: "2026-01-10T21:00:00.100+09:00",
    });
    expect(updateOut.success).toBe(false);
    if (!updateOut.success) {
      expect(
        updateOut.error.issues.some((i) =>
          i.message.includes("resolvedAt must be on or after onsetAt"),
        ),
      ).toBe(true);
    }
  });

  it("compares fractional seconds beyond Date's millisecond precision (create & update)", () => {
    const onsetAt = "2026-01-10T12:00:00.0009Z";
    const createOut = illnessEpisodeCreateSchema.safeParse({
      label: "Migraine",
      type: "OTHER",
      onsetAt,
      resolvedAt: "2026-01-10T12:00:00.0001Z",
    });
    expect(createOut.success).toBe(false);

    const updateOut = illnessEpisodeUpdateSchema.safeParse({
      onsetAt,
      resolvedAt: "2026-01-10T12:00:00.0001Z",
    });
    expect(updateOut.success).toBe(false);

    const offsetWindow = {
      onsetAt: "2026-01-10T21:00:00.000900+09:00",
      resolvedAt: "2026-01-10T12:00:00.00090Z",
    };
    expect(
      illnessEpisodeCreateSchema.safeParse({
        label: "Migraine",
        type: "OTHER",
        ...offsetWindow,
      }).success,
    ).toBe(true);
    expect(illnessEpisodeUpdateSchema.safeParse(offsetWindow).success).toBe(
      true,
    );
  });

  // Equal instant across different representations
  it("accepts equal instants across different offset representations (create & update)", () => {
    const createOut = illnessEpisodeCreateSchema.safeParse({
      label: "Rash",
      type: "ALLERGY",
      onsetAt: "2026-01-10T21:00:00+09:00",
      resolvedAt: "2026-01-10T12:00:00.000Z",
    });
    expect(createOut.success).toBe(true);

    const updateOut = illnessEpisodeUpdateSchema.safeParse({
      onsetAt: "2026-01-10T21:00:00+09:00",
      resolvedAt: "2026-01-10T12:00:00.000Z",
    });
    expect(updateOut.success).toBe(true);
  });
});

describe("strict future-time bound preservation", () => {
  it("rejects future onsetAt beyond clock skew (create)", () => {
    const futureDate = new Date(
      Date.now() + ENTRY_INSTANT_CLOCK_SKEW_MS + 60_000,
    ).toISOString();
    const out = illnessEpisodeCreateSchema.safeParse({
      label: "Future Condition",
      type: "INFECTION",
      onsetAt: futureDate,
    });
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(
        out.error.issues.some((i) =>
          i.message.includes("must be a plausible instant"),
        ),
      ).toBe(true);
    }
  });

  it("rejects future resolvedAt beyond clock skew (create & update)", () => {
    const futureDate = new Date(
      Date.now() + ENTRY_INSTANT_CLOCK_SKEW_MS + 60_000,
    ).toISOString();
    const createOut = illnessEpisodeCreateSchema.safeParse({
      label: "Future Resolve",
      type: "INFECTION",
      onsetAt: ONSET,
      resolvedAt: futureDate,
    });
    expect(createOut.success).toBe(false);

    const updateOut = illnessEpisodeUpdateSchema.safeParse({
      resolvedAt: futureDate,
    });
    expect(updateOut.success).toBe(false);
  });
});

type RefinementIssue = Parameters<
  Parameters<typeof refineEpisodeWindow>[1]["addIssue"]
>[0];

describe("refineEpisodeWindow shared helper", () => {
  it("adds issue when resolvedAt is earlier than onsetAt", () => {
    const issues: RefinementIssue[] = [];
    const ctx: Parameters<typeof refineEpisodeWindow>[1] = {
      value: { onsetAt: ONSET, resolvedAt: BEFORE },
      issues: [],
      addIssue: (issue) => {
        issues.push(issue);
      },
    };

    refineEpisodeWindow({ onsetAt: ONSET, resolvedAt: BEFORE }, ctx);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toEqual(
      expect.objectContaining({
        code: "custom",
        path: ["resolvedAt"],
        message: "resolvedAt must be on or after onsetAt",
      }),
    );
  });

  it("does not add issue when resolvedAt is on or after onsetAt", () => {
    const issues: RefinementIssue[] = [];
    const ctx: Parameters<typeof refineEpisodeWindow>[1] = {
      value: { onsetAt: ONSET, resolvedAt: AFTER },
      issues: [],
      addIssue: (issue) => {
        issues.push(issue);
      },
    };

    refineEpisodeWindow({ onsetAt: ONSET, resolvedAt: AFTER }, ctx);
    expect(issues).toHaveLength(0);
  });

  it("does not add issue when either instant is omitted", () => {
    const issues: RefinementIssue[] = [];
    const ctx: Parameters<typeof refineEpisodeWindow>[1] = {
      value: {},
      issues: [],
      addIssue: (issue) => {
        issues.push(issue);
      },
    };

    refineEpisodeWindow({ onsetAt: ONSET }, ctx);
    refineEpisodeWindow({ resolvedAt: AFTER }, ctx);
    refineEpisodeWindow({}, ctx);
    expect(issues).toHaveLength(0);
  });
});
