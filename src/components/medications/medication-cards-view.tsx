"use client";

import type { ComponentProps } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MedicationCard } from "@/components/medications/medication-card";
import { Glp1MedicationCard } from "@/components/medications/glp1-medication-card";
import {
  MedicationGroupHeader,
  type MedicationGroup,
} from "@/components/medications/medication-list-groups";
import type { MedicationGroupBy } from "@/lib/medication-list-layout";
import { cn } from "@/lib/utils";

/**
 * Loading placeholder for one medication card. Renders the
 * real Card/CardContent shell (so padding, radius and gap match the
 * loaded card exactly) with the shared Skeleton primitive standing in
 * for each populated slot.
 */
export function MedicationCardSkeleton() {
  return (
    <Card className="h-full" aria-hidden="true">
      <div className="flex items-start justify-between gap-2 px-4 md:px-6">
        <div className="space-y-2">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-3.5 w-20" />
        </div>
        <Skeleton className="size-8 rounded-md" />
      </div>
      <CardContent className="flex flex-col space-y-3.5">
        <Skeleton className="h-6 w-40 rounded-full" />
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-48" />
          <Skeleton className="h-3.5 w-36" />
        </div>
        <div className="space-y-2">
          <Skeleton className="h-3.5 w-full" />
          <Skeleton className="h-3.5 w-full" />
        </div>
        <div className="flex gap-2 pt-1">
          <Skeleton className="h-9 flex-1" />
          <Skeleton className="h-9 flex-1" />
        </div>
      </CardContent>
    </Card>
  );
}

type CardMedication = ComponentProps<typeof MedicationCard>["medication"] &
  ComponentProps<typeof Glp1MedicationCard>["medication"];

export interface MedicationCardsViewProps<T extends CardMedication> {
  activeMeds: readonly T[];
  inactiveMeds: readonly T[];
  activeGroups: MedicationGroup<T>[];
  inactiveGroups: MedicationGroup<T>[];
  groupBy: MedicationGroupBy;
  highlightId: string | null;
  isOpen: (group: MedicationGroup<T>) => boolean;
  toggle: (group: MedicationGroup<T>) => void;
  openEdit: (med: T) => void;
  openHistory: (med: T) => void;
  inactiveLabel: string;
}

export function MedicationCardsView<T extends CardMedication>({
  activeMeds,
  inactiveMeds,
  activeGroups,
  inactiveGroups,
  groupBy,
  highlightId,
  isOpen,
  toggle,
  openEdit,
  openHistory,
  inactiveLabel,
}: MedicationCardsViewProps<T>) {
  const renderCard = (med: T) =>
    med.treatmentClass === "GLP1" && !med.asNeeded ? (
      <Glp1MedicationCard
        key={med.id}
        medication={med}
        onEdit={() => openEdit(med)}
        onOpenHistory={() => openHistory(med)}
        highlighted={highlightId === med.id}
      />
    ) : (
      <MedicationCard
        key={med.id}
        medication={med}
        onEdit={() => openEdit(med)}
        onOpenHistory={() => openHistory(med)}
        highlighted={highlightId === med.id}
      />
    );

  const renderGroups = (
    groups: MedicationGroup<T>[],
    section: "active" | "inactive",
  ) =>
    groups.map((group) => {
      const open = isOpen(group);
      const panelId = `med-group-${section}-${group.category.key}`;
      return (
        <section key={group.category.key} className="space-y-3.5">
          <MedicationGroupHeader
            category={group.category}
            count={group.medications.length}
            open={open}
            onToggle={() => toggle(group)}
            panelId={panelId}
          />
          <div
            id={panelId}
            hidden={!open}
            className={cn("grid gap-4 sm:grid-cols-2", !open && "hidden")}
          >
            {open && group.medications.map(renderCard)}
          </div>
        </section>
      );
    });

  if (groupBy === "category") {
    return (
      <div className="space-y-6">
        {activeGroups.length > 0 && (
          <div className="space-y-4">
            {renderGroups(activeGroups, "active")}
          </div>
        )}
        {inactiveGroups.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-muted-foreground text-sm font-medium">
              {inactiveLabel} ({inactiveMeds.length})
            </h2>
            {renderGroups(inactiveGroups, "inactive")}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {activeMeds.length > 0 && (
        <div className="space-y-3.5">
          <div className="grid gap-4 sm:grid-cols-2">
            {activeMeds.map(renderCard)}
          </div>
        </div>
      )}

      {inactiveMeds.length > 0 && (
        <div className="space-y-3.5">
          <h2 className="text-muted-foreground text-sm font-medium">
            {inactiveLabel} ({inactiveMeds.length})
          </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {inactiveMeds.map(renderCard)}
          </div>
        </div>
      )}
    </div>
  );
}
