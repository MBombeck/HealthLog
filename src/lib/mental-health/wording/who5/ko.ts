/**
 * WHO-5, Korean: a validated translation, reproduced word for word.
 *
 * Neither WHO nor the Psychiatric Research Unit distributes a Korean
 * WHO-5; this is the validated Korean version from the literature. The
 * stem is the table's column header, the items and answers are as
 * printed less the full stop that closes each table cell, and the items
 * keep the present tense the published version uses.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    "Kim HJ, Moon YS, Son BK, Lee SK, Rho HJ, Kim DH. The utility of Korean version of the WHO Five Well-Being Index in evaluating depressive symptoms and quality of life in the aged dwelling in community (한국판 WHO-5의 유용성). Journal of Korean Geriatric Psychiatry 2010;14(2):90-96, Appendix 1, p. 96; free full text at https://www.kci.go.kr/kciportal/ci/sereArticleSearch/ciSereArtiView.kci?sereArticleSearchBean.artiId=ART001514454. Forward and blind back-translation, validated against depression and quality-of-life measures. The article states no licence beyond its copyright line (© 2010 Korean Association for Geriatric Psychiatry) and no restriction on using the instrument; the WHO-5 itself is free to use (WHO, CC BY-NC-SA 3.0 IGO).",
  stems: { period: "지난 2주 동안" },
  items: [
    "나는 즐겁고 기분이 좋다",
    "나는 평온하고 느긋하다",
    "나는 의욕적이고 활기차다",
    "나는 자고 일어나면 상쾌하고 푹 쉬었다는 느낌이 든다",
    "나의 일상생활은 흥미로운 일들로 가득하다",
  ],
  anchors: {
    all: {
      0: "전혀 그렇지 않다",
      1: "가끔 그렇다",
      2: "절반 미만이 그렇다",
      3: "절반 이상이 그렇다",
      4: "거의 그렇다",
      5: "항상 그렇다",
    },
  },
};

export default wording;
