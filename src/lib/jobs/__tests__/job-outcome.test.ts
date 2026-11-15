import { describe, expect, it, vi } from "vitest";

import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";

type SerializableJobOutcome = {
  ok: boolean;
  reason_code?: string;
  did?: Readonly<Record<string, string | number | boolean>>;
};

type JobOutcomeSubject = {
  JOB_FACT_ALLOWLIST: ReadonlySet<string>;
  MAX_JOB_FACTS: number;
  MAX_JOB_OUTCOME_BYTES: number;
  serializeJobOutcome(outcome: JobOutcome): SerializableJobOutcome;
};

function loadSubject(): Promise<JobOutcomeSubject> {
  return vi.importActual<JobOutcomeSubject>("@/lib/jobs/job-outcome");
}

const COHORT_FACT_KEYS = [
  "provider",
  "outcome",
  "total",
  "users_synced",
  "users_complete",
  "users_partial",
  "users_failed",
  "users_parked",
  "users_skipped",
  "users_useful",
  "users_clean_zero",
  "users_retryable",
  "downstream_failed",
  "measurements_imported",
] as const;

const FORBIDDEN_FACT_KEYS = [
  "user_id",
  "userId",
  "email",
  "name",
  "access_token",
  "refresh_token",
  "secret",
  "url",
  "raw_error",
  "health_value",
  "blood_glucose",
] as const;

describe("bounded generic JobOutcome serialization", () => {
  it("publishes a fixed allowlist for truthful cohort scalars", async () => {
    const { JOB_FACT_ALLOWLIST } = await loadSubject();
    for (const key of COHORT_FACT_KEYS) {
      expect(JOB_FACT_ALLOWLIST.has(key), key).toBe(true);
    }
    for (const key of FORBIDDEN_FACT_KEYS) {
      expect(JOB_FACT_ALLOWLIST.has(key), key).toBe(false);
    }
  });

  it.each(FORBIDDEN_FACT_KEYS)(
    "rejects the private or unbounded fact key %s",
    async (key) => {
      const { serializeJobOutcome } = await loadSubject();
      expect(() =>
        serializeJobOutcome(
          jobDone({ [key]: "private-value" } as Record<string, string>),
        ),
      ).toThrow(/fact|allow|private|unsupported/i);
    },
  );

  it("rejects nested objects, arrays, nulls, non-finite numbers, and unsafe integers", async () => {
    const { serializeJobOutcome } = await loadSubject();
    for (const unsafe of [
      { nested: true },
      ["user-a"],
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      -1,
    ]) {
      expect(() =>
        serializeJobOutcome(
          jobDone({ total: unsafe } as unknown as Record<string, number>),
        ),
      ).toThrow(/scalar|finite|integer|range|unsupported/i);
    }
  });

  it.each([
    "patient@example.test",
    "https://provider.test/capability",
    "token=secret",
    "raw upstream stack trace",
    "blood glucose 411",
    "x".repeat(65),
  ])("rejects an unbounded or private string fact: %s", async (value) => {
    const { serializeJobOutcome } = await loadSubject();
    expect(() => serializeJobOutcome(jobDone({ provider: value }))).toThrow(
      /code|string|private|length|unsupported/i,
    );
  });

  it("rejects too many facts and enforces a small serialized byte ceiling", async () => {
    const {
      JOB_FACT_ALLOWLIST,
      MAX_JOB_FACTS,
      MAX_JOB_OUTCOME_BYTES,
      serializeJobOutcome,
    } = await loadSubject();
    expect(MAX_JOB_FACTS).toBeGreaterThanOrEqual(COHORT_FACT_KEYS.length);
    expect(MAX_JOB_FACTS).toBeLessThanOrEqual(32);
    expect(MAX_JOB_OUTCOME_BYTES).toBeLessThanOrEqual(2_048);

    const allowed = [...JOB_FACT_ALLOWLIST];
    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_JOB_FACTS + 1 }, (_, index) => [
        allowed[index] ?? `overflow_${index}`,
        index,
      ]),
    );
    expect(() => serializeJobOutcome(jobDone(tooMany))).toThrow(
      /fact|count|limit|allow/i,
    );
  });

  it("distinguishes useful work from a successful clean zero", async () => {
    const { serializeJobOutcome } = await loadSubject();
    const useful = serializeJobOutcome(
      jobDone({ outcome: "useful", total: 1, measurements_imported: 4 }),
    );
    const cleanZero = serializeJobOutcome(
      jobDone({ outcome: "clean_zero", total: 1, measurements_imported: 0 }),
    );

    expect(useful.did?.outcome).toBe("useful");
    expect(cleanZero.did?.outcome).toBe("clean_zero");
    expect(useful).not.toEqual(cleanZero);
  });

  it("emits only stable failure codes and never serializes raw causes", async () => {
    const { serializeJobOutcome } = await loadSubject();
    const privateText =
      "patient@example.test https://provider.test?token=secret glucose=411";
    const serialized = serializeJobOutcome(
      jobFailed("provider_cohort_failed", new Error(privateText), {
        outcome: "clean_zero",
        total: 0,
      }),
    );

    expect(serialized).toEqual({
      ok: false,
      reason_code: "provider_cohort_failed",
      did: { outcome: "clean_zero", total: 0 },
    });
    expect(JSON.stringify(serialized)).not.toContain(privateText);
    expect(serialized).not.toHaveProperty("cause");
  });

  it.each([
    "raw upstream error",
    "https://provider.test/failure",
    "failed_for_user_patient@example.test",
    "token=secret",
    "x".repeat(65),
  ])("rejects an unstable or private failure reason: %s", async (reason) => {
    const { serializeJobOutcome } = await loadSubject();
    expect(() => serializeJobOutcome(jobFailed(reason))).toThrow(
      /reason|code|private|length/i,
    );
  });

  it("keeps a retryable queue failure failed so runJob will retry it", async () => {
    const { serializeJobOutcome } = await loadSubject();
    const serialized = serializeJobOutcome(
      jobFailed("provider_cohort_retry", new Error("socket reset"), {
        outcome: "clean_zero",
        users_retryable: 1,
      }),
    );

    expect(serialized.ok).toBe(false);
    expect(serialized.reason_code).toBe("provider_cohort_retry");
    expect(serialized.did).toEqual({
      outcome: "clean_zero",
      users_retryable: 1,
    });
  });
});

// #1384 — a generator reason and a provider type become facts the admin page
// and the repeated-failure alert can show.
describe("codeFact", () => {
  it("turns our own hyphenated codes into stable fact codes", async () => {
    const { codeFact, serializeJobOutcome } = await vi.importActual<
      typeof import("@/lib/jobs/job-outcome")
    >("@/lib/jobs/job-outcome");
    expect(codeFact("all-providers-failed")).toBe("all_providers_failed");
    expect(codeFact("openai-compatible")).toBe("openai_compatible");
    expect(codeFact("generator:invalid-json")).toBe("generator_invalid_json");
    expect(codeFact("timeout")).toBe("timeout");
    // Nothing usable: the caller leaves the fact out.
    expect(codeFact("")).toBeNull();
    expect(codeFact("---")).toBeNull();
    expect(codeFact(null)).toBeNull();
    // What it produces is a fact the serializer accepts.
    expect(
      serializeJobOutcome(
        jobDone({
          failure_cause: codeFact("all-providers-failed")!,
          failure_provider: codeFact("admin-openai")!,
        }),
      ),
    ).toEqual({
      ok: true,
      did: {
        failure_cause: "all_providers_failed",
        failure_provider: "admin_openai",
      },
    });
  });
});
