/**
 * v1.10.0 — the single derived-metric provenance source map.
 *
 * One place that pins, per derived metric, the cited standard (a real,
 * linkable primary source — DOI / WHO / professional-society standard) and
 * the i18n keys for the plain-language method copy + the honesty caveat the
 * `ProvenanceExplainer` / `ScoreAnatomyView` surface. Every score surface
 * (the dashboard tiles, the wellness rings, the anatomy detail pages, the
 * coincident-deviation flag) reads from here so the method + cited standard
 * a metric exposes stays one source — never a comment buried in the engine
 * module, never two surfaces disagreeing on the citation.
 *
 * Client-safe: a string-keyed metadata map + i18n key names, no compute, no
 * server imports — a `"use client"` surface value-imports it freely.
 *
 * One thing to know before trusting `standard` to reach a reader: it does
 * not, everywhere. `ProvenanceExplainer` accepts the prop and renders only
 * the method caption (v1.22 folded the cited-standard line out along with
 * the ⓘ popover it lived in), so a surface that goes through that component
 * shows the method copy and nothing else. `InfoPopover` still renders the
 * link, which is why the vitals dashboard does surface citations. The
 * Health Score is on the first path, so its honesty about what the number
 * covers has to live in `insights.healthScore.method` — the standard entry
 * alone would say it to nobody.
 */
import { HEALTH_SCORE_PROVENANCE } from "./health-score-provenance";
import type { ProvenanceStandard } from "./provenance-explainer";
import type { DerivedMetricId } from "@/lib/insights/derived/registry";

export interface MetricProvenanceMeta {
  /** i18n key for the plain-language method copy (under composite.*.method). */
  methodKey: string;
  /** The cited primary standard rendered as an external link. */
  standard: ProvenanceStandard;
  /**
   * Optional i18n key for an honesty caveat surfaced above the method —
   * e.g. STRESS_SCORE must state it is an HRV-derived proxy, not an
   * EDA/galvanic measurement.
   */
  caveatKey?: string;
}

/**
 * The cited standard + method/caveat keys for every derived metric. The
 * `method`/`caveat` keys live under `insights.derived.composite.<ID>.*`
 * (extending the shape SLEEP_SCORE + READINESS already use) so the i18n
 * bundle carries one consistent namespace.
 */
