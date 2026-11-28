"use client";

/**
 * Imaging exams (#1672), on the domain page template: the header, then one
 * group of rows, newest exam first. A row is the exam (modality, body part,
 * side) over one meta line (day and clinic); the trailing value is how many
 * files are filed against it. Tapping a row opens its sheet; an empty page
 * is the group's one add row. No summary zone, no hint text.
 */
import { useState } from "react";
import { Plus, ScanLine } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ListGroup, ListItem } from "@/components/ui/list-row";
import { PageHeader } from "@/components/ui/page-header";
import { QueryErrorCard } from "@/components/ui/query-error-card";
import { RowValue } from "@/components/ui/row-value";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { formatDate as formatCalendarDate } from "@/lib/date-format";
import { useDateFormatPreference, useTranslations } from "@/lib/i18n/context";

import { ImagingSheet } from "./imaging-sheet";
import { useImagingExams, type ImagingExam } from "./use-imaging";

export function ImagingView() {
  const { t, locale } = useTranslations();
  const dateFormat = useDateFormatPreference();
  const { user } = useAuth();
  const { canWriteDomain, canManageDomain } = useRecordCapabilities();
  // POST answers at WRITE on the labs section; edit and delete at MANAGE.
  const canAdd = canWriteDomain("labs");
  const canManage = canManageDomain("labs");
  const documentsEnabled = user?.modules?.inboundDocuments !== false;
  const { data, isLoading, isError, error, refetch } = useImagingExams();
  const exams = data?.exams ?? [];

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ImagingExam | null>(null);
  const [session, setSession] = useState(0);
  const openSheet = (exam: ImagingExam | null) => {
    setEditing(exam);
    setSession((n) => n + 1);
    setOpen(true);
  };

  const title = (exam: ImagingExam) =>
    [
      t(`imaging.modality.${exam.modality}`),
      [exam.bodyPart, exam.side ? t(`imaging.side.${exam.side}`) : null]
        .filter(Boolean)
        .join(" "),
    ]
      .filter(Boolean)
      .join(" · ");
  const meta = (exam: ImagingExam) =>
    [
      formatCalendarDate(exam.performedAt.slice(0, 10), dateFormat, locale),
      exam.facility,
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <div className="space-y-6" data-slot="imaging-page">
      <PageHeader
        title={t("imaging.title")}
        actions={
          canAdd && exams.length > 0 ? (
            <Button
              className="min-h-11 sm:min-h-9"
              data-slot="imaging-add"
              onClick={() => openSheet(null)}
            >
              <Plus className="size-4" />
              {t("common.add")}
            </Button>
          ) : null
        }
      />

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : isError ? (
        <QueryErrorCard
          error={error}
          title={t("imaging.loadError")}
          onRetry={() => void refetch()}
        />
      ) : (
        <section className="space-y-2" data-slot="imaging-group">
          {exams.length > 0 ? (
            <h2 className="flex items-baseline gap-2 text-sm font-semibold">
              {t("imaging.examsHeading")}
              <span className="text-muted-foreground font-normal tabular-nums">
                {exams.length}
              </span>
            </h2>
          ) : null}
          <ListGroup
            empty={
              canAdd
                ? {
                    label: t("imaging.addFirst"),
                    onSelect: () => openSheet(null),
                  }
                : undefined
            }
          >
            {exams.map((exam) => (
              <ListItem
                key={exam.id}
                data-slot="imaging-row"
                data-exam-id={exam.id}
                icon={
                  <span className="bg-muted text-muted-foreground flex size-8 items-center justify-center rounded-lg">
                    <ScanLine className="size-4" aria-hidden />
                  </span>
                }
                title={title(exam)}
                meta={meta(exam)}
                trailing={
                  exam.documents.length > 0 ? (
                    <RowValue>
                      {t("imaging.fileCount", {
                        count: exam.documents.length,
                      })}
                    </RowValue>
                  ) : undefined
                }
                onSelect={canManage ? () => openSheet(exam) : undefined}
              />
            ))}
          </ListGroup>
        </section>
      )}

      <ImagingSheet
        key={session}
        open={open}
        onOpenChange={setOpen}
        exam={editing}
        documentsEnabled={documentsEnabled}
      />
    </div>
  );
}
