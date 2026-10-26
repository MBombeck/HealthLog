"use client";

import {
  AlertCircle,
  AlertTriangle,
  Check,
  CircleCheck,
  Link2,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  SkipForward,
  Trash2,
  Unlink,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { DoseHistoryStatus } from "@/lib/medications/scheduling/dose-history";

import {
  formatSlotDelta,
  isSlotActionable,
  type LedgerRow,
} from "../dose-history-ledger-compute";

/** Status → semantic colour token + glyph. Mirrors the card status pill's
 * success / warning / destructive ramp so the surface reads as one vocabulary;
 * skipped + upcoming are calm muted, ad-hoc is the neutral-positive accent. */
const STATUS_TONE: Record<DoseHistoryStatus, string> = {
  taken_on_time: "text-success",
  taken_late: "text-warning",
  skipped: "text-muted-foreground",
  missed: "text-destructive",
  upcoming: "text-muted-foreground",
  ad_hoc: "text-primary",
};

function StatusGlyph({ status }: { status: DoseHistoryStatus }) {
  const cls = "size-3.5 shrink-0";
  switch (status) {
    case "taken_on_time":
      return <CircleCheck aria-hidden="true" className={cls} />;
    case "taken_late":
      return <AlertCircle aria-hidden="true" className={cls} />;
    case "missed":
      return <AlertTriangle aria-hidden="true" className={cls} />;
    case "ad_hoc":
      return <Plus aria-hidden="true" className={cls} />;
    case "skipped":
      return <SkipForward aria-hidden="true" className={cls} />;
    default:
      return null;
  }
}

interface LedgerRowItemProps {
  row: LedgerRow;
  marking: string | null;
  isToday: boolean;
  onMark: (row: LedgerRow, action: "taken" | "skipped") => void;
  onToggleSkipped: (intake: {
    id: string;
    skipped: boolean;
    scheduledFor: string | null;
  }) => void;
  onEdit: (event: {
    id: string;
    takenAt: string | null;
    skipped: boolean;
    scheduledFor: string | null;
  }) => void;
  onDelete: (id: string) => void;
  /** Open the pin confirm for an ad-hoc take onto the named slot (ISO). */
  onPin: (eventId: string, slotAt: string) => void;
  /** Release a pinned binding (server re-attributes by band). */
  onUnpin: (eventId: string) => void;
}

/**
 * One ledger row: time + status (colour + glyph + text) + (when an intake is
 * attributed) its real take time, plus the row actions.
 *
 * Action shape: an actionable slot that is still in play
 * (upcoming, or missed TODAY) carries exactly ONE visible [Genommen] button —
 * label visible on every viewport — plus the overflow kebab (Übersprungen).
 * Every settled row (taken / skipped / a past missed day / ad-hoc) carries
 * ONLY the kebab: Bearbeiten, the Übersprungen↔Genommen toggle, Löschen —
 * and, for a past missed slot, the Genommen / Übersprungen backfill marks.
 *
 * .x — exported for the delegated-affordance suite. The row's capability
 * gating is the interesting part and the ledger around it needs a payload, a
 * medication and a query client to paint one row.
 */
export function LedgerRowItem({
  row,
  marking,
  isToday,
  onMark,
  onToggleSkipped,
  onEdit,
  onDelete,
  onPin,
  onUnpin,
}: LedgerRowItemProps) {
  const { t } = useTranslations();
  const { canWriteDomain, canManageDomain } = useRecordCapabilities();
  const canAddIntake = canWriteDomain("medications");
  const canManageMedications = canManageDomain("medications");
  const fmt = useFormatters();

  const actionable = isSlotActionable(row);
  // A missed slot from an earlier day stays markable, but only through the
  // kebab — the visible button is reserved for doses still in play.
  const showTakenButton = actionable && (row.status === "upcoming" || isToday);
  const intake = row.intake;
  const takeBusy = marking === `${row.at}:taken`;
  const skipBusy = marking === `${row.at}:skipped`;

  // The leading time label: the slot's HH:mm for a slot row, else the ad-hoc
  // take's real clock time.
  const timeLabel =
    row.timeOfDay ?? fmt.time(new Date(intake?.takenAt ?? row.at));

  // When a take lands away from its slot, show both anchors so the row reads
  // "geplant 07:00 · genommen 11:29".
  const showTakeDetail =
    row.kind === "slot" &&
    intake?.takenAt &&
    (row.status === "taken_on_time" || row.status === "taken_late");

  // An ad-hoc take with a due-context shows WHEN the dose would
  // have been due; the pin action additionally needs the slot unserved and a
  // real persisted event to re-anchor.
  const dueContext =
    row.kind === "ad_hoc" && intake?.takenAt && row.nearestSlot
      ? row.nearestSlot
      : null;
  const canPin = Boolean(dueContext && !dueContext.filled && intake?.id);
  const canUnpin = Boolean(row.kind === "slot" && row.pinned && intake?.id);

  return (
    <li
      className="flex items-center justify-between gap-2 px-3 py-2"
      data-slot="ledger-row"
      data-status={row.status}
      data-kind={row.kind}
    >
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-foreground text-sm font-medium tabular-nums">
            {timeLabel}
          </span>
          <span
            className={`inline-flex items-center gap-1 text-xs font-medium ${STATUS_TONE[row.status]}`}
            data-slot="ledger-status"
          >
            <StatusGlyph status={row.status} />
            {t(`medications.detail.verlauf.status.${row.status}`)}
          </span>
          {row.kind === "ad_hoc" && (
            <Badge variant="outline" className="text-2xs">
              {t("medications.detail.verlauf.adHocTag")}
            </Badge>
          )}
          {/* The "zugeordnet" badge only when the row is actually
              bound to a slot. A released ("Zuordnung lösen") USER_PIN take
              surfaces as an ad-hoc row that also carries `pinned`; badging
              it "zugeordnet" would claim the binding the user just released. */}
          {row.kind === "slot" && row.pinned && (
            <Badge
              variant="outline"
              className="text-2xs"
              data-slot="ledger-pinned-badge"
            >
              {t("medications.detail.verlauf.pin.pinnedTag")}
            </Badge>
          )}
        </div>
        {showTakeDetail && (
          <p className="text-muted-foreground text-xs">
            {t("medications.detail.verlauf.takenDetail", {
              planned: row.timeOfDay ?? fmt.time(new Date(row.at)),
              taken: fmt.time(new Date(intake!.takenAt!)),
            })}
          </p>
        )}
        {/* Quiet per-intake dose override note. Only rows whose
            take recorded a deviating dose carry one; the configured dose
            stays implicit, so the ledger's rhythm is undisturbed. */}
        {intake?.doseTaken && (
          <p
            className="text-muted-foreground text-xs"
            data-slot="ledger-dose-taken"
          >
            {t("medications.detail.verlauf.doseTaken", {
              dose: intake.doseTaken,
            })}
          </p>
        )}
        {dueContext && (
          <p
            className="text-muted-foreground text-xs"
            data-slot="ledger-due-context"
          >
            {t("medications.detail.verlauf.pin.dueContext", {
              time: fmt.time(new Date(dueContext.at)),
              delta: formatSlotDelta(intake!.takenAt!, dueContext.at),
            })}
          </p>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {showTakenButton && canAddIntake && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onMark(row, "taken")}
            disabled={takeBusy || skipBusy}
            aria-busy={takeBusy || undefined}
            className="min-h-9"
            data-slot="ledger-mark-taken"
          >
            {takeBusy ? (
              <Loader2
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
            ) : (
              <Check aria-hidden="true" className="size-4" />
            )}
            {t("medications.detail.verlauf.markTaken")}
          </Button>
        )}
        {/* .x — the other half of the same admitted verb. Marking a dose
            taken OR skipped is one capability, and the medication card offers
            both; this ledger offered a delegate only the first, because skip
            lives in the kebab and the kebab is owner-only (it also holds edit,
            re-attribute and delete). Rather than mix admitted and withheld
            items in one menu, a delegate gets skip as its own control beside
            take, which is the shape the card already uses. The owner keeps it
            where it was. */}
        {showTakenButton && canAddIntake && !canManageMedications && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => onMark(row, "skipped")}
            disabled={takeBusy || skipBusy}
            aria-busy={skipBusy || undefined}
            className="min-h-9"
            data-slot="ledger-mark-skipped"
          >
            {skipBusy ? (
              <Loader2
                aria-hidden="true"
                className="size-4 animate-spin motion-reduce:animate-none"
              />
            ) : (
              <SkipForward aria-hidden="true" className="size-4" />
            )}
            {t("medications.detail.verlauf.markSkipped")}
          </Button>
        )}
        {canManageMedications && (
          <LedgerRowMenu
            row={row}
            actionable={actionable}
            showTakenButton={showTakenButton}
            skipBusy={skipBusy}
            canPin={canPin}
            canUnpin={canUnpin}
            dueContext={dueContext}
            timeLabel={timeLabel}
            onMark={onMark}
            onToggleSkipped={onToggleSkipped}
            onEdit={onEdit}
            onDelete={onDelete}
            onPin={onPin}
            onUnpin={onUnpin}
          />
        )}
      </div>
    </li>
  );
}

