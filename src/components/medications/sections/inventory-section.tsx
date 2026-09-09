"use client";

/**
 * v1.15.18 — Bestand (supply) tab body.
 *
 * v1.16.1 — the tab grows its write affordances:
 *
 *   - REGISTER: a "+" flow (header button + the empty-state CTA) that
 *     records a new pack / container via
 *     `POST /api/medications/[id]/inventory` — quantity in units,
 *     optional printed expiry. The quantity prefills from the
 *     medication's `dosesPerUnit` when configured.
 *   - CORRECT: a per-item adjust flow (`PATCH …/inventory/[itemId]`) for
 *     stock corrections and manual withdrawals — the count is set
 *     absolutely, clamped server-side to the item's capacity, and the
 *     canonical state machine derives the next state (0 ⇒ used up). The
 *     same flow edits the two dates that decide the state: the
 *     carton-printed expiry and the date the container was opened. The
 *     opening date is written by the intake consumption hook without the
 *     user typing it, so it needs a correction path more than any other
 *     field on the row.
 *   - DELETE: a per-item trash affordance behind a destructive confirm
 *     (`DELETE …/inventory/[itemId]`). Consumption stamps on intake
 *     events that referenced the container stay in place; a later
 *     restore skips the missing item.
 *
 * v1.16.10 — items count UNITS (tablets / ampoules / puffs);
 * `Medication.unitsPerDose` maps units to doses. Every dose-facing
 * readout divides by it (floor), with the raw unit count as secondary
 * text when the factor is > 1. The register flow gains a container-type
 * select (pen / ampoule / tablet pack / …, defaulted from the delivery
 * form) and, for multi-unit doses, a segmented Dosen | Einheiten
 * quantity input with live conversion — the wire always carries units.
 *
 * Reads stay on `GET /api/medications/[id]/inventory` (the same
 * per-item list the inventory CRUD route serves): a calm summary — the
 * doses remaining across every non-terminal item — plus a per-item list
 * with its container type and state badge. Shown for ALL medications
 * (pill packs count too).
 *
 * This file is the read half: the summary, the packaging line, and the
 * per-item rows. The three write dialogs live in `./inventory-dialogs`,
 * and the row shape they both speak in `./inventory-shared`. They are
 * re-exported here so the tab keeps one import surface.
 */

import { useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, PackageOpen, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteButton } from "@/components/data-list/delete-button";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { EmptyState } from "@/components/ui/empty-state";
import { SettingsGroup } from "@/components/medications/settings-group";
import { useDateFormatPreference, useTranslations } from "@/lib/i18n/context";
import { formatDate } from "@/lib/date-format";
import { queryKeys } from "@/lib/query-keys";
import { formatUnitCount } from "@/components/medications/units-per-dose";
import { apiDelete, apiGet } from "@/lib/api/api-fetch";
import type { SupplySummary } from "@/lib/medications/inventory/summary";
import {
  AddInventoryDialog,
  AdjustInventoryDialog,
  PackagingDialog,
  defaultContainerType,
  toLocalDayInput,
} from "./inventory-dialogs";
import {
  invalidateSupplyQueries,
  type InventoryItem,
  type InventoryState,
} from "./inventory-shared";

export { AddInventoryDialog, AdjustInventoryDialog } from "./inventory-dialogs";
export { invalidateSupplyQueries } from "./inventory-shared";

interface InventoryResponse {
  items: InventoryItem[];
  // v1.19.0 (iOS#25) — server-authoritative supply summary. The headline
  // figures are computed server-side via the shared `summariseSupply`
  // helper and shipped ready; the client renders them rather than
  // re-deriving in the browser, so web and iOS agree on the Bestand.
  summary?: SupplySummary;
  meta?: { total: number };
}

const STATE_BADGE: Record<
  InventoryState,
  "secondary" | "outline" | "destructive"
> = {
  ACTIVE: "secondary",
  IN_USE: "secondary",
  EXPIRED: "destructive",
  USED_UP: "outline",
};

