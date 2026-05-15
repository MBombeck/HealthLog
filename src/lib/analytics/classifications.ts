/**
 * Health metric classifications and rule-based alerts.
 * WHO BMI categories, ESC/ESH BP classification, and smart alerts.
 */

// ── BMI Classification (WHO) ────────────────────────────

export interface BmiClassification {
  category: string;
  color: string;
  severity: "normal" | "warning" | "danger";
}

export function classifyBMI(bmi: number): BmiClassification {
  if (bmi < 18.5) {
    return { category: "Underweight", color: "#f1fa8c", severity: "warning" };
  }
  if (bmi < 25) {
    return { category: "Normal", color: "#50fa7b", severity: "normal" };
  }
  if (bmi < 30) {
    return {
      category: "Overweight",
      color: "#ffb86c",
      severity: "warning",
    };
  }
  if (bmi < 35) {
    return {
      category: "Obesity Grade I",
      color: "#ff79c6",
      severity: "danger",
    };
  }
  if (bmi < 40) {
    return {
      category: "Obesity Grade II",
      color: "#ff5555",
      severity: "danger",
    };
  }
  return {
    category: "Obesity Grade III",
    color: "#ff5555",
    severity: "danger",
  };
}

// ── BP Classification (ESH 2023) ────────────────────────

export interface BpClassification {
  category: string;
  color: string;
  severity: "normal" | "elevated" | "warning" | "danger";
}

export function classifyBP(sys: number, dia: number): BpClassification {
  if (sys < 120 && dia < 80) {
    return { category: "Optimal", color: "#50fa7b", severity: "normal" };
  }
  if (sys < 130 && dia < 85) {
    return { category: "Normal", color: "#8be9fd", severity: "normal" };
  }
  if (sys < 140 && dia < 90) {
    return {
      category: "High-normal",
      color: "#f1fa8c",
      severity: "elevated",
    };
  }
  if (sys < 160 && dia < 100) {
    return {
      category: "Hypertension Grade 1",
      color: "#ffb86c",
      severity: "warning",
    };
  }
  if (sys < 180 && dia < 110) {
    return {
      category: "Hypertension Grade 2",
      color: "#ff79c6",
      severity: "danger",
    };
  }
  return {
    category: "Hypertension Grade 3",
    color: "#ff5555",
    severity: "danger",
  };
}

// ── Pulse Classification (AHA) ──────────────────────────

export interface PulseClassification {
  category: string;
  color: string;
  severity: "info" | "normal" | "warning" | "danger";
}

export function classifyPulse(bpm: number): PulseClassification {
  if (bpm < 60) {
    return { category: "Bradycardia", color: "#8be9fd", severity: "info" };
  }
  if (bpm <= 100) {
    return { category: "Normal", color: "#50fa7b", severity: "normal" };
  }
  if (bpm <= 120) {
    return { category: "Elevated", color: "#ffb86c", severity: "warning" };
  }
  return { category: "Tachycardia", color: "#ff5555", severity: "danger" };
}

// ── Sleep Duration Classification (AASM/SRS) ───────────

export interface SleepDurationClassification {
  category: string;
  color: string;
  severity: "normal" | "info" | "warning";
}

export function classifySleepDuration(
  hours: number,
): SleepDurationClassification {
  if (hours < 6) {
    return {
      category: "Far too short",
      color: "#ff5555",
      severity: "warning",
    };
  }
  if (hours < 7) {
    return { category: "Too short", color: "#ffb86c", severity: "warning" };
  }
  if (hours <= 9) {
    return { category: "On target", color: "#50fa7b", severity: "normal" };
  }
  if (hours <= 10) {
    return { category: "Slightly long", color: "#8be9fd", severity: "info" };
  }
  return {
    category: "Far too long",
    color: "#ff79c6",
    severity: "warning",
  };
}

// ── Body Fat Classification (ACE) ───────────────────────

export interface BodyFatClassification {
  category: string;
  color: string;
  severity: "normal" | "warning" | "danger";
}

/**
 * Classify a body-fat percentage according to the ACE (American Council
 * on Exercise) standard table. Source:
 *   https://www.acefitness.org/resources/everyone/blog/112/what-are-the-guidelines-for-percentage-of-body-fat-loss/
 *
 * v1.3.3 used `essential = 6 (M)` / `14 (F)` for the lower boundary,
 * which actually matches ACE's *Athletes* lower bound — readings below
 * that bound were mislabelled "Essential" instead of either "Below
 * essential" (a danger floor) or "Essential" proper (the 2-5 / 10-13
 * band, which is athletic-extreme but not pathological). v1.4 splits
 * that range into a danger band below the ACE essential floor and the
 * actual essential band as a warning.
 *
 * Cross-checked against:
 *   - Heyward V & Wagner D, "Applied Body Composition Assessment" 2nd
 *     ed (ACE's underlying source).
 *   - Gallagher D et al., "Healthy percentage body fat ranges: an
 *     approach for developing guidelines based on body mass index."
 *     Am J Clin Nutr. 2000.
 *     https://academic.oup.com/ajcn/article/72/3/694/4729363
 *   - NIH NHLBI Practical Guide on the Identification, Evaluation, and
 *     Treatment of Overweight and Obesity in Adults (2000) — does NOT
 *     publish percent-fat bands; flagged here as a hallucination
 *     avoidance reminder.
 */
