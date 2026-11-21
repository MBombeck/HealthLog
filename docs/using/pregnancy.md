# Pregnancy and after the birth

Cycle tracking can hold a pregnancy, and the weeks after a birth, as a state
of its own. While it holds, HealthLog stops predicting periods and fertile
days that are not coming, and shows your other values in that context. It
records what you enter and counts the weeks; it does not tell you what a week
means, and it scores nothing.

## Setting it

Open **Cycle**, then the settings tab, and find **Pregnancy and after the
birth** at the top. Pick one of three:

- **Ordinary cycle**, the default.
- **Pregnant**, with the first day of your last period and the due date you
  were given. Both are optional. The week is counted in completed weeks and
  days from the first day, or from the due date less 280 days when only the
  due date is known. Without either, the state holds and no week is shown.
- **After the birth**, with the date of the birth and how many weeks the state
  lasts (12 by default, 1 to 78). When those weeks are over, the ordinary cycle
  and its predictions come back on their own.

Going back to **Ordinary cycle** clears the pregnancy dates with it. Your goal
(general health, trying to conceive, and so on) is never changed by any of
this, so the ordinary cycle resumes with the goal you had.

A first day or a date of birth in the future, a due date that is not after the
first day, and "after the birth" without its date are refused with a message.

## What changes while it holds

- **Predictions pause everywhere.** The cycle page shows the week instead of a
  cycle day and never calls a period late. The predictions panel, the calendar
  subscription, the Coach's cycle context and the dashboard line carry no
  forecast. Period and fertile-window reminders are not sent.
- **Weight and blood pressure in context.** On the timeline the cycle lane
  shows the pregnancy and the weeks after the birth as stretches, and a value
  point inside the pregnancy names its week beside its date. The Health Score
  does not count the body-shape pillar (waist), the personal weight goal shows
  no distance, and no weight or BMI personal record is announced.
- **Doctor report.** With the cycle section selected, the report and a shared
  link show the state on the report date: the week, the first day and due
  date, or the date of the birth and the week since. The section appears even
  without any logged cycle.
- **Emergency card.** The card can show the pregnancy as one of its items.

## Apple Health

An Apple Health export (`export.xml`) carries pregnancy and lactation as
status samples. HealthLog reads them conservatively, and only when your cycle
settings hold no state yet:

- An ongoing pregnancy sample sets **Pregnant**, with the sample's first day as
  the pregnancy's first day. The due date is not read from the sample.
- An ongoing lactation sample sets **After the birth** only when a pregnancy
  sample ended at most 14 days before the lactation began; that end becomes the
  date of the birth. An ended pregnancy on its own sets nothing, because the
  import cannot tell how it ended.
- Once you have set or cleared the state yourself, an import never sets it
  again, so a state you cleared stays cleared.

Every state an import sets is written to your audit log.

## Backups

The state and its dates travel in the backup with the rest of your cycle
settings. A backup made before this feature restores the ordinary cycle.
