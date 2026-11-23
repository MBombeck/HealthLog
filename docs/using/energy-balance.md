# Energy balance

Under **Insights**, **Nutrients**, the **Energy balance** card sets what you
ate against what your body used, day by day:

- **Eaten** is the day's energy total from the nutrient store: whatever your
  phone or a bridge sends (Apple Health, Health Connect, or a script on
  `POST /api/nutrients/batch`). HealthLog does not log meals itself.
- **Used** is resting energy plus active energy, the day sums your watch or
  tracker sends (`BASAL_ENERGY_BURNED` and `ACTIVE_ENERGY_BURNED`).
- **Balance** is eaten minus used. A negative number is a deficit, a positive
  one a surplus. The card shows the number and leaves the judgement to you.

The headline is the average balance of the last seven days, once four of
them have one. Below it are the window's averages and the last seven days
that have a balance.

## When a number is missing

Every figure is computed when you open the card, so a corrected or late
import changes it with nothing to recalculate.

- A day with nothing eaten logged has no balance. It is not counted as zero,
  which would read as a fast.
- A day without active energy has no balance either: leaving it out would
  make a deficit look larger than it was.
- A day without a resting reading takes an estimate, the Mifflin-St Jeor
  equation, from your latest weight, your height, your age that day and your
  sex. The card says on how many days it did. Without one of them in your
  profile there is no estimate, and the card says what is missing.
- Today is still running and stays out of the averages.

The read is `GET /api/nutrients/energy-balance?days=30` (7 to 90 days), behind
the opt-in nutrients module, so a script or another client sees the same
figures.

## In the correlations and the Coach

The daily balance is also a channel in the correlation scan, named **daily
energy balance**. It pairs a day's balance with the next day's readings
(weight, sleep, mood and the rest), under the same evidence bar as every
other channel: at least 20 days that hold a balance, and only the days that
do. A day without one is left out, never counted as zero. It is never paired
with energy intake, which it is computed from. With the nutrients module off
it is not read.

The Coach sees one compact line: the averages of intake, expenditure and
balance over the last fourteen finished days, how many of them held a
balance, and on how many resting energy was estimated. It is told to treat
the line as a description of your record and never to turn it into a calorie
target, a diet or a weight forecast. The line is left out when the nutrients
module is off, when active energy is not among the Coach's sources, and
under a Coach lookback limit of seven days. AI analysis has to be on for the
Coach at all; the card and the correlations do not depend on it.
