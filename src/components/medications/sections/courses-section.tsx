"use client";

/**
 * v1.40 (#1024) — the courses of a medication, in the detail page's
 * Lifecycle group: one row per course (dates, where today sits, doses
 * taken), "Start a new course" once every course has ended, and edit /
 * delete per course. The rows follow the Lifecycle rows beside them (title +
 * muted helper, actions at the trailing edge); the editor is a
 * ResponsiveSheet with DateFields and inline refusals.
 *
 * Every figure is the server's (`courses`, `canStartCourse`); this file
 * renders them and computes nothing.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarPlus, Loader2, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";

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
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { FieldError } from "@/components/forms/field-error";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import type { MedicationCourseWire } from "@/components/medications/course-fields";
import { ApiError, apiDelete, apiPatch, apiPost } from "@/lib/api/api-fetch";
import { formatDate } from "@/lib/date-format";
import { useDateFormatPreference, useTranslations } from "@/lib/i18n/context";
import { invalidateMedicationReads } from "@/lib/query-keys";

/** The refusal codes the course routes answer, mapped to their copy. */
const REFUSAL_KEYS: Record<string, string> = {
  "medications.course.overlap": "medications.course.error.overlap",
  "medications.course.currentOpen": "medications.course.error.currentOpen",
  "medications.course.oneShot": "medications.course.error.oneShot",
  "medications.course.invalidRange": "medications.course.error.invalidRange",
};

function useCourseDate() {
  const { locale } = useTranslations();
  const pref = useDateFormatPreference();
  return (key: string) => formatDate(new Date(key), pref, locale);
}

