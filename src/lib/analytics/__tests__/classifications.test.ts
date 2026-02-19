import { describe, it, expect } from "vitest";
import { classifyBMI, classifyBP, generateAlerts } from "../classifications";

describe("classifyBMI", () => {
  it("classifies underweight", () => {
    const result = classifyBMI(17.5);
    expect(result.category).toBe("Untergewicht");
    expect(result.severity).toBe("warning");
  });

  it("classifies normal weight", () => {
    const result = classifyBMI(22);
    expect(result.category).toBe("Normalgewicht");
    expect(result.severity).toBe("normal");
  });

  it("classifies overweight", () => {
    const result = classifyBMI(27);
    expect(result.category).toBe("Übergewicht");
    expect(result.severity).toBe("warning");
  });

  it("classifies obesity grade I", () => {
    const result = classifyBMI(32);
    expect(result.category).toBe("Adipositas Grad I");
    expect(result.severity).toBe("danger");
  });

  it("classifies obesity grade II", () => {
    const result = classifyBMI(37);
    expect(result.category).toBe("Adipositas Grad II");
    expect(result.severity).toBe("danger");
  });

  it("classifies obesity grade III", () => {
    const result = classifyBMI(42);
    expect(result.category).toBe("Adipositas Grad III");
    expect(result.severity).toBe("danger");
  });

  it("handles boundary values", () => {
    expect(classifyBMI(18.5).category).toBe("Normalgewicht");
    expect(classifyBMI(25).category).toBe("Übergewicht");
    expect(classifyBMI(30).category).toBe("Adipositas Grad I");
    expect(classifyBMI(35).category).toBe("Adipositas Grad II");
    expect(classifyBMI(40).category).toBe("Adipositas Grad III");
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
    expect(result.category).toBe("Hoch-normal");
    expect(result.severity).toBe("elevated");
  });

  it("classifies hypertension grade 1", () => {
    const result = classifyBP(150, 95);
    expect(result.category).toBe("Hypertonie Grad 1");
    expect(result.severity).toBe("warning");
  });

  it("classifies hypertension grade 2", () => {
    const result = classifyBP(170, 105);
    expect(result.category).toBe("Hypertonie Grad 2");
    expect(result.severity).toBe("danger");
  });

  it("classifies hypertension grade 3", () => {
    const result = classifyBP(185, 115);
    expect(result.category).toBe("Hypertonie Grad 3");
    expect(result.severity).toBe("danger");
  });

  it("uses the higher category when sys and dia differ", () => {
    // Sys is optimal but dia is high
    const result = classifyBP(115, 95);
    expect(result.category).toBe("Hypertonie Grad 1");
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
    expect(alerts[0].title).toContain("Normalbereich");
  });

  it("generates warning for underweight BMI", () => {
    const alerts = generateAlerts({ bmi: 16 });
    expect(alerts[0].level).toBe("warning");
    expect(alerts[0].title).toContain("unter Normalbereich");
  });

  it("generates warning for obese BMI", () => {
    const alerts = generateAlerts({ bmi: 32 });
    expect(alerts[0].level).toBe("warning");
    expect(alerts[0].title).toContain("Adipositas");
  });

  it("generates danger for very high BP", () => {
    const alerts = generateAlerts({ bpAvgSys: 175, bpAvgDia: 105 });
    const bpAlert = alerts.find((a) => a.title.includes("Blutdruck"));
    expect(bpAlert?.level).toBe("danger");
  });

  it("generates success for good BP target adherence", () => {
    const alerts = generateAlerts({ bpPctInTarget: 85 });
    const targetAlert = alerts.find((a) =>
      a.title.includes("Zielbereichstreue"),
    );
    expect(targetAlert?.level).toBe("success");
  });

  it("generates warning for low BP target adherence", () => {
    const alerts = generateAlerts({ bpPctInTarget: 40 });
    const targetAlert = alerts.find((a) => a.title.includes("außerhalb"));
    expect(targetAlert?.level).toBe("warning");
  });

  it("generates info for significant weight increase", () => {
    const alerts = generateAlerts({ weightSlope30: 0.1 }); // 0.7 kg/week
    const weightAlert = alerts.find((a) => a.title.includes("Gewicht"));
    expect(weightAlert?.level).toBe("info");
    expect(weightAlert?.title).toContain("steigend");
  });

  it("generates warning for pulse anomalies", () => {
    const alerts = generateAlerts({ pulseAnomalyCount: 5 });
    const pulseAlert = alerts.find((a) => a.title.includes("Puls"));
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
