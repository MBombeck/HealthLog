"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { ListGroup, ListItem } from "@/components/ui/list-row";
import { NativeSelect } from "@/components/ui/native-select";
import { ResponsiveSheet } from "@/components/ui/responsive-sheet";
import {
  EMERGENCY_CARD_FIELDS,
  type EmergencyCardField,
} from "@/lib/emergency-card/fields";
import { useTranslations } from "@/lib/i18n/context";

/**
 * The two choices a QR link and a Wallet pass are made with, as two rows of
 * their card: what it shows (a count, the list in a sheet) and when it ends
 * (a select on the right). The twelve tick boxes used to stand open in each
 * card, one per line, twice on the page.
 */

export const EXPIRY_CHOICES = ["none", "30", "365", "730"] as const;
export type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];

/** Rows edge to edge in a card, a line above each (settings-pattern 3.2). */
const ROW = "border-t md:[&>div]:px-6";

export function CardFieldRows({
  idPrefix,
  fieldsLabel,
  expiryLabel,
  fields,
  onFieldsChange,
  expiry,
  onExpiryChange,
}: {
  idPrefix: string;
  fieldsLabel: string;
  expiryLabel: string;
  fields: ReadonlySet<EmergencyCardField>;
  onFieldsChange: (next: Set<EmergencyCardField>) => void;
  expiry: ExpiryChoice;
  onExpiryChange: (next: ExpiryChoice) => void;
}) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const toggle = (f: EmergencyCardField) => {
    const next = new Set(fields);
    if (next.has(f)) next.delete(f);
    else next.add(f);
    onFieldsChange(next);
  };
  return (
    <>
      <ul className="-mx-4 border-b md:-mx-6" data-slot={`${idPrefix}-rows`}>
        <ListItem
          className={ROW}
          data-slot={`${idPrefix}-fields-row`}
          onSelect={() => setOpen(true)}
          title={fieldsLabel}
          trailing={
            <span className="text-muted-foreground font-normal">
              {t("emergencyCard.fieldsCount", {
                count: fields.size,
                total: EMERGENCY_CARD_FIELDS.length,
              })}
            </span>
          }
        />
        <ListItem
          className={ROW}
          title={
            <Label htmlFor={`${idPrefix}-expiry`} className="cursor-pointer">
              {expiryLabel}
            </Label>
          }
          trailing={
            <NativeSelect
              id={`${idPrefix}-expiry`}
              value={expiry}
              // No frame: the choice reads as the row's value.
              className="h-9 w-auto border-transparent bg-transparent font-normal shadow-none"
              onChange={(e) => onExpiryChange(e.target.value as ExpiryChoice)}
            >
              {EXPIRY_CHOICES.map((c) => (
                <option key={c} value={c}>
                  {t(`emergencyCard.link.expiry.${c}`)}
                </option>
              ))}
            </NativeSelect>
          }
        />
      </ul>
      <ResponsiveSheet
        open={open}
        onOpenChange={setOpen}
        title={fieldsLabel}
        footer={
          <Button type="button" onClick={() => setOpen(false)}>
            {t("links.picker.done")}
          </Button>
        }
      >
        <ListGroup data-slot={`${idPrefix}-fields`}>
          {EMERGENCY_CARD_FIELDS.map((f) => (
            <ListItem
              key={f}
              leading={
                <Checkbox
                  id={`${idPrefix}-field-${f}`}
                  checked={fields.has(f)}
                  onCheckedChange={() => toggle(f)}
                />
              }
              title={
                // The label stretches over the row, so the whole row ticks.
                <Label
                  htmlFor={`${idPrefix}-field-${f}`}
                  className="block cursor-pointer after:absolute after:inset-0 after:content-['']"
                >
                  {t(`emergencyCard.fields.${f}`)}
                </Label>
              }
            />
          ))}
        </ListGroup>
      </ResponsiveSheet>
    </>
  );
}
