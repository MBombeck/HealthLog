/**
 * The questionnaire check-in, driven by clicks and keys in a real browser.
 *
 * The step arithmetic is pinned on its own in `check-in-nav.test.ts`; this
 * suite proves the wizard a person uses: one question at a time in the source
 * order, Back keeping the answer, the number keys, the review with a way back
 * to every answer, the optional PHQ-9 follow-up, the note over an unvalidated
 * translation staying on screen with every question, and the body the page
 * posts. The questionnaire text loads through the production chunk loader,
 * not a seeded cache.
 */
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { WORDING } from "@/lib/mental-health/wording";
import type { Locale } from "@/lib/i18n/config";

import { stubFetch } from "../../../../tests/browser/fetch-stub";
import { renderWithApp } from "../../../../tests/browser/render";
import { CheckInWizard } from "../check-in-wizard";
import { MentalWellbeing } from "../mental-wellbeing";
import type { CheckInAnswers, InstrumentId } from "../types";

const WHO5 = WORDING.WHO5.en;
const PHQ9 = WORDING.PHQ9.en;

async function wizard(
  instrument: InstrumentId,
  {
    locale = "en",
    isError = false,
  }: { locale?: Locale; isError?: boolean } = {},
) {
  const onSubmit = vi.fn<(answers: CheckInAnswers) => void>();
  const onBack = vi.fn();
  const { screen } = await renderWithApp(
    <CheckInWizard
      instrument={instrument}
      onSubmit={onSubmit}
      onBack={onBack}
      isPending={false}
      isError={isError}
    />,
    { locale },
  );
  const heading = screen.getByRole("heading", { level: 2 });
  /** The step on screen asks `text` (waiting out the language's chunk). */
  const expectQuestion = (text: string) =>
    expect.element(heading).toHaveTextContent(text);
  const answer = (name: string) =>
    screen.getByRole("radio", { name, exact: true });
  const button = (name: string) =>
    screen.getByRole("button", { name, exact: true });
  return { screen, onSubmit, onBack, expectQuestion, answer, button };
}

/**
 * Answer the current step by its position, as a keyboard user does: each new
 * step focuses its question, so Tab first reaches the answers, then the
 * number key chooses. The step moves the focus in an effect after it renders,
 * so the keys wait for the question to hold it, as a person reading it would;
 * pressed earlier, Tab started from the previous step's answer and the number
 * chose nothing.
 */
async function pressAnswer(position: number) {
  await expect
    .poll(() => document.activeElement?.getAttribute("data-slot"))
    .toBe("check-in-question");
  await userEvent.tab();
  await userEvent.keyboard(String(position));
}

