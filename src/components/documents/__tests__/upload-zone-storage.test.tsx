import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/context";
import type { DocumentUsageDto } from "@/lib/validations/inbound-documents";
import { UploadZone } from "../upload-zone";

/**
 * #1403 — the storage a record uses was only visible from 80 % of its quota
 * on, so on most instances there was no number anywhere and "counts against
 * this record" could not be checked. The use is now always one quiet meta
 * line; the warning block with its bar stays reserved for a nearly full
 * quota.
 */
const MB = 1024 * 1024;

function usage(usedBytes: number, quotaBytes: number): DocumentUsageDto {
  return {
    usedBytes,
    quotaBytes,
    maxFileBytes: 25 * MB,
    acceptedExtensions: [".pdf"],
    linkedEpisodes: [],
    linkedProcedures: [],
    assistAvailable: false,
    contentIndex: { enabled: false, indexedCount: 0, totalCount: 0 },
    deletedCount: 0,
  } as unknown as DocumentUsageDto;
}

function render(u: DocumentUsageDto | undefined) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <UploadZone usage={u} onFiles={() => {}} inputRef={createRef()} />
    </I18nProvider>,
  );
}

describe("UploadZone — storage use", () => {
  it("shows the use as a quiet meta line well below the quota", () => {
    const html = render(usage(12 * MB, 1024 * MB));
    expect(html).toContain('data-slot="document-storage-used"');
    expect(html).toContain("text-muted-foreground text-xs");
    expect(html).toMatch(/Storage: 12(\.0)? MB of 1(\.0)? GB used/);
    expect(html).not.toContain('data-slot="document-quota-bar"');
  });

  it("shows the use even when nothing is stored yet", () => {
    const html = render(usage(0, 1024 * MB));
    expect(html).toContain('data-slot="document-storage-used"');
  });

  it("switches to the warning block near the quota", () => {
    const html = render(usage(900 * MB, 1024 * MB));
    expect(html).toContain('data-slot="document-quota-bar"');
    expect(html).toContain("Storage almost full");
    expect(html).not.toContain('data-slot="document-storage-used"');
  });

  it("renders no figure while the usage is still loading", () => {
    const html = render(undefined);
    expect(html).not.toContain('data-slot="document-storage-used"');
    expect(html).not.toContain('data-slot="document-quota-bar"');
  });
});
