"use client";

import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/hooks/use-auth";
import { apiGet } from "@/lib/api/api-fetch";
import { queryKeys } from "@/lib/query-keys";

/** One point of `kind=glucoseKetoneIndex`, as the server resolved it. */
export interface GlucoseKetoneIndexSeriesPoint {
  /** The ketone reading's id. */
  id: string;
  /** The ketone reading's instant. */
  at: string;
  /** The index, one decimal. */
  value: number;
  gki: {
    glucoseId: string;
    glucoseAt: string;
    glucoseMmol: number;
    ketonesMmol: number;
  };
}

interface GlucoseKetoneIndexSeries {
  kind: "glucoseKetoneIndex";
  unit: string;
  points: GlucoseKetoneIndexSeriesPoint[];
}

/** The whole history the series route serves; the chart narrows it. */
export const GKI_SERIES_DAYS = 3650;

/**
 * The glucose-ketone index over the last {@link GKI_SERIES_DAYS} days (#1367).
 * The server pairs the readings and computes every index; the card draws them
 * as given.
 */
export function useGlucoseKetoneIndexSeries() {
  const { isAuthenticated } = useAuth();
  return useQuery({
    queryKey: queryKeys.glucoseKetoneIndexSeries(GKI_SERIES_DAYS),
    queryFn: () =>
      apiGet<GlucoseKetoneIndexSeries>(
        `/api/measurements/series?kind=glucoseKetoneIndex&days=${GKI_SERIES_DAYS}`,
      ),
    staleTime: 60_000,
    enabled: isAuthenticated,
  });
}
