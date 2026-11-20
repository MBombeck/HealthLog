"use client";

import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading placeholder for the table view. Mirrors the loaded table's
 * shell (same container, same column count, same row height) so the
 * page reserves the footprint and does not jump when the rows resolve —
 * the table-view counterpart of MedicationCardSkeleton.
 */
export function MedicationTableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Card
      className="border-border block gap-0 overflow-hidden py-0 text-current shadow-none md:gap-0 md:py-0"
      aria-hidden="true"
    >
      <Table>
        <TableHeader>
          <TableRow>
            {Array.from({ length: 6 }).map((_, i) => (
              <TableHead key={i}>
                <Skeleton className="h-4 w-16" />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }).map((_, i) => (
            <TableRow key={i}>
              <TableCell>
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-24" />
              </TableCell>
              <TableCell>
                <div className="space-y-1.5">
                  <Skeleton className="h-3.5 w-28" />
                  <Skeleton className="h-3.5 w-28" />
                </div>
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-14" />
              </TableCell>
              <TableCell>
                <div className="flex gap-1.5">
                  <Skeleton className="size-11 rounded-md sm:size-9" />
                  <Skeleton className="size-11 rounded-md sm:size-9" />
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
