# Budget Planner — v1.1.0

A simple budget planner that works on iPhone and PC from one link. Dark
background. No build step — just `index.html` + `app.js` + `style.css` +
`version.json` + `changelog.json` (+ this README).

## What it does

- **Budget** — Donut chart: money in (net pay) vs planned spending by category,
  and what you'll have left. Editable categories. Over-budget warning.
- **Paycheck** — Hours per week (total hours, or shifts with day + start/end times —
  overnight shifts handled) × hourly rate, minus a full per-line deduction breakdown:
  FICA (Social Security + Medicare) at the statutory 7.65%, federal income tax
  (editable, default 0%), NY state income tax (editable, default 0%). Shows gross,
  each deduction, total taken off, net pay, and net per month. "Match my pay stub"
  calibration: enter one real stub's gross + net and the app uses your real overall
  deduction %, with an adjustment line so the breakdown still matches.
  What-if: extra hours per week, and a raise (try a higher rate to see the difference).
  **Meal breaks count:** each shift has an unpaid meal break (30 minutes by default
  when a shift is over 6 hours, 0 otherwise, editable per shift). Paid hours =
  shift length − meal break, shown plainly per shift ("8 hrs, meal 30 min → paid
  7.5 hrs"). Total-hours mode has an "Unpaid meal break (minutes)" field too.
- **My Money** — Type your savings + checking balances and the date you last
  updated them. The app shows total balances, what's already spoken for (unpaid bills
  + this month's planned spending), and what you can spend. **This app does NOT
  log into your bank** — never put a bank login into a web page.
  **Bank statement import:** download a CSV from your bank's app/website and drop
  it in (or paste the text). The app reads it right here on your device — nothing
  leaves the device — and fills in your balance (pick Savings or Checking) plus your
  recent transactions, with an Undo. The parser handles common bank CSV shapes:
  Date / Description / Amount / Balance columns in any order, separate Debit/Credit
  columns, quoted fields, `$` and commas, and `(parentheses)` negatives. If it
  can't read the file, it says so plainly and manual entry still works.
- **Bills** — Editable list (name, amount, due date, auto-pay, paid). Sorted by due
  date. Starter entries are starting points, not live bank data.
- **Discounts** — Deal search (opens real searches you check yourself — the app never
  claims a code works), a student-discount directory (UNiDAYS, Student Beans, Spotify
  Student, Amazon Prime Student, Apple Education, Adobe student, Microsoft 365
  student, YouTube Premium student, Nike/SheerID), cashback-tool explainers
  (Checkmate, PayPal Honey, Rakuten), a discount-stacking calculator (stacked
  discounts multiply — 20% then 10% is $72 on $100, not $70), and a cashback estimator.
- **Calculators** — Split a bill, unit price comparison, tip calculator.

## Taxes are an estimate, not a tax filing

The paycheck math is a per-line estimate: FICA at 7.65%, federal and NY at whatever
rates you set (defaults 0% — at part-time student income these are often $0, but check
your pay stub). Your actual paycheck is the real number. Nothing here is tax advice
or a tax return.

## Update system

`version.json` holds the current version + its What's New notes. On load the app
fetches it; if a newer version exists, a banner shows that version's notes once,
with "Update now" (reloads) / "Later" — tapping either records that version as
seen in localStorage, so it never shows again for that version, only for a newer
one. "What's New" in the footer opens the full history from `changelog.json`
anytime without re-triggering the banner. If the version check fails (offline,
local file), it fails quietly.

## Privacy

Everything you type saves in `localStorage` on your own device and reloads next
visit. Nothing is sent anywhere. "Clear all my numbers" wipes it.

## Publish (GitHub Pages)

1. On github.com, create an empty **public** repo named `budget-planner`
   under `goldkid1000` (the automated repo-creation call was blocked with a 403,
   so this one manual step is needed).
2. Push `index.html`, `app.js`, `style.css` (and this README) to `main`.
3. Repo → Settings → Pages → Deploy from a branch → `main`, `/ (root)` → Save.
4. Live at https://goldkid1000.github.io/budget-planner/ (give Pages a few minutes,
   then hard-refresh).
