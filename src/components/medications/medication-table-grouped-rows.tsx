"use client";

import { Fragment, type ReactNode } from "react";
import { TableCell, TableRow } from "@/components/ui/table";
import {
  MedicationGroupHeader,
  type MedicationGroup,
} from "@/components/medications/medication-list-groups";
import type { TableMedication } from "@/components/medications/medication-table";

export function MedicationTableGroupedRows({
  groups,
  isOpen,
  toggle,
  colSpan,
  renderRows,
  sectionLabel,
}: {
  groups: MedicationGroup<TableMedication>[];
  isOpen: (group: MedicationGroup<TableMedication>) => boolean;
  toggle: (group: MedicationGroup<TableMedication>) => void;
  colSpan: number;
  renderRows: (medications: readonly TableMedication[]) => ReactNode;
  /**
   * A label row above the groups, for the inactive block: without it the
   * inactive groups would repeat the active category headers with nothing
   * telling them apart.
   */
  sectionLabel?: string;
}) {
  if (groups.length === 0) return null;
  return (
    <>
      {sectionLabel && (
        <TableRow className="hover:bg-transparent">
          <TableCell
            colSpan={colSpan}
            className="text-muted-foreground px-4 pt-4 pb-1.5 text-sm font-medium"
          >
            {sectionLabel}
          </TableCell>
        </TableRow>
      )}
      {groups.map((group) => {
        const open = isOpen(group);
        return (
          <Fragment key={group.category.key}>
            <TableRow className="bg-muted/40 hover:bg-transparent">
              <TableCell colSpan={colSpan} className="px-4 py-1.5">
                <MedicationGroupHeader
                  category={group.category}
                  count={group.medications.length}
                  open={open}
                  onToggle={() => toggle(group)}
                />
              </TableCell>
            </TableRow>
            {open && renderRows(group.medications)}
          </Fragment>
        );
      })}
    </>
  );
}
