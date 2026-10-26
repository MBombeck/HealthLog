/**
 * PHQ-9, Korean: a validated translation, reproduced word for word.
 *
 * Each column header ("전혀 방해 / 받지 / 않았다" and so on) is one
 * answer printed over three lines. The spacing of "7 일" and "2 주일" is
 * the form's own.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Pfizer Inc., PHQ-9, official translation "Korean for Korea", read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/PHQ9_Korean%20for%20Korea.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  stems: {
    period:
      "지난 2 주일 동안 당신은 다음의 문제들로 인해서 얼마나 자주 방해를 받았습니까?",
  },
  items: [
    "일 또는 여가 활동을 하는 데 흥미나 즐거움을 느끼지 못함",
    "기분이 가라앉거나, 우울하거나, 희망이 없음",
    "잠이 들거나 계속 잠을 자는 것이 어려움, 또는 잠을 너무 많이 잠",
    "피곤하다고 느끼거나 기운이 거의 없음",
    "입맛이 없거나 과식을 함",
    "자신을 부정적으로 봄 - 혹은 자신이 실패자라고 느끼거나 자신 또는 가족을 실망시킴",
    "신문을 읽거나 텔레비전 보는 것과 같은 일에 집중하는 것이 어려움",
    "다른 사람들이 주목할 정도로 너무 느리게 움직이거나 말을 함. 또는 반대로 평상시보다 많이 움직여서, 너무 안절부절 못하거나 들떠 있음",
    "자신이 죽는 것이 더 낫다고 생각하거나 어떤 식으로든 자신을 해칠 것이라고 생각함",
  ],
  anchors: {
    all: {
      0: "전혀 방해 받지 않았다",
      1: "며칠 동안 방해 받았다",
      2: "7 일 이상 방해 받았다",
      3: "거의 매일 방해 받았다",
    },
  },
  functional: {
    title:
      '만일 당신이 위의 문제 중 하나 이상 "예" 라고 응답하셨으면, 이러한 문제들로 인해서 당신은 일을 하거나 가정일을 돌보거나 다른 사람과 어울리는 것이 얼마나 어려웠습니까?',
    anchors: {
      0: "전혀 어렵지 않았다",
      1: "약간 어려웠다",
      2: "많이 어려웠다",
      3: "매우 많이 어려웠다",
    },
  },
};

export default wording;
