"use client";

import { useTranslations } from "@/lib/i18n/context";
import {
  INJECTION_SITE_KEYS,
  SITE_COORDS,
  describeInjectionSite,
  nextInjectionSite,
  type InjectionSiteKey,
} from "@/lib/medications/injection-sites";

/**
 * v1.4.25 W4d — injection-site picker.
 *
 * Stylized front-of-body SVG with 8 click-targets. The active site
 * highlights, the recommended next-site is ringed with a dashed outline
 * so the user can rotate sensibly without consulting a separate guide.
 *
 * Per Marc's "nichts brickt" directive the picker is opt-in — it's only
 * mounted from the GLP-1 dashboard tile and the optional log dialog.
 * Existing medication intake flows continue to work without it (the
 * intake-event row's `injectionSite` field stays NULL).
 *
 * Mobile-first: the picker is centred in a 320px column and remains
 * touch-friendly at Pixel-5 width. SVG buttons have 44px hit areas
 * (the visible circle is smaller but the <button> wrapper meets WCAG).
 */

interface InjectionSitePickerProps {
  /** Current selection, if any. */
  value: InjectionSiteKey | null;
  /** Recent rotation history (most recent first). Powers the
   *  "recommended next site" dashed-ring annotation. */
  history?: ReadonlyArray<InjectionSiteKey>;
  /** Called when the user picks a site. */
  onChange: (site: InjectionSiteKey) => void;
  /** Optional class for the outer wrapper. */
  className?: string;
}

export function InjectionSitePicker({
  value,
  history = [],
  onChange,
  className,
}: InjectionSitePickerProps) {
  const { t } = useTranslations();
  const recommended = nextInjectionSite(history);

  return (
    <div
      className={`flex flex-col items-center gap-3 ${className ?? ""}`}
      role="group"
      aria-label={t("medications.injectionSitePickerAriaLabel")}
    >
      <svg
        viewBox="0 0 120 300"
        className="text-foreground/40 h-[320px] w-auto max-w-full"
        role="img"
        aria-label={t("medications.injectionSiteBodyOutlineAriaLabel")}
      >
        {/* Head */}
        <circle
          cx="60"
          cy="22"
          r="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        {/* Neck */}
        <path
          d="M 56 36 L 56 46 L 64 46 L 64 36"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        {/* Torso */}
        <path
          d="M 40 50 Q 30 60 28 80 L 32 175 Q 40 185 60 185 Q 80 185 88 175 L 92 80 Q 90 60 80 50 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        {/* Arms */}
        <path
          d="M 32 60 L 16 110 L 14 150"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M 88 60 L 104 110 L 106 150"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        {/* Thighs */}
        <path
          d="M 36 185 L 30 270"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M 50 185 L 50 270"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M 70 185 L 70 270"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M 84 185 L 90 270"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        {/* Belt line */}
        <line
          x1="32"
          y1="155"
          x2="88"
          y2="155"
          stroke="currentColor"
          strokeWidth="0.8"
          strokeDasharray="2 3"
        />
        {/* Navel reference */}
        <circle cx="60" cy="130" r="1.5" fill="currentColor" />

        {/* Click targets */}
        {INJECTION_SITE_KEYS.map((site) => {
          const coord = SITE_COORDS[site];
          const isActive = site === value;
          const isRecommended = site === recommended;
          return (
            <g key={site}>
              {isRecommended && !isActive && (
                <circle
                  cx={coord.x}
                  cy={coord.y}
                  r="9"
                  fill="none"
                  className="stroke-primary"
                  strokeWidth="1.5"
                  strokeDasharray="2 2"
                />
              )}
              <circle
                cx={coord.x}
                cy={coord.y}
                r="6"
                className={
                  isActive
                    ? "fill-primary stroke-primary-foreground"
                    : "fill-muted stroke-foreground/60 hover:fill-accent"
                }
                strokeWidth="1.5"
              />
              {/* Invisible 24-unit hit-target for touch. The SVG renders
                  at ≈1.07× scale (320px box / 300-unit viewBox height),
                  so r=12 gives ≈25.6 CSS px diameter — clearing the
                  WCAG 2.5.8 Level AA 24×24 floor. Going larger would
                  overlap the abdomen-left / abdomen-right pair at
                  Δx=24 units; the picker stays interactive without
                  spacing collisions. */}
              <circle
                cx={coord.x}
                cy={coord.y}
                r="12"
                fill="transparent"
                role="button"
                tabIndex={0}
                aria-pressed={isActive}
                aria-label={t(describeInjectionSite(site))}
                onClick={() => onChange(site)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onChange(site);
                  }
                }}
                className="cursor-pointer focus:outline-none focus-visible:stroke-current focus-visible:stroke-2"
              />
            </g>
          );
        })}
      </svg>

      <div className="text-center text-xs">
        {value ? (
          <p className="text-foreground">{t(describeInjectionSite(value))}</p>
        ) : (
          <p className="text-muted-foreground">
            {recommended &&
              t("medications.glp1RotationSuggested", {
                site: t(describeInjectionSite(recommended)),
              })}
          </p>
        )}
      </div>
    </div>
  );
}
