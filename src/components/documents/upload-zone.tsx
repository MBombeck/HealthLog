"use client";

/**
 * The vault's upload plumbing: the hidden file input the page header's
 * Upload button opens, plus the record's storage use. The use is always
 * shown as one quiet meta line, so "counts against this record" is a number
 * a person can read (#1403); from 80 % of the quota on it becomes the
 * warning block with a bar. There is no standing drop-target card — it took a full band of
 * vertical space on every visit for an affordance the header button and
 * the page-wide drag-and-drop overlay already cover. Dropping a file
 * anywhere on the page is caught by that overlay; the header button opens
 * this input.
 *
 * The `accept` list comes verbatim from the usage endpoint (HEIC is
 * deliberately absent so the iOS picker transcodes camera photos to JPEG),
 * `multiple` is on, and there is NO `capture` attribute — mobile Safari
 * then offers camera AND library.
 */
import { type RefObject } from "react";

import { Progress } from "@/components/ui/progress";
import { useTranslations } from "@/lib/i18n/context";
import type { DocumentUsageDto } from "@/lib/validations/inbound-documents";
import { formatBytes } from "@/lib/format/bytes";
import { FileInput } from "@/components/ui/file-picker";

/** Usage fraction above which the quota bar appears. */
const QUOTA_BAR_THRESHOLD = 0.8;

export function UploadZone({
  usage,
  onFiles,
  inputRef,
}: {
  /** Limits + usage from `GET /api/documents/inbound/usage` (undefined while loading). */
  usage: DocumentUsageDto | undefined;
  onFiles: (files: File[]) => void;
  /** Exposed so the page header's Upload button can open the same picker. */
  inputRef: RefObject<HTMLInputElement | null>;
}) {
  const { t, locale } = useTranslations();

  const accept = usage?.acceptedExtensions.join(",");
  const usedFraction =
    usage && usage.quotaBytes > 0 ? usage.usedBytes / usage.quotaBytes : 0;

  const pickFiles = (list: FileList | null) => {
    if (!list || list.length === 0) return;
    onFiles(Array.from(list));
  };

  return (
    <div data-slot="document-upload-zone">
      <FileInput
        ref={inputRef}
        multiple
        accept={accept}
        className="sr-only"
        aria-label={t("documents.upload.browse")}
        onChange={(e) => {
          pickFiles(e.target.files);
          // Allow re-selecting the same file (duplicate flow) immediately.
          e.target.value = "";
        }}
      />

      {usage && usedFraction >= QUOTA_BAR_THRESHOLD ? (
        <div data-slot="document-quota-bar" className="space-y-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">
              {t("documents.upload.quotaAlmostFull")}
            </p>
            <p className="text-muted-foreground text-xs tabular-nums">
              {t("documents.upload.quotaUsed", {
                used: formatBytes(usage.usedBytes, locale),
                quota: formatBytes(usage.quotaBytes, locale),
              })}
            </p>
          </div>
          <Progress
            value={Math.min(100, usedFraction * 100)}
            aria-label={t("documents.upload.quotaUsed", {
              used: formatBytes(usage.usedBytes, locale),
              quota: formatBytes(usage.quotaBytes, locale),
            })}
          />
        </div>
      ) : usage ? (
        <p
          data-slot="document-storage-used"
          className="text-muted-foreground text-xs tabular-nums"
        >
          {t("documents.upload.storageUsed", {
            used: formatBytes(usage.usedBytes, locale),
            quota: formatBytes(usage.quotaBytes, locale),
          })}
        </p>
      ) : null}
    </div>
  );
}
