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
    return { category: "Untergewicht", color: "#f1fa8c", severity: "warning" };
  }
  if (bmi < 25) {
    return { category: "Normalgewicht", color: "#50fa7b", severity: "normal" };
  }
  if (bmi < 30) {
    return {
      category: "Übergewicht",
      color: "#ffb86c",
      severity: "warning",
    };
  }
  if (bmi < 35) {
    return {
      category: "Adipositas Grad I",
      color: "#ff79c6",
      severity: "danger",
    };
  }
  if (bmi < 40) {
    return {
      category: "Adipositas Grad II",
      color: "#ff5555",
      severity: "danger",
    };
  }
  return {
    category: "Adipositas Grad III",
    color: "#ff5555",
    severity: "danger",
  };
}

// ── BP Classification (ESC/ESH 2018) ────────────────────

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
      category: "Hoch-normal",
      color: "#f1fa8c",
      severity: "elevated",
    };
  }
  if (sys < 160 && dia < 100) {
    return {
      category: "Hypertonie Grad 1",
      color: "#ffb86c",
      severity: "warning",
    };
  }
  if (sys < 180 && dia < 110) {
    return {
      category: "Hypertonie Grad 2",
      color: "#ff79c6",
      severity: "danger",
    };
  }
  return {
    category: "Hypertonie Grad 3",
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
    return { category: "Bradykardie", color: "#8be9fd", severity: "info" };
  }
  if (bpm <= 100) {
    return { category: "Normal", color: "#50fa7b", severity: "normal" };
  }
  if (bpm <= 120) {
    return { category: "Erhöht", color: "#ffb86c", severity: "warning" };
  }
  return { category: "Tachykardie", color: "#ff5555", severity: "danger" };
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
      category: "Deutlich zu kurz",
      color: "#ff5555",
      severity: "warning",
    };
  }
  if (hours < 7) {
    return { category: "Zu kurz", color: "#ffb86c", severity: "warning" };
  }
  if (hours <= 9) {
    return { category: "Zielbereich", color: "#50fa7b", severity: "normal" };
  }
  if (hours <= 10) {
    return { category: "Etwas lang", color: "#8be9fd", severity: "info" };
  }
  return {
    category: "Deutlich zu lang",
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

export function classifyBodyFat(
  pct: number,
  gender: "MALE" | "FEMALE" | null,
  age?: number,
): BodyFatClassification {
  void age;
  // Define thresholds per gender; null uses average of male/female
  let essential: number;
  let athleteMax: number;
  let fitnessMax: number;
  let averageMax: number;

  if (gender === "MALE") {
    essential = 6;
    athleteMax = 13;
    fitnessMax = 17;
    averageMax = 24;
  } else if (gender === "FEMALE") {
    essential = 14;
    athleteMax = 20;
    fitnessMax = 24;
    averageMax = 31;
  } else {
    // Average of male and female thresholds
    essential = 10;
    athleteMax = 16.5;
    fitnessMax = 20.5;
    averageMax = 27.5;
  }

  if (pct < essential) {
    return {
      category: "Essenziell",
      color: "#f1fa8c",
      severity: "warning",
    };
  }
  if (pct <= athleteMax) {
    return { category: "Athletisch", color: "#50fa7b", severity: "normal" };
  }
  if (pct <= fitnessMax) {
    return { category: "Fitness", color: "#50fa7b", severity: "normal" };
  }
  if (pct <= averageMax) {
    return {
      category: "Durchschnitt",
      color: "#ffb86c",
      severity: "warning",
    };
  }
  return { category: "Adipös", color: "#ff5555", severity: "danger" };
}

// ── Activity Steps Classification (WHO) ─────────────────

export interface StepsClassification {
  category: string;
  color: string;
  severity: "normal" | "info" | "warning";
}

export function classifySteps(steps: number): StepsClassification {
  if (steps < 3000) {
    return {
      category: "Sehr wenig",
      color: "#ff5555",
      severity: "warning",
    };
  }
  if (steps < 5000) {
    return { category: "Wenig aktiv", color: "#ffb86c", severity: "warning" };
  }
  if (steps < 7500) {
    return {
      category: "Moderat aktiv",
      color: "#f1fa8c",
      severity: "info",
    };
  }
  if (steps < 10000) {
    return { category: "Aktiv", color: "#50fa7b", severity: "normal" };
  }
  return { category: "Sehr aktiv", color: "#50fa7b", severity: "normal" };
}

export function getStepsRange(): { min: number; max: number } {
  return { min: 7000, max: 10000 };
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
 * Normal resting pulse range (AHA).
 */
export function getPulseRange(): { min: number; max: number } {
  return { min: 60, max: 100 };
}

/**
 * Recommended nightly sleep duration for adults (AASM/SRS).
 */
export function getSleepDurationRange(): { min: number; max: number } {
  return { min: 7, max: 9 };
}

/**
 * BP target ranges based on ESC/ESH 2018 guidelines.
 */
export function getBpTargetsByAge(
  age: number,
  gender?: "MALE" | "FEMALE" | null,
): { sysLow: number; sysHigh: number; diaLow: number; diaHigh: number } {
  void gender;
  if (age < 65) {
    return { sysLow: 120, sysHigh: 129, diaLow: 70, diaHigh: 79 };
  }
  // 65+ (both 65–79 and ≥80 have the same targets per ESC/ESH)
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
        title: "BMI unter Normalbereich",
        message: `Ihr BMI von ${input.bmi} liegt unter dem Normalbereich (18,5–24,9).`,
      });
    } else if (input.bmi >= 25 && input.bmi < 30) {
      alerts.push({
        level: "info",
        title: "BMI im Bereich Übergewicht",
        message: `Ihr BMI von ${input.bmi} liegt im Bereich Übergewicht. Regelmäßige Bewegung und ausgewogene Ernährung können helfen.`,
      });
    } else if (input.bmi >= 30) {
      alerts.push({
        level: "warning",
        title: "BMI im Bereich Adipositas",
        message: `Ihr BMI von ${input.bmi} liegt im Bereich Adipositas.`,
      });
    } else {
      alerts.push({
        level: "success",
        title: "BMI im Normalbereich",
        message: `Ihr BMI von ${input.bmi} liegt im gesunden Bereich.`,
      });
    }
  }

  // BP alerts
  if (input.bpAvgSys != null && input.bpAvgDia != null) {
    const bpClass = classifyBP(input.bpAvgSys, input.bpAvgDia);
    if (bpClass.severity === "danger") {
      alerts.push({
        level: "danger",
        title: "Blutdruck deutlich erhöht",
        message: `Ihr durchschnittlicher Blutdruck (${input.bpAvgSys}/${input.bpAvgDia}) wird als "${bpClass.category}" eingestuft.`,
      });
    } else if (bpClass.severity === "warning") {
      alerts.push({
        level: "warning",
        title: "Blutdruck leicht erhöht",
        message: `Ihr durchschnittlicher Blutdruck (${input.bpAvgSys}/${input.bpAvgDia}) liegt im Bereich "${bpClass.category}".`,
      });
    }
  }

  // BP target adherence
  if (input.bpPctInTarget != null) {
    if (input.bpPctInTarget >= 80) {
      alerts.push({
        level: "success",
        title: "Gute Blutdruck-Zielbereichstreue",
        message: `${input.bpPctInTarget}% Ihrer Messungen liegen im Zielbereich.`,
      });
    } else if (input.bpPctInTarget < 50) {
      alerts.push({
        level: "warning",
        title: "Blutdruck oft außerhalb des Zielbereichs",
        message: `Nur ${input.bpPctInTarget}% Ihrer Messungen liegen im Zielbereich.`,
      });
    }
  }

  // Weight trend
  if (input.weightSlope30 != null) {
    const weeklyChange = input.weightSlope30 * 7;
    if (weeklyChange > 0.5) {
      alerts.push({
        level: "info",
        title: "Gewicht steigend",
        message: `Ihr Gewicht steigt um ca. ${weeklyChange.toFixed(1)} kg pro Woche in den letzten 30 Tagen.`,
      });
    } else if (weeklyChange < -0.5) {
      alerts.push({
        level: "info",
        title: "Gewicht fallend",
        message: `Ihr Gewicht sinkt um ca. ${Math.abs(weeklyChange).toFixed(1)} kg pro Woche in den letzten 30 Tagen.`,
      });
    }
  }

  // Pulse anomalies
  if (input.pulseAnomalyCount != null && input.pulseAnomalyCount > 2) {
    alerts.push({
      level: "warning",
      title: "Puls-Ausreißer erkannt",
      message: `${input.pulseAnomalyCount} ungewöhnliche Pulsmessungen in den letzten 30 Tagen.`,
    });
  }

  // Medication compliance
  if (input.medications) {
    for (const med of input.medications) {
      if (med.compliance7 < 80) {
        alerts.push({
          level: "warning",
          title: `Niedrige Einnahmetreue: ${med.name}`,
          message: `Ihre 7-Tage-Compliance für ${med.name} liegt bei nur ${med.compliance7}%. Regelmäßige Einnahme ist wichtig.`,
        });
      } else if (med.compliance7 >= 95) {
        alerts.push({
          level: "success",
          title: `Sehr gute Einnahmetreue: ${med.name}`,
          message: `${med.compliance7}% Compliance in den letzten 7 Tagen. Weiter so!`,
        });
      }
    }
  }

  return alerts;
}
