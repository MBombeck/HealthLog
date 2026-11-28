import { describe, expect, it } from "vitest";

import { FIT_UPLOAD_MAX_BYTES } from "@/lib/fit/container";
import {
  FIT_BATCH_FILE_MAX_BYTES,
  fitFileFailureOf,
  fitFileOutcome,
  importFitFile,
  runFitBatch,
  type FitBatchDeps,
  type FitBatchJob,
  type FitFileState,
} from "../fit-batch";

function file(name: string, body = name, size?: number): File {
  const f = new File([body], name);
  if (size !== undefined) Object.defineProperty(f, "size", { value: size });
  return f;
}

function json(status: number, body: unknown, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * The upload route and its worker as the card meets them: one job per
 * upload, the same bytes answered with the earlier job, the worker's result
 * decided by `results` per file name.
 */
function fakeServer(
  results: Record<string, FitBatchJob["result"] | { failed: string }>,
) {
  const byBytes = new Map<string, FitBatchJob>();
  let latest: FitBatchJob | null = null;
  const uploads: string[] = [];
  let pollsUntilDone = 0;
  const deps: FitBatchDeps = {
    async upload(f) {
      uploads.push(f.name);
      const bytes = await f.text();
      const existing = byBytes.get(bytes);
      if (existing && existing.status !== "failed")
        return json(202, {
          data: {
            jobId: existing.jobId,
            status: existing.status,
            idempotent: true,
          },
        });
      const outcome = results[f.name] ?? null;
      const job: FitBatchJob = {
        jobId: `job-${uploads.length}`,
        status: "queued",
        result: null,
        failureReason: null,
      };
      byBytes.set(bytes, job);
      latest = job;
      pollsUntilDone = 1;
      // The worker finishes after one poll.
      queueMicrotask(() => {
        if (outcome && "failed" in outcome) {
          job.status = "failed";
          job.failureReason = outcome.failed;
        } else {
          job.status = "done";
          job.result = outcome;
        }
      });
      return json(202, { data: { jobId: job.jobId, status: "queued" } });
    },
    async status() {
      if (pollsUntilDone > 0) {
        pollsUntilDone--;
        return {
          job: latest && { ...latest, status: "parsing" },
          importRunning: true,
        };
      }
      return { job: latest && { ...latest }, importRunning: false };
    },
    sleep: async () => {},
    cancelled: () => false,
  };
  return { deps, uploads };
}

async function run(files: File[], deps: FitBatchDeps) {
  const seen: FitFileState[][] = files.map(() => []);
  await runFitBatch(files, deps, (i, s) => seen[i]!.push(s));
  return seen.map((states) => states.at(-1)?.status);
}

describe("runFitBatch", () => {
  it("imports the files one after the other and reports each", async () => {
    const { deps, uploads } = fakeServer({
      "a.fit": { imported: 1 },
      "b.fit": { merged: 1 },
      "c.fit": { failed: "crc_mismatch: file checksum" },
    });
    const seen: string[] = [];
    await runFitBatch(
      [file("a.fit"), file("b.fit"), file("c.fit")],
      deps,
      (i, s) => seen.push(`${i}:${s.status}`),
    );
    expect(uploads).toEqual(["a.fit", "b.fit", "c.fit"]);
    // Each file starts only after the one before it has finished.
    expect(seen).toEqual([
      "0:uploading",
      "0:imported",
      "1:uploading",
      "1:imported",
      "2:uploading",
      "2:failed",
    ]);
  });

  it("reports a file chosen again as already imported", async () => {
    const { deps } = fakeServer({ "ride.fit": { imported: 1 } });
    expect(await run([file("ride.fit", "same bytes")], deps)).toEqual([
      "imported",
    ]);
    // The same bytes again, in a later selection and twice in one.
    expect(
      await run(
        [file("ride.fit", "same bytes"), file("copy.fit", "same bytes")],
        deps,
      ),
    ).toEqual(["duplicate", "duplicate"]);
  });

  it("reports the same session in other bytes as already imported", async () => {
    const { deps } = fakeServer({
      "ride.fit": { imported: 1 },
      "ride.zip": { imported: 0, merged: 0, alreadyPresent: 1 },
    });
    expect(
      await run([file("ride.fit", "bare"), file("ride.zip", "zipped")], deps),
    ).toEqual(["imported", "duplicate"]);
  });

  it("waits out the rate limit by its Retry-After and then sends the file", async () => {
    const waits: number[] = [];
    let calls = 0;
    const deps: FitBatchDeps = {
      upload: async () =>
        ++calls === 1
          ? json(429, { error: "slow down" }, { "Retry-After": "12" })
          : json(202, {
              data: { jobId: "j1", status: "done", idempotent: true },
            }),
      status: async () => ({ job: null, importRunning: false }),
      sleep: async (ms) => {
        waits.push(ms);
      },
      cancelled: () => false,
    };
    expect(await importFitFile(file("a.fit"), deps)).toEqual({
      status: "duplicate",
    });
    expect(waits).toEqual([12_000]);
  });

  it("gives up on a file while another import keeps running, sending it once", async () => {
    let uploads = 0;
    const deps: FitBatchDeps = {
      upload: async () => {
        uploads++;
        return json(409, { error: "busy" });
      },
      // Another kind of import (Apple Health, Health Connect): no FIT job.
      status: async () => ({ job: null, importRunning: true }),
      sleep: async () => {},
      cancelled: () => false,
    };
    expect(await importFitFile(file("a.fit"), deps)).toEqual({
      status: "failed",
      reason: "busy",
    });
    expect(uploads).toBe(1);
  });

  it("waits on the status read and sends the file again once the account is free", async () => {
    let uploads = 0;
    let reads = 0;
    const deps: FitBatchDeps = {
      upload: async () =>
        ++uploads === 1
          ? json(409, { error: "busy" })
          : json(202, {
              data: { jobId: "j1", status: "done", idempotent: true },
            }),
      status: async () => ({ job: null, importRunning: ++reads < 3 }),
      sleep: async () => {},
      cancelled: () => false,
    };
    expect(await importFitFile(file("a.fit"), deps)).toEqual({
      status: "duplicate",
    });
    expect(uploads).toBe(2);
    expect(reads).toBe(3);
  });

  it("stops the run at a file that waited out another import; the rest wait", async () => {
    const uploads: string[] = [];
    const deps: FitBatchDeps = {
      upload: async (f) => {
        uploads.push(f.name);
        return json(409, { error: "busy" });
      },
      status: async () => ({ job: null, importRunning: true }),
      sleep: async () => {},
      cancelled: () => false,
    };
    expect(
      await run([file("a.fit"), file("b.fit"), file("c.fit")], deps),
    ).toEqual(["failed", undefined, undefined]);
    expect(uploads).toEqual(["a.fit"]);
  });

  it("refuses a file over the cap without sending it", async () => {
    const { deps, uploads } = fakeServer({});
    expect(
      await importFitFile(
        file("big.fit", "x", FIT_BATCH_FILE_MAX_BYTES + 1),
        deps,
      ),
    ).toEqual({ status: "failed", reason: "tooLarge" });
    expect(uploads).toEqual([]);
  });

  it("stops when the card is gone", async () => {
    const { deps, uploads } = fakeServer({ "a.fit": { imported: 1 } });
    let gone = false;
    const seen: string[] = [];
    await runFitBatch(
      [file("a.fit"), file("b.fit")],
      { ...deps, cancelled: () => gone },
      (i, s) => {
        seen.push(`${i}:${s.status}`);
        if (s.status === "imported") gone = true;
      },
    );
    expect(uploads).toEqual(["a.fit"]);
    expect(seen).toEqual(["0:uploading", "0:imported"]);
  });
});

describe("fitFileOutcome", () => {
  const job = (over: Partial<FitBatchJob>): FitBatchJob => ({
    jobId: "j",
    status: "done",
    result: null,
    failureReason: null,
    ...over,
  });

  it("calls a file imported when it wrote or merged a workout", () => {
    expect(fitFileOutcome(job({ result: { imported: 1 } })).status).toBe(
      "imported",
    );
    expect(fitFileOutcome(job({ result: { merged: 2 } })).status).toBe(
      "imported",
    );
  });

  it("calls a file a duplicate when its sessions were already there", () => {
    expect(
      fitFileOutcome(job({ result: { imported: 0, alreadyPresent: 1 } })),
    ).toEqual({ status: "duplicate" });
  });

  it("names the reason of a failed job", () => {
    expect(
      fitFileOutcome(job({ status: "failed", failureReason: "not_fit: x" })),
    ).toEqual({ status: "failed", reason: "unsupported" });
    expect(fitFileOutcome(job({ result: {} }))).toEqual({
      status: "failed",
      reason: "noWorkout",
    });
  });
});

describe("fitFileFailureOf", () => {
  it("folds the worker codes into the short reasons", () => {
    expect(fitFileFailureOf("too_large: x")).toBe("tooLarge");
    expect(fitFileFailureOf("unsupported_file: x")).toBe("unsupported");
    expect(fitFileFailureOf("archive_invalid: x")).toBe("damaged");
    expect(fitFileFailureOf("malformed: x")).toBe("damaged");
    expect(fitFileFailureOf("too_complex: x")).toBe("damaged");
    expect(fitFileFailureOf("not_activity: x")).toBe("notActivity");
    expect(fitFileFailureOf("no_session: x")).toBe("noWorkout");
    expect(fitFileFailureOf("staging_missing: x")).toBe("retry");
    expect(fitFileFailureOf("interrupted_by_restart")).toBe("retry");
    expect(fitFileFailureOf(null)).toBe("retry");
  });
});

describe("FIT_BATCH_FILE_MAX_BYTES", () => {
  it("is the server's upload cap", () => {
    expect(FIT_BATCH_FILE_MAX_BYTES).toBe(FIT_UPLOAD_MAX_BYTES);
  });
});
