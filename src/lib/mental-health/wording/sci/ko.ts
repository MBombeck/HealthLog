/**
 * SCI, Korean: not a validated translation.
 *
 * No validated translation of the SCI in this language could be found whose
 * item text is openly published for reuse. This is a translation written for
 * HealthLog, faithful to the English and on the same scale; the surfaces say
 * so beside it and offer the English original.
 *
 * A Korean SCI was tested in a master's thesis (Song S-A, Sungshin Women's
 * University 2024; CC BY-NC-ND). It is not a peer-reviewed validation and
 * it changes the instrument: an agreement scale for items 5 to 7, a
 * different item 7 and no closing stem, so it is not used.
 */
import type { InstrumentWording } from "../types";

const wording: InstrumentWording = {
  validated: false,
  stems: {
    night: "지난 한 달 동안의 평소 밤을 생각해 볼 때 …",
    impact: "지난 한 달을 생각해 볼 때, 잠을 잘 자지 못한 것이 …",
    finally: "마지막으로 …",
  },
  items: [
    "… 잠드는 데 얼마나 걸립니까?",
    "… 그런 다음 밤중에 깨는 경우 … 모두 합해 얼마나 오래 깨어 있습니까? (깨어 있던 시간을 모두 더하십시오)",
    "… 일주일에 며칠 밤 수면에 문제가 있습니까?",
    "… 수면의 질을 어떻게 평가하시겠습니까?",
    "… 기분, 기력 또는 대인 관계에 어느 정도 영향을 주었습니까?",
    "… 집중력, 생산성 또는 깨어 있는 능력에 어느 정도 영향을 주었습니까?",
    "… 전반적으로 어느 정도 괴로움을 주었습니까?",
    "… 수면 문제가 얼마나 오래되었습니까?",
  ],
  anchors: {
    duration: {
      0: "61분 이상",
      1: "46–60분",
      2: "31–45분",
      3: "16–30분",
      4: "0–15분",
    },
    nights: { 0: "5–7", 1: "4", 2: "3", 3: "2", 4: "0–1" },
    quality: {
      0: "매우 나쁨",
      1: "나쁨",
      2: "보통",
      3: "좋음",
      4: "매우 좋음",
    },
    impact: {
      0: "매우 많이",
      1: "많이",
      2: "어느 정도",
      3: "약간",
      4: "전혀 아니다",
    },
    problemDuration: {
      0: "1년 초과",
      1: "7–12개월",
      2: "3–6개월",
      3: "1–2개월",
      4: "문제 없음 / 1개월 미만",
    },
  },
};

export default wording;
