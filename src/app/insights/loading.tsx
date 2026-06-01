/**
 * v1.8.3 — route-level loading skeleton for every `/insights/*` segment.
 *
 * Defense-in-depth for the navigation-freeze class: any RSC await on an
 * insights route (now or in a future refactor) streams this skeleton
 * instead of blocking the transition. The geometry mirrors `SubPageShell`
 * (heading + chart card + assessment card) so the post-load swap reflows
 * by less than a row. Pure server component — no client hooks, no data
 * fetch; Next.js renders it instantly while the segment streams.
 */
export default function InsightsLoading() {
  return (
    <div data-slot="insights-subpage-loading" className="space-y-6">
      <header className="space-y-2">
        <div className="bg-muted h-7 w-48 animate-pulse rounded motion-reduce:animate-none" />
        <div className="bg-muted/70 h-4 w-72 animate-pulse rounded motion-reduce:animate-none" />
      </header>

      {/* Chart card */}
      <div className="bg-card rounded-xl border p-4">
        <div className="bg-muted mb-4 h-4 w-32 animate-pulse rounded motion-reduce:animate-none" />
        <div className="bg-muted/60 h-56 w-full animate-pulse rounded-lg motion-reduce:animate-none" />
      </div>

      {/* Assessment card */}
      <div className="bg-card space-y-2 rounded-xl border p-4">
        <div className="flex items-center gap-2">
          <div className="bg-muted h-5 w-5 animate-pulse rounded motion-reduce:animate-none" />
          <div className="bg-muted h-4 w-40 animate-pulse rounded motion-reduce:animate-none" />
        </div>
        <div className="bg-muted h-3.5 w-full animate-pulse rounded motion-reduce:animate-none" />
        <div className="bg-muted h-3.5 w-11/12 animate-pulse rounded motion-reduce:animate-none" />
        <div className="bg-muted h-3.5 w-9/12 animate-pulse rounded motion-reduce:animate-none" />
      </div>
    </div>
  );
}
