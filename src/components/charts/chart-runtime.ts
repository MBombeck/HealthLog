/**
 * The ONE async boundary for every recharts-rendering component.
 *
 * Every `next/dynamic` chart import in the tree points at THIS module
 * (`import("@/components/charts/chart-runtime")`), never at the individual
 * chart files. Pointing N dynamic boundaries at N different modules made
 * Turbopack emit a separate chunk group per boundary, each carrying its own
 * full copy of the recharts module graph — the production build shipped
 * EIGHT ~312 KB copies of the library, and /insights alone downloaded two
 * (~92 KB gz of pure duplication on the worst-LCP route). One shared import
 * target ⇒ one shared chunk group ⇒ recharts exists exactly once, cached
 * across every route.
 *
 * Extends the v1.16.7 `mood-charts.ts` precedent (which did this for the
 * mood trio) to the whole chart surface; that scoped barrel is folded in
 * here.
 *
 * Rules:
 *  - A new recharts consumer is added HERE and loaded through
 *    `dynamic(() => import("@/components/charts/chart-runtime").then(...))`
 *    at its call site — with the call site's own matching skeleton.
 *  - No component outside this module's static import graph may import
 *    "recharts" directly.
 *  - Types stay importable from the component files directly (type-only
 *    imports are value-free and don't drag the chunk in).
 *
 * Loading this module also moves Recharts' text-measurement span out of
 * `<body>` before the first chart measures anything; see
 * `text-measurement-host.ts` for why that read was the dashboard's largest
 * main-thread cost.
 */

import { installTextMeasurementHost } from "./text-measurement-host";

installTextMeasurementHost();

export { HealthChart } from "./health-chart";
export { MoodChart } from "./mood-chart";
export { MedicationComplianceChart } from "./medication-compliance-chart";
export { ScatterCorrelationChart } from "./scatter-correlation-chart";
export { HostMetricsChart } from "@/components/admin/host-metrics-chart";
export { CustomMetricChart } from "@/components/custom-metrics/custom-metric-chart";
export { BbtChart } from "@/components/cycle/bbt-chart";
export { DeltaSparkline } from "@/components/insights/derived/delta-sparkline";
export { MoodDimensionTrends } from "@/components/insights/mood/mood-dimension-trends";
export { MoodDistributionChart } from "@/components/insights/mood/mood-distribution-chart";
export { MoodTimeOfDayChart } from "@/components/insights/mood/mood-time-of-day-chart";
export { MoodWeekdayChart } from "@/components/insights/mood/mood-weekday-chart";
export { SleepStageStackedBar } from "@/components/insights/sleep-stage-stacked-bar";
export { LabBiomarkerChart } from "@/components/labs/lab-biomarker-chart";
export { DoseStrengthCurve } from "@/components/medications/dose-strength-curve";
export { DrugLevelChart } from "@/components/medications/drug-level-chart";
export { EfficacyChart } from "@/components/medications/detail/efficacy/efficacy-chart";
export { AssessmentHistoryChart } from "@/components/mental-health/assessment-history-chart";
export { IntradayPulseChart } from "@/components/insights/intraday-pulse-chart";
export { NutrientDailyBarChart } from "./nutrient-daily-bar-chart";
export { WorkoutHrChart } from "./workout-hr-chart";
export { WorkoutElevationChart } from "./workout-elevation-chart";
export { CoachResultChart } from "@/components/insights/coach-panel/result-chart";