export function classifyBodyFat(
  pct: number,
  gender: "MALE" | "FEMALE" | null,
  age?: number,
): BodyFatClassification {
  void age;

  // ACE bands per gender. Order: dangerFloor, essentialMax, athleteMax,
  // fitnessMax, acceptableMax. Above acceptableMax = obese.
  let dangerFloor: number;
  let essentialMax: number;
  let athleteMax: number;
  let fitnessMax: number;
  let acceptableMax: number;

  if (gender === "MALE") {
    // ACE: essential 2-5, athletes 6-13, fitness 14-17, acceptable 18-24.
    dangerFloor = 2;
    essentialMax = 5;
    athleteMax = 13;
    fitnessMax = 17;
    acceptableMax = 24;
  } else if (gender === "FEMALE") {
    // ACE: essential 10-13, athletes 14-20, fitness 21-24, acceptable 25-31.
    dangerFloor = 10;
    essentialMax = 13;
    athleteMax = 20;
    fitnessMax = 24;
    acceptableMax = 31;
  } else {
    // Gender-neutral fallback: midpoint of M/F bands.
    dangerFloor = 6;
    essentialMax = 9;
    athleteMax = 16.5;
    fitnessMax = 20.5;
    acceptableMax = 27.5;
  }

  if (pct < dangerFloor) {
    // Below ACE essential floor — clinically concerning (immune /
    // hormonal / cardiac risk in chronic depletion).
    return {
      category: "Below essential",
      color: "#ff5555",
      severity: "danger",
    };
  }
  if (pct <= essentialMax) {
    return { category: "Essential", color: "#f1fa8c", severity: "warning" };
  }
  if (pct <= athleteMax) {
    return { category: "Athletic", color: "#50fa7b", severity: "normal" };
  }
  if (pct <= fitnessMax) {
    return { category: "Fitness", color: "#50fa7b", severity: "normal" };
  }
  if (pct <= acceptableMax) {
    return { category: "Acceptable", color: "#ffb86c", severity: "warning" };
  }
  return { category: "Obese", color: "#ff5555", severity: "danger" };
}

// ── Activity Steps Classification ───────────────────────
//
// Cohort source: Saint-Maurice PF, et al. "Association of daily step
// count and step intensity with mortality among US adults." JAMA. 2020.
// https://jamanetwork.com/journals/jama/fullarticle/2763292
// Mortality benefit accumulates strongly through ~12 000 steps/day
// (HR 0.49 at 8k vs 4k, HR 0.35 at 12k — continued dose-response,
// not a plateau). WHO publishes physical-activity TIME (150–300
// min/wk moderate) — NOT a step quota; do not cite "WHO ≥ 8 000 steps".

export interface StepsClassification {
  category: string;
  color: string;
  severity: "normal" | "info" | "warning";
}

export function classifySteps(steps: number): StepsClassification {
  if (steps < 3000) {
    return {
      category: "Very low",
      color: "#ff5555",
      severity: "warning",
    };
  }
  if (steps < 5000) {
    return { category: "Low active", color: "#ffb86c", severity: "warning" };
  }
  if (steps < 7500) {
    return {
      category: "Moderately active",
      color: "#f1fa8c",
      severity: "info",
    };
  }
  if (steps < 10000) {
    return { category: "Active", color: "#50fa7b", severity: "normal" };
  }
  return { category: "Very active", color: "#50fa7b", severity: "normal" };
}

/**
 * Activity-steps target range. Single source of truth: aligned with
 * `effective-range.ts` (Saint-Maurice JAMA 2020 — continued mortality
 * dose-response through ~12 000 steps/day). The v1.3.3 audit flagged a drift where this helper
 * returned {7 000, 10 000} while `effective-range.ts` returned
 * {8 000, 15 000}; both surfaces showed different "green" bands to the
 * same user. They now agree.
 */
export function getStepsRange(): { min: number; max: number } {
  return { min: 8000, max: 15000 };
}

// ── Target Range Helpers ────────────────────────────────

/**
 * Healthy weight range based on BMI 18.5–24.9 (WHO).
 */
export function getWeightRange(heightCm: number): { min: number; max: number } {
  const heightM = heightCm / 100;
  const heightSq = heightM * heightM;
  return {
    min: Math.round(18.5 * heightSq * 10) / 10,
    max: Math.round(24.9 * heightSq * 10) / 10,
  };
}

/**
 * Recommended nightly sleep duration for adults (AASM/SRS).
 */
export function getSleepDurationRange(): { min: number; max: number } {
  return { min: 7, max: 9 };
}

