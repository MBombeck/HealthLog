/**
 * Server classification category → the localized label's key, read by the
 * status pill and by the server when a category is worded into a sentence
 * (the rule alerts in `classifications.ts`). One map, so the pill and the
 * sentence can never name a band differently. The category is canonical
 * (emitted by `/api/insights/targets`); the value is the key under
 * `targets.status.*`.
 */
export const STATUS_CATEGORY_KEY: Readonly<Record<string, string>> = {
  Underweight: "underweight",
  Normal: "normal",
  Overweight: "overweight",
  "Obesity Grade I": "obesityGrade1",
  "Obesity Grade II": "obesityGrade2",
  "Obesity Grade III": "obesityGrade3",
  Optimal: "optimal",
  "High-normal": "highNormal",
  "Hypertension Grade 1": "hypertensionGrade1",
  "Hypertension Grade 2": "hypertensionGrade2",
  "Hypertension Grade 3": "hypertensionGrade3",
  "Below typical range": "belowTypicalRange",
  Elevated: "elevated",
  "Above typical range": "aboveTypicalRange",
  "Significantly low": "significantlyLow",
  "Slightly low": "slightlyLow",
  "On target": "onTarget",
  "Slightly elevated": "slightlyElevated",
  "Significantly elevated": "significantlyElevated",
  "Far too short": "farTooShort",
  "Too short": "tooShort",
  "Slightly long": "slightlyLong",
  "Far too long": "farTooLong",
  "Below essential": "belowEssential",
  Essential: "essential",
  Athletic: "athletic",
  Fitness: "fitness",
  Acceptable: "acceptable",
  Obese: "obese",
  "Very low": "veryLow",
  "Low active": "lowActive",
  "Moderately active": "moderatelyActive",
  Active: "active",
  "Very active": "veryActive",
  Good: "good",
  Moderate: "moderate",
  Low: "low",
  High: "high",
  "Very good": "veryGood",
  "Very stable": "veryStable",
  Stable: "stable",
  Fluctuating: "fluctuating",
};
