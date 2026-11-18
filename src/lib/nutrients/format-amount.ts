/**
 * How a nutrient amount reads on screen, one rule for every card on
 * `/insights/nutrients`, the day view and the chart tooltips: whole numbers
 * bare, one decimal where the amount has one, and no decimal from 1,000 up,
 * where a tenth is noise ("2.150 kcal", "120,5 g", "0,4 g", "400 µg"). The
 * cards used to disagree on one page: micronutrients always printed a decimal
 * ("400,0 µg"), caffeine and alcohol rounded to integers (0.4 g of alcohol
 * read "0 g" on a day with data), and the chart rounded what the headline
 * above it did not.
 */
export function formatNutrientAmount(
  fmt: {
    number: (value: number, fractionDigits?: number) => string;
    integer: (value: number) => string;
  },
  amount: number,
  /**
   * The catalog unit, when the caller has it. A milligram or microgram
   * amount from 100 up prints whole: "230 mg" of caffeine, not "230,3 mg",
   * a tenth no label or tracker states.
   */
  unit?: string,
): string {
  const wholeFrom = unit === "mg" || unit === "ug" ? 100 : 1000;
  const rounded =
    Math.abs(amount) >= wholeFrom
      ? Math.round(amount)
      : Math.round(amount * 10) / 10;
  return Number.isInteger(rounded)
    ? fmt.integer(rounded)
    : fmt.number(rounded, 1);
}
