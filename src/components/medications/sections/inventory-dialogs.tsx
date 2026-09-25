"use client";

/**
 * The supply tab's write dialogs: register a container, correct one, and edit
 * the medication-level packaging the register flow prefills from.
 *
 * They sit beside the list rather than inside it because they are the other
 * half of the tab: the list answers "what do I hold", these answer "change
 * it". Sharing one file made a single client component out of two concerns
 * that only meet at the row shape, and the shape now lives in
 * `./inventory-shared`.
 *
 * Both dates a container carries are entered — and stored — as a calendar day
 * at the browser's local midnight, so the conversions live here too, next to
 * the fields that produce them.
 */

import { useId, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import { DateField } from "@/components/ui/date-field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslations } from "@/lib/i18n/context";
import { apiPatch, apiPost, apiPut } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";
import {
  formatUnitsPerDose,
  parseUnitsPerDoseInput,
} from "@/lib/medications/units-per-dose";
import { startsInUseClock } from "@/lib/medications/inventory/clock-container-types";
import {
  CONTAINER_TYPES,
  invalidateSupplyQueries,
  type ContainerType,
  type InventoryItem,
} from "./inventory-shared";

/**
 * Both dates the row carries are entered — and were always stored — as a
 * calendar day at the browser's local midnight. Reading them back in the
 * same zone is what makes the value the user typed the value they see;
 * pinning to UTC would slide the day for anyone east of Greenwich.
 */
export function toLocalDayInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The inverse: a `yyyy-MM-dd` day back to the instant the API stores. */
export function fromLocalDayInput(day: string): string | null {
  if (!day) return null;
  const at = new Date(`${day}T00:00:00`);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** Default container kind for the register flow, from the delivery form. */
export function defaultContainerType(
  deliveryForm: string | undefined,
): ContainerType {
  if (deliveryForm === "INJECTION") return "PEN";
  if (deliveryForm === "ORAL") return "BLISTER";
  return "OTHER";
}

/**
 * Register a new pack / container. Quantity (units), container type and
 * optional printed expiry → Dialog per ui-guidelines §2.3. The quantity
 * prefills from the medication's `dosesPerUnit` so the common case is
 * one tap. For multi-unit doses (`unitsPerDose > 1`) a segmented
 * Dosen | Einheiten control converts live — the POST always carries
 * units.
 */
export function AddInventoryDialog({
  medicationId,
  defaultUnitsTotal,
  unitsPerDose,
  initialContainerType,
  onClose,
}: {
  medicationId: string;
  defaultUnitsTotal: number | null;
  unitsPerDose: number;
  initialContainerType: ContainerType;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  const [quantity, setQuantity] = useState(
    defaultUnitsTotal && defaultUnitsTotal >= 1 && defaultUnitsTotal <= 1000
      ? String(defaultUnitsTotal)
      : "",
  );
  // The unit the typed quantity is read in. Only surfaced when a dose
  // spans several units; the stored value is ALWAYS units.
  const [quantityMode, setQuantityMode] = useState<"units" | "doses">("units");
  const [containerType, setContainerType] =
    useState<ContainerType>(initialContainerType);
  const [expiry, setExpiry] = useState("");
  // Carton labelling. Only offered for a PEN: the native pen list is the
  // one surface that renders them, and asking for a maker + strength on a
  // blister pack would be noise on the far commoner path.
  const [manufacturer, setManufacturer] = useState("");
  const [doseStrength, setDoseStrength] = useState("");
  const [busy, setBusy] = useState(false);
  const formId = useId();

  const parsed = Number(quantity);
  const effectiveMode = unitsPerDose > 1 ? quantityMode : "units";
  const units = effectiveMode === "doses" ? parsed * unitsPerDose : parsed;
  const quantityValid =
    Number.isInteger(parsed) && parsed >= 1 && units >= 1 && units <= 1000;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!quantityValid || busy) return;
    setBusy(true);
    try {
      await apiPost(`/api/medications/${medicationId}/inventory`, {
        // The wire field carries UNITS (v1.16.10 symmetric naming).
        unitsTotal: units,
        containerType,
        printedExpiry: expiry
          ? new Date(`${expiry}T00:00:00`).toISOString()
          : null,
        // Trimmed to null so a field the user opened and left blank stores
        // absence rather than an empty string.
        manufacturer: manufacturer.trim() || null,
        doseStrength: doseStrength.trim() || null,
      });
      await invalidateSupplyQueries(queryClient, medicationId);
      toast.success(t("medications.detail.bestand.addSuccess"));
      onClose();
    } catch {
      toast.error(t("medications.detail.bestand.addFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResponsiveSheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("medications.detail.bestand.addTitle")}
      description={t("medications.detail.bestand.addDescription")}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={!quantityValid || busy}
            aria-busy={busy || undefined}
          >
            {busy && (
              <Loader2
                aria-hidden="true"
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
              />
            )}
            {t("medications.detail.bestand.addSubmit")}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <label
            htmlFor="inventory-add-container-type"
            className="text-sm font-medium"
          >
            {t("medications.detail.bestand.containerTypeLabel")}
          </label>
          <Select
            value={containerType}
            onValueChange={(v) => setContainerType(v as ContainerType)}
          >
            <SelectTrigger
              id="inventory-add-container-type"
              className="w-full"
              data-slot="inventory-container-type"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONTAINER_TYPES.map((ct) => (
                <SelectItem key={ct} value={ct}>
                  {t(`medications.detail.bestand.containerType.${ct}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <label
            htmlFor="inventory-add-quantity"
            className="text-sm font-medium"
          >
            {t("medications.detail.bestand.addQuantityLabel")}
          </label>
          {unitsPerDose > 1 && (
            <div
              className="border-border/60 inline-flex rounded-md border p-0.5"
              role="group"
              aria-label={t("medications.detail.bestand.addQuantityLabel")}
              data-slot="inventory-quantity-mode"
            >
              <Button
                type="button"
                size="sm"
                variant={quantityMode === "doses" ? "secondary" : "ghost"}
                aria-pressed={quantityMode === "doses"}
                className="h-7 px-2 text-xs"
                onClick={() => setQuantityMode("doses")}
              >
                {t("medications.detail.bestand.quantityModeDoses")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={quantityMode === "units" ? "secondary" : "ghost"}
                aria-pressed={quantityMode === "units"}
                className="h-7 px-2 text-xs"
                onClick={() => setQuantityMode("units")}
              >
                {t("medications.detail.bestand.quantityModeUnits")}
              </Button>
            </div>
          )}
          <Input
            id="inventory-add-quantity"
            type="number"
            inputMode="numeric"
            min={1}
            max={
              effectiveMode === "doses" ? Math.floor(1000 / unitsPerDose) : 1000
            }
            step={1}
            required
            autoComplete="off"
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            aria-describedby="inventory-add-quantity-helper"
          />
          {unitsPerDose > 1 && Number.isInteger(parsed) && parsed >= 1 && (
            <p
              className="text-muted-foreground text-xs"
              data-slot="inventory-quantity-conversion"
            >
              {effectiveMode === "doses"
                ? t("medications.detail.bestand.quantityInUnits", { units })
                : // A unit count below one dose must not read "≈ 0 doses" —
                  // it is simply less than one dose.
                  Math.floor(parsed / unitsPerDose) === 0
                  ? t("medications.detail.bestand.quantityUnderOneDose")
                  : t("medications.detail.bestand.quantityInDoses", {
                      doses: Math.floor(parsed / unitsPerDose),
                    })}
            </p>
          )}
          <p
            id="inventory-add-quantity-helper"
            className="text-muted-foreground text-xs"
          >
            {t("medications.detail.bestand.addQuantityHelper")}
          </p>
        </div>
        <div className="space-y-2">
          <label htmlFor="inventory-add-expiry" className="text-sm font-medium">
            {t("medications.detail.bestand.addExpiryLabel")}
          </label>
          <DateField
            id="inventory-add-expiry"
            value={expiry}
            onChange={setExpiry}
          />
        </div>
        {containerType === "PEN" && (
          <>
            <div className="space-y-2">
              <label
                htmlFor="inventory-add-manufacturer"
                className="text-sm font-medium"
              >
                {t("medications.detail.bestand.addManufacturerLabel")}
              </label>
              <Input
                id="inventory-add-manufacturer"
                value={manufacturer}
                maxLength={120}
                onChange={(e) => setManufacturer(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <label
                htmlFor="inventory-add-dose-strength"
                className="text-sm font-medium"
              >
                {t("medications.detail.bestand.addDoseStrengthLabel")}
              </label>
              <Input
                id="inventory-add-dose-strength"
                value={doseStrength}
                maxLength={60}
                onChange={(e) => setDoseStrength(e.target.value)}
              />
              <p className="text-muted-foreground text-sm">
                {t("medications.detail.bestand.addDoseStrengthHint")}
              </p>
            </div>
          </>
        )}
      </form>
    </ResponsiveSheet>
  );
}

/**
 * Correct one container: the remaining-unit count (covers both "I
 * miscounted" and a manual withdrawal), the carton-printed expiry, and
 * the date it was opened. The server clamps the count to the item's
 * capacity and re-derives the state from the two dates; 0 units marks
 * the item used up.
 *
 * Both dates are editable because both decide the state — and the
 * opening date in particular is written by the intake consumption hook
 * without the user ever typing it, so an auto-open on a back-dated dose
 * needs a way back. Each field is sent only when it actually changed,
 * so saving a unit correction never rewrites a date the user did not
 * touch.
 */
export function AdjustInventoryDialog({
  medicationId,
  item,
  onClose,
}: {
  medicationId: string;
  item: InventoryItem;
  onClose: () => void;
}) {
  const { t } = useTranslations();
  const queryClient = useQueryClient();
  // v1.18.3 (iOS#31) — an unknown remaining count (null) pre-fills empty,
  // not the literal "null"; the operator types the corrected figure.
  const [value, setValue] = useState(
    item.unitsRemaining == null ? "" : String(item.unitsRemaining),
  );
  const initialExpiry = toLocalDayInput(item.printedExpiry);
  const initialOpened = toLocalDayInput(item.firstUseAt);
  const [expiry, setExpiry] = useState(initialExpiry);
  const [opened, setOpened] = useState(initialOpened);
  const [busy, setBusy] = useState(false);
  const formId = useId();

  const parsed = Number(value);
  // v1.16.12 — fractional remaining allowed (a ½-tablet dose leaves 29.5).
  // v1.18.3 — when capacity is unknown (null) the only ceiling is finiteness.
  const valid =
    value.trim() !== "" &&
    Number.isFinite(parsed) &&
    parsed >= 0 &&
    (item.unitsTotal == null || parsed <= item.unitsTotal);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    try {
      await apiPatch(`/api/medications/${medicationId}/inventory/${item.id}`, {
        // The wire field carries UNITS (v1.16.10 symmetric naming).
        unitsRemaining: parsed,
        // Absent means untouched on the server, so only changed fields
        // ride along. A cleared field sends null, which is a deliberate
        // "there is no such date" — not the same as leaving it alone.
        ...(expiry !== initialExpiry && {
          printedExpiry: fromLocalDayInput(expiry),
        }),
        ...(opened !== initialOpened && {
          markAsFirstUseAt: fromLocalDayInput(opened),
        }),
      });
      await invalidateSupplyQueries(queryClient, medicationId);
      toast.success(t("medications.detail.bestand.adjustSuccess"));
      onClose();
    } catch {
      toast.error(t("medications.detail.bestand.adjustFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResponsiveSheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("medications.detail.bestand.adjustTitle")}
      description={t("medications.detail.bestand.adjustDescription")}
      footer={
        <>
          <Button type="button" variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={!valid || busy}
            aria-busy={busy || undefined}
          >
            {busy && (
              <Loader2
                aria-hidden="true"
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
              />
            )}
            {t("medications.detail.bestand.adjustSubmit")}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <label
            htmlFor="inventory-adjust-remaining"
            className="text-sm font-medium"
          >
            {t("medications.detail.bestand.adjustQuantityLabel")}
          </label>
          <Input
            id="inventory-adjust-remaining"
            type="number"
            inputMode="decimal"
            min={0}
            max={item.unitsTotal ?? undefined}
            step="any"
            required
            autoComplete="off"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-describedby="inventory-adjust-helper"
          />
          <p
            id="inventory-adjust-helper"
            className="text-muted-foreground text-xs"
          >
            {t("medications.detail.bestand.adjustHelper", {
              total: item.unitsTotal ?? t("medications.detail.bestand.unknown"),
            })}
          </p>
        </div>
        <div className="space-y-2">
          <label
            htmlFor="inventory-edit-expiry"
            className="text-sm font-medium"
          >
            {t("medications.detail.bestand.editExpiryLabel")}
          </label>
          <DateField
            id="inventory-edit-expiry"
            value={expiry}
            onChange={setExpiry}
            aria-describedby="inventory-edit-expiry-helper"
            data-testid="inventory-edit-expiry"
          />
          <p
            id="inventory-edit-expiry-helper"
            className="text-muted-foreground text-xs"
          >
            {t("medications.detail.bestand.editExpiryHelper")}
          </p>
        </div>
        <div className="space-y-2">
          <label
            htmlFor="inventory-edit-opened"
            className="text-sm font-medium"
          >
            {t("medications.detail.bestand.editOpenedLabel")}
          </label>
          <DateField
            id="inventory-edit-opened"
            value={opened}
            onChange={setOpened}
            aria-describedby="inventory-edit-opened-helper"
            data-testid="inventory-edit-opened"
          />
          <p
            id="inventory-edit-opened-helper"
            className="text-muted-foreground text-xs"
          >
            {startsInUseClock(item.containerType)
              ? t("medications.detail.bestand.editOpenedHelperClock")
              : t("medications.detail.bestand.editOpenedHelper")}
          </p>
        </div>
      </form>
    </ResponsiveSheet>
  );
}

/**
 * Edit the medication-level packaging economics from the supply tab:
 * units one dose consumes, and the default container size the register
 * flow prefills. Both PUT sparsely onto the medication — the wizard's
 * dose step stays the source on create; this is the correction surface
 * for a manufacturer switch (same medication, different blister size).
 */
export function PackagingDialog({
  medicationId,
  unitsPerDose,
  dosesPerUnit,
  onClose,
}: {
  medicationId: string;
  unitsPerDose: number;
  dosesPerUnit: number | null;
  onClose: () => void;
}) {
  const { t, locale } = useTranslations();
  const queryClient = useQueryClient();
  // #1034 — opens on the value as the reader writes it ("1,5" in German)
  // and reads back through the same parser as the wizard's Other field.
  const [perDoseValue, setPerDoseValue] = useState(() =>
    formatUnitsPerDose(unitsPerDose, locale),
  );
  const [packValue, setPackValue] = useState(
    dosesPerUnit === null ? "" : String(dosesPerUnit),
  );
  const [busy, setBusy] = useState(false);
  const formId = useId();

  const parsedPerDose = parseUnitsPerDoseInput(perDoseValue);
  const perDoseValid = parsedPerDose !== null;
  const parsedPack = packValue.trim() === "" ? null : Number(packValue);
  const packValid =
    parsedPack === null ||
    (Number.isInteger(parsedPack) && parsedPack >= 1 && parsedPack <= 1000);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!perDoseValid || !packValid || busy) return;
    setBusy(true);
    try {
      await apiPut(`/api/medications/${medicationId}`, {
        unitsPerDose: parsedPerDose,
        dosesPerUnit: parsedPack,
      });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.medicationDetail(medicationId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.medications(),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.medicationInventory(medicationId),
        }),
      ]);
      toast.success(t("medications.detail.bestand.packagingSuccess"));
      onClose();
    } catch {
      toast.error(t("medications.detail.bestand.packagingFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ResponsiveSheet
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("medications.detail.bestand.packagingTitle")}
      description={t("medications.detail.bestand.packagingDescription")}
      footer={
        <>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            disabled={busy}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="submit"
            form={formId}
            disabled={!perDoseValid || !packValid || busy}
          >
            {busy && (
              <Loader2
                aria-hidden="true"
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
              />
            )}
            {t("common.save")}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <label
            htmlFor="packaging-units-per-dose"
            className="text-sm font-medium"
          >
            {t("medications.detail.bestand.packagingUnitsPerDoseLabel")}
          </label>
          <Input
            id="packaging-units-per-dose"
            type="text"
            inputMode="decimal"
            maxLength={12}
            required
            autoComplete="off"
            value={perDoseValue}
            onChange={(e) => setPerDoseValue(e.target.value)}
            aria-invalid={
              (perDoseValue.trim() !== "" && !perDoseValid) || undefined
            }
            aria-describedby="packaging-units-per-dose-helper"
          />
          <p
            id="packaging-units-per-dose-helper"
            className="text-muted-foreground text-xs"
          >
            {t("medications.detail.bestand.packagingUnitsPerDoseHelper")}
          </p>
        </div>
        <div className="space-y-2">
          <label
            htmlFor="packaging-default-pack"
            className="text-sm font-medium"
          >
            {t("medications.detail.bestand.packagingDefaultPackLabel")}
          </label>
          <Input
            id="packaging-default-pack"
            type="number"
            inputMode="numeric"
            min={1}
            max={1000}
            step={1}
            autoComplete="off"
            value={packValue}
            onChange={(e) => setPackValue(e.target.value)}
            aria-describedby="packaging-default-pack-helper"
          />
          <p
            id="packaging-default-pack-helper"
            className="text-muted-foreground text-xs"
          >
            {t("medications.detail.bestand.packagingDefaultPackHelper")}
          </p>
        </div>
      </form>
    </ResponsiveSheet>
  );
}
