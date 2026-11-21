/**
 * `ImportJob.exportedAt` — the worker end of the wiring.
 *
 * The parse side is proved behaviourally in
 * `src/lib/measurements/__tests__/import-apple-health-export.test.ts`:
 * the parser hands the archive's own stamp to `onExportDate`. What that
 * cannot show is whether anything persists it. The column, the status
 * endpoint that returns it and the published contract that requires it
 * all existed for a year while the one line that would produce the value
 * was a `return`, so the half of the pipe worth pinning is this one.
 *
 * Source-shaped rather than run-shaped: driving the worker needs a real
 * `export.zip`, a queue and a database, which the ECG contract test
 * beside this one already declines to do for the same reason.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workerSource = readFileSync(
  join(process.cwd(), "src/lib/jobs/apple-health-import-worker.ts"),
  "utf8",
);
const parserSource = readFileSync(
  join(
    process.cwd(),
    "src/lib/measurements/import-apple-health-export-handlers.ts",
  ),
  "utf8",
);
const statusRouteSource = readFileSync(
  join(
    process.cwd(),
    "src/app/api/import/apple-health-export/[jobId]/status/route.ts",
  ),
  "utf8",
);

describe("Apple Health import — the archive's export stamp reaches the column", () => {
  it("subscribes to the parser's export-date hook", () => {
    expect(workerSource).toMatch(/onExportDate:\s*async\s*\(exportedAt\)/);
  });

  it("writes the stamp onto the job row it is running", () => {
    expect(workerSource).toMatch(
      /onExportDate:[\s\S]{0,400}?prisma\s*\.?\s*importJob[\s\S]{0,200}?\.update\([\s\S]{0,200}?exportedAt/,
    );
  });

  it("keeps the write best-effort so provenance cannot fail an import", () => {
    expect(workerSource).toMatch(
      /onExportDate:[\s\S]{0,400}?exportedAt[\s\S]{0,120}?\.catch\(/,
    );
  });

  it("no longer discards the element that carries the stamp", () => {
    // The ignore list is where `ExportDate` spent its first year.
    const ignoreBlock = /Known elements we intentionally ignore/.exec(
      parserSource,
    );
    expect(ignoreBlock).not.toBeNull();
    const before = parserSource.slice(
      Math.max(0, (ignoreBlock?.index ?? 0) - 400),
      ignoreBlock?.index ?? 0,
    );
    expect(before).not.toMatch(/name === "ExportDate" \|\|/);
  });

  it("still surfaces the column the contract promises", () => {
    expect(statusRouteSource).toMatch(/exportedAt:\s*row\.exportedAt/);
  });
});
