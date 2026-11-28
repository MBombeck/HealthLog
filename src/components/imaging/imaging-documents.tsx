"use client";

/**
 * The exam's report and pictures (#1672): the vault through the shared link
 * picker, and an upload that files new files in the vault as kind `IMAGING`
 * on the exam's day and selects them. Rendered only while the document vault
 * module is on.
 */
import { useMemo, useRef, useState } from "react";
import { FolderOpen, Loader2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { FileInput } from "@/components/ui/file-picker";
import {
  EntityLinkPicker,
  type EntityLinkOption,
} from "@/components/links/entity-link-picker";
import {
  linkedDocumentOption,
  useVaultDocumentOptions,
} from "@/components/links/vault-document-options";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import { recordHref } from "@/lib/links/hrefs";
import type { ImagingExamDocumentDTO } from "@/lib/imaging/shared";

import { IMAGING_UPLOAD_ACCEPT, uploadImagingDocument } from "./imaging-upload";

export function ImagingDocuments({
  day,
  open,
  selected,
  onChange,
  linked,
  onUploadingChange,
}: {
  /** The exam day (YYYY-MM-DD), the picker's anchor and the upload's date. */
  day: string;
  open: boolean;
  selected: string[];
  onChange: (ids: string[]) => void;
  /** What the exam is filed against on the server, for the chips. */
  linked: readonly ImagingExamDocumentDTO[];
  onUploadingChange: (uploading: boolean) => void;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const fileInput = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<EntityLinkOption[]>([]);
  const vault = useVaultDocumentOptions({
    enabled: open,
    anchor: day ? `${day}T00:00:00.000Z` : null,
  });
  const known = useMemo(
    () => [
      ...linked
        .map((link) => linkedDocumentOption(link, (iso) => format.date(iso)))
        .filter((option): option is EntityLinkOption => option !== null),
      ...uploaded,
    ],
    [linked, uploaded, format],
  );

  const busy = (value: boolean) => {
    setUploading(value);
    onUploadingChange(value);
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    busy(true);
    let ids = selected;
    try {
      for (const file of Array.from(files)) {
        const result = await uploadImagingDocument(file, day || null);
        const id = result.ok ? result.document.id : result.existingId;
        if (!id) {
          showErrorToast(t("imaging.uploadFailed"));
          continue;
        }
        const label = result.ok
          ? (result.document.title ?? result.document.filename ?? file.name)
          : file.name;
        setUploaded((current) => [
          ...current,
          {
            id,
            label,
            dateLabel: day ? format.date(day) : null,
            href: recordHref("document", id),
          },
        ]);
        if (!ids.includes(id)) ids = [...ids, id];
      }
      onChange(ids);
    } catch (err) {
      showErrorToast(t("imaging.uploadFailed"), { cause: err });
    } finally {
      busy(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  return (
    <div className="border-t pt-4" data-slot="imaging-documents">
      <EntityLinkPicker
        icon={FolderOpen}
        title={t("imaging.form.documents")}
        slot="imaging-document"
        pending={vault.pending}
        error={vault.error}
        errorLabel={t("links.picker.loadError")}
        onRetry={vault.retry}
        selected={selected}
        onChange={onChange}
        options={vault.options}
        server={vault.server}
        knownOptions={known}
        searchPlaceholder={t("links.picker.searchPlaceholder")}
        emptyLabel={t("imaging.form.noDocuments")}
        extraAction={
          <>
            <FileInput
              ref={fileInput}
              accept={IMAGING_UPLOAD_ACCEPT}
              multiple
              data-slot="imaging-upload-input"
              onChange={(e) => void onFiles(e.target.files)}
            />
            <Button
              type="button"
              variant="outline"
              className="min-h-9"
              data-slot="imaging-upload"
              disabled={uploading}
              onClick={() => fileInput.current?.click()}
            >
              {uploading ? (
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
              ) : (
                <Upload className="size-4" aria-hidden />
              )}
              {t("imaging.form.upload")}
            </Button>
          </>
        }
      />
    </div>
  );
}
