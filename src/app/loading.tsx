/**
 * v1.8.3 — root-level loading skeleton (dashboard segment + any top-level
 * route without its own `loading.tsx`).
 *
 * Defense-in-depth for the navigation-freeze class: a segment that streams
 * paints this tile-grid skeleton instead of a blank frame. Pure server
 * component — no client hooks, no data fetch. More specific segments (e.g.
 * `/insights`) provide their own skeleton and take precedence.
 */
export default function RootLoading() {
  return (
    <div data-slot="dashboard-loading" className="space-y-6 p-4">
      <div className="bg-muted h-7 w-44 animate-pulse rounded motion-reduce:animate-none" />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-card rounded-xl border p-4">
            <div className="bg-muted mb-3 h-4 w-24 animate-pulse rounded motion-reduce:animate-none" />
            <div className="bg-muted/60 h-24 w-full animate-pulse rounded-lg motion-reduce:animate-none" />
          </div>
        ))}
      </div>
    </div>
  );
}
