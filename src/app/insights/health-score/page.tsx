import { redirect } from "next/navigation";

/**
 * `/insights/health-score` moved to `/insights/scores/health` in 1.50, where
 * the Health score's panel and its course share one page beside the other
 * scores. Kept as a redirect so saved links and the day view still land.
 */
export default function HealthScoreHistoryPage(): never {
  redirect("/insights/scores/health");
}
