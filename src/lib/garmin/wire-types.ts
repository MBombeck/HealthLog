/**
 * Garmin Personal API wire shapes, the parts the sync reads.
 *
 * Taken from Garmin's published OpenAPI document (Personal API 1.0.0). Every
 * field is optional and nullable on purpose: a day without data comes back as
 * an object whose fields are all null, and the live service has been seen to
 * send epoch milliseconds where the document says a date-time string (sleep
 * window instants, weigh-in instants). The mappers in `./map.ts` accept both.
 */

/** An instant as Garmin sends it: epoch ms, or an ISO-like string without zone. */
export type GarminInstant = number | string | null | undefined;

/** `GET /usersummary-service/v2/dailysummaries` → `{ data: [...] }`. */
export interface GarminDailySummary {
  calendarDate?: string | null;
  includesWellnessData?: boolean | null;
  movement?: {
    steps?: { value?: number | null; distanceInMeters?: number | null } | null;
    floorsAscended?: { value?: number | null } | null;
  } | null;
  calories?: { burnedActive?: number | null } | null;
  heartRate?: { restingValue?: number | null } | null;
  stress?: { avgLevel?: number | null } | null;
  bodyBattery?: { maxValue?: number | null } | null;
}

export interface GarminDailySummaryEnvelope {
  data?: GarminDailySummary[] | null;
}

/** One entry of `GET /sleep-service/sleep/dailySleepSummariesByDate`. */
export interface GarminSleepSummary {
  id?: number | string | null;
  calendarDate?: string | null;
  sleepTimeSeconds?: number | null;
  sleepEndTimestampGMT?: GarminInstant;
  deepSleepSeconds?: number | null;
  lightSleepSeconds?: number | null;
  remSleepSeconds?: number | null;
  awakeSleepSeconds?: number | null;
  averageSpO2Value?: number | null;
  averageRespirationValue?: number | null;
  sleepScores?: Record<
    string,
    { value?: number | null; qualifierKey?: string | null } | null
  > | null;
}

/** `GET /hrv-service/hrv/daily/{fromDate}/{toDate}`. */
export interface GarminHrvEnvelope {
  hrvSummaries?: Array<{
    calendarDate?: string | null;
    /** Average overnight HRV. Garmin measures RMSSD. */
    lastNightAvg?: number | null;
  }> | null;
}

/** One weigh-in. Masses are grams on the live service, whatever the document says. */
export interface GarminWeighIn {
  samplePk?: number | string | null;
  date?: GarminInstant;
  timestampGMT?: GarminInstant;
  calendarDate?: string | null;
  weight?: number | null;
  bmi?: number | null;
  bodyFat?: number | null;
  bodyWater?: number | null;
  boneMass?: number | null;
  muscleMass?: number | null;
  visceralFat?: number | null;
  sourceType?: string | null;
}

/** `GET /weight-service/weight/range/{start}/{end}?includeAll=true`. */
export interface GarminWeightRangeEnvelope {
  dailyWeightSummaries?: Array<{
    summaryDate?: string | null;
    latestWeight?: GarminWeighIn | null;
    allWeightMetrics?: GarminWeighIn[] | null;
  }> | null;
}

/** One entry of `GET /activitylist-service/activities/search/activities`. */
export interface GarminActivity {
  activityId?: number | string | null;
  startTimeGMT?: string | null;
  beginTimestamp?: number | null;
  activityType?: { typeKey?: string | null } | null;
  distance?: number | null;
  duration?: number | null;
  elapsedDuration?: number | null;
  movingDuration?: number | null;
  elevationGain?: number | null;
  calories?: number | null;
  averageHR?: number | null;
  maxHR?: number | null;
  steps?: number | null;
  aerobicTrainingEffect?: number | null;
  anaerobicTrainingEffect?: number | null;
  activityTrainingLoad?: number | null;
}

/** A date the menstrual-cycle service sends either bare or wrapped. */
export type GarminCycleDate =
  | string
  | { localDate?: string | null; date?: string | null }
  | null
  | undefined;

/** `GET /periodichealth-service/menstrualcycle/summary/{calendarDate}`. */
export interface GarminCycleSummary {
  startDate?: GarminCycleDate;
  periodLength?: number | null;
  predictedCycle?: boolean | null;
  pregnancyCycle?: boolean | null;
}