/**
 * The owner's row menu: the backfill marks for a slot no longer in play,
 * pin and release, edit, the skipped/taken toggle, delete.
 */
function LedgerRowMenu({
  row,
  actionable,
  showTakenButton,
  skipBusy,
  canPin,
  canUnpin,
  dueContext,
  timeLabel,
  onMark,
  onToggleSkipped,
  onEdit,
  onDelete,
  onPin,
  onUnpin,
}: Pick<
  LedgerRowItemProps,
  | "row"
  | "onMark"
  | "onToggleSkipped"
  | "onEdit"
  | "onDelete"
  | "onPin"
  | "onUnpin"
> & {
  actionable: boolean;
  showTakenButton: boolean;
  skipBusy: boolean;
  canPin: boolean;
  canUnpin: boolean;
  dueContext: LedgerRow["nearestSlot"] | null;
  timeLabel: string;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const intake = row.intake;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
          aria-label={t("medications.detail.verlauf.rowActionsLabel", {
            time: timeLabel,
          })}
          data-slot="ledger-row-menu"
        >
          <MoreVertical aria-hidden="true" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-slot="ledger-row-menu-content">
        {actionable && !showTakenButton && (
          <DropdownMenuItem
            onClick={() => onMark(row, "taken")}
            data-slot="ledger-menu-taken"
          >
            <Check aria-hidden="true" className="mr-2 size-4" />
            {t("medications.detail.verlauf.markTaken")}
          </DropdownMenuItem>
        )}
        {actionable && (
          <DropdownMenuItem
            onClick={() => onMark(row, "skipped")}
            data-slot="ledger-mark-skipped"
          >
            {skipBusy ? (
              <Loader2
                aria-hidden="true"
                className="mr-2 size-4 animate-spin motion-reduce:animate-none"
              />
            ) : (
              <SkipForward aria-hidden="true" className="mr-2 size-4" />
            )}
            {t("medications.detail.verlauf.markSkipped")}
          </DropdownMenuItem>
        )}
        {canPin && (
          <DropdownMenuItem
            onClick={() => onPin(intake!.id as string, dueContext!.at)}
            data-slot="ledger-pin"
          >
            <Link2 aria-hidden="true" className="mr-2 size-4" />
            {t("medications.detail.verlauf.pin.action", {
              time: fmt.time(new Date(dueContext!.at)),
            })}
          </DropdownMenuItem>
        )}
        {canUnpin && (
          <DropdownMenuItem
            onClick={() => onUnpin(intake!.id as string)}
            data-slot="ledger-unpin"
          >
            <Unlink aria-hidden="true" className="mr-2 size-4" />
            {t("medications.detail.verlauf.pin.release")}
          </DropdownMenuItem>
        )}
        {intake?.id && (
          <>
            <DropdownMenuItem
              onClick={() =>
                onEdit({
                  id: intake.id as string,
                  takenAt: intake.takenAt,
                  skipped: intake.skipped,
                  scheduledFor: intake.scheduledFor,
                })
              }
              data-slot="ledger-edit"
            >
              <Pencil aria-hidden="true" className="mr-2 size-4" />
              {t("medications.detail.intake.rowActions.edit")}
            </DropdownMenuItem>
            {(row.status === "skipped" ||
              row.status === "taken_on_time" ||
              row.status === "taken_late") && (
              <DropdownMenuItem
                onClick={() =>
                  onToggleSkipped({
                    id: intake.id as string,
                    skipped: intake.skipped,
                    scheduledFor: intake.scheduledFor,
                  })
                }
                data-slot="ledger-toggle-skipped"
              >
                {intake.skipped ? (
                  <Check aria-hidden="true" className="mr-2 size-4" />
                ) : (
                  <SkipForward aria-hidden="true" className="mr-2 size-4" />
                )}
                {intake.skipped
                  ? t("medications.detail.verlauf.markAsTaken")
                  : t("medications.detail.verlauf.markAsSkipped")}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onDelete(intake.id as string)}
              data-slot="ledger-delete"
            >
              <Trash2 aria-hidden="true" className="mr-2 size-4" />
              {t("medications.detail.intake.rowActions.delete")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
