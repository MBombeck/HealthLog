/**
 * The database row on the backups card says where the newest good dump is,
 * how long a deleted account stays in the dumps, and each thing that keeps a
 * dump from being taken or from ever ageing out of the bucket.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { DatabaseBackupHealth } from "@/lib/database-backup/health";
import type { LifecycleVerdict } from "@/lib/jobs/offhost-lifecycle";

import { DatabaseDumpRow } from "../database-dump-row";

const HEALTHY: DatabaseBackupHealth = {
  enabled: true,
  directory: "/var/lib/healthlog/backups",
  keepNightly: 7,
  localDirWritable: true,
  localPersistent: true,
  localReason: "volume",
  offhostConfigured: true,
  lastGood: {
    at: "2026-10-24T23:31:00.000Z",
    fileName: "healthlog-20261024T233000Z-daily.dump",
    sizeBytes: 52_428_800,
    local: true,
    offhost: true,
  },
  lastFailure: null,
  offhost: { lastUploadAt: "2026-10-24T23:31:00.000Z", failure: null },
};

function render(
  health: DatabaseBackupHealth,
  bucketLifecycle: LifecycleVerdict | null = {
    state: "configured",
    expirationDays: 30,
  },
): string {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <DatabaseDumpRow health={health} bucketLifecycle={bucketLifecycle} />
    </I18nProvider>,
  );
}

describe("<DatabaseDumpRow>", () => {
  it("names the newest good dump, where it is, and how long dumps keep deleted accounts", () => {
    const html = render(HEALTHY);
    expect(html).toContain("kept on this server and off-host");
    expect(html).toContain(
      "the newest 7 nightly dumps are kept on this server",
    );
    expect(html).toContain(
      "before the latest update stays until the next update",
    );
    expect(html).toContain("removed after 30 days");
    expect(html).not.toContain('data-slot="database-dump-failed"');
    expect(html).not.toContain('data-slot="database-dump-setup"');
    expect(html).not.toContain('data-slot="database-dump-no-lifecycle"');
  });

  it("says when the newest dump stayed on this server because its upload failed", () => {
    const at = "2026-10-25T23:31:00.000Z";
    const html = render({
      ...HEALTHY,
      lastGood: { ...HEALTHY.lastGood!, at, offhost: false },
      lastFailure: { at, error: "off-host upload failed: AccessDenied" },
      offhost: {
        lastUploadAt: "2026-10-22T23:31:00.000Z",
        failure: { at, error: "off-host upload failed: AccessDenied" },
      },
    });
    expect(html).toContain('data-slot="database-dump-offhost-failed"');
    expect(html).toContain("did not reach the off-host bucket");
    expect(html).toContain("AccessDenied");
    expect(html).toContain("The newest dump in the bucket is from");
    // Said once, as the upload it is, not also as a failed dump.
    expect(html).not.toContain('data-slot="database-dump-failed"');
  });

  it("shows a failure at the instant of the newest dump, such as retention throwing", () => {
    const at = "2026-10-25T23:31:00.000Z";
    const html = render({
      ...HEALTHY,
      lastGood: { ...HEALTHY.lastGood!, at },
      lastFailure: { at, error: "EACCES: permission denied, unlink" },
    });
    expect(html).toContain('data-slot="database-dump-failed"');
    expect(html).not.toContain('data-slot="database-dump-offhost-failed"');
  });

  it("warns when no bucket rule ever removes the dumps", () => {
    const html = render(HEALTHY, { state: "missing", expirationDays: null });
    expect(html).toContain('data-slot="database-dump-no-lifecycle"');
    expect(html).toContain("never removed");
  });

  it("shows a failure newer than the last good dump, and not an older one", () => {
    const failed = render({
      ...HEALTHY,
      lastFailure: {
        at: "2026-10-25T23:31:00.000Z",
        error: "pg_dump exited 1: No space left on device",
      },
    });
    expect(failed).toContain('data-slot="database-dump-failed"');
    expect(failed).toContain("No space left on device");
    const recovered = render({
      ...HEALTHY,
      lastFailure: { at: "2026-10-20T23:31:00.000Z", error: "old" },
    });
    expect(recovered).not.toContain('data-slot="database-dump-failed"');
  });

  it("says when dumps go off-host only, or cannot be taken at all", () => {
    const unwritable = {
      ...HEALTHY,
      localDirWritable: false,
      localPersistent: false,
      localReason: "not_writable" as const,
    };
    expect(render(unwritable, null)).toContain("dumps go off-host only");
    expect(render({ ...unwritable, offhostConfigured: false }, null)).toContain(
      "no database dump can be taken",
    );
    expect(render({ ...HEALTHY, lastGood: null }, null)).toContain(
      "No database dump yet",
    );
  });

  it("does not promise dumps on this server from a directory inside the container", () => {
    const layer = {
      ...HEALTHY,
      localPersistent: false,
      localReason: "container_layer" as const,
      lastGood: { ...HEALTHY.lastGood!, local: false },
    };
    const html = render(layer);
    expect(html).toContain('data-slot="database-dump-setup"');
    expect(html).toContain("lost at the next update");
    expect(html).toContain("Dumps go off-host only");
    expect(html).not.toContain("kept on this server");
    expect(html).toContain("removed after 30 days");
    const nowhere = render({ ...layer, offhostConfigured: false }, null);
    expect(nowhere).toContain("no database dump is kept anywhere");
    expect(nowhere).not.toContain('data-slot="database-dump-retention"');
  });
});