function CourseEditor({
  medicationId,
  course,
  open,
  onOpenChange,
}: {
  medicationId: string;
  /** Absent → start a new course. */
  course?: MedicationCourseWire;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [startsOn, setStartsOn] = useState(course?.startsOn ?? "");
  const [endsOn, setEndsOn] = useState(course?.endsOn ?? "");
  const [note, setNote] = useState(course?.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const rangeInvalid = startsOn !== "" && endsOn !== "" && endsOn < startsOn;

  async function save() {
    if (!startsOn || rangeInvalid || saving) return;
    setSaving(true);
    setError(null);
    const body = {
      startsOn,
      endsOn: endsOn === "" ? null : endsOn,
      note: note.trim() === "" ? null : note.trim(),
    };
    try {
      if (course) {
        await apiPatch(
          `/api/medications/${medicationId}/courses/${course.id}`,
          body,
        );
      } else {
        await apiPost(`/api/medications/${medicationId}/courses`, body);
      }
      await invalidateMedicationReads(queryClient);
      onOpenChange(false);
    } catch (err) {
      const code =
        err instanceof ApiError
          ? (err.meta?.errorCode as string | undefined)
          : undefined;
      setError(
        t(
          code && REFUSAL_KEYS[code]
            ? REFUSAL_KEYS[code]
            : "medications.course.error.generic",
        ),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title={
        course
          ? t("medications.course.editTitle")
          : t("medications.course.startNew")
      }
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={() => void save()}
            disabled={!startsOn || rangeInvalid || saving}
            data-slot="medication-course-save"
          >
            {saving && (
              <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            )}
            {t("common.save")}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-slot="medication-course-editor">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="medication-course-start">
              {t("medications.course.startsOn")}
            </Label>
            <DateField
              id="medication-course-start"
              value={startsOn}
              onChange={setStartsOn}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="medication-course-end">
              {t("medications.course.endsOn")}
            </Label>
            <DateField
              id="medication-course-end"
              value={endsOn}
              min={startsOn || undefined}
              onChange={setEndsOn}
              aria-invalid={rangeInvalid || undefined}
              aria-describedby="medication-course-end-error"
            />
            <FieldError
              id="medication-course-end-error"
              message={
                rangeInvalid
                  ? t("medications.course.error.invalidRange")
                  : undefined
              }
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="medication-course-note">
            {t("medications.course.note")}
          </Label>
          <Input
            id="medication-course-note"
            value={note}
            maxLength={280}
            placeholder={t("medications.course.notePlaceholder")}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <FieldError id="medication-course-error" message={error ?? undefined} />
      </div>
    </ResponsiveSheet>
  );
}

export function CoursesRow({
  medicationId,
  courses,
  canStartCourse,
  canEdit,
}: {
  medicationId: string;
  courses: MedicationCourseWire[];
  canStartCourse: boolean;
  /** Course writes are the owner's; a shared record shows the list only. */
  canEdit: boolean;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const date = useCourseDate();
  const [editing, setEditing] = useState<MedicationCourseWire | null>(null);
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState<MedicationCourseWire | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function confirmDelete(course: MedicationCourseWire) {
    setDeleteBusy(true);
    try {
      await apiDelete(`/api/medications/${medicationId}/courses/${course.id}`);
      await invalidateMedicationReads(queryClient);
      setDeleting(null);
    } catch {
      toast.error(t("medications.course.error.generic"));
    } finally {
      setDeleteBusy(false);
    }
  }

  const statusLabel = (status: MedicationCourseWire["status"]) =>
    status === "CURRENT"
      ? t("medications.course.status.current")
      : status === "UPCOMING"
        ? t("medications.course.status.upcoming")
        : t("medications.course.status.ended");

  return (
    <div className="space-y-3" data-slot="medication-courses-row">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-foreground text-sm font-medium">
            {t("medications.course.title")}
          </p>
          <p className="text-muted-foreground text-xs">
            {t("medications.course.helper")}
          </p>
        </div>
        {canEdit && canStartCourse && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setStarting(true)}
            className="min-h-11 shrink-0 sm:min-h-9"
            data-slot="medication-course-start-new"
          >
            <CalendarPlus aria-hidden="true" className="size-4" />
            {t("medications.course.startNew")}
          </Button>
        )}
      </div>

      {courses.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("medications.course.none")}
        </p>
      ) : (
        <ul className="space-y-2">
          {courses.map((course, index) => (
            <li
              key={course.id}
              className="border-border flex min-h-12 items-center gap-2 rounded-md border px-3 py-2"
              data-slot="medication-course-item"
              data-status={course.status}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  {course.endsOn
                    ? t("medications.course.range", {
                        start: date(course.startsOn),
                        end: date(course.endsOn),
                      })
                    : t("medications.course.since", {
                        start: date(course.startsOn),
                      })}
                </p>
                <p className="text-muted-foreground text-xs">
                  {t("medications.course.meta", {
                    n: index + 1,
                    status: statusLabel(course.status),
                    taken: course.takenDoses,
                  })}
                </p>
                {course.note && (
                  <p className="text-sm break-words">{course.note}</p>
                )}
              </div>
              {canEdit && (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-11 sm:size-9"
                    onClick={() => setEditing(course)}
                    aria-label={t("medications.course.editTitle")}
                    title={t("medications.course.editTitle")}
                  >
                    <Pencil className="size-4" aria-hidden="true" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground hover:text-foreground size-11 sm:size-9"
                    onClick={() => setDeleting(course)}
                    aria-label={t("medications.course.delete")}
                    title={t("medications.course.delete")}
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {starting && (
        <CourseEditor
          medicationId={medicationId}
          open={starting}
          onOpenChange={setStarting}
        />
      )}
      {editing && (
        <CourseEditor
          medicationId={medicationId}
          course={editing}
          open={editing !== null}
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
        />
      )}

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("medications.course.deleteTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {courses.length === 1
                ? t("medications.course.deleteLastConfirm")
                : t("medications.course.deleteBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteBusy}
              onClick={(e) => {
                e.preventDefault();
                if (deleting) void confirmDelete(deleting);
              }}
            >
              {t("medications.course.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
