import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Loading silhouette for the morning block, in its footprint: the label, the
 * sentence and the health score dial (80 px on a phone, 120 px from md up),
 * then the cards. The swap to the loaded block replaces content in place.
 *
 * It renders the same markup in the server pass and in the first client
 * pass, and the block fills in one step once both of its reads are there,
 * never one card at a time. Always `aria-hidden`: the tile strip's skeleton
 * carries the page's loading semantics.
 */
export function MorningSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-slot="morning-skeleton"
      className="flex flex-col gap-4"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 md:gap-x-6">
        <div className="min-w-0 space-y-2.5">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-6 w-3/4 max-w-full" />
          <Skeleton className="h-6 w-1/2 max-w-full" />
        </div>
        <Skeleton className="size-20 rounded-full md:size-[120px]" />
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} density="compact">
            <CardContent className="flex flex-col gap-3">
              <Skeleton className="h-4 w-28" />
              <div className="flex items-center gap-4">
                <Skeleton className="size-[120px] shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
