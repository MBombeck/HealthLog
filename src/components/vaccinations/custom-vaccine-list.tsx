"use client";

/**
 * v1.42 (#1005) — the record's own vaccine definitions, below the dose log.
 *
 * Rendered only once the record holds at least one: the way in is the dose
 * form's picker ("Add own vaccine"), and an empty heading on every Impfpass
 * would advertise a feature most people never need. Each row names the
 * definition and reads it back in the catalogue's own sentences, so a
 * definition and a catalogue entry describe themselves the same way. A row
 * opens the definition for someone who may edit it.
 */
import { useState } from "react";
import { Plus, Syringe } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeading } from "@/components/ui/section-heading";
import { useTranslations } from "@/lib/i18n/context";
import {
  customLookupOf,
  resolveVaccineEntry,
} from "@/lib/vaccinations/resolve-vaccine-entry";
import { CatalogInfo } from "./catalog-info";
import { CustomVaccineSheet } from "./custom-vaccine-sheet";
import type { CustomVaccine } from "./use-vaccinations";

export function CustomVaccineList({
  customs,
  canAdd,
  canManage,
}: {
  customs: readonly CustomVaccine[];
  /** WRITE on `profile`: may add a definition. */
  canAdd: boolean;
  /** MANAGE on `profile`: may edit and remove one. */
  canManage: boolean;
}) {
  const { t } = useTranslations();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CustomVaccine | null>(null);
  const [session, setSession] = useState(0);

  if (customs.length === 0) return null;

  const openSheet = (row: CustomVaccine | null) => {
    setEditing(row);
    setSession((n) => n + 1);
    setOpen(true);
  };

  return (
    <section className="space-y-4" data-slot="custom-vaccine-section">
      <SectionHeading
        icon={Syringe}
        title={t("vaccinations.custom.title")}
        subtitle={t("vaccinations.custom.sectionDescription")}
        action={
          canAdd ? (
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 sm:min-h-9"
              data-slot="custom-vaccine-add"
              onClick={() => openSheet(null)}
            >
              <Plus className="size-4" aria-hidden />
              {t("vaccinations.custom.add")}
            </Button>
          ) : null
        }
      />

      <div className="space-y-2">
        {customs.map((custom) => {
          const entry = resolveVaccineEntry(
            { customVaccineId: custom.id },
            customLookupOf([custom]),
          );
          const editable = canManage;
          return (
            <Card
              key={custom.id}
              className="hover:bg-muted/40 gap-0 transition-colors"
              data-slot="custom-vaccine-row"
              data-custom-vaccine-id={custom.id}
              role={editable ? "button" : undefined}
              tabIndex={editable ? 0 : undefined}
              onClick={editable ? () => openSheet(custom) : undefined}
              onKeyDown={
                editable
                  ? (event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        openSheet(custom);
                      }
                    }
                  : undefined
              }
            >
              <CardContent className="space-y-1 px-4 py-3">
                <p className="text-foreground text-sm font-medium">
                  {custom.name}
                </p>
                <CatalogInfo entry={entry} />
              </CardContent>
            </Card>
          );
        })}
      </div>

      <CustomVaccineSheet
        key={session}
        open={open}
        onOpenChange={setOpen}
        customVaccine={editing}
        canRemove={canManage}
      />
    </section>
  );
}
