/**
 * What the backups console shows while a restore runs and after it ends.
 *
 * The restore runs as a background job; this is the only place an operator
 * learns how it is going. Pinned here:
 *   1. a running restore names its phase with the counts and draws a bar
 *      only where the share is known, and says the account still shows its
 *      current data;
 *   2. a failed restore says what went wrong and that nothing changed, except
 *      for the one failure after the commit, where saying so would be false;
 *   3. a succeeded restore reports through the outcome module, so an empty
 *      file restored to an empty account is not drawn as a tick;
 *   4. the panels shown are every active job and the newest finished one not
 *      dismissed;
 *   5. the copy resolves in more than one locale.
 *
 * Mutation check: always print the "nothing was changed" line and case 2's
 * after-commit test goes red; render the bar in every phase and case 1's
 * clearing test goes red.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import {
  RestoreJobStatus,
  visibleRestoreJobs,
} from "@/components/admin/backup-restore-status";
import type { BackupRestoreJobView } from "@/lib/jobs/backup-restore";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/admin/backups",
}));

function job(overrides: Partial<BackupRestoreJobView>): BackupRestoreJobView {
  return {
    id: "job-1",
    userId: "user-1",
    username: "alex",
    backupId: "backup-1",
    restoreInstanceSettings: false,
    status: "running",
    phase: "measurements",
    progress: {
      measurementsChecked: 1_250_000,
      measurementsTotal: 1_250_000,
      measurementsWritten: 400_000,
      sectionsDone: 0,
      sectionsTotal: 17,
    },
    result: null,
    failure: null,
    attempts: 1,
    createdAt: "2026-09-25T08:00:00.000Z",
    startedAt: "2026-09-25T08:00:01.000Z",
    completedAt: null,
    ...overrides,
  };
}

function render(view: BackupRestoreJobView, locale: "en" | "de" = "en") {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <RestoreJobStatus job={view} onDismiss={() => {}} />
    </I18nProvider>,
  );
}

describe("RestoreJobStatus while it runs", () => {
  it("names the phase with its counts and draws the share done", () => {
    const html = render(job({}));
    expect(html).toContain("Restoring alex");
    expect(html).toContain("Writing readings: 400,000 of 1,250,000");
    expect(html).toContain('data-slot="restore-job-progress"');
    expect(html).toContain("keeps showing its current data");
  });

  it("draws no bar where the share is not known", () => {
    const html = render(job({ phase: "clearing" }));
    expect(html).toContain("Clearing the account");
    expect(html).not.toContain('data-slot="restore-job-progress"');
  });

  it("says a queued restore is waiting", () => {
    const html = render(job({ status: "queued", phase: null, progress: null }));
    expect(html).toContain("waiting to start");
  });

  it("says when it was started again after a restart", () => {
    expect(render(job({ attempts: 2 }))).toContain("Started again");
  });
});

describe("RestoreJobStatus once it failed", () => {
  it("says why, and that nothing changed", () => {
    const html = render(
      job({
        status: "failed",
        phase: null,
        failure: { code: "interrupted", message: "server text" },
      }),
    );
    expect(html).toContain("did not complete");
    expect(html).toContain("server restarted");
    expect(html).toContain("Nothing was changed");
    expect(html).toContain('data-failure-code="interrupted"');
  });

  it("does not claim nothing changed when the data was restored", () => {
    const html = render(
      job({
        status: "failed",
        phase: null,
        failure: { code: "failed_after_commit", message: "server text" },
      }),
    );
    expect(html).toContain("The data was restored");
    expect(html).not.toContain("Nothing was changed");
  });
});

describe("RestoreJobStatus once it succeeded", () => {
  const result = {
    summary: { measurements: 1_250_000, medications: 3 },
    skipped: { links: 0, catalogueKeys: [] },
    cleared: { measurements: 10 },
  };

  it("reports the count through the outcome module", () => {
    const html = render(
      job({
        status: "succeeded",
        phase: null,
        result,
        completedAt: "2026-09-25T08:02:00.000Z",
      }),
    );
    expect(html).toContain("Restore of alex finished");
    expect(html).toContain("1,250,003 records restored");
    expect(html).toContain('data-outcome="success"');
  });

  it("does not draw a tick for a file that restored nothing", () => {
    const html = render(
      job({
        status: "succeeded",
        phase: null,
        result: { ...result, summary: {} },
      }),
    );
    expect(html).toContain('data-outcome="empty"');
  });
});

describe("visibleRestoreJobs", () => {
  it("shows every active job and the newest finished one not dismissed", () => {
    const jobs = [
      job({ id: "running", status: "running" }),
      job({ id: "newest-done", status: "succeeded" }),
      job({ id: "older-done", status: "failed" }),
    ];
    expect(visibleRestoreJobs(jobs, new Set()).map((j) => j.id)).toEqual([
      "running",
      "newest-done",
    ]);
    expect(
      visibleRestoreJobs(jobs, new Set(["newest-done"])).map((j) => j.id),
    ).toEqual(["running", "older-done"]);
  });
});

describe("RestoreJobStatus in another language", () => {
  it("speaks German", () => {
    const html = render(job({}), "de");
    expect(html).toContain("alex wird wiederhergestellt");
    expect(html).toContain("Messwerte werden geschrieben");
  });
});
