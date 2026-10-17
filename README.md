# Budget Planner — v1.0.0

A simple budget planner that works on iPhone and PC from one link. No build step —
just `index.html` + `app.js` + `style.css` (+ this README).

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
- **My Money** — Type your savings + checking balances and the date you last
  updated them. The app shows total balances, what's already spoken for (unpaid bills
  + this month's planned spending), and what you can spend. **This app does NOT
  connect to your bank** — never put a bank login into a web page.
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