describe("<CheckInWizard> steps", () => {
  it("opens on the first question with the stem and the answers in source order", async () => {
    const { screen, button } = await wizard("WHO5");
    await expect.element(screen.getByText(WHO5.items[0])).toBeVisible();
    await expect.element(screen.getByText(WHO5.stems.period)).toBeVisible();
    await expect.element(screen.getByText("Question 1 of 5")).toBeVisible();
    const labels = screen
      .getByRole("radio")
      .elements()
      .map((el) => el.textContent);
    expect(labels).toEqual([5, 4, 3, 2, 1, 0].map((v) => WHO5.anchors.all[v]));
    await expect.element(button("Back")).toBeDisabled();
    await expect.element(button("Next")).toBeDisabled();
    await expect.element(button("See my result")).not.toBeInTheDocument();
    // The instrument's own explanation heads the check-in; the landing's
    // self-test disclaimer does not follow the person into it.
    await expect
      .element(
        screen.getByText(
          "5-question well-being check. Answer for the last two weeks; higher numbers mean better well-being.",
        ),
      )
      .toBeVisible();
    await expect
      .element(screen.getByText(/not a diagnosis/i))
      .not.toBeInTheDocument();
    // English is the validated wording: no note, no switch.
    await expect
      .element(screen.getByText(/has not been scientifically validated/))
      .not.toBeInTheDocument();
  });

  it("gives each SCI item its own answers under its section stem", async () => {
    const SCI = WORDING.SCI.en;
    const { screen, expectQuestion } = await wizard("SCI");
    await expectQuestion(SCI.items[0]);
    await expect.element(screen.getByText(SCI.stems.night)).toBeVisible();
    await expect.element(screen.getByText("Question 1 of 8")).toBeVisible();
    expect(
      screen
        .getByRole("radio")
        .elements()
        .map((el) => el.textContent),
    ).toEqual([4, 3, 2, 1, 0].map((v) => SCI.anchors.duration[v]));
  });

  it("advances on a choice, and Back returns with the answer still chosen", async () => {
    const { screen, answer, button, expectQuestion } = await wizard("WHO5");
    await answer(WHO5.anchors.all[3]).click();
    await expect.element(screen.getByText("Question 2 of 5")).toBeVisible();
    await expectQuestion(WHO5.items[1]);
    await expect.element(button("Next")).toBeDisabled();

    await button("Back").click();
    await expectQuestion(WHO5.items[0]);
    await expect.element(answer(WHO5.anchors.all[3])).toBeChecked();
    await button("Next").click();
    await expectQuestion(WHO5.items[1]);
  });

  it("chooses by number key, moves with the arrows and focuses each new question", async () => {
    const { screen, answer } = await wizard("WHO5");
    await answer(WHO5.anchors.all[5]).click();
    await expect
      .element(screen.getByRole("heading", { name: WHO5.items[1] }))
      .toHaveFocus();
    await userEvent.tab();
    await expect.element(answer(WHO5.anchors.all[5])).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    await expect.element(answer(WHO5.anchors.all[3])).toHaveFocus();
    await userEvent.keyboard("{End}");
    await expect.element(answer(WHO5.anchors.all[0])).toHaveFocus();

    // "2" is the second answer as printed, which scores 4 on the WHO-5.
    await userEvent.keyboard("2");
    await expect.element(screen.getByText("Question 3 of 5")).toBeVisible();
    await screen.getByRole("button", { name: "Back", exact: true }).click();
    await expect.element(answer(WHO5.anchors.all[4])).toBeChecked();
  });

  it("reviews every answer, changes one and returns to the review", async () => {
    const { screen, onSubmit, button } = await wizard("WHO5");
    for (const position of [1, 2, 3, 4, 5]) await pressAnswer(position);
    await expect
      .element(screen.getByRole("heading", { name: "Check your answers" }))
      .toBeVisible();
    await expect
      .element(screen.getByText("All 5 questions answered"))
      .toBeVisible();

    await screen
      .getByRole("button", { name: "Change the answer to question 3" })
      .click();
    await expect.element(screen.getByText("Question 3 of 5")).toBeVisible();
    await screen
      .getByRole("radio", { name: WHO5.anchors.all[0], exact: true })
      .click();
    await expect
      .element(screen.getByRole("heading", { name: "Check your answers" }))
      .toBeVisible();

    await button("See my result").click();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      items: [5, 4, 0, 2, 1],
      functionalDifficulty: undefined,
      englishOriginal: false,
    });
  });

  it("asks the PHQ-9 follow-up as an optional step that a second press clears", async () => {
    const { screen, onSubmit, answer, button, expectQuestion } =
      await wizard("PHQ9");
    for (let i = 0; i < 9; i++) await pressAnswer(1);
    await expect
      .element(screen.getByText("Follow-up question (optional)"))
      .toBeVisible();
    await expectQuestion(PHQ9.functional!.title);
    await expect.element(button("Review answers")).toBeEnabled();

    await answer(PHQ9.functional!.anchors[2]).click();
    await expect.element(answer(PHQ9.functional!.anchors[2])).toBeChecked();
    await answer(PHQ9.functional!.anchors[2]).click();
    await expect.element(answer(PHQ9.functional!.anchors[2])).not.toBeChecked();

    await button("Review answers").click();
    await expect.element(screen.getByText("Not answered")).toBeVisible();
    await button("See my result").click();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      items: [0, 0, 0, 0, 0, 0, 0, 0, 0],
      functionalDifficulty: undefined,
      englishOriginal: false,
    });
  });

  it("returns to the overview and shows a failed submit", async () => {
    const { screen, onBack } = await wizard("GAD7", { isError: true });
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Something went wrong. Please try again.");
    await screen.getByRole("button", { name: "Overview" }).click();
    expect(onBack).toHaveBeenCalledOnce();
  });
});

