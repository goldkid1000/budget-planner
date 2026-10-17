# Budget Planner — v1.2.0

A simple budget planner that works on iPhone and PC from one link. Dark
background. No build step — just `index.html` + `app.js` + `style.css` +
`version.json` + `changelog.json` + `manifest.json` + `sw.js` + `icons/` (+ this README).
Installable: tap **Install app** at the top of the Budget tab (iPhone: Share →
Add to Home Screen; PC: browser menu → Install). Works offline once installed.

## What it does

- **Budget** — "Money I have right now" at the top (filled in from your My Money
  balances, editable in place). Donut chart: money you have + money in (net pay)
  − bills due − planned spending by category = what you'll have left. Editable
  categories. Over-budget warning.
- **Paycheck** — Hours per week (total hours, or shifts with day + start/end times —
  overnight shifts handled) × hourly rate, minus a full per-line deduction breakdown
  matching a real pay stub: Social Security (6.2%), Medicare (1.45%), federal
  income tax (editable, default 0%), NY state income tax (editable, default 0%),
  NY FLI (editable, default 0%), 401K (editable, default 0%), membership fee
  (W+) — flat $ per check, company stock contribution — flat $ per check, stock
  purchase — flat $ per check. Each line has a plain-words explanation. Shows
  gross, taxes total, deductions total, total taken off, net pay, and net per
  month. **"Use my real pay stub"**: enter gross + every line from one real stub
  and the app uses your real rates from then on ("Reset to estimates" restores
  the defaults). What-if: extra hours per week, and a raise (try a higher rate
  to see the difference).
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

The paycheck math is a per-line estimate: Social Security 6.2% + Medicare 1.45%
(the statutory rates), everything else at whatever rates / $ amounts you set
(defaults $0 — at part-time student income these are often $0, but check
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

v1.1.1 fixes: the What's New box used to open empty (the modal's `display:flex`
was cancelling the HTML `hidden` attribute, so it showed on load with no notes —
now `hidden` wins and the notes render instantly from a built-in copy, then the
fetched history swaps in); typing a category amount no longer steals focus;
bills are editable in place; switching hours mode no longer wipes the tip %;
footer gains a "Check for updates" button.

## Privacy

Everyone starts blank — a fresh visitor sees $0 everywhere, no prefilled numbers,
no example money. Everything you type saves in `localStorage` on your own device
and reloads next visit. Nothing is sent anywhere. "Clear all my numbers" wipes it.
Your numbers stay on this device — nobody else sees them.

## Install (PWA)

`manifest.json` + `sw.js` + `icons/` make the app installable from the same link.
The service worker caches the app shell (cache-first) so it opens offline once
installed; `version.json` / `changelog.json` are fetched fresh so update checks
always see the newest version. If service-worker registration fails, the app
still works fully online.

## Publish (GitHub Pages)

1. On github.com, create an empty **public** repo named `budget-planner`
   under `goldkid1000` (the automated repo-creation call was blocked with a 403,
   so this one manual step is needed).
2. Push `index.html`, `app.js`, `style.css`, `manifest.json`, `sw.js`, `icons/`,
   `version.json`, `changelog.json` (and this README) to `main`.
3. Repo → Settings → Pages → Deploy from a branch → `main`, `/ (root)` → Save.
4. Live at https://goldkid1000.github.io/budget-planner/ (give Pages a few minutes,
   then hard-refresh).
