import type { VisibleValueBand } from "./types";

/**
 * The value bands, painted as HTML behind the plot. The overlay is pinned to
 * the plot's own edges (the chart margin of 8 px plus the y axis on the left,
 * the 8 px margin on the right, the plot's top and bottom insets), so a band
 * tracks the line exactly.
 */
export function ChartBandOverlay({
  bands,
  yAxisWidth,
}: {
  bands: VisibleValueBand[];
  yAxisWidth: number;
}) {
  return (
    <div
      className="pointer-events-none absolute"
      style={{
        left: `${8 + yAxisWidth}px`,
        right: "8px",
        top: "10px",
        bottom: "32px",
        zIndex: 0,
      }}
    >
      {bands.map((band) => (
        <div
          key={band.key}
          className="absolute right-0 left-0"
          style={{
            top: `${band.topPct}%`,
            height: `${band.heightPct}%`,
            backgroundColor: band.color,
            opacity: band.opacity,
            borderTop: `1px solid ${band.color}`,
            borderBottom: `1px solid ${band.color}`,
          }}
        />
      ))}
    </div>
  );
}
