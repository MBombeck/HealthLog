/**
 * SCI, Portuguese (Brazil): not a validated translation.
 *
 * No validated translation of the SCI in this language could be found whose
 * item text is openly published for reuse. This is a translation written for
 * HealthLog, faithful to the English and on the same scale; the surfaces say
 * so beside it and offer the English original.
 *
 * The SCI is validated in European Portuguese (Marques et al., J Sleep Res
 * 2024), not in Brazilian Portuguese, and that version's text is
 * available only from its authors on request.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: false,
  stems: {
    night: "Pensando em uma noite típica do último mês …",
    impact: "Pensando no último mês, em que medida o sono ruim …",
    finally: "Por fim …",
  },
  items: [
    "… quanto tempo você leva para pegar no sono?",
    "… se depois você acorda durante a noite … quanto tempo fica acordado/a no total? (some todos os despertares)",
    "… quantas noites por semana você tem problema com o sono?",
    "… como você avaliaria a qualidade do seu sono?",
    "… afetou seu humor, sua energia ou seus relacionamentos?",
    "… afetou sua concentração, sua produtividade ou sua capacidade de se manter acordado/a?",
    "… incomodou você de modo geral?",
    "… há quanto tempo você tem problema com o sono?",
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
      0: "Muito ruim",
      1: "Ruim",
      2: "Regular",
      3: "Boa",
      4: "Muito boa",
    },
    impact: {
      0: "Muitíssimo",
      1: "Muito",
      2: "Mais ou menos",
      3: "Um pouco",
      4: "Nada",
    },
    problemDuration: {
      0: "> 1 ano",
      1: "7–12 meses",
      2: "3–6 meses",
      3: "1–2 meses",
      4: "Não tenho problema / < 1 mês",
    },
  },
};

export default wording;
