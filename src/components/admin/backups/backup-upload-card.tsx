import { Loader2, Upload } from "lucide-react";
import type { ChangeEvent, RefObject } from "react";

import {
  ReproofCancelledError,
  type useRecentProof,
} from "@/components/settings/security-section/use-recent-proof";
import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";

import { BackupTargetDialog } from "./backup-target-dialog";
import { useBackupUpload } from "./use-backup-upload";

/**
 * The upload card, and for a file whose account is not on this server, the
 * dialog that sends it again into an account the admin picks. The dialog is
 * mounted per refused file, so every file starts from a clean form.
 */
export function BackupUpload({
  recentProof,
}: {
  recentProof: ReturnType<typeof useRecentProof>;
}) {
  const {
    upload,
    fileInputRef,
    handleFileChange,
    orphan,
    uploadInto,
    closeOrphan,
  } = useBackupUpload(recentProof);
  return (
    <>
      <BackupUploadCard
        pending={upload.isPending || uploadInto.isPending}
        fileInputRef={fileInputRef}
        onFileChange={handleFileChange}
      />
      {orphan ? (
        <BackupTargetDialog
          file={orphan}
          pending={uploadInto.isPending}
          error={
            uploadInto.error instanceof ReproofCancelledError
              ? null
              : uploadInto.error
          }
          onSubmit={(target) => uploadInto.mutate(target)}
          onClose={closeOrphan}
        />
      ) : null}
    </>
  );
}

/**
 * The upload card: separate from the table so admins can ingest a backup file
 * independently of any existing rows. The visible button proxies a hidden
 * file input so the layout stays clean while keyboard and screen-reader users
 * keep a labelled control.
 */
export function BackupUploadCard({
  pending,
  fileInputRef,
  onFileChange,
}: {
  pending: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  const { t } = useTranslations();
  return (
    <div className="bg-muted/30 border-border flex flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <div className="text-sm font-medium">
          {t("admin.section.backups.uploadTitle")}
        </div>
        <p className="text-muted-foreground text-xs">
          {t("admin.section.backups.uploadDescription")}{" "}
          <span
            data-slot="backup-upload-help"
            className="text-muted-foreground"
          >
            {t("admin.section.backups.uploadHelp")}
          </span>
        </p>
      </div>
      <div>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json,application/gzip,.gz"
          className="sr-only"
          onChange={onFileChange}
          aria-label={t("admin.section.backups.uploadButton")}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => fileInputRef.current?.click()}
          className="min-h-11"
        >
          {pending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          {t("admin.section.backups.uploadButton")}
        </Button>
      </div>
    </div>
  );
}
