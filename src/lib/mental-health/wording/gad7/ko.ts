/**
 * GAD-7, Korean: a validated translation, reproduced word for word.
 *
 * Each column header is one answer printed over four lines; the third
 * reads "2 주 중 / 절반 이상 / 방해 / 받았다".
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: true,
  source:
    'Pfizer Inc., GAD-7, official translation "Korean for Korea", read from https://www.phqscreeners.com/images/sites/g/files/g10060481/f/201412/GAD7_Korean%20for%20Korea.pdf. Developed by Drs. Robert L. Spitzer, Janet B.W. Williams, Kurt Kroenke and colleagues, with an educational grant from Pfizer Inc. No permission required to reproduce, translate, display or distribute.',
  stems: {
    period:
      "지난 2 주 동안 당신은 다음의 문제들로 인해서 얼마나 자주 방해를 받았습니까?",
  },
  items: [
    "초조하거나 불안하거나 조마조마하게 느낀다",
    "걱정하는 것을 멈추거나 조절할 수가 없다",
    "여러 가지 것들에 대해 걱정을 너무 많이 한다",
    "편하게 있기가 어렵다",
    "너무 안절부절못해서 가만히 있기가 힘들다",
    "쉽게 짜증이 나거나 쉽게 성을 내게 된다",
    "마치 끔찍한 일이 생길 것처럼 두렵게 느껴진다",
  ],
  anchors: {
    all: {
      0: "전혀 방해 받지 않았다",
      1: "며칠 동안 방해 받았다",
      2: "2 주 중 절반 이상 방해 받았다",
      3: "거의 매일 방해 받았다",
    },
  },
};

export default wording;