export function InventorySection({
  medicationId,
  dosesPerUnit,
  unitsPerDose,
  deliveryForm,
}: {
  medicationId: string;
  /** Prefills the register flow's quantity when the medication tracks it. */
  dosesPerUnit?: number | null;
  /** Units one dose consumes; dose-derived readouts divide by it. */
  unitsPerDose?: number | null;
  /** Defaults the register flow's container type. */
  deliveryForm?: string;
}) {
  const { t, locale } = useTranslations();
  const { inSharedRecord } = useRecordCapabilities();
  const dateFormatPref = useDateFormatPreference();
  const queryClient = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [adjustItem, setAdjustItem] = useState<InventoryItem | null>(null);
  const [packagingOpen, setPackagingOpen] = useState(false);

  async function deleteItem(item: InventoryItem) {
    try {
      await apiDelete(`/api/medications/${medicationId}/inventory/${item.id}`);
      await invalidateSupplyQueries(queryClient, medicationId);
      toast.success(t("medications.detail.bestand.deleteSuccess"));
    } catch {
      toast.error(t("medications.detail.bestand.deleteFailed"));
    }
  }

  // v1.16.12 — guard at > 0, NOT ≥ 1: a fractional unitsPerDose (½ tablet
  // per dose) must stay fractional or the dose-derived counts halve.
  const perDose = unitsPerDose && unitsPerDose > 0 ? unitsPerDose : 1;

  const { data, isLoading } = useQuery<InventoryResponse>({
    queryKey: queryKeys.medicationInventory(medicationId),
    queryFn: async () => {
      return apiGet<InventoryResponse>(
        `/api/medications/${medicationId}/inventory`,
      );
    },
    staleTime: 30_000,
    // v1.16.12 (#316) — fresh on every mount so reopening the supply tab
    // reflects stock changed elsewhere (a dose on another device, a
    // refill) without a manual reload.
    refetchOnMount: "always",
  });

  // v1.16.11 — the low-stock alert threshold, for the cross-link row
  // below the supply summary (same shared key + cache the cards read).
  // Null on failure falls back to the server default (7 days).
  const { data: thresholds } = useQuery({
    queryKey: queryKeys.settingsReminderThresholds(),
    queryFn: async () => {
      try {
        return await apiGet<{
          lateMinutes: number;
          missedMinutes: number;
          lowStockRunwayDays: number | null;
        }>("/api/settings/reminder-thresholds");
      } catch {
        return null;
      }
    },
    staleTime: 5 * 60 * 1000,
  });
  const lowStockDays = thresholds == null ? 7 : thresholds.lowStockRunwayDays;

  if (isLoading) {
    return (
      <div
        className="flex h-32 items-center justify-center"
        role="status"
        aria-busy="true"
        aria-live="polite"
      >
        <Loader2
          aria-hidden="true"
          className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none"
        />
      </div>
    );
  }

  const items = Array.isArray(data?.items) ? data.items : [];
  // v1.19.0 (iOS#25) — the supply headline is server-authoritative: the
  // GET response carries a `summary` computed server-side through the
  // shared `summariseSupply` helper (ACTIVE / IN_USE with units left;
  // EXPIRED surfaced separately, never available; dose-derived counts
  // floored). The client renders these ready figures so web and iOS show
  // identical numbers. The per-item rows below still divide by `perDose`
  // locally, which is presentation only — the canonical pool is the DTO.
  const summary = data?.summary;
  const remainingUnits = summary?.unitsRemaining ?? 0;
  const totalUnits = summary?.unitsTotal ?? 0;
  const remaining = summary?.dosesRemaining ?? 0;
  const total = summary?.dosesTotal ?? 0;
  const expiredUnits = summary?.expiredUnits ?? 0;
  // Nothing available, but stock is sitting in containers that were
  // declared unusable. That is a different statement from "no supply
  // recorded" and the headline has to make the difference.
  const allExpired = totalUnits === 0 && expiredUnits > 0;

  const dialogs = (
    <>
      {addOpen && (
        <AddInventoryDialog
          medicationId={medicationId}
          defaultUnitsTotal={dosesPerUnit ?? null}
          unitsPerDose={perDose}
          initialContainerType={defaultContainerType(deliveryForm)}
          onClose={() => setAddOpen(false)}
        />
      )}
      {adjustItem && (
        <AdjustInventoryDialog
          medicationId={medicationId}
          item={adjustItem}
          onClose={() => setAdjustItem(null)}
        />
      )}
      {packagingOpen && (
        <PackagingDialog
          medicationId={medicationId}
          unitsPerDose={perDose}
          dosesPerUnit={dosesPerUnit ?? null}
          onClose={() => setPackagingOpen(false)}
        />
      )}
    </>
  );

  if (items.length === 0) {
    return (
      <>
        <EmptyState
          icon={<PackageOpen className="size-6" />}
          title={t("medications.detail.bestand.empty")}
          description={t("medications.detail.bestand.emptyHelper")}
          ctaSize="lg"
          action={
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              {t("medications.detail.bestand.emptyCta")}
            </Button>
          }
        />
        {dialogs}
      </>
    );
  }

  return (
    <div className="space-y-4" data-slot="medication-inventory-section">
      <SettingsGroup
        label={t("medications.detail.bestand.title")}
        dataSlot="inventory-summary-group"
      >
        <div className="flex items-center justify-between gap-3 py-3">
          <p className="text-foreground text-sm font-medium">
            {/* "0 of 0 doses" beside "+ 54 units expired" read as two
                contradicting statements — the first says nothing was ever
                configured, the second says stock was written off. When the
                available pool is empty and expired stock is all that is
                left, say that instead. */}
            {allExpired
              ? t("medications.detail.bestand.summaryAllExpired", {
                  units: expiredUnits,
                })
              : t("medications.detail.bestand.summary", { remaining, total })}
            {perDose !== 1 && !allExpired && (
              <span className="text-muted-foreground block text-xs font-normal">
                {t("medications.detail.bestand.unitsDetail", {
                  remaining: formatUnitCount(remainingUnits),
                  total: formatUnitCount(totalUnits),
                })}
              </span>
            )}
            {expiredUnits > 0 && !allExpired && (
              <span
                className="text-muted-foreground block text-xs font-normal"
                data-slot="inventory-expired-suffix"
              >
                {t("medications.detail.bestand.expiredSuffix", {
                  units: expiredUnits,
                })}
              </span>
            )}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAddOpen(true)}
            className="min-h-11 shrink-0 sm:min-h-9"
            data-slot="inventory-add-button"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t("medications.detail.bestand.addButton")}
          </Button>
        </div>
        {/* v1.16.11 — cross-link to the low-stock alert setting: the
            threshold lives in Settings → Notifications, but the question
            "when will it warn me?" comes up here, where the stock lives. */}
        {/* `/settings` is not a shared-record destination, so the cross-link
            is withheld under a switch rather than opening onto the "not part
            of what was shared" panel. */}
        {!inSharedRecord && (
          <div className="py-2">
            <Link
              href="/settings/notifications#low-stock"
              className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
              data-slot="inventory-low-stock-link"
            >
              {lowStockDays !== null
                ? t("medications.detail.bestand.lowStockLinkOn", {
                    days: lowStockDays,
                  })
                : t("medications.detail.bestand.lowStockLinkOff")}
            </Link>
          </div>
        )}
      </SettingsGroup>

      {/* v1.16.11 — packaging economics surfaced where the stock lives:
          the wizard's dose step owns these on create/edit, but a
          manufacturer switch (a different blister size) happens while
          looking at the supply, so the supply tab carries them too. */}
      <SettingsGroup
        label={t("medications.detail.bestand.packagingTitle")}
        dataSlot="inventory-packaging-group"
      >
        <div className="flex items-center justify-between gap-3 py-3">
          <p className="text-foreground text-sm font-medium">
            {t("medications.detail.bestand.packagingUnitsPerDose", {
              units: perDose,
            })}
            <span className="text-muted-foreground block text-xs font-normal">
              {dosesPerUnit != null
                ? t("medications.detail.bestand.packagingDefaultPack", {
                    units: dosesPerUnit,
                  })
                : t("medications.detail.bestand.packagingNoDefaultPack")}
            </span>
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPackagingOpen(true)}
            className="min-h-11 shrink-0 sm:min-h-9"
            data-slot="inventory-packaging-edit"
          >
            {t("medications.detail.bestand.packagingEdit")}
          </Button>
        </div>
      </SettingsGroup>

      <SettingsGroup
        label={t("medications.detail.bestand.itemsTitle")}
        dataSlot="inventory-items-group"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className="flex items-center justify-between gap-3 py-3"
            data-slot="inventory-item-row"
          >
            <span className="text-foreground text-sm">
              <span className="block">
                {t(
                  `medications.detail.bestand.containerType.${item.containerType}`,
                )}
              </span>
              {/* Meta line: per-container figures with the state badge
                  inline at meta-text size — read-only, never a control. */}
              <span className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
                <span>
                  {/* v1.18.3 (iOS#31) — an unknown unit count (null) renders
                      "—" rather than a fabricated 0-dose figure. */}
                  {item.unitsRemaining == null || item.unitsTotal == null
                    ? t("medications.detail.bestand.unknown")
                    : t("medications.detail.bestand.doses", {
                        remaining: Math.floor(item.unitsRemaining / perDose),
                        total: Math.floor(item.unitsTotal / perDose),
                      })}
                  {perDose !== 1 &&
                    item.unitsRemaining != null &&
                    item.unitsTotal != null && (
                      <>
                        {" · "}
                        {t("medications.detail.bestand.unitsDetail", {
                          remaining: formatUnitCount(item.unitsRemaining),
                          total: formatUnitCount(item.unitsTotal),
                        })}
                      </>
                    )}
                </span>
                <Badge
                  variant={STATE_BADGE[item.state]}
                  className="px-1.5 py-0 text-xs font-normal"
                  data-slot="inventory-state-badge"
                >
                  {t(`medications.detail.bestand.state.${item.state}`)}
                </Badge>
              </span>
              {/* The two dates that decide the row's state. They used to
                  be invisible here — a container could read EXPIRED with
                  nothing on screen to explain why, and no way to correct
                  the value that caused it. */}
              {(item.firstUseAt || item.printedExpiry) && (
                <span
                  className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs"
                  data-slot="inventory-item-dates"
                >
                  {item.firstUseAt && (
                    <span>
                      {t("medications.detail.bestand.openedOn", {
                        date: formatDate(
                          toLocalDayInput(item.firstUseAt),
                          dateFormatPref,
                          locale,
                        ),
                      })}
                    </span>
                  )}
                  {item.firstUseAt && item.printedExpiry && <span>·</span>}
                  {item.printedExpiry && (
                    <span>
                      {t("medications.detail.bestand.expiresOn", {
                        date: formatDate(
                          toLocalDayInput(item.printedExpiry),
                          dateFormatPref,
                          locale,
                        ),
                      })}
                    </span>
                  )}
                </span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setAdjustItem(item)}
                className="min-h-11 sm:min-h-9"
                data-slot="inventory-adjust-button"
              >
                {t("medications.detail.bestand.adjustButton")}
              </Button>
              <DeleteButton
                domain="medications"
                onConfirm={() => void deleteItem(item)}
                title={t("medications.detail.bestand.deleteTitle")}
                description={t("medications.detail.bestand.deleteDescription")}
              />
            </span>
          </div>
        ))}
      </SettingsGroup>

      {dialogs}
    </div>
  );
}
