/**
 * SCI, Spanish: not a validated translation.
 *
 * No validated translation of the SCI in this language could be found whose
 * item text is openly published for reuse. This is a translation written for
 * HealthLog, faithful to the English and on the same scale; the surfaces say
 * so beside it and offer the English original.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: false,
  stems: {
    night: "Pensando en una noche típica del último mes …",
    impact: "Pensando en el último mes, ¿en qué medida dormir mal …",
    finally: "Por último …",
  },
  items: [
    "… ¿cuánto tiempo tarda en quedarse dormido/a?",
    "… si después se despierta durante la noche … ¿cuánto tiempo permanece despierto/a en total? (sume todos los despertares)",
    "… ¿cuántas noches a la semana tiene un problema con el sueño?",
    "… ¿cómo valoraría la calidad de su sueño?",
    "… ha afectado a su estado de ánimo, su energía o sus relaciones?",
    "… ha afectado a su concentración, su productividad o su capacidad para mantenerse despierto/a?",
    "… le ha molestado en general?",
    "… ¿desde hace cuánto tiempo tiene un problema con el sueño?",
  ],
  anchors: {
    duration: {
      0: "≥ 61 min",
      1: "46–60 min",
      2: "31–45 min",
      3: "16–30 min",
      4: "0–15 min",
    },
    nights: { 0: "5–7", 1: "4", 2: "3", 3: "2", 4: "0–1" },
    quality: {
      0: "Muy mala",
      1: "Mala",
      2: "Regular",
      3: "Buena",
      4: "Muy buena",
    },
    impact: { 0: "Muchísimo", 1: "Mucho", 2: "Algo", 3: "Un poco", 4: "Nada" },
    problemDuration: {
      0: "> 1 año",
      1: "7–12 meses",
      2: "3–6 meses",
      3: "1–2 meses",
      4: "No tengo ningún problema / < 1 mes",
    },
  },
};

export default wording;