export const METRIC_PROVENANCE: Record<DerivedMetricId, MetricProvenanceMeta> =
  {
    VITALS_BASELINE: {
      methodKey: "insights.derived.composite.VITALS_BASELINE.method",
      standard: {
        // Robust central-tendency / dispersion via the median ± k·MAD.
        name: "Leys et al. 2013, J. Exp. Soc. Psychol.",
        url: "https://doi.org/10.1016/j.jesp.2013.03.013",
      },
    },
    HRV_BALANCE: {
      methodKey: "insights.derived.composite.HRV_BALANCE.method",
      standard: {
        // Task Force of the ESC / NASPE — HRV standards of measurement.
        name: "Task Force ESC/NASPE 1996, Circulation",
        url: "https://doi.org/10.1161/01.CIR.93.5.1043",
      },
    },
    BMI: {
      methodKey: "insights.derived.composite.BMI.method",
      standard: {
        // WHO Technical Report Series 894 — BMI classification.
        name: "WHO Technical Report Series 894",
        url: "https://iris.who.int/handle/10665/42330",
      },
    },
    FITNESS_AGE: {
      methodKey: "insights.derived.composite.FITNESS_AGE.method",
      standard: {
        // FRIEND registry CRF reference standards (Kaminsky et al.).
        name: "Kaminsky et al. 2015, Mayo Clin. Proc. (FRIEND)",
        url: "https://doi.org/10.1016/j.mayocp.2015.07.026",
      },
    },
    VASCULAR_AGE_DELTA: {
      methodKey: "insights.derived.composite.VASCULAR_AGE_DELTA.method",
      standard: {
        // Reference values for arterial stiffness (PWV) collaboration.
        name: "Reference Values for Arterial Stiffness 2010, Eur. Heart J.",
        url: "https://doi.org/10.1093/eurheartj/ehq165",
      },
      caveatKey: "insights.derived.composite.VASCULAR_AGE_DELTA.caveat",
    },
    COINCIDENT_DEVIATION: {
      methodKey: "insights.derived.composite.COINCIDENT_DEVIATION.method",
      standard: {
        // Hampel-identifier / median ± k·MAD outlier flagging.
        name: "Leys et al. 2013, J. Exp. Soc. Psychol.",
        url: "https://doi.org/10.1016/j.jesp.2013.03.013",
      },
      caveatKey: "insights.derived.composite.COINCIDENT_DEVIATION.caveat",
    },
    SLEEP_SCORE: {
      methodKey: "insights.derived.composite.SLEEP_SCORE.method",
      standard: {
        name: "Hirshkowitz et al. 2015, Sleep Health",
        url: "https://doi.org/10.1016/j.sleh.2014.12.010",
      },
    },
    READINESS: {
      methodKey: "insights.derived.composite.READINESS.method",
      standard: {
        name: "Plews et al. 2013, Sports Medicine",
        url: "https://doi.org/10.1007/s40279-013-0071-8",
      },
    },
    RECOVERY_SCORE: {
      methodKey: "insights.derived.composite.RECOVERY_SCORE.method",
      standard: {
        // HRV-guided recovery / training-readiness framing.
        name: "Buchheit 2014, Front. Physiol.",
        url: "https://doi.org/10.3389/fphys.2014.00073",
      },
    },
    STRESS_SCORE: {
      methodKey: "insights.derived.composite.STRESS_SCORE.method",
      standard: {
        // Neurovisceral-integration / HRV-as-stress-index basis.
        name: "Kim et al. 2018, Psychiatry Investig.",
        url: "https://doi.org/10.30773/pi.2017.08.17",
      },
    },
    STRAIN_SCORE: {
      methodKey: "insights.derived.composite.STRAIN_SCORE.method",
      standard: {
        // Banister TRIMP training-load model (HR-reserve weighting).
        name: "Banister 1991, TRIMP model",
        url: "https://en.wikipedia.org/wiki/Training_Impulse",
      },
    },
    WRIST_TEMPERATURE_BASELINE: {
      methodKey: "insights.derived.composite.WRIST_TEMPERATURE_BASELINE.method",
      standard: {
        // Robust personal-deviation band via the median ± k·MAD.
        name: "Leys et al. 2013, J. Exp. Soc. Psychol.",
        url: "https://doi.org/10.1016/j.jesp.2013.03.013",
      },
      caveatKey: "insights.derived.composite.WRIST_TEMPERATURE_BASELINE.caveat",
    },
    STAIR_ASCENT_SPEED_BASELINE: {
      methodKey:
        "insights.derived.composite.STAIR_ASCENT_SPEED_BASELINE.method",
      standard: {
        // Robust personal-trend band via the median ± k·MAD.
        name: "Leys et al. 2013, J. Exp. Soc. Psychol.",
        url: "https://doi.org/10.1016/j.jesp.2013.03.013",
      },
      caveatKey:
        "insights.derived.composite.STAIR_ASCENT_SPEED_BASELINE.caveat",
    },
    STAIR_DESCENT_SPEED_BASELINE: {
      methodKey:
        "insights.derived.composite.STAIR_DESCENT_SPEED_BASELINE.method",
      standard: {
        // Robust personal-trend band via the median ± k·MAD.
        name: "Leys et al. 2013, J. Exp. Soc. Psychol.",
        url: "https://doi.org/10.1016/j.jesp.2013.03.013",
      },
      caveatKey:
        "insights.derived.composite.STAIR_DESCENT_SPEED_BASELINE.caveat",
    },
    SIX_MINUTE_WALK_BAND: {
      methodKey: "insights.derived.composite.SIX_MINUTE_WALK_BAND.method",
      standard: {
        // Enright & Sherrill 1998 reference equations (ATS 2002 test standard).
        name: "Enright & Sherrill 1998, Am. J. Respir. Crit. Care Med.",
        url: "https://doi.org/10.1164/ajrccm.158.5.9710086",
      },
      caveatKey: "insights.derived.composite.SIX_MINUTE_WALK_BAND.caveat",
    },
    TRAJECTORY: {
      methodKey: "insights.derived.composite.TRAJECTORY.method",
      standard: {
        // Ordinary least squares + the textbook OLS prediction interval.
        name: "Montgomery, Peck & Vining 2012, Intro. to Linear Regression Analysis",
        url: "https://www.wiley.com/en-us/Introduction+to+Linear+Regression+Analysis%2C+5th+Edition-p-9780470542811",
      },
      caveatKey: "insights.derived.composite.TRAJECTORY.caveat",
    },
    SAME_TIME_BASELINE: {
      methodKey: "insights.derived.composite.SAME_TIME_BASELINE.method",
      standard: {
        // Same robust median ± k·MAD estimator as the vitals baseline, applied
        // to the window's totals at one local hour rather than to daily means.
        name: "Leys et al. 2013, J. Exp. Soc. Psychol.",
        url: "https://doi.org/10.1016/j.jesp.2013.03.013",
      },
      caveatKey: "insights.derived.composite.SAME_TIME_BASELINE.caveat",
    },
    // The HEALTH_SCORE entry lives in its own module so the eager insights
    // overview can import just this metric's citation without pulling the whole
    // map; the rationale for its wording is documented there.
    HEALTH_SCORE: HEALTH_SCORE_PROVENANCE,
  };
