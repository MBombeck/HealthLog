"use client";

/**
 * The exam's sheet: create and edit, one surface (#1672).
 *
 * Modality and day are the only required fields; Save is disabled until both
 * are there. The report and the pictures are vault documents: picked from the
 * vault through the shared link picker, or uploaded here, which files them in
 * the vault as kind `IMAGING` and selects them. Saving writes the links.
 *
 * Delete sits behind the footer's "⋯" in edit mode. The caller decides who
 * may reach edit mode (MANAGE on the labs section) and create (WRITE).
 */
import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FolderOpen, Loader2, Trash2, Upload } from "lucide-react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ActionMenu } from "@/components/ui/action-menu";
import { ActionPair } from "@/components/ui/action-pair";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EntityLinkPicker } from "@/components/links/entity-link-picker";
import {
  linkedDocumentOption,
  useVaultDocumentOptions,
} from "@/components/links/vault-document-options";
import type { EntityLinkOption } from "@/components/links/entity-link-picker";
import { toastWrittenOutcome } from "@/components/outcome/outcome-toast";
import { localizedApiError } from "@/lib/api/localized-error";
import { showErrorToast } from "@/lib/errors/error-toast";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  IMAGING_MODALITIES,
  IMAGING_SIDES,
  IMAGING_TEXT_MAX,
  type ImagingModality,
  type ImagingSide,
} from "@/lib/imaging/shared";
import { useTodayKey } from "@/components/day/use-today-key";

import { IMAGING_UPLOAD_ACCEPT, uploadImagingDocument } from "./imaging-upload";
import {
  useImagingMutations,
  type ImagingExam,
  type ImagingWriteBody,
} from "./use-imaging";

/** Select sentinel for "not sided". */
const SIDE_NONE = "NONE";

interface Draft {
  modality: ImagingModality | "";
  day: string;
  side: ImagingSide | typeof SIDE_NONE;
  bodyPart: string;
  facility: string;
  requestingDoctor: string;
  conclusion: string;
  documentIds: string[];
}

function draftFrom(exam: ImagingExam | null, today: string): Draft {
  return {
    modality: exam?.modality ?? "",
    day: exam ? exam.performedAt.slice(0, 10) : today,
    side: exam?.side ?? SIDE_NONE,
    bodyPart: exam?.bodyPart ?? "",
    facility: exam?.facility ?? "",
    requestingDoctor: exam?.requestingDoctor ?? "",
    conclusion: exam?.conclusion ?? "",
    documentIds: exam?.documents.map((d) => d.id) ?? [],
  };
}

function bodyFrom(draft: Draft): ImagingWriteBody | null {
  if (!draft.modality || !/^\d{4}-\d{2}-\d{2}$/.test(draft.day)) return null;
  return {
    modality: draft.modality,
    performedAt: `${draft.day}T00:00:00.000Z`,
    side: draft.side === SIDE_NONE ? null : draft.side,
    bodyPart: draft.bodyPart.trim() || null,
    facility: draft.facility.trim() || null,
    requestingDoctor: draft.requestingDoctor.trim() || null,
    conclusion: draft.conclusion.trim() || null,
    documentIds: draft.documentIds,
  };
}

