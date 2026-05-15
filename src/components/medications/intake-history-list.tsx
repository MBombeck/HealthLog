"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidateKeys, medicationDependentKeys } from "@/lib/query-keys";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DateTimeInput } from "@/components/ui/date-input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Loader2,
  Pencil,
  Trash2,
  ChevronLeft,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  MoreHorizontal,
  Check,
  SkipForward,
  AlertTriangle,
} from "lucide-react";
import { useId, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { formatDateTime } from "@/lib/format";
import { useTranslations } from "@/lib/i18n/context";

interface IntakeEvent {
  id: string;
  medicationId: string;
  scheduledFor: string;
  takenAt: string | null;
  skipped: boolean;
  source: string;
  createdAt: string;
}

interface IntakeHistoryListProps {
  medicationId: string;
  createOpen?: boolean;
  onCreateOpenChange?: (open: boolean) => void;
}

// SOURCE_LABELS built dynamically via t() in the component

const PAGE_SIZE = 25;

function toDateTimeLocalValue(isoString: string): string {
  const date = new Date(isoString);
  const offset = date.getTimezoneOffset();
  const local = new Date(date.getTime() - offset * 60 * 1000);
  return local.toISOString().slice(0, 16);
}

function dateTimeLocalToISO(value: string): string {
  return new Date(value).toISOString();
}

export function IntakeHistoryList({
  medicationId,
  createOpen,
  onCreateOpenChange,
}: IntakeHistoryListProps) {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const { t } = useTranslations();

  const sourceLabels: Record<string, string> = {
    WEB: t("medications.sourceWeb"),
    API: t("medications.sourceApi"),
    REMINDER: t("medications.sourceReminder"),
    IMPORT: t("medications.sourceImport"),
  };

  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<string>("scheduledFor");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  // Edit state
  const [editing, setEditing] = useState<IntakeEvent | null>(null);
  const [editScheduledFor, setEditScheduledFor] = useState("");
  const [editTakenAt, setEditTakenAt] = useState("");
  const [editSkipped, setEditSkipped] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [editDeleteDialogOpen, setEditDeleteDialogOpen] = useState(false);
  // v1.4.27 MB3 — error banners reference the form inputs via
  // aria-describedby so screen readers announce validation failures.
  const editErrorId = useId();
  const editErrorDescriptor = editError ? editErrorId : undefined;

  // v1.4.27 R4 RC2 — portal targets + stable form ids so the edit and
  // create sheets sticky-pin Save / Cancel via the
  // `<ResponsiveSheet>` footer slot. Submit buttons keep their `<form>`
  // association via the HTML `form` attribute.
  const editFormId = useId();
  const createFormId = useId();
  const [editFooterEl, setEditFooterEl] = useState<HTMLDivElement | null>(null);
  const [createFooterEl, setCreateFooterEl] = useState<HTMLDivElement | null>(
    null,
  );

  // Create state — controlled via props or internal
  const [internalCreating, setInternalCreating] = useState(false);
  const creating = createOpen ?? internalCreating;
  const [createScheduledFor, setCreateScheduledFor] = useState("");
  const [createTakenAt, setCreateTakenAt] = useState("");
  const [createSkipped, setCreateSkipped] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const createErrorId = useId();
  const createErrorDescriptor = createError ? createErrorId : undefined;
  const setCreatingRaw = onCreateOpenChange ?? setInternalCreating;
  const setCreating = useCallback(
    (open: boolean) => {
      if (open) {
        const now = toDateTimeLocalValue(new Date().toISOString());
        setCreateScheduledFor(now);
        setCreateTakenAt(now);
        setCreateSkipped(false);
        setCreateError(null);
      }
      setCreatingRaw(open);
    },
    [setCreatingRaw],
  );

  function toggleSort(column: string) {
    if (sortBy === column) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(column);
      setSortDir(column === "scheduledFor" ? "desc" : "asc");
    }
    setPage(1);
  }

  const { data, isLoading } = useQuery({
    queryKey: ["medications", medicationId, "intake", page, sortBy, sortDir],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String((page - 1) * PAGE_SIZE));
      params.set("sortBy", sortBy);
      params.set("sortDir", sortDir);
      const res = await fetch(
        `/api/medications/${medicationId}/intake?${params}`,
      );
      if (!res.ok) throw new Error("Failed to fetch");
      const json = await res.json();
      return json.data as {
        events: IntakeEvent[];
        meta: { total: number; limit: number; offset: number };
      };
    },
    enabled: isAuthenticated,
  });

  const deleteMutation = useMutation({
    mutationFn: async (eventId: string) => {
      const res = await fetch(
        `/api/medications/${medicationId}/intake/${eventId}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error("Delete failed");
    },
    onSuccess: () => {
      void invalidateKeys(queryClient, medicationDependentKeys);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({
      eventId,
      takenAt,
      skipped,
      scheduledFor,
    }: {
      eventId: string;
      takenAt: string | null;
      skipped: boolean;
      scheduledFor: string;
    }) => {
      const res = await fetch(
        `/api/medications/${medicationId}/intake/${eventId}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ takenAt, skipped, scheduledFor }),
        },
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Update failed");
    },
    onSuccess: async () => {
      await invalidateKeys(queryClient, medicationDependentKeys);
      setEditing(null);
      setEditError(null);
    },
    onError: (err) => {
      setEditError(
        err instanceof Error ? err.message : t("medications.saveError"),
      );
    },
  });

  const createMutation = useMutation({
    mutationFn: async ({
      scheduledFor,
      takenAt,
      skipped,
    }: {
      scheduledFor: string;
      takenAt: string | null;
      skipped: boolean;
    }) => {
      const res = await fetch(`/api/medications/${medicationId}/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scheduledFor, takenAt, skipped }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Create failed");
    },
    onSuccess: async () => {
      await invalidateKeys(queryClient, medicationDependentKeys);
      setCreating(false);
      setCreateError(null);
    },
    onError: (err) => {
      setCreateError(
        err instanceof Error ? err.message : t("medications.saveError"),
      );
    },
  });

  const totalPages = data ? Math.ceil(data.meta.total / PAGE_SIZE) : 0;

  function startEdit(event: IntakeEvent) {
    setEditing(event);
    setEditScheduledFor(toDateTimeLocalValue(event.scheduledFor));
    setEditTakenAt(event.takenAt ? toDateTimeLocalValue(event.takenAt) : "");
    setEditSkipped(event.skipped);
    setEditError(null);
  }

  function closeEdit() {
    if (updateMutation.isPending || deleteMutation.isPending) return;
    setEditing(null);
    setEditError(null);
    setEditDeleteDialogOpen(false);
  }

  function closeCreate() {
    if (createMutation.isPending) return;
    setCreating(false);
    setCreateError(null);
  }

  async function deleteEditingEvent() {
    if (!editing) return;
    try {
      setEditError(null);
      await deleteMutation.mutateAsync(editing.id);
      closeEdit();
    } catch {
      setEditError(t("medications.deleteError"));
    }
  }

  async function submitEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editing) return;

    const scheduledDate = new Date(editScheduledFor);
    if (Number.isNaN(scheduledDate.getTime())) {
      setEditError(t("medications.invalidTimestamp"));
      return;
    }

    setEditError(null);
    updateMutation.mutate({
      eventId: editing.id,
      scheduledFor: dateTimeLocalToISO(editScheduledFor),
      takenAt:
        editSkipped || !editTakenAt ? null : dateTimeLocalToISO(editTakenAt),
      skipped: editSkipped,
    });
  }

  async function submitCreate(e: React.FormEvent) {
    e.preventDefault();

    const scheduledDate = new Date(createScheduledFor);
    if (Number.isNaN(scheduledDate.getTime())) {
      setCreateError(t("medications.invalidTimestamp"));
      return;
    }

    setCreateError(null);
    createMutation.mutate({
      scheduledFor: dateTimeLocalToISO(createScheduledFor),
      takenAt:
        createSkipped || !createTakenAt
          ? null
          : dateTimeLocalToISO(createTakenAt),
      skipped: createSkipped,
    });
  }

  function getStatusBadge(event: IntakeEvent) {
    if (event.skipped) {
      return (
        <Badge variant="outline" className="text-muted-foreground gap-1">
          <SkipForward className="h-3 w-3" />
          {t("medications.intakeStatusSkipped")}
        </Badge>
      );
    }
    if (event.takenAt) {
      return (
        <Badge
          variant="secondary"
          className="gap-1 bg-green-500/20 text-green-400"
        >
          <Check className="h-3 w-3" />
          {t("medications.intakeStatusTaken")}
        </Badge>
      );
    }
    return (
      <Badge variant="secondary" className="gap-1 bg-red-500/20 text-red-400">
        <AlertTriangle className="h-3 w-3" />
        {t("medications.intakeStatusMissed")}
      </Badge>
    );
  }

  if (!isAuthenticated) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("medications.loginRequiredIntakes")}
      </p>
    );
  }

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-center justify-end">
          {data?.meta?.total !== undefined && (
            <span className="text-muted-foreground text-sm">
              {t("medications.intakeCount", { count: data.meta.total })}
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
          </div>
        ) : !data?.events?.length ? (
          <div className="text-muted-foreground flex h-32 items-center justify-center rounded-lg border border-dashed">
            {t("medications.noIntakesYet")}
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="bg-card border-border hidden overflow-hidden rounded-lg border md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <SortableHead
                      column="scheduledFor"
                      label={t("medications.intakeScheduledFor")}
                      currentSort={sortBy}
                      currentDir={sortDir}
                      onSort={toggleSort}
                    />
                    <SortableHead
                      column="takenAt"
                      label={t("medications.intakeTakenAt")}
                      currentSort={sortBy}
                      currentDir={sortDir}
                      onSort={toggleSort}
                    />
                    <TableHead className="w-32">
                      {t("medications.intakeStatus")}
                    </TableHead>
                    <SortableHead
                      column="source"
                      label={t("medications.intakeSource")}
                      currentSort={sortBy}
                      currentDir={sortDir}
                      onSort={toggleSort}
                      className="w-28"
                    />
                    <TableHead className="w-20 pr-4 text-right">
                      {t("medications.actions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.events.map((event) => (
                    <TableRow key={event.id}>
                      <TableCell className="text-sm tabular-nums">
                        {formatDateTime(event.scheduledFor)}
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm tabular-nums">
                        {event.takenAt ? formatDateTime(event.takenAt) : "—"}
                      </TableCell>
                      <TableCell>{getStatusBadge(event)}</TableCell>
                      <TableCell>
                        <Badge variant="outline" className="text-xs">
                          {sourceLabels[event.source] ?? event.source}
                        </Badge>
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="size-11"
                            onClick={() => startEdit(event)}
                            aria-label={t("common.edit")}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <DeleteButton
                            label={t("medications.intakeDeleteConfirm")}
                            description={t(
                              "medications.intakeDeleteDescription",
                            )}
                            onConfirm={() => deleteMutation.mutate(event.id)}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile cards */}
            <div className="space-y-2 md:hidden">
              {data.events.map((event) => (
                <div
                  key={event.id}
                  className="bg-card border-border rounded-lg border p-3"
                >
                  <div className="flex items-start justify-between">
                    <div className="min-w-0 space-y-1">
                      <p className="text-sm font-medium tabular-nums">
                        {formatDateTime(event.scheduledFor)}
                      </p>
                      {event.takenAt && (
                        <p className="text-muted-foreground text-xs tabular-nums">
                          {t("medications.intakeTakenAt")}:{" "}
                          {formatDateTime(event.takenAt)}
                        </p>
                      )}
                      <div className="flex items-center gap-1.5">
                        {getStatusBadge(event)}
                        <Badge variant="outline" className="text-xs">
                          {sourceLabels[event.source] ?? event.source}
                        </Badge>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-11"
                        onClick={() => startEdit(event)}
                        aria-label={t("common.edit")}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <DeleteButton
                        label={t("medications.intakeDeleteConfirm")}
                        description={t("medications.intakeDeleteDescription")}
                        onConfirm={() => deleteMutation.mutate(event.id)}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground text-sm">
              {t("medications.pageInfo", { page, total: totalPages })}
            </span>
            <div className="flex gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                aria-label={t("medications.previousPage")}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-11"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                aria-label={t("medications.nextPage")}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Edit Sheet */}
      <ResponsiveSheet
        open={!!editing}
        onOpenChange={(open) => !open && closeEdit()}
        title={t("medications.editIntake")}
        footer={<div ref={setEditFooterEl} className="flex w-full" />}
      >
          {editing && (
            <form
              id={editFormId}
              onSubmit={submitEdit}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="edit-scheduledFor">
                  {t("medications.intakeScheduledFor")}
                </Label>
                <DateTimeInput
                  id="edit-scheduledFor"
                  value={editScheduledFor}
                  onChange={(e) => setEditScheduledFor(e.target.value)}
                  required
                  aria-required="true"
                  aria-invalid={!!editError || undefined}
                  aria-describedby={editErrorDescriptor}
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="edit-takenAt">
                  {t("medications.intakeTakenAt")}
                </Label>
                <DateTimeInput
                  id="edit-takenAt"
                  value={editTakenAt}
                  onChange={(e) => setEditTakenAt(e.target.value)}
                  disabled={editSkipped}
                  aria-invalid={!!editError || undefined}
                  aria-describedby={editErrorDescriptor}
                />
              </div>

              <div className="flex items-center gap-2">
                <Switch
                  id="edit-skipped"
                  checked={editSkipped}
                  onCheckedChange={(checked) => {
                    setEditSkipped(checked);
                    if (checked) setEditTakenAt("");
                  }}
                />
                <Label htmlFor="edit-skipped">
                  {t("medications.intakeStatusSkipped")}
                </Label>
              </div>

              {editError && (
                <div
                  id={editErrorId}
                  role="alert"
                  aria-live="assertive"
                  className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
                >
                  {editError}
                </div>
              )}

              {editFooterEl
                ? createPortal(
                    <div className="flex w-full items-center justify-between gap-2">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="size-11"
                            disabled={
                              updateMutation.isPending ||
                              deleteMutation.isPending
                            }
                            aria-label={t("common.moreOptions")}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem
                            variant="destructive"
                            onClick={() => setEditDeleteDialogOpen(true)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            {t("common.delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>

                      <div className="flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          onClick={closeEdit}
                          disabled={
                            updateMutation.isPending ||
                            deleteMutation.isPending
                          }
                        >
                          {t("common.cancel")}
                        </Button>
                        <Button
                          type="submit"
                          form={editFormId}
                          disabled={
                            updateMutation.isPending ||
                            deleteMutation.isPending
                          }
                        >
                          {updateMutation.isPending ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                          ) : null}
                          {t("common.save")}
                        </Button>
                      </div>
                    </div>,
                    editFooterEl,
                  )
                : null}

              <AlertDialog
                open={editDeleteDialogOpen}
                onOpenChange={setEditDeleteDialogOpen}
              >
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("medications.intakeDeleteConfirm")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("medications.intakeDeleteDescription")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={deleteMutation.isPending}>
                      {t("common.cancel")}
                    </AlertDialogCancel>
                    <AlertDialogAction
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={deleteEditingEvent}
                      disabled={deleteMutation.isPending}
                    >
                      {deleteMutation.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                      ) : null}
                      {t("common.delete")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </form>
          )}
      </ResponsiveSheet>

      {/* Create Sheet */}
      <ResponsiveSheet
        open={creating}
        onOpenChange={(open) => !open && closeCreate()}
        title={t("medications.newIntake")}
        footer={<div ref={setCreateFooterEl} className="flex w-full" />}
      >
          <form
            id={createFormId}
            onSubmit={submitCreate}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="create-scheduledFor">
                {t("medications.intakeScheduledFor")}
              </Label>
              <DateTimeInput
                id="create-scheduledFor"
                value={createScheduledFor}
                onChange={(e) => setCreateScheduledFor(e.target.value)}
                required
                aria-required="true"
                aria-invalid={!!createError || undefined}
                aria-describedby={createErrorDescriptor}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="create-takenAt">
                {t("medications.intakeTakenAt")}
              </Label>
              <DateTimeInput
                id="create-takenAt"
                value={createTakenAt}
                onChange={(e) => setCreateTakenAt(e.target.value)}
                disabled={createSkipped}
                aria-invalid={!!createError || undefined}
                aria-describedby={createErrorDescriptor}
              />
            </div>

            <div className="flex items-center gap-2">
              <Switch
                id="create-skipped"
                checked={createSkipped}
                onCheckedChange={(checked) => {
                  setCreateSkipped(checked);
                  if (checked) setCreateTakenAt("");
                }}
              />
              <Label htmlFor="create-skipped">
                {t("medications.intakeStatusSkipped")}
              </Label>
            </div>

            {createError && (
              <div
                id={createErrorId}
                role="alert"
                aria-live="assertive"
                className="bg-destructive/10 text-destructive rounded-lg p-3 text-sm"
              >
                {createError}
              </div>
            )}

          </form>
          {createFooterEl
            ? createPortal(
                <div className="flex w-full items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={closeCreate}
                    disabled={createMutation.isPending}
                  >
                    {t("common.cancel")}
                  </Button>
                  <Button
                    type="submit"
                    form={createFormId}
                    disabled={createMutation.isPending}
                  >
                    {createMutation.isPending ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin motion-reduce:animate-none" />
                    ) : null}
                    {t("common.save")}
                  </Button>
                </div>,
                createFooterEl,
              )
            : null}
      </ResponsiveSheet>
    </>
  );
}

function SortableHead({
  column,
  label,
  currentSort,
  currentDir,
  onSort,
  className,
}: {
  column: string;
  label: string;
  currentSort: string;
  currentDir: "asc" | "desc";
  onSort: (col: string) => void;
  className?: string;
}) {
  const isActive = currentSort === column;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className="hover:text-foreground inline-flex items-center gap-1 transition-colors"
      >
        {label}
        {isActive ? (
          currentDir === "asc" ? (
            <ArrowUp className="h-3.5 w-3.5" />
          ) : (
            <ArrowDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ArrowUpDown className="h-3.5 w-3.5 opacity-40" />
        )}
      </button>
    </TableHead>
  );
}

function DeleteButton({
  label,
  description,
  onConfirm,
}: {
  label: string;
  description: string;
  onConfirm: () => void;
}) {
  const { t } = useTranslations();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="text-destructive size-11"
          aria-label={label}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{label}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={onConfirm}
          >
            {t("common.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
