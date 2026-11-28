/**
 * The record `mobile-route-overflow.spec.ts` measures.
 *
 * A phone-width overflow guard that visits an empty page proves nothing: an
 * empty list fits any viewport, and the lab list that panned sideways on a
 * phone only did so once it held a reading. So the account gets one or two of
 * everything a signed-in route can render — readings with reference ranges, a
 * medication, a mood entry, a visit, a vaccination, an illness episode, a
 * custom metric, a workout, a document — and every dynamic route has a real id
 * to open.
 *
 * Written through the app's own routes, once, from `globalSetup`, so the
 * parallel workers of the spec never race each other to seed it. An account
 * that already holds a lab reading is taken as seeded, which keeps a local
 * re-run against a reused database from doubling every row.
 */
import { request as playwrightRequest } from "@playwright/test";

/** Long on purpose: the names are what a narrow column has to give way to. */
export const MOBILE_ROUTES_ANALYTE = "Glomeruläre Filtrationsrate (eGFR)";

export async function seedMobileRoutesRecord(
  baseURL: string,
  storageStatePath: string,
): Promise<void> {
  const ctx = await playwrightRequest.newContext({
    baseURL,
    storageState: storageStatePath,
  });
  try {
    // The document is the last thing written, so its presence means a
    // complete record. A run that died half-way is finished by the next one:
    // a row it already wrote answers 409 and is skipped.
    const existing = await ctx.get("/api/documents/inbound");
    const existingBody = (await existing.json()) as {
      data: { documents?: unknown[] } | unknown[] | null;
    };
    const documents = Array.isArray(existingBody.data)
      ? existingBody.data
      : (existingBody.data?.documents ?? []);
    if (documents.length > 0) return;

    const post = async (path: string, data: unknown): Promise<unknown> => {
      const res = await ctx.post(path, { data });
      if (res.status() === 409) return null;
      if (!res.ok()) {
        throw new Error(
          `[mobile-routes-fixture] ${path} answered ${res.status()}: ${(await res.text()).slice(0, 200)}`,
        );
      }
      return ((await res.json()) as { data: unknown }).data;
    };
    const daysAgo = (days: number, hour = 8) => {
      const at = new Date(Date.now() - days * 86_400_000);
      at.setUTCHours(hour, 0, 0, 0);
      return at.toISOString();
    };

    for (let day = 1; day <= 6; day += 1) {
      await post("/api/measurements", {
        type: "WEIGHT",
        value: 80 + day / 10,
        measuredAt: daysAgo(day, 7),
      });
      await post("/api/measurements", {
        type: "BLOOD_PRESSURE_SYS",
        value: 120 + day,
        measuredAt: daysAgo(day, 7),
      });
      await post("/api/measurements", {
        type: "BLOOD_PRESSURE_DIA",
        value: 78 + (day % 3),
        measuredAt: daysAgo(day, 7),
      });
      await post("/api/measurements", {
        type: "PULSE",
        value: 60 + day,
        measuredAt: daysAgo(day, 7),
      });
      await post("/api/measurements", {
        type: "BLOOD_GLUCOSE",
        value: 92 + day,
        glucoseContext: "FASTING",
        measuredAt: daysAgo(day, 6),
      });
      await post("/api/mood-entries", {
        mood: day % 2 ? "GUT" : "OKAY",
        moodLoggedAt: daysAgo(day, 20),
      });
    }

    // Two readings of one marker, so the list row has a trend line and a
    // range bar, plus a qualitative one with neither.
    for (const [days, value] of [
      [40, 78],
      [5, 84],
    ] as const) {
      await post("/api/labs", {
        analyte: MOBILE_ROUTES_ANALYTE,
        panel: "Nierenwerte und Elektrolyte",
        value,
        unit: "mL/min/1.73m²",
        referenceLow: 60,
        referenceHigh: 120,
        takenAt: daysAgo(days),
      });
    }
    await post("/api/labs", {
      analyte: "Hepatitis-B-Oberflächenantigen",
      valueText: "negativ",
      takenAt: daysAgo(5),
    });

    await post("/api/medications", {
      name: "Ramipril",
      dose: "5 mg",
      schedules: [{ windowStart: "08:00", windowEnd: "09:00" }],
    });

    const practitioner = (await post("/api/practitioners", {
      name: "Gemeinschaftspraxis für Allgemeinmedizin",
      specialty: "Allgemeinmedizin und Innere Medizin",
    })) as { id: string } | null;
    await post("/api/encounters", {
      occurredAt: daysAgo(20),
      practitionerId: practitioner?.id ?? null,
      reason: "Routinekontrolle Blutdruck und Blutbild",
    });
    await post("/api/vaccinations", {
      occurredAt: daysAgo(300),
      antigenSlug: "tetanus",
      doseNumber: 1,
      lotNumber: "AB1234-XY",
      practitionerId: practitioner?.id ?? null,
    });

    await post("/api/imaging", {
      modality: "MRI",
      performedAt: daysAgo(40),
      side: "LEFT",
      bodyPart: "Knie",
      facility: "Radiologie am Markt",
      conclusion: "Kleiner Meniskusriss",
    });

    await post("/api/illness/episodes", {
      label: "Erkältung mit Husten",
      type: "INFECTION",
      onsetAt: daysAgo(12),
      resolvedAt: daysAgo(6),
    });

    const metric = (await post("/api/custom-metrics", {
      name: "Augeninnendruck rechts",
      unit: "mmHg",
      targetLow: 10,
      targetHigh: 21,
      decimals: 0,
    })) as { id: string } | null;
    const metricId =
      metric?.id ??
      (
        (await (await ctx.get("/api/custom-metrics")).json()) as {
          data: { customMetrics: Array<{ id: string }> };
        }
      ).data.customMetrics[0]?.id;
    await post(`/api/custom-metrics/${metricId}/entries`, {
      value: 16,
      measuredAt: daysAgo(3),
    });

    await post("/api/workouts/batch", {
      workouts: [
        {
          sportType: "running",
          startedAt: daysAgo(2, 6),
          endedAt: new Date(
            new Date(daysAgo(2, 6)).getTime() + 45 * 60_000,
          ).toISOString(),
          source: "APPLE_HEALTH",
          externalId: "e2e-mobile-routes-run",
          activeEnergyKcal: 420,
          distanceM: 6500,
        },
      ],
    });

    const pdf =
      "%PDF-1.4\n%e2e-mobile-routes\n" +
      "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
      "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
      "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
      "xref\n0 4\ntrailer<</Size 4/Root 1 0 R>>\n%%EOF\n";
    const doc = await ctx.post("/api/documents/inbound", {
      multipart: {
        file: {
          name: "laborbefund-hausarzt-mit-langem-dateinamen.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from(pdf),
        },
        title: "Laborbefund Hausarzt mit einem sehr langen Titel",
        kind: "LAB_RESULT",
      },
    });
    if (!doc.ok()) {
      throw new Error(
        `[mobile-routes-fixture] /api/documents/inbound answered ${doc.status()}`,
      );
    }
  } finally {
    await ctx.dispose();
  }
}
