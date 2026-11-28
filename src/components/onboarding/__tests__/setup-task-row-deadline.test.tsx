/**
 * The second-factor deadline shows the day the server resolved in the
 * profile's zone (`deadlineDate`), not the instant read in the browser's
 * zone, so the web and the app name the same date.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ShieldCheck } from "lucide-react";

import { I18nProvider } from "@/lib/i18n/context";
import { primeLocales } from "@/__tests__/helpers/prime-locales";
import type { SetupTask } from "@/lib/setup/types";

import { SetupTaskRow } from "../setup-task-rows";

primeLocales("de");

describe("SetupTaskRow deadline", () => {
  it("names the server's day, not the instant's day in the browser", () => {
    // 12:30 UTC on 1 December is already 2 December in Auckland, the
    // profile's zone, and still 1 December west of it.
    const task: SetupTask = {
      id: "second-factor",
      status: "todo",
      value: null,
      deadline: "2026-12-01T12:30:00.000Z",
      deadlineDate: "2026-12-02",
      deadlineTimeZone: "Pacific/Auckland",
    } as SetupTask;
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="de">
        <SetupTaskRow
          task={task}
          kind="person"
          href="/settings/security"
          Icon={ShieldCheck}
        />
      </I18nProvider>,
    );
    expect(html).toContain("Bis 02.12.");
    expect(html).not.toContain("01.12.");
  });
});
