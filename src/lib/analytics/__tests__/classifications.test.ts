import { describe, it, expect } from "vitest";
import {
  classifyBMI,
  classifyBP,
  classifyBodyFat,
  generateAlerts,
} from "../classifications";

describe("classifyBMI", () => {
  it("classifies underweight", () => {
    const result = classifyBMI(17.5);
    expect(result.category).toBe("Underweight");
    expect(result.severity).toBe("warning");
  });

  it("classifies normal weight", () => {
    const result = classifyBMI(22);
    expect(result.category).toBe("Normal");
    expect(result.severity).toBe("normal");
  });

  it("classifies overweight", () => {
    const result = classifyBMI(27);
    expect(result.category).toBe("Overweight");
    expect(result.severity).toBe("warning");
  });

  it("classifies obesity grade I", () => {
    const result = classifyBMI(32);
    expect(result.category).toBe("Obesity Grade I");
    expect(result.severity).toBe("danger");
  });

  it("classifies obesity grade II", () => {
    const result = classifyBMI(37);
    expect(result.category).toBe("Obesity Grade II");
    expect(result.severity).toBe("danger");
  });

  it("classifies obesity grade III", () => {
    const result = classifyBMI(42);
    expect(result.category).toBe("Obesity Grade III");
    expect(result.severity).toBe("danger");
  });

  it("handles boundary values", () => {
    expect(classifyBMI(18.5).category).toBe("Normal");
    expect(classifyBMI(25).category).toBe("Overweight");
    expect(classifyBMI(30).category).toBe("Obesity Grade I");
    expect(classifyBMI(35).category).toBe("Obesity Grade II");
    expect(classifyBMI(40).category).toBe("Obesity Grade III");
  });
});

describe("classifyBP", () => {
  it("classifies optimal", () => {
    const result = classifyBP(115, 75);
    expect(result.category).toBe("Optimal");
    expect(result.severity).toBe("normal");
  });

  it("classifies normal", () => {
    const result = classifyBP(125, 82);
    expect(result.category).toBe("Normal");
    expect(result.severity).toBe("normal");
  });

  it("classifies high-normal", () => {
    const result = classifyBP(135, 87);
    expect(result.category).toBe("High-normal");
    expect(result.severity).toBe("elevated");
  });

  it("classifies hypertension grade 1", () => {
    const result = classifyBP(150, 95);
    expect(result.category).toBe("Hypertension Grade 1");
    expect(result.severity).toBe("warning");
  });

  it("classifies hypertension grade 2", () => {
    const result = classifyBP(170, 105);
    expect(result.category).toBe("Hypertension Grade 2");
    expect(result.severity).toBe("danger");
  });

  it("classifies hypertension grade 3", () => {
    const result = classifyBP(185, 115);
    expect(result.category).toBe("Hypertension Grade 3");
    expect(result.severity).toBe("danger");
  });

  it("uses the higher category when sys and dia differ", () => {
    // Sys is optimal but dia is high
    const result = classifyBP(115, 95);
    expect(result.category).toBe("Hypertension Grade 1");
  });
});