describe("<CheckInWizard> in the reader's language", () => {
  const SCI_DE = WORDING.SCI.de;
  const NOTE =
    "Diese Übersetzung ist nicht wissenschaftlich validiert; nimm das Ergebnis als Orientierung.";

  it("keeps the note over an unvalidated translation on screen with every question", async () => {
    await page.viewport(390, 640);
    const { screen, expectQuestion } = await wizard("SCI", { locale: "de" });
    expect(SCI_DE.validated).toBe(false);
    const note = screen.getByText(NOTE);
    for (let i = 0; i < 8; i++) {
      await expectQuestion(SCI_DE.items[i]);
      await expect.element(note).toBeVisible();
      const rect = note.element().getBoundingClientRect();
      expect(rect.top, `step ${i + 1}`).toBeGreaterThanOrEqual(0);
      expect(rect.bottom, `step ${i + 1}`).toBeLessThanOrEqual(
        window.innerHeight,
      );
      // The first question arrives with the language's chunk, after the
      // focus move has run, so it is answered by pointer; the rest by key.
      if (i === 0) await screen.getByRole("radio").first().click();
      else await pressAnswer(1);
    }
    await expect
      .element(screen.getByRole("heading", { name: "Antworten prüfen" }))
      .toBeVisible();
    await expect.element(note).toBeVisible();
  });

  it("switches to the English original and says so in the answers", async () => {
    const { screen, onSubmit, expectQuestion } = await wizard("SCI", {
      locale: "de",
    });
    await expectQuestion(SCI_DE.items[0]);
    await screen
      .getByRole("button", { name: "Englischen Originaltext zeigen" })
      .click();
    await expect
      .element(screen.getByRole("heading", { name: WORDING.SCI.en.items[0] }))
      .toHaveAttribute("lang", "en");
    // The note stays: the reader is still in a language with no validated form.
    await expect.element(screen.getByText(NOTE)).toBeVisible();
    await screen.getByRole("radio").first().click();
    for (let i = 1; i < 8; i++) await pressAnswer(1);
    await screen
      .getByRole("button", { name: "Ergebnis ansehen", exact: true })
      .click();
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ englishOriginal: true }),
    );
  });

  it("shows a validated translation with no note and no switch", async () => {
    const { screen, expectQuestion } = await wizard("PHQ9", { locale: "nl" });
    await expectQuestion(WORDING.PHQ9.nl.items[0]);
    await expect
      .element(screen.getByText(WORDING.PHQ9.nl.stems.period))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /English/ }))
      .not.toBeInTheDocument();
  });
});

describe("the check-in from the overview", () => {
  it("posts the answers with the instrument and the reader's language, then shows the result", async () => {
    const api = stubFetch().on("GET", "/api/mental-health/assessments", {
      data: { assessments: [] },
    });
    const post = api.deferred("POST", "/api/mental-health/assessments");
    const { screen } = await renderWithApp(<MentalWellbeing />);

    const start =
      '[data-instrument="WHO5"] [data-slot="instrument-card-start"]';
    await expect.poll(() => document.querySelector(start)).toBeTruthy();
    await page.elementLocator(document.querySelector(start)!).click();
    await expect.element(screen.getByText(WHO5.items[0])).toBeVisible();
    await screen.getByRole("radio").nth(1).click();
    for (const position of [2, 3, 1, 2]) await pressAnswer(position);
    const submit = screen.getByRole("button", { name: "See my result" });
    await submit.click();

    await expect
      .element(screen.getByRole("button", { name: "Saving…" }))
      .toBeDisabled();
    expect(api.calls("POST", "/api/mental-health/assessments")).toHaveLength(1);
    expect(api.calls("POST", "/api/mental-health/assessments")[0].body).toEqual(
      {
        instrument: "WHO5",
        locale: "en",
        items: [4, 4, 3, 5, 4],
        englishOriginal: false,
      },
    );

    post.release({
      status: 201,
      data: {
        assessment: {
          id: "a-1",
          instrument: "WHO5",
          locale: "en",
          wording: "validated",
          totalScore: 80,
          severityBand: "good",
          item9Flagged: false,
          crisisShownAt: null,
          takenAt: "2026-09-15T10:00:00.000Z",
        },
        actionThreshold: 50,
        crisis: null,
      },
    });
    await expect
      .element(screen.getByText("80", { exact: true }).first())
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "See my result" }))
      .not.toBeInTheDocument();
  });
});