/**
 * BP target ranges based on ESH 2023 guidelines (numerically
 * unchanged from the joint ESC/ESH 2018 document; the 2023 update
 * is ESH-only since ESC withdrew from joint authoring).
 */
export function getBpTargetsByAge(
  age: number,
  gender?: "MALE" | "FEMALE" | null,
): { sysLow: number; sysHigh: number; diaLow: number; diaHigh: number } {
  void gender;
  if (age < 65) {
    return { sysLow: 120, sysHigh: 129, diaLow: 70, diaHigh: 79 };
  }
  // 65+ (both 65–79 and ≥80 have the same targets per ESH 2023)
  return { sysLow: 130, sysHigh: 139, diaLow: 70, diaHigh: 79 };
}

// ── Health Alerts ────────────────────────────────────────

export interface HealthAlert {
  level: "success" | "info" | "warning" | "danger";
  title: string;
  message: string;
}

export interface AlertInput {
  bmi?: number | null;
  bpAvgSys?: number | null;
  bpAvgDia?: number | null;
  bpPctInTarget?: number | null;
  weightSlope30?: number | null;
  pulseAvg30?: number | null;
  pulseAnomalyCount?: number;
  medications?: Array<{
    name: string;
    compliance7: number;
    compliance30: number;
  }>;
}

export function generateAlerts(input: AlertInput): HealthAlert[] {
  const alerts: HealthAlert[] = [];

  // BMI alerts
  if (input.bmi != null) {
    if (input.bmi < 18.5) {
      alerts.push({
        level: "warning",
        title: "BMI below normal range",
        message: `Your BMI of ${input.bmi} is below the normal range (18.5–24.9).`,
      });
    } else if (input.bmi >= 25 && input.bmi < 30) {
      alerts.push({
        level: "info",
        title: "BMI in overweight range",
        message: `Your BMI of ${input.bmi} is in the overweight range. Regular exercise and a balanced diet can help.`,
      });
    } else if (input.bmi >= 30) {
      alerts.push({
        level: "warning",
        title: "BMI in obesity range",
        message: `Your BMI of ${input.bmi} is in the obesity range.`,
      });
    } else {
      alerts.push({
        level: "success",
        title: "BMI in normal range",
        message: `Your BMI of ${input.bmi} is in the healthy range.`,
      });
    }
  }

  // BP alerts
  if (input.bpAvgSys != null && input.bpAvgDia != null) {
    const bpClass = classifyBP(input.bpAvgSys, input.bpAvgDia);
    if (bpClass.severity === "danger") {
      alerts.push({
        level: "danger",
        title: "Blood pressure significantly elevated",
        message: `Your average blood pressure (${input.bpAvgSys}/${input.bpAvgDia}) is classified as "${bpClass.category}".`,
      });
    } else if (bpClass.severity === "warning") {
      alerts.push({
        level: "warning",
        title: "Blood pressure slightly elevated",
        message: `Your average blood pressure (${input.bpAvgSys}/${input.bpAvgDia}) is in the "${bpClass.category}" range.`,
      });
    }
  }

  // BP target adherence
  if (input.bpPctInTarget != null) {
    if (input.bpPctInTarget >= 80) {
      alerts.push({
        level: "success",
        title: "Good blood pressure target adherence",
        message: `${input.bpPctInTarget}% of your readings are within the target range.`,
      });
    } else if (input.bpPctInTarget < 50) {
      alerts.push({
        level: "warning",
        title: "Blood pressure often outside target range",
        message: `Only ${input.bpPctInTarget}% of your readings are within the target range.`,
      });
    }
  }

  // Weight trend
  if (input.weightSlope30 != null) {
    const weeklyChange = input.weightSlope30 * 7;
    if (weeklyChange > 0.5) {
      alerts.push({
        level: "info",
        title: "Weight increasing",
        message: `Your weight is increasing by approx. ${weeklyChange.toFixed(1)} kg per week over the last 30 days.`,
      });
    } else if (weeklyChange < -0.5) {
      alerts.push({
        level: "info",
        title: "Weight decreasing",
        message: `Your weight is decreasing by approx. ${Math.abs(weeklyChange).toFixed(1)} kg per week over the last 30 days.`,
      });
    }
  }

  // Pulse anomalies
  if (input.pulseAnomalyCount != null && input.pulseAnomalyCount > 2) {
    alerts.push({
      level: "warning",
      title: "Pulse outliers detected",
      message: `${input.pulseAnomalyCount} unusual pulse readings in the last 30 days.`,
    });
  }

  // Medication compliance
  if (input.medications) {
    for (const med of input.medications) {
      if (med.compliance7 < 80) {
        alerts.push({
          level: "warning",
          title: `Low compliance: ${med.name}`,
          message: `Your 7-day compliance for ${med.name} is only ${med.compliance7}%. Regular intake is important.`,
        });
      } else if (med.compliance7 >= 95) {
        alerts.push({
          level: "success",
          title: `Excellent compliance: ${med.name}`,
          message: `${med.compliance7}% compliance over the last 7 days. Keep it up!`,
        });
      }
    }
  }

  return alerts;
}