export function ImagingSheet({
  open,
  onOpenChange,
  exam,
  documentsEnabled,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `null` creates an exam; a row edits it. */
  exam: ImagingExam | null;
  /** The `inboundDocuments` module: off leaves the documents block out. */
  documentsEnabled: boolean;
}) {
  const { t } = useTranslations();
  const format = useFormatters();
  const { create, update, remove } = useImagingMutations();
  const today = useTodayKey();
  const [seed] = useState(() => draftFrom(exam, today));
  const [draft, setDraft] = useState<Draft>(seed);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<EntityLinkOption[]>([]);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const isEdit = exam !== null;
  const body = bodyFrom(draft);
  const busy = create.isPending || update.isPending || remove.isPending;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const vault = useVaultDocumentOptions({
    enabled: documentsEnabled && open,
    anchor: draft.day ? `${draft.day}T00:00:00.000Z` : null,
  });
  const known = useMemo(
    () => [
      ...(exam?.documents ?? [])
        .map((link) => linkedDocumentOption(link, (iso) => format.date(iso)))
        .filter((option): option is EntityLinkOption => option !== null),
      ...uploaded,
    ],
    [exam, uploaded, format],
  );

  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!body) return;
    setError(null);
    try {
      if (isEdit) {
        await update.mutateAsync({ id: exam.id, body });
        toastWrittenOutcome("success", t("imaging.updated"));
      } else {
        await create.mutateAsync(body);
        toastWrittenOutcome("success", t("imaging.created"));
      }
      onOpenChange(false);
    } catch (err) {
      const message = localizedApiError(err, t, "imaging.saveFailed");
      setError(message);
      showErrorToast(message, { cause: err });
    }
  };

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const result = await uploadImagingDocument(file, draft.day || null);
        const id = result.ok ? result.document.id : result.existingId;
        if (!id) {
          showErrorToast(t("imaging.uploadFailed"));
          continue;
        }
        setUploaded((current) => [
          ...current,
          {
            id,
            label: result.ok
              ? (result.document.title ?? result.document.filename ?? file.name)
              : file.name,
            dateLabel: draft.day ? format.date(draft.day) : null,
            href: `/documents?doc=${encodeURIComponent(id)}`,
          },
        ]);
        setDraft((current) =>
          current.documentIds.includes(id)
            ? current
            : { ...current, documentIds: [...current.documentIds, id] },
        );
      }
    } catch (err) {
      showErrorToast(t("imaging.uploadFailed"), { cause: err });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const footer = (
    <ActionPair>
      {isEdit ? (
        <ActionMenu disabled={busy} slot="imaging-more">
          <DropdownMenuItem onClick={() => setConfirmingDelete(true)}>
            <Trash2 className="mr-2 size-4" />
            {t("common.delete")}
          </DropdownMenuItem>
        </ActionMenu>
      ) : null}
      <Button
        type="button"
        variant="outline"
        onClick={() => onOpenChange(false)}
        disabled={busy}
      >
        {t("common.cancel")}
      </Button>
      <Button
        type="submit"
        form="imaging-form"
        data-slot="imaging-save"
        disabled={!body || busy || uploading}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
        ) : null}
        {t("common.save")}
      </Button>
    </ActionPair>
  );

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      dirty={JSON.stringify(draft) !== JSON.stringify(seed)}
      title={t(isEdit ? "imaging.editTitle" : "imaging.createTitle")}
      footer={<div ref={setFooterEl} className="flex w-full" />}
    >
      <form
        id="imaging-form"
        onSubmit={(event) => void submit(event)}
        className="space-y-4"
        data-slot="imaging-form"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="imaging-modality">
              {t("imaging.form.modality")}
            </Label>
            <Select
              value={draft.modality}
              onValueChange={(value) =>
                set("modality", value as ImagingModality)
              }
            >
              <SelectTrigger
                id="imaging-modality"
                className="w-full"
                data-slot="imaging-modality"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {IMAGING_MODALITIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`imaging.modality.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="imaging-day">{t("imaging.form.date")}</Label>
            <DateField
              id="imaging-day"
              value={draft.day}
              max={today}
              onChange={(value) => set("day", value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="imaging-body-part">
              {t("imaging.form.bodyPart")}
            </Label>
            <Input
              id="imaging-body-part"
              value={draft.bodyPart}
              maxLength={IMAGING_TEXT_MAX.bodyPart}
              onChange={(e) => set("bodyPart", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="imaging-side">{t("imaging.form.side")}</Label>
            <Select
              value={draft.side}
              onValueChange={(value) => set("side", value as Draft["side"])}
            >
              <SelectTrigger id="imaging-side" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SIDE_NONE}>
                  {t("imaging.form.sideNone")}
                </SelectItem>
                {IMAGING_SIDES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`imaging.side.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="imaging-facility">
              {t("imaging.form.facility")}
            </Label>
            <Input
              id="imaging-facility"
              value={draft.facility}
              maxLength={IMAGING_TEXT_MAX.facility}
              onChange={(e) => set("facility", e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="imaging-doctor">
              {t("imaging.form.requestingDoctor")}
            </Label>
            <Input
              id="imaging-doctor"
              value={draft.requestingDoctor}
              maxLength={IMAGING_TEXT_MAX.requestingDoctor}
              onChange={(e) => set("requestingDoctor", e.target.value)}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="imaging-conclusion">
              {t("imaging.form.conclusion")}
            </Label>
            <Textarea
              id="imaging-conclusion"
              value={draft.conclusion}
              maxLength={IMAGING_TEXT_MAX.conclusion}
              rows={3}
              onChange={(e) => set("conclusion", e.target.value)}
            />
          </div>
        </div>

        {documentsEnabled ? (
          <div className="border-t pt-4" data-slot="imaging-documents">
            <EntityLinkPicker
              icon={FolderOpen}
              title={t("imaging.form.documents")}
              slot="imaging-document"
              pending={vault.pending}
              error={vault.error}
              errorLabel={t("links.picker.loadError")}
              onRetry={vault.retry}
              selected={draft.documentIds}
              onChange={(ids) => set("documentIds", ids)}
              options={vault.options}
              server={vault.server}
              knownOptions={known}
              searchPlaceholder={t("links.picker.searchPlaceholder")}
              emptyLabel={t("imaging.form.noDocuments")}
              extraAction={
                <>
                  <input
                    ref={fileInput}
                    type="file"
                    accept={IMAGING_UPLOAD_ACCEPT}
                    multiple
                    hidden
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
        ) : null}

        {error ? (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        ) : null}

        {footerEl ? createPortal(footer, footerEl) : null}
      </form>

      {isEdit ? (
        <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("imaging.deleteTitle")}</AlertDialogTitle>
              <AlertDialogDescription>
                {t("imaging.deleteDescription")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={remove.isPending}>
                {t("common.cancel")}
              </AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                data-slot="imaging-delete-confirm"
                disabled={remove.isPending}
                onClick={() =>
                  remove.mutate(exam.id, {
                    onSuccess: () => {
                      toastWrittenOutcome("success", t("imaging.deleted"));
                      onOpenChange(false);
                    },
                    onError: (failure) =>
                      showErrorToast(t("imaging.deleteFailed"), {
                        cause: failure,
                      }),
                  })
                }
              >
                {t("common.delete")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </ResponsiveSheet>
  );
}