describe("generateAlerts", () => {
  it("returns empty for empty input", () => {
    expect(generateAlerts({})).toEqual([]);
  });

  it("generates BMI success alert for normal BMI", () => {
    const alerts = generateAlerts({ bmi: 22 });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].level).toBe("success");
    expect(alerts[0].title).toContain("normal range");
  });

  it("generates warning for underweight BMI", () => {
    const alerts = generateAlerts({ bmi: 16 });
    expect(alerts[0].level).toBe("warning");
    expect(alerts[0].title).toContain("below normal");
  });

  it("generates warning for obese BMI", () => {
    const alerts = generateAlerts({ bmi: 32 });
    expect(alerts[0].level).toBe("warning");
    expect(alerts[0].title).toContain("obesity");
  });

  it("generates danger for very high BP", () => {
    const alerts = generateAlerts({ bpAvgSys: 175, bpAvgDia: 105 });
    const bpAlert = alerts.find((a) => a.title.includes("Blood pressure"));
    expect(bpAlert?.level).toBe("danger");
  });

  it("generates success for good BP target adherence", () => {
    const alerts = generateAlerts({ bpPctInTarget: 85 });
    const targetAlert = alerts.find((a) =>
      a.title.includes("target adherence"),
    );
    expect(targetAlert?.level).toBe("success");
  });

  it("generates warning for low BP target adherence", () => {
    const alerts = generateAlerts({ bpPctInTarget: 40 });
    const targetAlert = alerts.find((a) => a.title.includes("outside"));
    expect(targetAlert?.level).toBe("warning");
  });

  it("generates info for significant weight increase", () => {
    const alerts = generateAlerts({ weightSlope30: 0.1 }); // 0.7 kg/week
    const weightAlert = alerts.find((a) => a.title.includes("Weight"));
    expect(weightAlert?.level).toBe("info");
    expect(weightAlert?.title).toContain("increasing");
  });

  it("generates warning for pulse anomalies", () => {
    const alerts = generateAlerts({ pulseAnomalyCount: 5 });
    const pulseAlert = alerts.find((a) => a.title.includes("Pulse"));
    expect(pulseAlert?.level).toBe("warning");
  });

  it("generates medication compliance alerts", () => {
    const alerts = generateAlerts({
      medications: [
        { name: "Metoprolol", compliance7: 60, compliance30: 70 },
        { name: "Ramipril", compliance7: 98, compliance30: 95 },
      ],
    });
    const lowAlert = alerts.find(
      (a) => a.title.includes("Metoprolol") && a.level === "warning",
    );
    const highAlert = alerts.find(
      (a) => a.title.includes("Ramipril") && a.level === "success",
    );
    expect(lowAlert).toBeDefined();
    expect(highAlert).toBeDefined();
  });
});

// v1.4 marathon — closes the body-fat ACE drift identified in the
// medical-truthfulness audit. Below-essential is now a danger band,
// "Essential" is the warning band proper, and the labels match ACE.
describe("classifyBodyFat (ACE bands)", () => {
  it("flags below-essential as danger for males", () => {
    expect(classifyBodyFat(1, "MALE").category).toBe("Below essential");
    expect(classifyBodyFat(1, "MALE").severity).toBe("danger");
  });

  it("flags below-essential as danger for females", () => {
    expect(classifyBodyFat(8, "FEMALE").category).toBe("Below essential");
    expect(classifyBodyFat(8, "FEMALE").severity).toBe("danger");
  });

  it("classifies the ACE essential band as a warning, not normal", () => {
    expect(classifyBodyFat(4, "MALE").category).toBe("Essential");
    expect(classifyBodyFat(4, "MALE").severity).toBe("warning");
    expect(classifyBodyFat(11, "FEMALE").category).toBe("Essential");
    expect(classifyBodyFat(11, "FEMALE").severity).toBe("warning");
  });

  it("recognises ACE Athletic and Fitness as normal", () => {
    expect(classifyBodyFat(10, "MALE").category).toBe("Athletic");
    expect(classifyBodyFat(15, "MALE").category).toBe("Fitness");
    expect(classifyBodyFat(17, "FEMALE").category).toBe("Athletic");
    expect(classifyBodyFat(22, "FEMALE").category).toBe("Fitness");
    for (const result of [
      classifyBodyFat(10, "MALE"),
      classifyBodyFat(15, "MALE"),
      classifyBodyFat(17, "FEMALE"),
      classifyBodyFat(22, "FEMALE"),
    ]) {
      expect(result.severity).toBe("normal");
    }
  });

  it("acceptable band uses the new label and warning severity", () => {
    expect(classifyBodyFat(20, "MALE").category).toBe("Acceptable");
    expect(classifyBodyFat(20, "MALE").severity).toBe("warning");
    expect(classifyBodyFat(28, "FEMALE").category).toBe("Acceptable");
    expect(classifyBodyFat(28, "FEMALE").severity).toBe("warning");
  });

  it("classifies obesity by ACE upper bound", () => {
    expect(classifyBodyFat(30, "MALE").category).toBe("Obese");
    expect(classifyBodyFat(35, "FEMALE").category).toBe("Obese");
  });
});
