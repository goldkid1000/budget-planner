/* Budget Planner v2.3.0 — all data stays in localStorage on this device. */
'use strict';

var APP_VERSION = '2.3.0';

/* ---------- pure math helpers (also used by node tests) ---------- */
function round2(n){ return Math.round((n + Number.EPSILON) * 100) / 100; }
function money(n){
  var v = Number(n); if(!isFinite(v)) v = 0;
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function money0(n){
  var v = Number(n); if(!isFinite(v)) v = 0;
  return '$' + Math.round(v).toLocaleString('en-US');
}
function num0(v){ var n = parseFloat(v); return isFinite(n) ? n : 0; }
/* shift hours from "HH:MM" strings; overnight (end <= start) rolls past midnight */
function toMinutes(timeStr){
  var parts = String(timeStr || '').split(':');
  var h = parseInt(parts[0], 10), m = parseInt(parts[1], 10);
  if(!isFinite(h) || !isFinite(m)) return 0;
  return h * 60 + m;
}
function calcShiftHours(startStr, endStr){
  var s = toMinutes(startStr), e = toMinutes(endStr);
  if(e <= s) e += 1440;
  return (e - s) / 60;
}
/* paid hours for one shift: shift length minus unpaid meal break, never below 0 */
function calcShiftPaidHours(startStr, endStr, mealMinutes){
  var paid = calcShiftHours(startStr, endStr) - num0(mealMinutes) / 60;
  return paid > 0 ? paid : 0;
}
/* default meal break for a shift: 30 min when the shift is over 6 hours, else 0 */
function defaultMeal(startStr, endStr){
  return calcShiftHours(startStr, endStr) > 6 ? 30 : 0;
}
/* v1.3.1: Giel's standard paid break — 15 minutes every shift. Breaks are
   paid at Walmart, so they never reduce paid hours: tracked and shown,
   never subtracted. */
function defaultBreak(){ return 15; }
function fmtHrs(h){
  var v = Number(h); if(!isFinite(v)) v = 0;
  return (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, '');
}
/* compare dotted version strings: -1 if a<b, 0 if equal, 1 if a>b */
function compareVersions(a, b){
  var pa = String(a || '').split('.').map(function(x){ return parseInt(x, 10) || 0; });
  var pb = String(b || '').split('.').map(function(x){ return parseInt(x, 10) || 0; });
  for(var i = 0; i < Math.max(pa.length, pb.length); i++){
    var d = (pa[i] || 0) - (pb[i] || 0);
    if(d) return d < 0 ? -1 : 1;
  }
  return 0;
}
/* ---------- bank statement CSV parser (pure; runs on-device only) ---------- */
function parseCSVText(text){
  var rows = [], row = [], field = '', inQuotes = false;
  for(var i = 0; i < text.length; i++){
    var c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i + 1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if(c === '"'){ inQuotes = true; }
    else if(c === ','){ row.push(field); field = ''; }
    else if(c === '\n'){ row.push(field); field = ''; rows.push(row); row = []; }
    else if(c === '\r'){ /* \n handles the line break */ }
    else field += c;
  }
  if(field !== '' || row.length){ row.push(field); rows.push(row); }
  return rows.filter(function(r){ return r.length > 1 || (r.length === 1 && String(r[0]).trim() !== ''); });
}
function normHeader(h){ return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function parseAmount(raw){
  var s = String(raw == null ? '' : raw).trim();
  if(!s) return null;
  var neg = false;
  if(/^\(.*\)$/.test(s)){ neg = true; s = s.slice(1, -1); }
  if(/-$/.test(s)){ neg = true; s = s.slice(0, -1); }
  s = s.replace(/[$,\s]/g, '');
  if(s === '' || s === '-' || s === '.') return null;
  var n = parseFloat(s);
  if(!isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}
function parseDateLoose(raw){
  var s = String(raw == null ? '' : raw).trim();
  if(!s) return null;
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if(m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if(m){
    var y = m[3].length === 2 ? '20' + m[3] : m[3];
    return y + '-' + String(m[1]).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0');
  }
  var d = new Date(s);
  if(!isNaN(d.getTime())) return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  return null;
}
function findCol(headers, tests, skip){
  for(var i = 0; i < headers.length; i++){
    if(skip && skip.indexOf(i) !== -1) continue;
    var h = normHeader(headers[i]);
    for(var j = 0; j < tests.length; j++){ if(h.indexOf(tests[j]) !== -1) return i; }
  }
  return -1;
}
/* Parse a bank statement CSV. Returns {ok, transactions, balance, statementDate, count}
   or {ok:false, error}. Tolerant of column order/casing, quoted fields, $ and commas,
   (parentheses) negatives, trailing-minus negatives, and separate debit/credit columns. */
function parseStatementCSV(text){
  var rows = parseCSVText(String(text || ''));
  if(!rows.length) return { ok: false, error: "Couldn't read that — the file looks empty. Try downloading the CSV again from your bank." };
  var headerIdx = -1, headers = null;
  for(var r = 0; r < Math.min(rows.length, 10); r++){
    var cells = rows[r];
    var hasDate = false, hasOther = false;
    for(var c = 0; c < cells.length; c++){
      var h = normHeader(cells[c]);
      if(h.indexOf('date') !== -1) hasDate = true;
      if(h.indexOf('description') !== -1 || h.indexOf('memo') !== -1 || h.indexOf('payee') !== -1 ||
         h.indexOf('amount') !== -1 || h.indexOf('balance') !== -1 ||
         h.indexOf('debit') !== -1 || h.indexOf('credit') !== -1 ||
         h.indexOf('withdrawal') !== -1 || h.indexOf('deposit') !== -1) hasOther = true;
    }
    if(hasDate && hasOther){ headerIdx = r; headers = cells; break; }
  }
  if(headerIdx === -1) return { ok: false, error: "Couldn't find a header row with Date, Description, Amount and Balance. Your bank's CSV download usually has one — try that file." };
  var dateCol = findCol(headers, ['date'], []);
  var descCol = findCol(headers, ['description', 'memo', 'payee', 'details'], [dateCol]);
  var balCol = findCol(headers, ['runningbalance', 'endingbalance', 'balance'], [dateCol, descCol]);
  var debitCol = findCol(headers, ['debit', 'withdrawal', 'moneyout', 'amountdebit'], [dateCol, descCol, balCol]);
  var creditCol = findCol(headers, ['credit', 'deposit', 'moneyin', 'amountcredit'], [dateCol, descCol, balCol, debitCol]);
  var amtCol = -1;
  if(!(debitCol !== -1 && creditCol !== -1)){
    amtCol = findCol(headers, ['amount', 'charge', 'total'], [dateCol, descCol, balCol, debitCol, creditCol]);
  }
  if(dateCol === -1) return { ok: false, error: "Couldn't find a Date column in your statement." };
  if(amtCol === -1 && (debitCol === -1 || creditCol === -1)) return { ok: false, error: "Couldn't find an Amount column (or Debit/Credit columns) in your statement." };
  var txns = [], balance = null, latestDate = null;
  for(var i = headerIdx + 1; i < rows.length; i++){
    var row = rows[i];
    var date = parseDateLoose(row[dateCol]);
    if(!date) continue;
    var amt = null;
    if(amtCol !== -1) amt = parseAmount(row[amtCol]);
    else {
      var d = parseAmount(row[debitCol]), cr = parseAmount(row[creditCol]);
      if(d != null || cr != null) amt = (cr || 0) - (d || 0);
    }
    if(amt == null) continue;
    var desc = descCol !== -1 ? String(row[descCol] == null ? '' : row[descCol]).trim() : '';
    var bal = balCol !== -1 ? parseAmount(row[balCol]) : null;
    if(bal != null) balance = bal;
    if(!latestDate || date > latestDate) latestDate = date;
    txns.push({ date: date, description: desc, amount: amt, balance: bal });
  }
  if(!txns.length) return { ok: false, error: "Found the columns but no transactions with a date and amount. Try the CSV download from your bank." };
  return { ok: true, transactions: txns, balance: balance, statementDate: latestDate, count: txns.length };
}
/* paycheck: hours per week, rate, ded profile, freq.
   ded: { ss, medicare, federal, ny, fli, k401 } are % of gross;
        { membership, stockContrib, stockPurch } are flat $ per pay period.
   Each line is rounded to cents first (like a real pay stub), then summed,
   so the totals match the lines exactly.
   estimate: when passed { stateCode }, federal + state tax come from the
   2025 bracket tables instead of ded.federal / ded.ny (estimate mode —
   no pay stub entered). FICA, FLI, 401K and flat lines still use ded. */
function calcPaycheck(hours, rate, ded, freq, estimate){
  /* v2.0.2 auto-detect: overtime — hours over 40/week are paid at 1.5x.
     Automatic; the breakdown always shows when it kicked in. */
  var regHrs = Math.min(hours, 40), otHrs = Math.max(hours - 40, 0);
  var weeklyGross = round2(regHrs * rate + otHrs * rate * 1.5);
  var mult = freq === 'biweekly' ? 2 : (freq === 'monthly' ? 52 / 12 : 1);
  var periodGross = weeklyGross * mult;
  var d = ded || {};
  var ssAmt = round2(periodGross * num0(d.ss) / 100);
  var medicareAmt = round2(periodGross * num0(d.medicare) / 100);
  var fedAmt, nyAmt;
  if(estimate){
    var est = calcEstimateTaxes(weeklyGross, estimate.stateCode);
    fedAmt = round2(est.federalAnnual * mult / 52);
    nyAmt = round2(est.stateAnnual * mult / 52);
  } else {
    fedAmt = round2(periodGross * num0(d.federal) / 100);
    nyAmt = round2(periodGross * num0(d.ny) / 100);
  }
  var fliAmt = round2(periodGross * num0(d.fli) / 100);
  var k401Amt = round2(periodGross * num0(d.k401) / 100);
  var memberAmt = round2(num0(d.membership) * mult);
  var stockContribAmt = round2(num0(d.stockContrib) * mult);
  var stockPurchAmt = round2(num0(d.stockPurch) * mult);
  var taxesTotal = round2(ssAmt + medicareAmt + fedAmt + nyAmt + fliAmt);
  var dedTotal = round2(k401Amt + memberAmt + stockContribAmt + stockPurchAmt);
  var totalDed = round2(taxesTotal + dedTotal);
  var net = round2(periodGross - totalDed);
  var effRate = periodGross > 0 ? totalDed / periodGross : 0;
  var monthlyNet = weeklyGross * (1 - effRate) * (52 / 12);
  return { weeklyGross: weeklyGross, periodGross: periodGross, otHrs: otHrs,
           otAmt: round2(otHrs * rate * 1.5), regHrs: regHrs,
           ssAmt: ssAmt, medicareAmt: medicareAmt, fedAmt: fedAmt, nyAmt: nyAmt,
           fliAmt: fliAmt, k401Amt: k401Amt, memberAmt: memberAmt,
           stockContribAmt: stockContribAmt, stockPurchAmt: stockPurchAmt,
           taxesTotal: taxesTotal, dedTotal: dedTotal, totalDed: totalDed,
           net: net, effRate: effRate, monthlyNet: monthlyNet,
           estimateUsed: !!estimate,
           periodLabel: freq === 'biweekly' ? 'per 2 weeks' : (freq === 'monthly' ? 'per month' : 'per week') };
}
/* derive a ded profile from one real pay stub: % lines from (line / gross),
   flat lines kept as $ per check. Rates rounded to 4 decimals — the
   per-line cent rounding in calcPaycheck then reproduces the stub exactly. */
function deriveDedFromStub(gross, lines){
  function pct(amt){ return gross > 0 ? Math.round((num0(amt) / gross * 100) * 10000) / 10000 : 0; }
  return { ss: pct(lines.ss), medicare: pct(lines.medicare), federal: pct(lines.federal),
           ny: pct(lines.ny), fli: pct(lines.fli), k401: pct(lines.k401),
           membership: round2(lines.membership), stockContrib: round2(lines.stockContrib),
           stockPurch: round2(lines.stockPurch) };
}
/* savings-goal projection from the monthly leftover (take-home − unpaid
   bills − planned spending). Never invents a date when leftover <= 0.
   Returns { status: 'reached' | 'date' | 'far' | 'short', toGo, months,
   dateStr, shortfall, extraHours }. 'far' = over 50 years at this pace. */
function calcGoalProjection(goal, saved, monthlyLeftover, rate, effRate){
  var toGo = Math.max(num0(goal) - num0(saved), 0);
  /* v2.0.0: a $0 goal is not "reached" — it means no goal was set yet */
  if(toGo <= 0) return num0(goal) > 0
    ? { status: 'reached', toGo: 0, months: 0, dateStr: '', shortfall: 0, extraHours: 0 }
    : { status: 'noset', toGo: 0, months: 0, dateStr: '', shortfall: 0, extraHours: 0 };
  var leftover = num0(monthlyLeftover);
  if(leftover > 0){
    var months = Math.ceil(toGo / leftover);
    if(months > 600) return { status: 'far', toGo: toGo, months: months, dateStr: '', shortfall: 0, extraHours: 0 };
    var date = new Date(); date.setMonth(date.getMonth() + months);
    return { status: 'date', toGo: toGo, months: months,
      dateStr: date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
      shortfall: 0, extraHours: 0 };
  }
  var shortfall = -leftover;
  var perHourMonth = num0(rate) * (1 - num0(effRate)) * (52 / 12);
  var extraHours = perHourMonth > 0 ? shortfall / perHourMonth : 0;
  return { status: 'short', toGo: toGo, months: 0, dateStr: '', shortfall: shortfall, extraHours: extraHours };
}
/* Deal Watchlist status from the last price the user typed in.
   The app never checks a store's price by itself — every price here is
   one the user entered after opening the link. */
function watchlistStatus(item){
  if(item.lastSeen === null || item.lastSeen === undefined || item.lastSeen === '')
    return { kind: 'none', text: 'No price entered yet — open the link and type the price you see.' };
  var seen = num0(item.lastSeen), target = num0(item.target);
  if(seen <= target) return { kind: 'deal', text: 'Deal! ' + money(target - seen) + ' below your target.' };
  return { kind: 'notyet', text: 'Not yet — ' + money(seen - target) + ' above your target.' };
}
function calcDiscount(price, d1, d2, cashbackPct){
  var after1 = price * (1 - d1 / 100);
  var after2 = after1 * (1 - d2 / 100);
  var cashback = after2 * (cashbackPct / 100);
  var finalPay = after2 - cashback;
  return { after1: after1, after2: after2, cashback: cashback, finalPay: finalPay, saved: price - finalPay };
}
function calcSplit(total, people, tipPct){
  var tip = total * (tipPct / 100);
  var withTip = total + tip;
  return { tip: tip, withTip: withTip, each: people > 0 ? withTip / people : 0 };
}
function calcUnit(price, size){ return size > 0 ? price / size : 0; }
function calcTip(bill, pct){ var tip = bill * (pct / 100); return { tip: tip, total: bill + tip }; }

/* ---------- 2025 income-tax estimate tables (single filer) ----------
   Source: Tax Foundation, "State Individual Income Tax Rates and Brackets,
   2025" (single-filer columns). Each state: ded = 2025 standard deduction
   for a single filer PLUS any plain-dollar personal exemption from the same
   table; credit = single-filer personal-exemption credit where the state
   gives one instead of a deduction (CA, UT, IA, NE, OR, DE); brackets =
   [upper bound, rate] pairs, rate applying up to that bound (last = Infinity).
   States with no wage income tax (AK, FL, NV, NH, SD, TN, TX, WA, WY) are
   null — WA taxes capital gains only, so wage tax is $0 here.
   Deliberately NOT modeled (estimate only): personal-exemption phaseouts,
   itemized deductions, dependent credits/exemptions, local/city income tax,
   NY tax-benefit recapture, payroll taxes (CA disability, WA Cares, MA PFML).
   Federal: 2025 single standard deduction $15,000 + 2025 brackets. */
var NO_TAX_STATE_NAMES = { AK: 'Alaska', FL: 'Florida', NV: 'Nevada',
  NH: 'New Hampshire', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas',
  WA: 'Washington', WY: 'Wyoming' };
var FEDERAL_STD_DED_2025 = 15000;
var FEDERAL_BRACKETS_2025 = [[11925, 0.10], [48475, 0.12], [103350, 0.22], [197300, 0.24],
  [250525, 0.32], [626350, 0.35], [Infinity, 0.37]];
var STATE_TAX_2025 = {
  AL: { name: 'Alabama', ded: 4500, credit: 0, brackets: [[500, 0.02], [3000, 0.04], [Infinity, 0.05]] },
  AK: null,
  AZ: { name: 'Arizona', ded: 15000, credit: 0, brackets: [[Infinity, 0.025]] },
  AR: { name: 'Arkansas', ded: 2410, credit: 29, brackets: [[4500, 0.02], [Infinity, 0.039]] },
  CA: { name: 'California', ded: 5540, credit: 149, brackets: [[10756, 0.01], [25499, 0.02], [40245, 0.04], [55866, 0.06], [70606, 0.08], [360659, 0.093], [432787, 0.103], [721314, 0.113], [1000000, 0.123], [Infinity, 0.133]] },
  CO: { name: 'Colorado', ded: 15000, credit: 0, brackets: [[Infinity, 0.044]] },
  CT: { name: 'Connecticut', ded: 15000, credit: 0, brackets: [[10000, 0.02], [50000, 0.045], [100000, 0.055], [200000, 0.06], [250000, 0.065], [500000, 0.069], [Infinity, 0.0699]] },
  DE: { name: 'Delaware', ded: 3250, credit: 110, brackets: [[2000, 0], [5000, 0.022], [10000, 0.039], [20000, 0.048], [25000, 0.052], [60000, 0.0555], [Infinity, 0.066]] },
  DC: { name: 'Washington DC', ded: 15000, credit: 0, brackets: [[10000, 0.04], [40000, 0.06], [60000, 0.065], [250000, 0.085], [500000, 0.0925], [1000000, 0.0975], [Infinity, 0.1075]] },
  FL: null,
  GA: { name: 'Georgia', ded: 12000, credit: 0, brackets: [[Infinity, 0.0539]] },
  HI: { name: 'Hawaii', ded: 5544, credit: 0, brackets: [[9600, 0.014], [14400, 0.032], [19200, 0.055], [24000, 0.064], [36000, 0.068], [48000, 0.072], [125000, 0.076], [175000, 0.079], [225000, 0.0825], [275000, 0.09], [325000, 0.10], [Infinity, 0.11]] },
  ID: { name: 'Idaho', ded: 15000, credit: 0, brackets: [[4673, 0], [Infinity, 0.05695]] },
  IL: { name: 'Illinois', ded: 2850, credit: 0, brackets: [[Infinity, 0.0495]] },
  IN: { name: 'Indiana', ded: 1000, credit: 0, brackets: [[Infinity, 0.03]] },
  IA: { name: 'Iowa', ded: 0, credit: 40, brackets: [[Infinity, 0.038]] },
  KS: { name: 'Kansas', ded: 12765, credit: 0, brackets: [[23000, 0.052], [Infinity, 0.0558]] },
  KY: { name: 'Kentucky', ded: 3270, credit: 0, brackets: [[Infinity, 0.04]] },
  LA: { name: 'Louisiana', ded: 12500, credit: 0, brackets: [[Infinity, 0.03]] },
  ME: { name: 'Maine', ded: 20150, credit: 0, brackets: [[26800, 0.058], [63450, 0.0675], [Infinity, 0.0715]] },
  MD: { name: 'Maryland', ded: 5900, credit: 0, brackets: [[1000, 0.02], [2000, 0.03], [3000, 0.04], [100000, 0.0475], [125000, 0.05], [150000, 0.0525], [250000, 0.055], [Infinity, 0.0575]] },
  MA: { name: 'Massachusetts', ded: 4400, credit: 0, brackets: [[1083150, 0.05], [Infinity, 0.09]] },
  MI: { name: 'Michigan', ded: 5800, credit: 0, brackets: [[Infinity, 0.0425]] },
  MN: { name: 'Minnesota', ded: 14950, credit: 0, brackets: [[32570, 0.0535], [106990, 0.068], [198630, 0.0785], [Infinity, 0.0985]] },
  MS: { name: 'Mississippi', ded: 8300, credit: 0, brackets: [[10000, 0], [Infinity, 0.044]] },
  MO: { name: 'Missouri', ded: 15000, credit: 0, brackets: [[1313, 0], [2626, 0.02], [3939, 0.025], [5252, 0.03], [6565, 0.035], [7878, 0.04], [9191, 0.045], [Infinity, 0.047]] },
  MT: { name: 'Montana', ded: 15000, credit: 0, brackets: [[21100, 0.047], [Infinity, 0.059]] },
  NE: { name: 'Nebraska', ded: 8600, credit: 171, brackets: [[4030, 0.0246], [24120, 0.0351], [38870, 0.0501], [Infinity, 0.052]] },
  NV: null,
  NH: null,
  NJ: { name: 'New Jersey', ded: 1000, credit: 0, brackets: [[20000, 0.014], [35000, 0.0175], [40000, 0.035], [75000, 0.05525], [500000, 0.0637], [1000000, 0.0897], [Infinity, 0.1075]] },
  NM: { name: 'New Mexico', ded: 15000, credit: 0, brackets: [[5500, 0.015], [16500, 0.032], [33500, 0.043], [66500, 0.047], [210000, 0.049], [Infinity, 0.059]] },
  NY: { name: 'New York', ded: 8000, credit: 0, brackets: [[8500, 0.04], [11700, 0.045], [13900, 0.0525], [80650, 0.055], [215400, 0.06], [1077550, 0.0685], [5000000, 0.0965], [25000000, 0.103], [Infinity, 0.109]] },
  NC: { name: 'North Carolina', ded: 12750, credit: 0, brackets: [[Infinity, 0.0425]] },
  ND: { name: 'North Dakota', ded: 15000, credit: 0, brackets: [[48475, 0], [244825, 0.0195], [Infinity, 0.025]] },
  OH: { name: 'Ohio', ded: 2400, credit: 0, brackets: [[26050, 0], [100000, 0.0275], [Infinity, 0.035]] },
  OK: { name: 'Oklahoma', ded: 7350, credit: 0, brackets: [[1000, 0.0025], [2500, 0.0075], [3750, 0.0175], [4900, 0.0275], [7200, 0.0375], [Infinity, 0.0475]] },
  OR: { name: 'Oregon', ded: 2800, credit: 250, brackets: [[4400, 0.0475], [11050, 0.0675], [125000, 0.0875], [Infinity, 0.099]] },
  PA: { name: 'Pennsylvania', ded: 0, credit: 0, brackets: [[Infinity, 0.0307]] },
  RI: { name: 'Rhode Island', ded: 16000, credit: 0, brackets: [[79900, 0.0375], [181650, 0.0475], [Infinity, 0.0599]] },
  SC: { name: 'South Carolina', ded: 15000, credit: 0, brackets: [[3560, 0], [17830, 0.03], [Infinity, 0.062]] },
  SD: null,
  TN: null,
  TX: null,
  UT: { name: 'Utah', ded: 0, credit: 900, brackets: [[Infinity, 0.0455]] },
  VT: { name: 'Vermont', ded: 12500, credit: 0, brackets: [[47900, 0.0335], [116000, 0.066], [242000, 0.076], [Infinity, 0.0875]] },
  VA: { name: 'Virginia', ded: 9430, credit: 0, brackets: [[3000, 0.02], [5000, 0.03], [17000, 0.05], [Infinity, 0.0575]] },
  WA: null,
  WV: { name: 'West Virginia', ded: 2000, credit: 0, brackets: [[10000, 0.0222], [25000, 0.0296], [40000, 0.0333], [60000, 0.0444], [Infinity, 0.0482]] },
  WI: { name: 'Wisconsin', ded: 14260, credit: 0, brackets: [[14680, 0.035], [29370, 0.044], [323290, 0.053], [Infinity, 0.0765]] },
  WY: null
};
/* progressive tax on taxable income: each slice of income pays its own rate */
function calcBracketTax(taxable, brackets){
  var t = Math.max(0, num0(taxable));
  var tax = 0, prev = 0;
  brackets.forEach(function(b){
    var upper = b[0], rate = b[1];
    if(t > prev) tax += (Math.min(t, upper) - prev) * rate;
    prev = upper;
  });
  return tax;
}
/* annual federal + state income-tax estimate from a weekly gross (single filer).
   Returns { federalAnnual, stateAnnual, stateName, noStateTax }. */
function calcEstimateTaxes(weeklyGross, stateCode){
  var annual = Math.max(0, num0(weeklyGross)) * 52;
  var fedTaxable = Math.max(0, annual - FEDERAL_STD_DED_2025);
  var federalAnnual = calcBracketTax(fedTaxable, FEDERAL_BRACKETS_2025);
  var st = STATE_TAX_2025[stateCode] || null;
  if(!st) return { federalAnnual: federalAnnual, stateAnnual: 0,
    stateName: NO_TAX_STATE_NAMES[stateCode] || 'this state', noStateTax: true };
  var stateTaxable = Math.max(0, annual - st.ded);
  var stateAnnual = Math.max(0, calcBracketTax(stateTaxable, st.brackets) - st.credit);
  return { federalAnnual: federalAnnual, stateAnnual: stateAnnual, stateName: st.name, noStateTax: false };
}

/* v2.0.0 employer presets — starting points only, the rate stays editable.
   Nothing here is personal data: these are public job titles + typical rates. */
var EMPLOYERS = {
  custom:   { name: 'Custom', rate: null },
  walmart:  { name: 'Walmart — Digital Personal Shopper', rate: 16 },
  target:   { name: 'Target', rate: 16 },
  amazon:   { name: 'Amazon warehouse', rate: 19 },
  mcdonalds:{ name: "McDonald's", rate: 15 }
};
/* ---------- v2.0.0: employer presets ---------- */
function employerForKey(key){ return EMPLOYERS[key] || EMPLOYERS.custom; }

/* ---------- v2.0.0: device sync code (manual one-time transfer, no server) ---------- */
function syncEncode(payload){
  var b64 = btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function syncDecode(code){
  var b64 = String(code).replace(/-/g, '+').replace(/_/g, '/');
  while(b64.length % 4) b64 += '=';
  return decodeURIComponent(escape(atob(b64)));
}

if (typeof module !== 'undefined' && module.exports){
  module.exports = { round2: round2, money: money, money0: money0, calcPaycheck: calcPaycheck,
    deriveDedFromStub: deriveDedFromStub,
    calcShiftHours: calcShiftHours, calcShiftPaidHours: calcShiftPaidHours, defaultMeal: defaultMeal,
    toMinutes: toMinutes, compareVersions: compareVersions, parseStatementCSV: parseStatementCSV,
    calcDiscount: calcDiscount, calcSplit: calcSplit, calcUnit: calcUnit, calcTip: calcTip,
    calcBracketTax: calcBracketTax, calcEstimateTaxes: calcEstimateTaxes,
    calcGoalProjection: calcGoalProjection, watchlistStatus: watchlistStatus, employerForKey: employerForKey, syncEncode: syncEncode, syncDecode: syncDecode,
    STATE_TAX_2025: STATE_TAX_2025, FEDERAL_BRACKETS_2025: FEDERAL_BRACKETS_2025,
    FEDERAL_STD_DED_2025: FEDERAL_STD_DED_2025 };
}

/* ---------- app (browser only) ---------- */
if (typeof document !== 'undefined'){

var KEY = 'budgetPlanner.v1';
var COLORS = ['#46d98a','#4db2ff','#f2c14e','#b48cff','#ff7a70','#2dd4bf','#f472b6','#9aa8a0','#6ea8ff','#f2994a'];

var DEFAULTS = {
  hours: 0, rate: 0, freq: 'weekly',
  employerKey: 'custom',
  hoursMode: 'total',
  mealTotal: 0,
  shifts: [],
  ded: { ss: 6.2, medicare: 1.45, federal: 0, ny: 0, fli: 0, k401: 0,
         membership: 0, stockContrib: 0, stockPurch: 0 },
  startingMoney: null,
  stubSaved: null,
  checking: 0, balanceDate: '',
  categories: [
    { name: 'Food', amount: 0 },
    { name: 'Transport', amount: 0 },
    { name: 'Fun', amount: 0 },
    { name: 'Subscriptions', amount: 0 },
    { name: 'Clothes', amount: 0 },
    { name: 'Other', amount: 0 }
  ],
  goal: 0, saved: 0,
  bills: [],
  stateCode: 'NY',
  watchlist: [],
  dealsRefreshedAt: null,
  stocks: [],
  syncUsed: [],
  earn: {},
  earnAdded: 0
};

var STUDENT = [
  { name: 'UNiDAYS', what: 'Free student verification that unlocks student discounts and deals at lots of stores.', url: 'https://www.myunidays.com/', cta: 'Open UNiDAYS' },
  { name: 'Student Beans', what: 'Free student verification with student discounts and deals at lots of stores.', url: 'https://www.studentbeans.com/', cta: 'Open Student Beans' },
  { name: 'Spotify Student', what: 'A student plan at a lower monthly price than the regular plan. Check Spotify for what is included.', url: 'https://www.spotify.com/us/student/', cta: 'Open Spotify Student' },
  { name: 'Amazon Prime Student', what: 'A student trial plus discounted Prime membership. Search “Prime Student” on Amazon.', url: 'https://www.amazon.com/', cta: 'Open Amazon' },
  { name: 'Apple Education Pricing', what: 'Education pricing on Mac, iPad, and accessories through the Apple Education Store.', url: 'https://www.apple.com/us-edu/store', cta: 'Open Apple Education' },
  { name: 'Adobe Creative Cloud student plan', what: 'Student pricing on Creative Cloud. Check Adobe for the current student price.', url: 'https://www.adobe.com/creativecloud/buy/students.html', cta: 'Open Adobe student plans' },
  { name: 'Microsoft 365 for students', what: 'Office apps for students — many schools include it free, so check with your school first.', url: 'https://www.microsoft.com/en-us/education', cta: 'Open Microsoft Education' },
  { name: 'YouTube Premium student', what: 'A student plan at a lower monthly price than the regular plan. Check YouTube for current terms.', url: 'https://www.youtube.com/premium', cta: 'Open YouTube Premium' },
  { name: 'Nike student discount', what: 'A student discount verified through SheerID. Check Nike for the current offer.', url: 'https://www.nike.com/', cta: 'Open Nike' }
];
var CASHBACK = [
  { name: 'Checkmate', what: 'A browser extension/app that says it automatically tries promo codes at checkout and pays cashback at many stores. This planner cannot auto-apply codes — Checkmate is a separate service.', url: 'https://joincheckmate.com/', cta: 'Open Checkmate' },
  { name: 'PayPal Honey', what: 'A browser extension that tries promo codes at checkout and offers points/cashback. A separate service — read its terms before signing up.', url: 'https://www.joinhoney.com/', cta: 'Open Honey' },
  { name: 'Rakuten', what: 'Pays cashback when you start your shopping trip on Rakuten and click through to a store. A separate service.', url: 'https://www.rakuten.com/', cta: 'Open Rakuten' }
];

function loadState(){
  try{
    var raw = localStorage.getItem(KEY);
    if(raw){ var s = JSON.parse(raw); if(s && s.categories) return s; }
  }catch(e){}
  return JSON.parse(JSON.stringify(DEFAULTS));
}
var S = loadState();
/* fill in fields added in later versions so old saved data keeps working */
if(!S.ded) S.ded = { ss: 6.2, medicare: 1.45, federal: 0, ny: 0, fli: 0, k401: 0, membership: 0, stockContrib: 0, stockPurch: 0 };
/* v2.3.0: Earn tab state */
if(!S.earn || typeof S.earn !== 'object') S.earn = {};
if(S.earnAdded === undefined || S.earnAdded === null) S.earnAdded = 0;
/* v1.2.0: the old single FICA % splits into Social Security + Medicare at the
   statutory 6.2 / 1.45 ratio, so old saved rates keep working. The old
   gross/net "calibration" is gone — the per-line pay-stub profile replaces it. */
if(S.ded.fica !== undefined){
  var oldFica = num(S.ded.fica);
  var ssPart = oldFica > 0 ? oldFica * (6.2 / 7.65) : 6.2;
  var medPart = oldFica > 0 ? oldFica * (1.45 / 7.65) : 1.45;
  S.ded = { ss: Math.round(ssPart * 10000) / 10000, medicare: Math.round(medPart * 10000) / 10000,
            federal: num(S.ded.federal), ny: num(S.ded.ny),
            fli: 0, k401: 0, membership: 0, stockContrib: 0, stockPurch: 0 };
} else {
  var dedKeys = ['ss', 'medicare', 'federal', 'ny', 'fli', 'k401', 'membership', 'stockContrib', 'stockPurch'];
  var dedDefaults = { ss: 6.2, medicare: 1.45, federal: 0, ny: 0, fli: 0, k401: 0, membership: 0, stockContrib: 0, stockPurch: 0 };
  dedKeys.forEach(function(k){ if(S.ded[k] === undefined || S.ded[k] === null) S.ded[k] = dedDefaults[k]; });
}
if(S.calibration !== undefined) delete S.calibration;
if(S.startingMoney === undefined) S.startingMoney = null;
if(S.stubSaved === undefined) S.stubSaved = null;
if(!S.shifts) S.shifts = JSON.parse(JSON.stringify(DEFAULTS.shifts));
if(!S.hoursMode) S.hoursMode = 'total';
if(S.mealTotal === undefined) S.mealTotal = 0;
if(S.stateCode === undefined) S.stateCode = 'NY';
if(!S.watchlist) S.watchlist = [];
if(S.dealsRefreshedAt === undefined) S.dealsRefreshedAt = null;
/* no made-up default date: balances show "Set the date…" until the user picks one */
/* v1.1.0: shifts saved before meal breaks get the default rule (30 min over 6 hrs) */
S.shifts.forEach(function(sh){
  if(sh.meal === undefined || sh.meal === null) sh.meal = defaultMeal(sh.start, sh.end);
  if(sh.breakMin === undefined || sh.breakMin === null) sh.breakMin = defaultBreak();
});
if(S.breakTotal === undefined) S.breakTotal = 0;
if(S.paydayWeekday === undefined || S.paydayWeekday === null) S.paydayWeekday = 2;
if(S.lastPayday === undefined) S.lastPayday = '';
if(!S.statementTxns) S.statementTxns = [];
if(S.statementInfo === undefined) S.statementInfo = null;
/* v2.0.0: new fields */
if(S.employerKey === undefined) S.employerKey = 'custom';
if(!S.stocks) S.stocks = [];
if(!S.syncUsed) S.syncUsed = [];
S.watchlist.forEach(function(it){ if(!it.history) it.history = []; if(it.store === undefined) it.store = 'Other'; });
S.stocks.forEach(function(st){ if(!st.history) st.history = []; });
function save(){ try{ localStorage.setItem(KEY, JSON.stringify(S)); }catch(e){} }
function num(v, d){ var n = parseFloat(v); return isFinite(n) ? n : (d || 0); }

function effectiveHours(){
  if(S.hoursMode === 'shifts'){
    return S.shifts.reduce(function(a, sh){ return a + calcShiftPaidHours(sh.start, sh.end, sh.meal); }, 0);
  }
  /* total-hours mode: unpaid meal break comes off the total */
  var paid = num(S.hours) - num(S.mealTotal) / 60;
  return paid > 0 ? paid : 0;
}
/* v2.0.2 auto-detect: next payday from payday weekday + frequency.
   Returns {date: Date|null, daysAway: number|null}. */
function nextPaydayInfo(nowOpt){
  var now = nowOpt || new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var wd = (S.paydayWeekday === undefined || S.paydayWeekday === null) ? 2 : num(S.paydayWeekday, 2);
  var freq = S.freq || 'weekly';
  function atNoon(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12); }
  if(freq === 'weekly'){
    var d = new Date(today);
    while(d.getDay() !== wd) d.setDate(d.getDate() + 1);
    d = atNoon(d);
    return { date: d, daysAway: Math.round((d - atNoon(today)) / 86400000) };
  }
  /* biweekly/monthly need an anchor: last payday, else the most recent payday weekday */
  var anchor = null;
  if(S.lastPayday){ var pa = new Date(S.lastPayday + 'T12:00:00'); if(isFinite(pa)) anchor = pa; }
  if(!anchor){
    anchor = new Date(today);
    while(anchor.getDay() !== wd) anchor.setDate(anchor.getDate() - 1);
    anchor = atNoon(anchor);
  }
  if(freq === 'biweekly'){
    var d2 = new Date(anchor);
    var t = atNoon(today);
    if(d2 <= t){ var diff = Math.ceil((t - d2) / 86400000 / 14); d2.setDate(d2.getDate() + diff * 14); }
    return { date: d2, daysAway: Math.round((d2 - t) / 86400000) };
  }
  /* monthly: same calendar date next month, rolling forward while past */
  var m = new Date(anchor); m.setMonth(m.getMonth() + 1);
  var t2 = atNoon(today);
  while(m <= t2) m.setMonth(m.getMonth() + 1);
  return { date: m, daysAway: Math.round((m - t2) / 86400000) };
}
function fmtPayday(d){
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
/* v2.0.2 auto-detect: sanity flags on odd paycheck inputs. Returns string[]. */
function paycheckFlags(hours, rate, net){
  var flags = [];
  if(hours > 80) flags.push(fmtHrs(hours) + ' hrs/week is very high \u2014 double-check your hours.');
  if(rate > 0 && rate < 7.25) flags.push(money(rate) + '/hr is below the federal minimum wage ($7.25) \u2014 check your rate.');
  if(net < 0 && (hours > 0 || rate > 0)) flags.push('Deductions are higher than gross pay \u2014 check your deduction entries.');
  return flags;
}
function currentPaycheck(){
  /* No pay stub entered → estimate mode: federal + state tax from the 2025
     bracket tables for the picked state. A saved pay stub wins over the
     estimate — the stub numbers are the real ones. */
  if(!S.stubSaved) return calcPaycheck(effectiveHours(), S.rate, S.ded, S.freq, { stateCode: S.stateCode || 'NY' });
  return calcPaycheck(effectiveHours(), S.rate, S.ded, S.freq);
}

/* Money the user HAS right now. If they typed a number in the Budget tab,
   that wins. Otherwise it follows the My Money balances (typed or imported).
   Blank (null) until anything is entered — fresh visitors start at $0. */
function effectiveStartingMoney(){
  if(S.startingMoney !== null && S.startingMoney !== undefined && S.startingMoney !== '' && isFinite(Number(S.startingMoney))) return num(S.startingMoney);
  return num(S.saved) + num(S.checking);
}

function monthlyIncome(){
  return currentPaycheck().monthlyNet;
}
function plannedSpend(){ return S.categories.reduce(function(a, c){ return a + num(c.amount); }, 0); }

/* ---------- animations (v1.3.0): count-ups + donut transitions ----------
   Transform/opacity only, short durations. Everything here is skipped when
   the device prefers reduced motion, and when requestAnimationFrame is
   unavailable (tests, old browsers) numbers are set directly. */
var REDUCED_MOTION = false;
try{ REDUCED_MOTION = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }catch(e){}
function setMoneyText(el, value, fmt){
  if(!el) return;
  var fmtFn = fmt || money;
  var target = num(value);
  var prev = (el._moneyCurrent !== undefined) ? el._moneyCurrent : null;
  if(el._moneyRaf){ if(typeof cancelAnimationFrame !== 'undefined'){ try{ cancelAnimationFrame(el._moneyRaf); }catch(e){} } el._moneyRaf = 0; }
  if(prev === null || REDUCED_MOTION || typeof requestAnimationFrame === 'undefined'){
    el.textContent = fmtFn(target); el._moneyCurrent = target; return;
  }
  var start = prev, startT = null, DUR = 220;
  function step(ts){
    if(startT === null) startT = ts;
    var p = Math.min(1, (ts - startT) / DUR);
    var e = 1 - Math.pow(1 - p, 3);
    var cur = start + (target - start) * e;
    el._moneyCurrent = cur;
    el.textContent = fmtFn(cur);
    if(p < 1){ el._moneyRaf = requestAnimationFrame(step); }
    else { el._moneyRaf = 0; el._moneyCurrent = target; el.textContent = fmtFn(target); }
  }
  el._moneyRaf = requestAnimationFrame(step);
}
/* donut circles are kept across renders so the CSS transition can glide
   them to their new sizes instead of rebuilding them every keystroke */
var donutCircleEls = [];
var donutPrevLeft = 0;
function renderDonut(slices, total){
  var svg = document.getElementById('donutSvg');
  if(!svg) return;
  var C = 2 * Math.PI * 80;
  if(!document.createElementNS){
    /* fallback (tests / old browsers): rebuild the markup */
    var acc0 = 0, html = '';
    slices.forEach(function(s){
      if(s.value <= 0) return;
      var frac = s.value / total;
      var dash = frac * C;
      html += '<circle cx="100" cy="100" r="80" fill="none" stroke="' + s.color + '" stroke-width="34" ' +
        'stroke-dasharray="' + dash.toFixed(1) + ' ' + (C - dash).toFixed(1) + '" stroke-dashoffset="' + (-acc0).toFixed(1) + '" />';
      acc0 += dash;
    });
    svg.innerHTML = html;
    return;
  }
  var acc = 0;
  slices.forEach(function(s, i){
    var frac = s.value / total;
    var dash = frac * C;
    var c = donutCircleEls[i];
    if(!c){
      c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', '100'); c.setAttribute('cy', '100'); c.setAttribute('r', '80');
      c.setAttribute('fill', 'none'); c.setAttribute('stroke-width', '34');
      svg.appendChild(c);
      donutCircleEls.push(c);
    }
    c.setAttribute('stroke', s.color);
    c.setAttribute('stroke-dasharray', dash.toFixed(1) + ' ' + (C - dash).toFixed(1));
    c.setAttribute('stroke-dashoffset', (-acc).toFixed(1));
    acc += dash;
    /* v2.0.0: tap/hover a slice to see its details */
    if(!c._detailBound){
      c._detailBound = true;
      c.style.cursor = 'pointer';
      (function(lbl, val){
        var show = function(){
          var d = document.getElementById('donutDetail');
          if(d && total > 0) d.textContent = lbl + ' — ' + money(val) + ' (' + Math.round(val / total * 100) + '% of ' + money(total) + ')';
        };
        c.addEventListener('click', show);
        c.addEventListener('mouseover', show);
      })(s.label || 'Slice', s.value);
    }
  });
  while(donutCircleEls.length > slices.length){
    var extra = donutCircleEls.pop();
    if(extra.parentNode) extra.parentNode.removeChild(extra);
  }
}

function renderAll(){
  renderBudget(); renderPaycheck(); renderMyMoney(); renderBills();
  renderDiscountsStatic(); renderDiscountCalc(); renderCashbackEst();
  renderCalculators(); renderWatchlist(); renderStocks(); renderEarn();
}

function renderBudget(){
  /* don't clobber the starting-money field the user is currently typing in */
  var startEl = document.getElementById('startingMoneyInput');
  if(startEl && document.activeElement !== startEl){
    startEl.value = (S.startingMoney !== null && S.startingMoney !== undefined && S.startingMoney !== '') ? S.startingMoney : '';
    startEl.placeholder = (num(S.saved) + num(S.checking)) > 0 ? 'Using balances: ' + money(num(S.saved) + num(S.checking)) : '0.00';
  }
  renderBudgetSummary();
  renderCategoryList();
  renderGoal();
}

function renderBudgetSummary(){
  /* Budget anchors on the money the user HAS:
     money I have + money coming in − bills due − planned spending = left */
  var starting = effectiveStartingMoney();
  var income = monthlyIncome();
  var bills = unpaidBillsTotal();
  var spend = plannedSpend();
  var left = starting + income - bills - spend;
  setMoneyText(document.getElementById('startingLine'), starting);
  setMoneyText(document.getElementById('incomeLine'), income);
  setMoneyText(document.getElementById('billsLine'), bills);
  setMoneyText(document.getElementById('spendLine'), spend);
  setMoneyText(document.getElementById('leftLine'), left);
  updateEarnTotal();
  setMoneyText(document.getElementById('donutLeft'), left, money);
  /* v2.0.0 grow/shrink pulse: the center number pops up or down with the change */
  (function(){
    var dl = document.getElementById('donutLeft');
    if(!dl) return;
    var dir = left > donutPrevLeft ? 'pulse-up' : (left < donutPrevLeft ? 'pulse-down' : '');
    donutPrevLeft = left;
    if(dir && !REDUCED_MOTION){
      dl.classList.remove('pulse-up', 'pulse-down');
      void dl.offsetWidth;
      dl.classList.add(dir);
    }
  })();
  document.getElementById('donutSub').textContent = left >= 0 ? 'left this month' : 'over budget';
  document.getElementById('overBudgetWarn').hidden = left >= 0;
  var haveEl = document.getElementById('budgetHaveLine');
  if(haveEl) haveEl.textContent = 'You have ' + money(starting) + ' right now.';
  var promptEl = document.getElementById('startingMoneyPrompt');
  if(promptEl) promptEl.hidden = !(starting <= 0 && !S.balanceDate && !(S.statementInfo && S.statementInfo.date));

  /* take-home breakdown: the whole chain, so the monthly number is checkable
     from its own inputs. weeklyNet uses the same effRate as monthlyNet, so
     the chain multiplies out exactly to the displayed monthly number. */
  var p = currentPaycheck();
  var hrs = effectiveHours();
  var weeklyNet = p.weeklyGross * (1 - p.effRate);
  var pctTaken = (p.effRate * 100).toFixed(2).replace(/\.?0+$/, '');
  var bdEl = document.getElementById('incomeBreakdown');
  if(bdEl) bdEl.textContent = income > 0
    ? fmtHrs(hrs) + ' paid hrs/week' + (p.otHrs > 0.001 ? ' (' + fmtHrs(p.regHrs) + ' regular + ' + fmtHrs(p.otHrs) + ' OT at 1.5×)' : '') + ' × ' + money(S.rate) + '/hr = ' +
      money(p.weeklyGross) + ' gross → ' + money(weeklyNet) + ' take-home/week (' + pctTaken +
      '% taken off) → × 52 ÷ 12 = ' + money(p.monthlyNet) + ' / month. A month averages 4⅓ weeks, so this is more than 4 weekly paychecks.'
    : 'No income entered yet — set your hours and rate in the Paycheck tab and this will show the full math.';
  /* live stamp: proves the numbers just re-rendered */
  var stampEl = document.getElementById('budgetUpdatedStamp');
  if(stampEl) stampEl.textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  /* starting-money source: an override, once typed, wins over the balances
     until cleared — make that visible instead of silent */
  var overrideActive = (S.startingMoney !== null && S.startingMoney !== undefined && S.startingMoney !== '' && isFinite(Number(S.startingMoney)));
  var srcEl = document.getElementById('startingMoneySource');
  if(srcEl) srcEl.textContent = overrideActive
    ? 'Using the number you typed here (' + money(S.startingMoney) + '). Changes in My Money will not change this until you clear it.'
    : 'Following your My Money balances (' + money(num(S.saved) + num(S.checking)) + ').';
  var clrBtn = document.getElementById('clearStartingMoneyBtn');
  if(clrBtn) clrBtn.hidden = !overrideActive;

  /* donut: slices = categories + bills, plus a "left" slice when positive.
     Circles persist across renders so they glide to their new sizes. */
  var total = Math.max(spend + bills + Math.max(left, 0), 1);
  var slices = [];
  S.categories.forEach(function(c, i){
    if(num(c.amount) > 0) slices.push({ label: c.name || 'Category', value: num(c.amount), color: COLORS[i % COLORS.length] });
  });
  if(bills > 0) slices.push({ label: 'Bills due', value: bills, color: '#e8b34b' });
  if(left > 0) slices.push({ label: "You'll have left", value: left, color: '#2ed573' });
  renderDonut(slices, total);
  var donutDetailEl = document.getElementById('donutDetail');
  if(donutDetailEl) donutDetailEl.textContent = slices.length === 0
    ? 'Nothing to show yet — add income, bills, or planned spending and your breakdown will appear here.'
    : 'Tap a donut slice to see its details.';
  /* the goal projection depends on these same numbers, so it recomputes
     on every keystroke of every money input — not just its own fields */
  renderGoal();
}

function renderCategoryList(){
  var income = monthlyIncome();
  /* categories list */
  var list = document.getElementById('categoryList');
  list.innerHTML = '';
  S.categories.forEach(function(c, i){
    var pct = income > 0 ? Math.round(num(c.amount) / income * 100) : 0;
    var row = document.createElement('div'); row.className = 'cat-row';
    row.innerHTML = '<span class="cat-dot" style="background:' + COLORS[i % COLORS.length] + '"></span>' +
      '<input type="text" value="' + esc(c.name) + '" data-cat-name="' + i + '" aria-label="Category name">' +
      '<input type="number" min="0" step="1" value="' + num(c.amount) + '" data-cat-amt="' + i + '" aria-label="Category amount per month">' +
      '<span class="cat-pct">' + pct + '%</span>' +
      '<button class="btn-mini danger" data-cat-del="' + i + '" type="button">Delete</button>';
    list.appendChild(row);
  });
}

function renderGoal(){
  /* savings goal — don't clobber the field the user is currently typing in */
  var goalEl = document.getElementById('goalAmount');
  var savedEl = document.getElementById('savedAmount');
  if(document.activeElement !== goalEl) goalEl.value = S.goal;
  if(document.activeElement !== savedEl) savedEl.value = S.saved;
  var toGo = Math.max(S.goal - S.saved, 0);
  var pct = S.goal > 0 ? Math.min(100, Math.round(S.saved / S.goal * 100)) : 0;
  /* progress bar fills via transform (scaleX) so it animates cheaply */
  var fill = document.getElementById('goalFill');
  if(fill) fill.style.transform = 'scaleX(' + (pct / 100) + ')';
  document.getElementById('goalPct').textContent = pct + '%';
  document.getElementById('goalToGo').textContent = money(toGo) + ' to go';
  /* monthly leftover is what can actually go toward the goal:
     take-home − unpaid bills − planned spending */
  var monthlyLeftover = monthlyIncome() - unpaidBillsTotal() - plannedSpend();
  var p = currentPaycheck();
  var proj = calcGoalProjection(S.goal, S.saved, monthlyLeftover, S.rate, p.effRate);
  var pace = document.getElementById('paceLine');
  if(proj.status === 'reached'){ pace.textContent = '🎉 Goal reached — nice work.'; }
  else if(proj.status === 'noset'){ pace.textContent = 'Set a savings goal above and this will project the date you\'ll reach it.'; }
  else if(proj.status === 'date'){
    pace.textContent = 'You\'ll hit ' + money0(S.goal) + ' by ' + proj.dateStr +
      ' — saving about ' + money(monthlyLeftover) + '/month, about ' + proj.months +
      ' month' + (proj.months === 1 ? '' : 's') + ' to go.';
  }
  else if(proj.status === 'far'){
    pace.textContent = 'At about ' + money(monthlyLeftover) + '/month it would take over 50 years to reach ' +
      money0(S.goal) + ' — the math is real, but the goal needs a bigger monthly leftover. Cut spending or add hours to move it sooner.';
  }
  else {
    var msg = 'At this pace you are not saving — planned spending is at or above your income, so there is no date to show yet. ' +
      'You\'re ' + money(proj.shortfall) + '/month short — cut planned spending by ' + money(proj.shortfall);
    if(proj.extraHours > 0) msg += ', or add about ' + (Math.round(proj.extraHours * 10) / 10) + ' hrs/week at your rate';
    msg += ', to start saving.';
    pace.textContent = msg;
  }
}

function renderPaycheck(){
  document.getElementById('hoursModeTotal').classList.toggle('active', S.hoursMode !== 'shifts');
  document.getElementById('hoursModeShifts').classList.toggle('active', S.hoursMode === 'shifts');
  document.getElementById('hoursTotalBox').hidden = S.hoursMode === 'shifts';
  document.getElementById('hoursShiftsBox').hidden = S.hoursMode !== 'shifts';
  /* don't clobber the field the user is currently typing in */
  var hoursInputEl = document.getElementById('hoursInput');
  var rateInputEl = document.getElementById('rateInput');
  var mealTotalEl = document.getElementById('mealTotalInput');
  document.getElementById('hoursSlider').value = S.hours;
  if(document.activeElement !== hoursInputEl) hoursInputEl.value = S.hours;
  if(document.activeElement !== rateInputEl) rateInputEl.value = S.rate;
  document.getElementById('freqSelect').value = S.freq;
  /* state picker drives the estimate; a saved pay stub overrides it */
  var stateSel = document.getElementById('stateSelect');
  if(stateSel) stateSel.value = S.stateCode || 'NY';
  /* v2.0.0 employer preset drives the rate (rate stays editable after) */
  var empSel = document.getElementById('employerSelect');
  if(empSel) empSel.value = S.employerKey || 'custom';
  var empHint = document.getElementById('employerHint');
  if(empHint){
    var ep = employerForKey(S.employerKey);
    empHint.textContent = (ep.rate !== null && ep.rate !== undefined)
      ? ep.name + ' preset: $' + ep.rate + '/hr \u2014 starting point only, change the rate below if yours is different.'
      : 'Custom \u2014 type your own rate below.';
  }
  var estimateMode = !S.stubSaved;
  var fedInput = document.getElementById('federalInput');
  var nyInput = document.getElementById('nyInput');
  var pNow = currentPaycheck();
  if(estimateMode){
    /* federal + state come from the 2025 tables — show the effective %
       they work out to, read-only, so the breakdown stays checkable */
    if(fedInput){ fedInput.disabled = true; fedInput.value = pNow.periodGross > 0 ? (pNow.fedAmt / pNow.periodGross * 100).toFixed(4).replace(/\.?0+$/, '') : 0; }
    if(nyInput){ nyInput.disabled = true; nyInput.value = pNow.periodGross > 0 ? (pNow.nyAmt / pNow.periodGross * 100).toFixed(4).replace(/\.?0+$/, '') : 0; }
  } else {
    if(fedInput) fedInput.disabled = false;
    if(nyInput) nyInput.disabled = false;
  }
  document.getElementById('ssInput').value = S.ded.ss;
  document.getElementById('medicareInput').value = S.ded.medicare;
  if(!estimateMode) document.getElementById('federalInput').value = S.ded.federal;
  if(!estimateMode) document.getElementById('nyInput').value = S.ded.ny;
  document.getElementById('fliInput').value = S.ded.fli;
  document.getElementById('k401Input').value = S.ded.k401;
  document.getElementById('memberInput').value = S.ded.membership;
  document.getElementById('stockContribInput').value = S.ded.stockContrib;
  document.getElementById('stockPurchInput').value = S.ded.stockPurch;

  var shiftList = document.getElementById('shiftList');
  shiftList.innerHTML = '';
  var totalLen = 0, totalMeal = 0, totalPaid = 0, totalBreak = 0;
  S.shifts.forEach(function(sh, i){
    var len = calcShiftHours(sh.start, sh.end);
    var meal = (sh.meal === undefined || sh.meal === null) ? defaultMeal(sh.start, sh.end) : num(sh.meal);
    var brk = (sh.breakMin === undefined || sh.breakMin === null) ? defaultBreak() : num(sh.breakMin);
    var paid = calcShiftPaidHours(sh.start, sh.end, meal);
    totalLen += len; totalMeal += meal; totalPaid += paid; totalBreak += brk;
    var row = document.createElement('div'); row.className = 'bill-row';
    row.innerHTML = '<span class="bill-name">' + esc(sh.day) + '</span>' +
      '<span>' + esc(fmtTime(sh.start)) + ' – ' + esc(fmtTime(sh.end)) + '</span>' +
      '<label class="field small">Meal (min) <input type="number" min="0" step="5" value="' + meal + '" data-shift-meal="' + i + '" aria-label="Meal break in minutes"></label>' +
      '<label class="field small">Break (min) <input type="number" min="0" step="5" value="' + brk + '" data-shift-break="' + i + '" aria-label="Paid break in minutes"></label>' +
      '<button class="btn-mini danger" data-shift-del="' + i + '" type="button">Delete</button>' +
      '<span class="shift-math">' + fmtHrs(len) + ' hrs, meal ' + fmtHrs(meal) + ' min (unpaid) → paid ' + fmtHrs(paid) + ' hrs · break ' + fmtHrs(brk) + ' min (paid)</span>';
    shiftList.appendChild(row);
  });
  if(!S.shifts.length) shiftList.innerHTML = '<p class="hint">No shifts yet — add one below.</p>';
  document.getElementById('shiftTotalOut').textContent = fmtHrs(totalPaid) + ' hrs / week';
  document.getElementById('shiftMathOut').textContent = S.shifts.length
    ? 'Shift time ' + fmtHrs(totalLen) + ' hrs total − meal ' + fmtHrs(totalMeal) + ' min total (unpaid) → paid ' + fmtHrs(totalPaid) + ' hrs · breaks ' + fmtHrs(totalBreak) + ' min total (paid).'
    : '';
  if(document.activeElement !== mealTotalEl) mealTotalEl.value = S.mealTotal || 0;
  var breakTotalEl = document.getElementById('breakTotalInput');
  if(document.activeElement !== breakTotalEl) breakTotalEl.value = S.breakTotal || 0;
  var brkNote = num(S.breakTotal) > 0 ? ' · break ' + fmtHrs(num(S.breakTotal)) + ' min total (paid)' : '';
  document.getElementById('totalMealMath').textContent = num(S.mealTotal) > 0
    ? fmtHrs(num(S.hours)) + ' hrs − ' + fmtHrs(num(S.mealTotal)) + ' min meal (unpaid) → paid ' + fmtHrs(effectiveHours()) + ' hrs.' + brkNote
    : 'Paid hours: ' + fmtHrs(effectiveHours()) + ' hrs / week.' + brkNote;

  renderPaycheckOutputs();
}

/* paycheck result lines + stub form + what-if — no list rebuild, so it is
   safe to call while typing (e.g. a shift meal break) without stealing focus */
function renderPaycheckOutputs(){
  var p = currentPaycheck();
  var st = STATE_TAX_2025[S.stateCode || 'NY'];
  var stateName = st ? st.name : (NO_TAX_STATE_NAMES[S.stateCode] || 'this state');
  var stateLabel = document.getElementById('stateTaxLabel');
  if(stateLabel) stateLabel.textContent = stateName + ' state tax';
  var noteEl = document.getElementById('stateTaxNote');
  if(noteEl){
    if(S.stubSaved){
      noteEl.textContent = 'Using your real pay stub — the state estimate is not applied. Your stub numbers win.';
    } else if(!st){
      noteEl.textContent = stateName + ' has no income tax on wages, so state tax is $0 here. Federal is estimated from the 2025 single-filer standard deduction ($15,000) + 2025 brackets. Estimate only — not tax advice, no city/local tax.';
    } else {
      noteEl.textContent = 'Estimate for ' + stateName + ': single filer, 2025 tax year, state income tax only (no city/local tax). Standard deduction ' + money(st.ded) +
        (st.credit ? ' + ' + money(st.credit) + ' exemption credit' : '') +
        ' + 2025 brackets. Federal uses the 2025 $15,000 standard deduction + 2025 brackets. Estimate only — not tax advice. Your pay stub, when entered, is the real number.';
    }
  }
  setMoneyText(document.getElementById('grossOut'), p.periodGross);
  document.getElementById('grossPer').textContent = p.periodLabel;
  document.getElementById('ssOut').textContent = '−' + money(p.ssAmt);
  document.getElementById('medicareOut').textContent = '−' + money(p.medicareAmt);
  document.getElementById('federalOut').textContent = '−' + money(p.fedAmt);
  document.getElementById('nyOut').textContent = '−' + money(p.nyAmt);
  document.getElementById('fliOut').textContent = '−' + money(p.fliAmt);
  document.getElementById('taxesTotalOut').textContent = money(p.taxesTotal);
  document.getElementById('k401Out').textContent = '−' + money(p.k401Amt);
  document.getElementById('memberOut').textContent = '−' + money(p.memberAmt);
  document.getElementById('stockContribOut').textContent = '−' + money(p.stockContribAmt);
  document.getElementById('stockPurchOut').textContent = '−' + money(p.stockPurchAmt);
  document.getElementById('dedTotalOut').textContent = money(p.dedTotal);
  document.getElementById('takenOffOut').textContent = money(p.totalDed);
  document.getElementById('takenOffPct').textContent = (p.effRate * 100).toFixed(2).replace(/\.?0+$/, '') + '%';
  setMoneyText(document.getElementById('takeHomeOut'), p.net);
  document.getElementById('takeHomePer').textContent = p.periodLabel;
  setMoneyText(document.getElementById('monthlyOut'), p.monthlyNet);
  /* v2.0.2 auto-detections box: overtime, next payday, sanity flags */
  (function(){
    var box = document.getElementById('detectBox');
    if(!box) return;
    var hrs = effectiveHours();
    var lines = [];
    if(p.otHrs > 0.001){
      lines.push('<p><strong>Overtime detected:</strong> ' + fmtHrs(p.otHrs) + ' hrs over 40 at 1.5\u00d7 = ' +
        money(p.otAmt) + ' extra gross. (' + fmtHrs(p.regHrs) + ' regular + ' + fmtHrs(p.otHrs) + ' OT.)</p>');
    }
    var pd = nextPaydayInfo();
    if(pd.date){
      lines.push('<p><strong>Next payday:</strong> ' + fmtPayday(pd.date) +
        (pd.daysAway === 0 ? ' \u2014 today!' : pd.daysAway === 1 ? ' \u2014 tomorrow.' : ' \u2014 in ' + pd.daysAway + ' days.') + '</p>');
    }
    paycheckFlags(hrs, S.rate, p.net).forEach(function(f){
      lines.push('<p class="flag">\u26a0\ufe0f ' + esc(f) + '</p>');
    });
    box.innerHTML = lines.length ? lines.join('') : '<p class="explain">No detections \u2014 everything looks normal.</p>';
    var lpw = document.getElementById('lastPaydayWrap');
    if(lpw) lpw.hidden = (S.freq !== 'biweekly' && S.freq !== 'monthly');
    var pds = document.getElementById('paydayWeekday');
    if(pds && document.activeElement !== pds) pds.value = String((S.paydayWeekday === undefined || S.paydayWeekday === null) ? 2 : S.paydayWeekday);
    var lpi = document.getElementById('lastPaydayInput');
    if(lpi && document.activeElement !== lpi) lpi.value = S.lastPayday || '';
  })();

  /* pay-stub form: show what the current profile means in dollars at the
     stub gross (or the current period gross), without clobbering typing */
  var stubGrossEl = document.getElementById('stubGross');
  var stubGrossVal = S.stubSaved ? num(S.stubSaved.gross) : p.periodGross;
  if(document.activeElement !== stubGrossEl) stubGrossEl.value = S.stubSaved ? S.stubSaved.gross : '';
  var stubFields = [
    ['stubFederal', S.ded.federal], ['stubNY', S.ded.ny], ['stubFLI', S.ded.fli],
    ['stubSS', S.ded.ss], ['stubMedicare', S.ded.medicare], ['stubK401', S.ded.k401]
  ];
  stubFields.forEach(function(pair){
    var el = document.getElementById(pair[0]);
    if(el && document.activeElement !== el) el.value = stubGrossVal > 0 ? (stubGrossVal * pair[1] / 100).toFixed(2) : '';
  });
  [['stubMember', S.ded.membership], ['stubStockContrib', S.ded.stockContrib], ['stubStockPurch', S.ded.stockPurch]].forEach(function(pair){
    var el = document.getElementById(pair[0]);
    if(el && document.activeElement !== el) el.value = pair[1] > 0 ? pair[1].toFixed(2) : '';
  });
  var stubStatus = document.getElementById('stubStatus');
  if(S.stubSaved){
    stubStatus.textContent = 'Using your pay stub: gross ' + money(S.stubSaved.gross) + ' → net ' +
      money(S.stubSaved.net) + '. Change any line above and tap "Use this stub" again to update.';
  } else {
    stubStatus.textContent = 'No pay stub saved — the breakdown uses the rates above (Social Security 6.2% + Medicare 1.45%, everything else $0).';
  }

  var extraH = num(document.getElementById('extraHours').value, 0);
  var extraNet = extraH * S.rate * (1 - p.effRate);
  document.getElementById('extraHoursOut').textContent = '+' + extraH + ' hrs/week → about ' + money(extraNet) +
    ' more take-home per week (' + money(extraNet * 52 / 12) + ' / month).';
  var newRate = num(document.getElementById('newRate').value, 0);
  if(newRate > 0){
    var newP = calcPaycheck(effectiveHours(), newRate, S.ded, 'weekly');
    var oldP = calcPaycheck(effectiveHours(), S.rate, S.ded, 'weekly');
    document.getElementById('newRateOut').textContent = 'At $' + newRate.toFixed(2) + '/hr with the same hours: ' +
      money(newP.net) + ' take-home / week — that is ' + money(newP.net - oldP.net) +
      ' more per week (' + money((newP.net - oldP.net) * 52 / 12) + ' / month).';
  } else {
    document.getElementById('newRateOut').textContent = 'Type a new hourly rate above to see the difference.';
  }
}

function fmtTime(t){
  var parts = String(t || '').split(':');
  var h = parseInt(parts[0], 10), m = parts[1] || '00';
  if(!isFinite(h)) return t;
  var ap = h >= 12 ? 'PM' : 'AM';
  var h12 = h % 12; if(h12 === 0) h12 = 12;
  return h12 + ':' + m + ' ' + ap;
}

function unpaidBillsTotal(){
  return S.bills.reduce(function(a, b){ return a + (b.paid ? 0 : num(b.amount)); }, 0);
}

function renderMyMoney(){
  var savingsBalEl = document.getElementById('savingsBalInput');
  var checkingBalEl = document.getElementById('checkingBalInput');
  if(document.activeElement !== savingsBalEl) savingsBalEl.value = S.saved;
  if(document.activeElement !== checkingBalEl) checkingBalEl.value = S.checking;
  document.getElementById('balanceDateInput').value = S.balanceDate || '';
  var total = num(S.saved) + num(S.checking);
  var bills = unpaidBillsTotal();
  var budget = plannedSpend();
  var canSpend = total - bills - budget;
  setMoneyText(document.getElementById('moneyTotal'), total);
  document.getElementById('moneyBills').textContent = money(bills);
  document.getElementById('moneyBudget').textContent = money(budget);
  document.getElementById('moneyCanSpend').textContent = money(canSpend);
  document.getElementById('moneyWarn').hidden = canSpend >= 0;
  document.getElementById('moneyUpdatedLine').textContent = S.balanceDate
    ? 'Balances as of ' + new Date(S.balanceDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) + '. Update them when your balance changes.'
    : 'Set the date you last checked your balances.';

  /* statement transactions from the last import, newest first (up to 10) */
  var txnList = document.getElementById('txnList');
  txnList.innerHTML = '';
  if(S.statementTxns && S.statementTxns.length){
    var head = document.createElement('p');
    head.className = 'result-line';
    head.textContent = 'Recent transactions from your statement' +
      (S.statementInfo && S.statementInfo.date ? ' (latest ' + new Date(S.statementInfo.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ')' : '') + ':';
    txnList.appendChild(head);
    S.statementTxns.slice().sort(function(a, b){ return a.date < b.date ? 1 : (a.date > b.date ? -1 : 0); }).slice(0, 10).forEach(function(t){
      var r = document.createElement('div'); r.className = 'txn-row';
      var d = new Date(t.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      r.innerHTML = '<span class="txn-desc">' + esc(d) + ' · ' + esc(t.description || 'Transaction') + '</span>' +
        '<span class="txn-amt ' + (t.amount >= 0 ? 'txn-pos' : 'txn-neg') + '">' + (t.amount >= 0 ? '+' : '−') + money(Math.abs(t.amount)) + '</span>';
      txnList.appendChild(r);
    });
  }
}

function fmtISODate(iso){
  if(!iso) return '';
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ---------- bank statement import (all local, nothing leaves the device) ---------- */
var pendingImport = null, preImportSnapshot = null;

function handleStatementText(text){
  var res = parseStatementCSV(text);
  var status = document.getElementById('csvStatus');
  pendingImport = null;
  document.getElementById('csvConfirm').hidden = true;
  document.getElementById('csvUndoBtn').hidden = true;
  if(!res.ok){ status.textContent = res.error; return; }
  pendingImport = res;
  status.textContent = 'Read ' + res.count + ' transaction' + (res.count === 1 ? '' : 's') + ' from your statement.';
  var found = document.getElementById('csvFound');
  if(res.balance != null){
    found.textContent = 'Found balance ' + money(res.balance) +
      (res.statementDate ? ' (latest transaction ' + fmtISODate(res.statementDate) + ')' : '') +
      ' and ' + res.count + ' transactions. Pick which account this statement is for, then use it.';
  } else {
    found.textContent = 'Found ' + res.count + ' transactions, but no balance column, so your balance still needs typing. Pick an account and use it to save the transactions.';
  }
  document.getElementById('csvConfirm').hidden = false;
}

function applyStatement(){
  if(!pendingImport) return;
  preImportSnapshot = { saved: S.saved, checking: S.checking, balanceDate: S.balanceDate,
    statementTxns: S.statementTxns, statementInfo: S.statementInfo };
  var account = 'savings';
  document.querySelectorAll('input[name="stmtAccount"]').forEach(function(r){ if(r.checked) account = r.value; });
  if(pendingImport.balance != null){
    if(account === 'checking') S.checking = pendingImport.balance;
    else S.saved = pendingImport.balance;
  }
  if(pendingImport.statementDate) S.balanceDate = pendingImport.statementDate;
  S.statementTxns = pendingImport.transactions.slice(-100);
  S.statementInfo = { balance: pendingImport.balance, date: pendingImport.statementDate, count: pendingImport.count, account: account };
  save(); renderAll();
  document.getElementById('csvStatus').textContent = 'Done — ' +
    (pendingImport.balance != null ? 'balance updated from your statement.' : 'transactions saved. Balance still needs typing since the statement had no balance column.') +
    ' You can undo below.';
  document.getElementById('csvUndoBtn').hidden = false;
  pendingImport = null;
}

function undoStatement(){
  if(!preImportSnapshot) return;
  S.saved = preImportSnapshot.saved;
  S.checking = preImportSnapshot.checking;
  S.balanceDate = preImportSnapshot.balanceDate;
  S.statementTxns = preImportSnapshot.statementTxns;
  S.statementInfo = preImportSnapshot.statementInfo;
  preImportSnapshot = null;
  save(); renderAll();
  document.getElementById('csvStatus').textContent = 'Undone — your balances are back to what they were before the import.';
  document.getElementById('csvUndoBtn').hidden = true;
  document.getElementById('csvConfirm').hidden = true;
}

/* ---------- update system: banner once per version, manual What's New ---------- */
var UPDATE_SEEN_PREFIX = 'budgetPlanner.update.seen.v';
var CHANGELOG_FALLBACK = [
  { version: '2.1.0', notes: [
    'Full visual rework: a premium dark fintech look \u2014 deeper layered backgrounds, a refined mint accent system, gradient cards and buttons, a glassy bottom tab bar on phones, polished inputs with glowing focus rings, and a richer header. Every feature works exactly as before.',
    'New micro-details: gradient card titles with accent underlines, bolder money figures, smoother press feedback, and clearer focus states for keyboard users. All animations still respect your reduced-motion setting.'
  ] },
  { version: '2.0.5', notes: [
    'Fixed: the Install button could stay visible inside the installed app — the stylesheet was overriding the hide signal. The install prompt now reliably hides when installed and shows only on the web.'
  ] },
  { version: '2.0.4', notes: [
    'Hot-fix: the app\u2019s offline cache now always pulls fresh files from the network when a new version installs — the old installer could pack stale files into the new cache, which is how an update could leave you on the old build.'
  ] },
  { version: '2.0.3', notes: [
    'Fixed updates getting stuck: tapping Update now waits for the new version to actually install before reloading, and the update notice stays until the new version is confirmed running — no more "latest version" while showing the old number. The footer version number is now written by the app itself, so it can never go stale.'
  ] },
  { version: '2.0.2', notes: [
    'Install prompt now hides completely when the app is installed — it only shows on the web.',
    'Paycheck auto-detections: overtime is now automatic — hours over 40/week are paid at 1.5x and the breakdown says so. A new Auto-detections card shows your next payday (pick your payday weekday; add your last payday date for every-2-weeks pay) and flags odd inputs, like hours over 80/week, a rate below federal minimum wage, or deductions higher than your gross.'
  ] },
  { version: '2.0.1', notes: [
    'Fixed the donut on mobile: it now shows a subtle ring with a helpful hint when there is nothing to chart yet, instead of a blank hole. The "left" slice is a brighter green that actually shows up on the dark theme, and the donut centers itself on phone screens.'
  ] },
  { version: '2.0.0', notes: [
    'Rebuilt for v2.0: where-you-work picker (Walmart, Target, Amazon, McDonald\u2019s, or custom) sets your rate with one tap \u2014 the rate stays editable, presets are starting points.',
    'New Stocks tab (educational): watchlist with prices you type in, price-history charts with highs and lows, an allocation calculator, and beginner investing videos. Paper-trading only \u2014 nothing moves real money, and this is not financial advice.',
    'Device sync code: generate a one-time code on your phone, paste it on your PC (or the other way), and everything moves over. No server, no account.',
    'Deal Watchlist upgrade: store presets (Best Buy, Walmart, Amazon, Target, Newegg), per-item price history with a mini chart, and a target-hit alert.',
    'Donut chart: tap any slice to see its category, amount, and share; the center number pops up or down as it changes.',
    'Fixed empty states: the goal celebration only fires on a real goal you reached, and with no income entered the budget says so plainly instead of showing a $0 math chain.',
    'New layout: phones get the single-column stacked cards with the bottom tab bar; PCs get a multi-column dashboard.'
  ] },
  { version: '1.3.1', notes: [
    'Shifts now track your paid 15-minute breaks: every shift starts with a 15-minute break and a 30-minute meal, shown right on the shift line. Breaks are paid, so they never reduce your paid hours \u2014 the math line reads "8 hrs, meal 30 min (unpaid) \u2192 paid 7.5 hrs \u00b7 break 15 min (paid)". Old shifts pick up the 15-minute break automatically.'
  ] },
  { version: '1.3.0', notes: [
    'Savings goal date: the goal now recomputes on every keystroke — type hours, bills, or spending and the date moves right away. When you are saving, it says "You\'ll hit $X by [Month Year]" with the math. When spending eats the whole paycheck, it tells you exactly how short you are per month and how many extra hours/week would fix it — never a made-up date.',
    'Deal Watchlist in Discount Finder: add an item + the price you would buy at. "Check price now" opens the store page; type the price you see and the app says Deal or Not yet, with a Last checked stamp and a Refresh deals button. Prices are ones you type — the app never pretends to check a store by itself.',
    'State tax picker in the Paycheck tab: pick your state and the estimate uses that state\'s real 2025 standard deduction + brackets (single filer). States with no wage income tax come out $0. Federal uses the 2025 $15,000 standard deduction + 2025 brackets. If you entered a real pay stub, the stub numbers still win. Estimate only — not tax advice, no city/local tax.',
    'Animations: money numbers count up when they change, the donut glides to its new shape, the goal bar fills smoothly, tabs fade in, buttons give a little press feedback. All of it turns off automatically if your device prefers reduced motion, and it stays light on phones.'
  ] },
  { version: '1.2.2', notes: [
    'Every number now shows how it was worked out — the take-home line shows your paid hours × rate → take-home/week → monthly, so you can check it yourself.',
    'The Budget tab shows an “Updated HH:MM:SS” stamp that refreshes on every change, so you can see the numbers are live.',
    '“Money I have right now” now says plainly whether it is using your typed number or following your My Money balances, with a Clear button to go back to following your balances.',
    'Typing a bill amount or a shift meal break updates the budget right away instead of waiting until you tap away.',
    'Fixed: a number once typed in “Money I have right now” used to keep overriding your balances with no visible sign — now the source is always shown.'
  ] },
  { version: '1.2.1', notes: [
    'Savings update your budget right away — typing your saved balance or checking balance updates “You’ll have left” immediately, no tab switch needed.',
    'Phone layout — the top header no longer hides under the iPhone status bar, and the last card no longer hides behind the bottom tab bar.'
  ] },
  { version: '1.2.0', notes: [
    'Paycheck now shows every line from a real pay stub — federal tax, NY state tax, NY FLI, Social Security, Medicare, 401K, membership fee, company stock contribution, and stock purchase — each with a plain-words explanation.',
    'Use my real pay stub — enter each line from your stub once and the app uses your real rates from then on. Reset to estimates anytime.',
    'Your budget starts from the money you actually have — "Money I have right now" at the top of the Budget tab, filled in from your balances, editable in place.',
    'Installable — tap "Install app" at the top of the Budget tab to add it to your phone or PC home screen. Works offline once installed.',
    'Everyone starts blank — your numbers stay on your own device only. Nobody else sees them.'
  ] },
  { version: '1.1.1', notes: [
    "What's New actually shows the notes now — the box used to open empty.",
    'Typing a category amount no longer kicks you out of the box after each number.',
    'Bills can now be edited in place — name, amount, due date, and auto-pay — instead of delete-and-retype.',
    "Switching between Total hours and My shifts no longer wipes the tip calculator's %.",
    'New rate box says plainly to type a rate instead of showing $0.00.',
    'New: Check for updates button in the footer.',
    'Balances no longer start with a made-up date — empty until you set it.'
  ] },
  { version: '1.1.0', notes: [
    'Dark background — easier on the eyes, day and night.',
    'Bank statement import — drop in a CSV from your bank and the app fills in your balance. Nothing leaves your device, no bank login.',
    'Meal breaks count — shifts over 6 hours start with a 30-minute unpaid meal break, taken off your paid hours.',
    'Simpler to read — plain words, one main action per tab, extra details tucked behind “Show details”.',
    'Update notices — the app tells you when a new version is out, once per version.',
    'Polished on PC and phone.'
  ] },
  { version: '1.0.0', notes: [
    'First version — budget donut, paycheck calculator with tax breakdown, My Money, bills, discount finder, and calculators.'
  ] }
];

function showUpdateBanner(version, notes){
  var banner = document.getElementById('updateBanner');
  document.getElementById('updateBannerTitle').textContent = 'Budget Planner was updated to v' + version + ' — here\u2019s what changed';
  var list = document.getElementById('updateBannerNotes');
  list.innerHTML = '';
  notes.forEach(function(n){
    var li = document.createElement('li'); li.textContent = n; list.appendChild(li);
  });
  banner.hidden = false;
  banner.dataset.version = version;
}

function markUpdateSeen(version){
  try{ localStorage.setItem(UPDATE_SEEN_PREFIX + version, '1'); }catch(e){}
}

function checkForUpdate(manual){
  try{
    fetch('version.json', { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(remote){
      if(!remote || !remote.version){
        if(manual) setUpdateCheckStatus('Couldn\u2019t check — try again in a bit.');
        return;
      }
      if(compareVersions(remote.version, APP_VERSION) <= 0){
        if(manual) setUpdateCheckStatus('You\u2019re on the latest version (v' + APP_VERSION + ').');
        return;
      }
      /* a manual check always shows the banner, even if this version was seen before */
      if(!manual){
        try{ if(localStorage.getItem(UPDATE_SEEN_PREFIX + remote.version)) return; }catch(e){}
      }
      showUpdateBanner(remote.version, remote.notes || []);
      if(manual) setUpdateCheckStatus('');
    }).catch(function(){
      if(manual) setUpdateCheckStatus('Couldn\u2019t check — you may be offline.');
      /* auto check: no network / local file — fail quietly */
    });
  }catch(e){}
}

function setUpdateCheckStatus(msg){
  var el = document.getElementById('updateCheckStatus');
  if(el) el.textContent = msg || '';
}

function renderWhatsNewNotes(versions){
  var body = document.getElementById('whatsNewBody');
  body.innerHTML = '';
  versions.forEach(function(v){
    var div = document.createElement('div'); div.className = 'whatsnew-version';
    var h = document.createElement('h4'); h.textContent = 'v' + v.version + (v.version === APP_VERSION ? ' — you have this one' : '');
    div.appendChild(h);
    var ul = document.createElement('ul');
    (v.notes || []).forEach(function(n){ var li = document.createElement('li'); li.textContent = n; ul.appendChild(li); });
    div.appendChild(ul);
    body.appendChild(div);
  });
}

function openWhatsNew(){
  /* show the built-in notes IMMEDIATELY so the box is never empty, then
     swap in the full history from changelog.json when it arrives */
  renderWhatsNewNotes(CHANGELOG_FALLBACK);
  fetch('changelog.json', { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(data){
    renderWhatsNewNotes((data && data.versions) ? data.versions : CHANGELOG_FALLBACK);
  }).catch(function(){ /* keep the built-in notes */ });
  document.getElementById('whatsNewModal').hidden = false;
}

function renderBills(){
  var list = document.getElementById('billList');
  list.innerHTML = '';
  var sorted = S.bills.slice().sort(function(a, b){
    if(!a.due && !b.due) return 0;
    if(!a.due) return 1;
    if(!b.due) return -1;
    return a.due < b.due ? -1 : (a.due > b.due ? 1 : 0);
  });
  var total = 0;
  sorted.forEach(function(b){
    var idx = S.bills.indexOf(b);
    if(!b.paid) total += num(b.amount);
    var row = document.createElement('div');
    row.className = 'bill-row' + (b.paid ? ' paid' : '');
    row.innerHTML = '<label class="check"><input type="checkbox" data-bill-paid="' + idx + '"' + (b.paid ? ' checked' : '') + '> Paid</label>' +
      '<input type="text" value="' + esc(b.name) + '" data-bill-name="' + idx + '" aria-label="Bill name">' +
      '<input type="number" min="0" step="0.01" value="' + num(b.amount) + '" data-bill-amt="' + idx + '" aria-label="Bill amount">' +
      '<input type="date" value="' + esc(b.due || '') + '" data-bill-due="' + idx + '" aria-label="Bill due date">' +
      '<label class="check"><input type="checkbox" data-bill-auto="' + idx + '"' + (b.auto ? ' checked' : '') + '> Auto-pay</label>' +
      '<button class="btn-mini danger" data-bill-del="' + idx + '" type="button">Delete</button>' +
      (b.note ? '<span class="bill-note">' + esc(b.note) + '</span>' : '');
    list.appendChild(row);
  });
  document.getElementById('billsTotal').textContent = money(total);
  if(!sorted.length) list.innerHTML = '<p class="hint">No bills yet — add one above.</p>';
}

function renderDiscountsStatic(){
  var sl = document.getElementById('studentList');
  if(!sl.dataset.done){
    sl.dataset.done = '1';
    STUDENT.forEach(function(s){
      var d = document.createElement('div'); d.className = 'disc-card';
      d.innerHTML = '<h4>' + esc(s.name) + '</h4><p>' + esc(s.what) + '</p><a href="' + s.url + '" target="_blank" rel="noopener">' + esc(s.cta) + ' ↗</a>';
      sl.appendChild(d);
    });
    var cl = document.getElementById('cashbackList');
    CASHBACK.forEach(function(s){
      var d = document.createElement('div'); d.className = 'disc-card';
      d.innerHTML = '<h4>' + esc(s.name) + '</h4><p>' + esc(s.what) + '</p><a href="' + s.url + '" target="_blank" rel="noopener">' + esc(s.cta) + ' ↗</a>';
      cl.appendChild(d);
    });
  }
}

function renderDiscountCalc(){
  var r = calcDiscount(num(document.getElementById('discPrice').value), num(document.getElementById('discOne').value),
    num(document.getElementById('discTwo').value), num(document.getElementById('discCashback').value));
  var steps = 'After first discount: ' + money(r.after1) + ' · After extra discount: ' + money(r.after2);
  if(num(document.getElementById('discCashback').value) > 0) steps += ' · Cashback back: ' + money(r.cashback);
  document.getElementById('discSteps').textContent = steps;
  document.getElementById('discFinal').textContent = money(r.finalPay);
  document.getElementById('discSaved').textContent = money(r.saved);
}
/* ---------- Deal Watchlist (Discount Finder) ----------
   The user adds an item + the price they'd buy at. "Check price now"
   opens the store link; the user types the price they see and the app
   compares it to the target. The app NEVER checks a store's price by
   itself — every price here is one the user typed in. */
function fmtCheckedStamp(ts){
  if(!ts) return 'Never checked yet.';
  return 'Last checked ' + new Date(ts).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function renderWatchlist(){
  var list = document.getElementById('watchlistList');
  if(!list) return;
  list.innerHTML = '';
  if(!S.watchlist.length){
    list.innerHTML = '<p class="hint">No watched deals yet — add one above.</p>';
  }
  S.watchlist.forEach(function(item, i){
    var status = watchlistStatus(item);
    var row = document.createElement('div'); row.className = 'disc-card';
    var safeUrl = String(item.url || '').trim();
    var href = /^https?:\/\//i.test(safeUrl) ? safeUrl : ('https://' + safeUrl);
    var statusClass = status.kind === 'deal' ? 'txn-pos' : (status.kind === 'notyet' ? 'txn-neg' : '');
    var hist = item.history || [];
    var statusText = (status.kind === 'deal' ? '🎯 ' : '') + status.text;
    row.innerHTML =
      '<h4><a href="' + esc(href) + '" target="_blank" rel="noopener">' + esc(item.name || 'Item') + ' ↗</a></h4>' +
      '<p class="hint">🏪 ' + esc(item.store || 'Other') + '</p>' +
      '<p>Now: ' + (item.lastSeen !== null && item.lastSeen !== undefined && item.lastSeen !== '' ? money(item.lastSeen) : '—') +
      ' · Target: ' + money(item.target) + '</p>' +
      '<p class="result-line ' + statusClass + '">' + esc(statusText) + '</p>' +
      '<p class="hint">' + esc(fmtCheckedStamp(item.lastChecked)) + '</p>' +
      '<canvas class="mini-chart" id="wlChart' + i + '" width="300" height="64" aria-label="Price history chart"></canvas>' +
      '<p class="hint">' + (hist.length ? hist.length + ' logged price' + (hist.length === 1 ? '' : 's') + ' \u2014 the chart shows your highs and lows.' : 'Log prices over time to build a price-history chart.') + '</p>' +
      '<div class="add-row">' +
      '<input type="number" min="0" step="0.01" id="wlPrice' + i + '" placeholder="Price you see now ($)" aria-label="Price you see now">' +
      '<button class="btn-primary" data-wl-update="' + i + '" type="button">Update price</button>' +
      '<button class="btn-mini" data-wl-log="' + i + '" type="button">Log price</button>' +
      '<button class="btn-mini" data-wl-check="' + i + '" type="button">Check price now</button>' +
      '<button class="btn-mini danger" data-wl-del="' + i + '" type="button">Remove</button>' +
      '</div>';
    list.appendChild(row);
    drawPriceChart('wlChart' + i, hist);
  });
  var stamp = document.getElementById('dealsStamp');
  if(stamp) stamp.textContent = S.dealsRefreshedAt ? fmtCheckedStamp(S.dealsRefreshedAt) : 'Never refreshed yet.';
  var hint = document.getElementById('watchlistHint');
  if(hint) hint.textContent = 'Prices are ones you type in — the app never checks a store\'s price by itself.';
}
function renderCashbackEst(){
  var amt = num(document.getElementById('cbAmount').value);
  var pct = num(document.getElementById('cbPct').value);
  document.getElementById('cbOut').textContent = money(amt * pct / 100);
}

function renderCalculators(){
  var sp = calcSplit(num(document.getElementById('splitTotal').value), num(document.getElementById('splitPeople').value, 1), num(document.getElementById('splitTip').value));
  document.getElementById('splitTipOut').textContent = money(sp.tip);
  document.getElementById('splitTotalOut').textContent = money(sp.withTip);
  document.getElementById('splitEachOut').textContent = money(sp.each);
  var ua = calcUnit(num(document.getElementById('unitPriceA').value), num(document.getElementById('unitSizeA').value));
  var ub = calcUnit(num(document.getElementById('unitPriceB').value), num(document.getElementById('unitSizeB').value));
  document.getElementById('unitOutA').textContent = money(ua);
  document.getElementById('unitOutB').textContent = money(ub);
  var v = document.getElementById('unitVerdict');
  if(ua > 0 && ub > 0){
    v.textContent = ua < ub ? '✅ Size A is cheaper per unit.' : (ub < ua ? '✅ Size B is cheaper per unit.' : 'Same price per unit.');
  } else { v.textContent = ''; }
  var t = calcTip(num(document.getElementById('tipBill').value), num(document.getElementById('tipPct').value));
  document.getElementById('tipOut').textContent = money(t.tip);
  document.getElementById('tipTotalOut').textContent = money(t.total);
}

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function switchView(name){
  document.querySelectorAll('.view').forEach(function(v){ v.classList.toggle('active', v.id === 'view-' + name); });
  document.querySelectorAll('.nav-btn').forEach(function(b){ b.classList.toggle('active', b.dataset.view === name); });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function bind(){
  document.querySelectorAll('.nav-btn').forEach(function(b){
    b.addEventListener('click', function(){ switchView(b.dataset.view); });
  });
  bindEarn();
  document.getElementById('clearAllBtn').addEventListener('click', function(){
    if(confirm('Clear all your numbers? Everything you typed will be reset to the starting values.')){
      try{ localStorage.removeItem(KEY); }catch(e){}
      S = JSON.parse(JSON.stringify(DEFAULTS));
      renderAll();
    }
  });

  /* budget inputs */
  /* typing in a category updates the totals, but does NOT rebuild the list —
     rebuilding would destroy the field being typed in and steal focus */
  document.getElementById('categoryList').addEventListener('input', function(e){
    var t = e.target;
    if(t.dataset.catName !== undefined){ S.categories[+t.dataset.catName].name = t.value; }
    if(t.dataset.catAmt !== undefined){ S.categories[+t.dataset.catAmt].amount = num(t.value); }
    save(); renderBudgetSummary(); renderMyMoney();
  });
  document.getElementById('categoryList').addEventListener('click', function(e){
    var t = e.target;
    if(t.dataset.catDel !== undefined){
      S.categories.splice(+t.dataset.catDel, 1); save(); renderBudget(); renderMyMoney();
    }
  });
  document.getElementById('addCatBtn').addEventListener('click', function(){
    var name = document.getElementById('newCatName').value.trim();
    var amt = num(document.getElementById('newCatAmount').value);
    if(!name){ alert('Give the category a name first.'); return; }
    S.categories.push({ name: name, amount: amt });
    document.getElementById('newCatName').value = '';
    document.getElementById('newCatAmount').value = '';
    save(); renderBudget(); renderMyMoney();
  });
  document.getElementById('goalAmount').addEventListener('input', function(e){ S.goal = num(e.target.value); save(); renderGoal(); });
  /* Saved so far IS the savings balance the budget anchors on (same number
     as "Savings balance" in My Money) — so it must refresh the budget
     summary too, or "You'll have left" stays stale after typing here. */
  document.getElementById('savedAmount').addEventListener('input', function(e){ S.saved = num(e.target.value); save(); renderGoal(); renderMyMoney(); renderBudgetSummary(); });

  /* paycheck inputs */
  function setHours(v){ S.hours = num(v); save(); renderAll(); }
  document.getElementById('hoursSlider').addEventListener('input', function(e){ setHours(e.target.value); });
  document.getElementById('hoursInput').addEventListener('input', function(e){ setHours(e.target.value); });
  document.getElementById('hoursModeTotal').addEventListener('click', function(){ S.hoursMode = 'total'; save(); renderAll(); });
  document.getElementById('hoursModeShifts').addEventListener('click', function(){ S.hoursMode = 'shifts'; save(); renderAll(); });
  document.getElementById('addShiftBtn').addEventListener('click', function(){
    var start = document.getElementById('shiftStart').value || '09:00';
    var end = document.getElementById('shiftEnd').value || '14:00';
    S.shifts.push({ day: document.getElementById('shiftDay').value,
      start: start, end: end, meal: defaultMeal(start, end), breakMin: defaultBreak() });
    save(); renderAll();
  });
  /* shift meal: update on every keystroke — refresh just this row's math,
     the shift totals, and the paycheck outputs (no list rebuild, no focus loss) */
  document.getElementById('shiftList').addEventListener('input', function(e){
    var t = e.target;
    var isMeal = t.dataset.shiftMeal !== undefined, isBreak = t.dataset.shiftBreak !== undefined;
    if(!isMeal && !isBreak) return;
    var i = +(isMeal ? t.dataset.shiftMeal : t.dataset.shiftBreak);
    var v = Math.max(0, num(t.value));
    if(isMeal) S.shifts[i].meal = v; else S.shifts[i].breakMin = v;
    save();
    var sh = S.shifts[i];
    var len = calcShiftHours(sh.start, sh.end);
    var mNow = num(sh.meal), bNow = num(sh.breakMin);
    var paid = calcShiftPaidHours(sh.start, sh.end, mNow);
    var row = t.closest('.bill-row');
    if(row){
      var mathEl = row.querySelector('.shift-math');
      if(mathEl) mathEl.textContent = fmtHrs(len) + ' hrs, meal ' + fmtHrs(mNow) + ' min (unpaid) → paid ' + fmtHrs(paid) + ' hrs · break ' + fmtHrs(bNow) + ' min (paid)';
    }
    var totalLen = 0, totalMeal = 0, totalPaid = 0, totalBreak = 0;
    S.shifts.forEach(function(s){
      totalLen += calcShiftHours(s.start, s.end);
      totalMeal += num(s.meal);
      totalPaid += calcShiftPaidHours(s.start, s.end, s.meal);
      totalBreak += num(s.breakMin);
    });
    document.getElementById('shiftTotalOut').textContent = fmtHrs(totalPaid) + ' hrs / week';
    document.getElementById('shiftMathOut').textContent = S.shifts.length
      ? 'Shift time ' + fmtHrs(totalLen) + ' hrs total − meal ' + fmtHrs(totalMeal) + ' min total (unpaid) → paid ' + fmtHrs(totalPaid) + ' hrs · breaks ' + fmtHrs(totalBreak) + ' min total (paid).'
      : '';
    renderPaycheckOutputs(); renderMyMoney(); renderBudgetSummary();
  });
  document.getElementById('shiftList').addEventListener('change', function(e){
    var t = e.target;
    if(t.dataset.shiftMeal !== undefined){
      var m = num(t.value);
      if(m < 0) m = 0;
      S.shifts[+t.dataset.shiftMeal].meal = m;
      save(); renderAll();
    }
    if(t.dataset.shiftBreak !== undefined){
      var b = num(t.value);
      if(b < 0) b = 0;
      S.shifts[+t.dataset.shiftBreak].breakMin = b;
      save(); renderAll();
    }
  });
  document.getElementById('mealTotalInput').addEventListener('change', function(e){
    var m = num(e.target.value);
    if(m < 0) m = 0;
    S.mealTotal = m;
    save(); renderAll();
  });
  document.getElementById('breakTotalInput').addEventListener('change', function(e){
    var b = num(e.target.value);
    if(b < 0) b = 0;
    S.breakTotal = b;
    save(); renderAll();
  });
  document.getElementById('shiftList').addEventListener('click', function(e){
    var t = e.target;
    if(t.dataset.shiftDel !== undefined){ S.shifts.splice(+t.dataset.shiftDel, 1); save(); renderAll(); }
  });
  document.getElementById('rateInput').addEventListener('input', function(e){ S.rate = num(e.target.value); save(); renderAll(); });
  document.getElementById('freqSelect').addEventListener('change', function(e){ S.freq = e.target.value; save(); renderAll(); });
  document.getElementById('paydayWeekday').addEventListener('change', function(e){ S.paydayWeekday = num(e.target.value, 2); save(); renderAll(); });
  document.getElementById('lastPaydayInput').addEventListener('change', function(e){ S.lastPayday = e.target.value || ''; save(); renderAll(); });
  /* deduction profile inputs: % lines computed from gross, flat lines are $ per check */
  var dedInputMap = { ssInput: 'ss', medicareInput: 'medicare', federalInput: 'federal', nyInput: 'ny',
    fliInput: 'fli', k401Input: 'k401', memberInput: 'membership', stockContribInput: 'stockContrib', stockPurchInput: 'stockPurch' };
  Object.keys(dedInputMap).forEach(function(id){
    document.getElementById(id).addEventListener('input', function(e){
      var v = num(e.target.value);
      if(v < 0) v = 0;
      S.ded[dedInputMap[id]] = v;
      save(); renderAll();
    });
  });
  document.getElementById('extraHours').addEventListener('input', renderPaycheck);
  document.getElementById('newRate').addEventListener('input', renderPaycheck);
  /* "Use my real pay stub": read gross + every line, derive the profile, save it */
  document.getElementById('useStubBtn').addEventListener('click', function(){
    var g = num(document.getElementById('stubGross').value);
    var lines = {
      federal: num(document.getElementById('stubFederal').value),
      ny: num(document.getElementById('stubNY').value),
      fli: num(document.getElementById('stubFLI').value),
      ss: num(document.getElementById('stubSS').value),
      medicare: num(document.getElementById('stubMedicare').value),
      k401: num(document.getElementById('stubK401').value),
      membership: num(document.getElementById('stubMember').value),
      stockContrib: num(document.getElementById('stubStockContrib').value),
      stockPurch: num(document.getElementById('stubStockPurch').value)
    };
    if(g <= 0){ alert('Enter the gross pay from your pay stub first.'); return; }
    var lineTotal = 0;
    Object.keys(lines).forEach(function(k){ if(lines[k] < 0){ lines[k] = 0; } lineTotal += lines[k]; });
    if(lineTotal > g){ alert('The lines add up to more than the gross pay — check the numbers and try again.'); return; }
    S.ded = deriveDedFromStub(g, lines);
    S.stubSaved = { gross: round2(g), net: round2(g - lineTotal) };
    save(); renderAll();
  });
  document.getElementById('resetStubBtn').addEventListener('click', function(){
    S.ded = { ss: 6.2, medicare: 1.45, federal: 0, ny: 0, fli: 0, k401: 0, membership: 0, stockContrib: 0, stockPurch: 0 };
    S.stubSaved = null;
    save(); renderAll();
  });

  /* statement import */
  document.getElementById('importToggleBtn').addEventListener('click', function(){
    var panel = document.getElementById('importPanel');
    panel.hidden = !panel.hidden;
    document.getElementById('importToggleBtn').textContent = panel.hidden ? 'Import a bank statement (CSV)' : 'Hide statement import';
  });
  document.getElementById('dropZone').addEventListener('click', function(){
    document.getElementById('csvFile').click();
  });
  document.getElementById('dropZone').addEventListener('keydown', function(e){
    if(e.key === 'Enter' || e.key === ' '){ e.preventDefault(); document.getElementById('csvFile').click(); }
  });
  document.getElementById('dropZone').addEventListener('dragover', function(e){
    e.preventDefault(); document.getElementById('dropZone').classList.add('drag');
  });
  document.getElementById('dropZone').addEventListener('dragleave', function(){
    document.getElementById('dropZone').classList.remove('drag');
  });
  document.getElementById('dropZone').addEventListener('drop', function(e){
    e.preventDefault();
    document.getElementById('dropZone').classList.remove('drag');
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if(!f){ return; }
    var reader = new FileReader();
    reader.onload = function(){ handleStatementText(reader.result); };
    reader.readAsText(f);
  });
  document.getElementById('csvFile').addEventListener('change', function(e){
    var f = e.target.files && e.target.files[0];
    if(!f){ return; }
    var reader = new FileReader();
    reader.onload = function(){ handleStatementText(reader.result); };
    reader.readAsText(f);
    e.target.value = '';
  });
  document.getElementById('csvPasteBtn').addEventListener('click', function(){
    var text = document.getElementById('csvPaste').value;
    if(!text.trim()){ document.getElementById('csvStatus').textContent = 'Paste your statement text first.'; return; }
    handleStatementText(text);
  });
  document.getElementById('csvApplyBtn').addEventListener('click', applyStatement);
  document.getElementById('csvUndoBtn').addEventListener('click', undoStatement);

  /* update system */
  document.getElementById('updateNowBtn').addEventListener('click', function(){
    /* v2.0.3: never strand the user on the old build. The notice is only
       consumed once the NEW build boots (see boot check below). Wait for the
       updated service worker to activate before reloading, so the reload
       serves the new cached shell instead of the old one. */
    var v = document.getElementById('updateBanner').dataset.version || '';
    function go(){
      try{ sessionStorage.setItem('bp.update.pending', v); }catch(e){}
      location.reload();
    }
    if('serviceWorker' in navigator){
      navigator.serviceWorker.getRegistration().then(function(reg){
        if(!reg){ go(); return; }
        reg.update().then(function(){
          var sw = reg.installing || reg.waiting;
          if(sw && sw.state !== 'activated'){
            var done = false;
            sw.addEventListener('statechange', function(){
              if(!done && sw.state === 'activated'){ done = true; go(); }
            });
            setTimeout(function(){ if(!done){ done = true; go(); } }, 5000);
          } else { go(); }
        }).catch(go);
      }).catch(go);
    } else { go(); }
  });
  document.getElementById('updateLaterBtn').addEventListener('click', function(){
    var v = document.getElementById('updateBanner').dataset.version || '';
    markUpdateSeen(v);
    document.getElementById('updateBanner').hidden = true;
  });
  document.getElementById('whatsNewBtn').addEventListener('click', openWhatsNew);
  document.getElementById('checkUpdateBtn').addEventListener('click', function(){ checkForUpdate(true); });
  document.getElementById('whatsNewClose').addEventListener('click', function(){
    document.getElementById('whatsNewModal').hidden = true;
  });
  document.getElementById('whatsNewModal').addEventListener('click', function(e){
    if(e.target === document.getElementById('whatsNewModal')) document.getElementById('whatsNewModal').hidden = true;
  });
  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape' && !document.getElementById('whatsNewModal').hidden){
      document.getElementById('whatsNewModal').hidden = true;
    }
  });
  document.getElementById('savingsBalInput').addEventListener('input', function(e){ S.saved = num(e.target.value); save(); renderBudget(); renderMyMoney(); });
  /* Checking balance also feeds the budget anchor (saved + checking) —
     refresh the budget summary too, or "You'll have left" stays stale. */
  document.getElementById('checkingBalInput').addEventListener('input', function(e){ S.checking = num(e.target.value); save(); renderMyMoney(); renderBudgetSummary(); });
  document.getElementById('balanceDateInput').addEventListener('change', function(e){ S.balanceDate = e.target.value; save(); renderMyMoney(); });

  /* starting money (Budget tab anchor) — blank follows the My Money balances */
  document.getElementById('startingMoneyInput').addEventListener('input', function(e){
    var raw = e.target.value;
    if(raw === '' || raw === null){ S.startingMoney = null; }
    else { S.startingMoney = Math.max(0, num(raw)); }
    save(); renderBudgetSummary();
  });

  /* clear the override — go back to following the My Money balances */
  document.getElementById('clearStartingMoneyBtn').addEventListener('click', function(){
    S.startingMoney = null;
    save(); renderBudget();
  });

  /* bills inputs */
  document.getElementById('addBillBtn').addEventListener('click', function(){
    var name = document.getElementById('billName').value.trim();
    var amt = num(document.getElementById('billAmount').value);
    if(!name){ alert('Give the bill a name first.'); return; }
    S.bills.push({ name: name, amount: amt, due: document.getElementById('billDue').value,
      auto: document.getElementById('billAuto').checked, paid: false, note: '' });
    document.getElementById('billName').value = '';
    document.getElementById('billAmount').value = '';
    document.getElementById('billDue').value = '';
    document.getElementById('billAuto').checked = false;
    save(); renderBills(); renderMyMoney(); renderBudgetSummary();
  });
  /* bills: update on every keystroke too (the 'change' handler below still
     rebuilds the list on blur) — typing an amount must move the budget now */
  document.getElementById('billList').addEventListener('input', function(e){
    var t = e.target;
    if(t.dataset.billName !== undefined){ S.bills[+t.dataset.billName].name = t.value.trim() || 'Bill'; }
    else if(t.dataset.billAmt !== undefined){ S.bills[+t.dataset.billAmt].amount = Math.max(0, num(t.value)); }
    else if(t.dataset.billDue !== undefined){ S.bills[+t.dataset.billDue].due = t.value; }
    else return;
    save(); renderMyMoney(); renderBudgetSummary();
  });
  document.getElementById('billList').addEventListener('change', function(e){
    var t = e.target;
    if(t.dataset.billPaid !== undefined){ S.bills[+t.dataset.billPaid].paid = t.checked; }
    else if(t.dataset.billName !== undefined){ S.bills[+t.dataset.billName].name = t.value.trim() || 'Bill'; }
    else if(t.dataset.billAmt !== undefined){ S.bills[+t.dataset.billAmt].amount = Math.max(0, num(t.value)); }
    else if(t.dataset.billDue !== undefined){ S.bills[+t.dataset.billDue].due = t.value; }
    else if(t.dataset.billAuto !== undefined){ S.bills[+t.dataset.billAuto].auto = t.checked; }
    else return;
    save(); renderBills(); renderMyMoney(); renderBudgetSummary();
  });
  document.getElementById('billList').addEventListener('click', function(e){
    var t = e.target;
    if(t.dataset.billDel !== undefined){ S.bills.splice(+t.dataset.billDel, 1); save(); renderBills(); renderMyMoney(); renderBudgetSummary(); }
  });

  /* state picker: estimate mode follows the picked state */
  document.getElementById('stateSelect').addEventListener('change', function(e){
    S.stateCode = e.target.value || 'NY';
    save(); renderAll();
  });

  /* v2.0.0 employer preset */
  document.getElementById('employerSelect').addEventListener('change', function(e){
    var key = e.target.value || 'custom';
    S.employerKey = key;
    var ep = employerForKey(key);
    if(ep.rate !== null && ep.rate !== undefined) S.rate = ep.rate;
    save(); renderAll();
  });

  /* v2.0.0 stocks */
  document.getElementById('addStockBtn').addEventListener('click', function(){
    var symEl = document.getElementById('stockSym');
    var sym = symEl.value.trim().toUpperCase().replace(/[^A-Z.]/g, '');
    if(!sym){ alert('Type a ticker symbol first.'); return; }
    if(S.stocks.some(function(s){ return s.sym === sym; })){ alert(sym + ' is already on your watchlist.'); return; }
    S.stocks.push({ sym: sym, price: null, change: null, high52: null, low52: null, history: [] });
    symEl.value = ''; save(); renderStocks();
  });
  document.getElementById('stockSym').addEventListener('keydown', function(e){
    if(e.key === 'Enter') document.getElementById('addStockBtn').click();
  });
  var stockListEl = document.getElementById('stockList');
  stockListEl.addEventListener('change', function(e){
    var t = e.target, i = -1;
    if(t.dataset.stockPrice !== undefined){ i = +t.dataset.stockPrice; S.stocks[i].price = num(t.value) || null; }
    else if(t.dataset.stockChange !== undefined){ i = +t.dataset.stockChange; S.stocks[i].change = (t.value === '' ? null : num(t.value)); }
    else if(t.dataset.stockHigh !== undefined){ i = +t.dataset.stockHigh; S.stocks[i].high52 = num(t.value) || null; }
    else if(t.dataset.stockLow !== undefined){ i = +t.dataset.stockLow; S.stocks[i].low52 = num(t.value) || null; }
    else return;
    save(); renderStocks();
  });
  stockListEl.addEventListener('click', function(e){
    var t = e.target;
    if(t.dataset.stockLog !== undefined){
      var i = +t.dataset.stockLog, st = S.stocks[i], pv = num(st.price);
      if(!(pv > 0)){ alert('Type the current price first, then log it.'); return; }
      st.history.push({ d: Date.now(), p: pv });
      if(st.history.length > 90) st.history = st.history.slice(-90);
      save(); renderStocks();
    } else if(t.dataset.stockDel !== undefined){
      S.stocks.splice(+t.dataset.stockDel, 1); save(); renderStocks();
    }
  });
  document.getElementById('allocAmt').addEventListener('input', renderAlloc);

  /* v2.0.0 device sync code */
  document.getElementById('syncExportBtn').addEventListener('click', function(){
    var payload = { v: 1,
      id: 's' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36),
      ts: Date.now(), state: S };
    document.getElementById('syncCodeOut').value = syncEncode(payload);
    document.getElementById('syncCopyBtn').hidden = false;
    document.getElementById('syncStatus').textContent = 'Code generated \u2014 copy it, then paste it on your other device. Use it once.';
  });
  document.getElementById('syncCopyBtn').addEventListener('click', function(){
    var ta = document.getElementById('syncCodeOut');
    var status = document.getElementById('syncStatus');
    function done(){ status.textContent = 'Copied \u2014 paste it on your other device.'; }
    function manual(){ status.textContent = 'Copy didn\u2019t work \u2014 long-press the code to copy it manually.'; }
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(ta.value).then(done, manual);
    } else { ta.select(); try{ document.execCommand('copy'); done(); }catch(e){ manual(); } }
  });
  document.getElementById('syncImportBtn').addEventListener('click', function(){
    var raw = document.getElementById('syncCodeIn').value.trim();
    var status = document.getElementById('syncStatus');
    if(!raw){ status.textContent = 'Paste a sync code first.'; return; }
    var pl;
    try{ pl = JSON.parse(syncDecode(raw)); }
    catch(e){ status.textContent = 'That code didn\u2019t decode \u2014 check you copied the whole thing.'; return; }
    if(!pl || pl.v !== 1 || !pl.state || typeof pl.state !== 'object'){
      status.textContent = 'That doesn\u2019t look like a Budget Planner sync code.'; return;
    }
    if((S.syncUsed || []).indexOf(pl.id) >= 0){
      status.textContent = 'This code was already used on this device.'; return;
    }
    if(!window.confirm('Replace everything on this device with the synced data?')) return;
    S = pl.state;
    if(S.employerKey === undefined) S.employerKey = 'custom';
    if(!S.stocks) S.stocks = [];
    if(!S.syncUsed) S.syncUsed = [];
    S.watchlist.forEach(function(it){ if(!it.history) it.history = []; });
    S.syncUsed.push(pl.id);
    save(); renderAll();
    status.textContent = '\u2713 Synced \u2014 your numbers from the other device are now here.';
  });

  /* deal watchlist */
  document.getElementById('addWatchlistBtn').addEventListener('click', function(){
    var name = document.getElementById('wlName').value.trim();
    var url = document.getElementById('wlUrl').value.trim();
    var price = num(document.getElementById('wlPrice').value);
    var target = num(document.getElementById('wlTarget').value);
    if(!name){ alert('Give the item a name first.'); return; }
    if(!url){ alert('Paste the store link first.'); return; }
    var storeEl = document.getElementById('wlStore');
    S.watchlist.push({ name: name, store: storeEl ? storeEl.value : 'Other', url: url,
      lastSeen: price > 0 ? price : null, target: target,
      lastChecked: price > 0 ? Date.now() : null,
      history: price > 0 ? [{ d: Date.now(), p: price }] : [] });
    document.getElementById('wlName').value = '';
    document.getElementById('wlUrl').value = '';
    document.getElementById('wlPrice').value = '';
    document.getElementById('wlTarget').value = '';
    save(); renderWatchlist();
  });
  document.getElementById('watchlistList').addEventListener('click', function(e){
    var t = e.target;
    if(t.dataset.wlUpdate !== undefined){
      var i = +t.dataset.wlUpdate;
      var priceEl = document.getElementById('wlPrice' + i);
      var v = priceEl ? num(priceEl.value) : 0;
      if(v <= 0){ alert('Type the price you see on the store page first.'); return; }
      S.watchlist[i].lastSeen = v;
      S.watchlist[i].lastChecked = Date.now();
      save(); renderWatchlist();
    } else if(t.dataset.wlLog !== undefined){
      var k = +t.dataset.wlLog;
      var logEl = document.getElementById('wlPrice' + k);
      var lv = logEl ? num(logEl.value) : 0;
      if(lv <= 0){ alert('Type the price you see on the store page first.'); return; }
      if(!S.watchlist[k].history) S.watchlist[k].history = [];
      S.watchlist[k].history.push({ d: Date.now(), p: lv });
      if(S.watchlist[k].history.length > 60) S.watchlist[k].history = S.watchlist[k].history.slice(-60);
      S.watchlist[k].lastSeen = lv;
      S.watchlist[k].lastChecked = Date.now();
      save(); renderWatchlist();
    } else if(t.dataset.wlCheck !== undefined){
      var j = +t.dataset.wlCheck;
      var safeUrl = String(S.watchlist[j].url || '').trim();
      var href = /^https?:\/\//i.test(safeUrl) ? safeUrl : ('https://' + safeUrl);
      if(typeof window !== 'undefined' && typeof window.open === 'function') window.open(href, '_blank', 'noopener');
      var hint = document.getElementById('watchlistHint');
      if(hint) hint.textContent = 'Opened ' + S.watchlist[j].name + ' — type the price you see, then tap Update price.';
    } else if(t.dataset.wlDel !== undefined){
      S.watchlist.splice(+t.dataset.wlDel, 1);
      save(); renderWatchlist();
    }
  });
  document.getElementById('refreshDealsBtn').addEventListener('click', function(){
    S.dealsRefreshedAt = Date.now();
    save(); renderWatchlist();
  });
  /* discounts */
  function doDealSearch(){
    var q = document.getElementById('dealQuery').value.trim();
    if(!q){ alert('Type a store or item first.'); return; }
    var enc = encodeURIComponent(q);
    document.getElementById('dealLinks').hidden = false;
    document.getElementById('dealQueryOut').textContent = q;
    document.getElementById('dealGoogle').href = 'https://www.google.com/search?q=' + enc + '+promo+code';
    document.getElementById('dealBing').href = 'https://www.bing.com/search?q=' + enc + '+promo+code';
    document.getElementById('dealDuck').href = 'https://duckduckgo.com/?q=' + enc + '+promo+code';
    document.getElementById('dealStudent').href = 'https://www.google.com/search?q=' + enc + '+student+discount';
  }
  document.getElementById('dealSearchBtn').addEventListener('click', doDealSearch);
  document.getElementById('dealQuery').addEventListener('keydown', function(e){ if(e.key === 'Enter') doDealSearch(); });
  ['discPrice','discOne','discTwo','discCashback'].forEach(function(id){
    document.getElementById(id).addEventListener('input', renderDiscountCalc);
  });
  ['cbAmount','cbPct'].forEach(function(id){
    document.getElementById(id).addEventListener('input', renderCashbackEst);
  });

  /* calculators */
  ['splitTotal','splitPeople','splitTip'].forEach(function(id){
    document.getElementById(id).addEventListener('input', renderCalculators);
  });
  ['unitPriceA','unitSizeA','unitPriceB','unitSizeB'].forEach(function(id){
    document.getElementById(id).addEventListener('input', renderCalculators);
  });
  document.getElementById('tipBill').addEventListener('input', renderCalculators);
  document.getElementById('tipPct').addEventListener('input', renderCalculators);
  /* tip % chips only — hours-mode chips have their own handlers above, and the
     old unscoped selector used to wipe the tip % with "undefined" on mode switch */
  document.querySelectorAll('.btn-chip[data-tip]').forEach(function(b){
    b.addEventListener('click', function(){
      document.getElementById('tipPct').value = b.dataset.tip;
      document.querySelectorAll('.btn-chip[data-tip]').forEach(function(x){ x.classList.toggle('active', x === b); });
      renderCalculators();
    });
  });
  /* install button — one button at the top of the Budget tab */
  document.getElementById('installBtn').addEventListener('click', function(){
    if(deferredPrompt){
      var p = deferredPrompt;
      deferredPrompt = null;
      p.prompt();
      if(p.userChoice) p.userChoice.then(function(){ updateInstallBtn(); }).catch(function(){});
      updateInstallBtn();
    } else {
      var help = document.getElementById('installHelp');
      help.hidden = !help.hidden;
    }
  });
  document.getElementById('installHelpClose').addEventListener('click', function(){
    document.getElementById('installHelp').hidden = true;
  });
}


/* ---------- v2.0.0: price history mini chart (shared by stocks + watchlist) ---------- */
function drawPriceChart(id, hist){
  var cv = document.getElementById(id);
  if(!cv || !cv.getContext) return;
  var ctx = cv.getContext('2d'), W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);
  var ps = (hist || []).map(function(h){ return num(h.p); }).filter(function(x){ return x > 0; });
  if(ps.length < 2){
    ctx.fillStyle = '#8a949c'; ctx.font = '11px sans-serif';
    ctx.fillText('Log 2+ prices to see the chart', 8, H / 2 + 4);
    return;
  }
  var hi = Math.max.apply(null, ps), lo = Math.min.apply(null, ps), span = (hi - lo) || 1;
  var n = ps.length, slot = (W - 16) / n, bw = Math.max(2, slot - 3);
  ps.forEach(function(val, i){
    var h = 10 + (val - lo) / span * (H - 30);
    var x = 8 + i * slot;
    var up = i === 0 || val >= ps[i - 1];
    ctx.fillStyle = up ? '#7fd6a8' : '#e06c6c';
    ctx.fillRect(x, H - 8 - h, bw, h);
  });
  ctx.fillStyle = '#8a949c'; ctx.font = '10px sans-serif';
  ctx.fillText('high ' + money(hi), W - 64, 11);
  ctx.fillText('low ' + money(lo), W - 64, H - 1);
}

/* ---------- v2.0.0: stocks (educational paper-trading — prices are user-typed) ---------- */
function renderStocks(){
  var list = document.getElementById('stockList');
  if(!list) return;
  list.innerHTML = '';
  if(!S.stocks.length){
    list.innerHTML = '<p class="hint">No stocks yet \u2014 add a ticker above. Paper-trading only: prices you type, nothing real moves.</p>';
  }
  S.stocks.forEach(function(st, i){
    var row = document.createElement('div'); row.className = 'stock-card';
    var hist = st.history || [];
    row.innerHTML =
      '<h4>' + esc(String(st.sym || '').toUpperCase()) + '</h4>' +
      '<div class="add-row">' +
      '<input type="number" min="0" step="0.01" placeholder="Price you see ($)" value="' + (st.price || '') + '" data-stock-price="' + i + '" aria-label="Current price">' +
      '<input type="number" step="0.01" placeholder="Day change %" value="' + (st.change === null || st.change === undefined ? '' : st.change) + '" data-stock-change="' + i + '" aria-label="Day change percent">' +
      '</div>' +
      '<div class="add-row">' +
      '<input type="number" min="0" step="0.01" placeholder="52-wk high ($)" value="' + (st.high52 || '') + '" data-stock-high="' + i + '" aria-label="52 week high">' +
      '<input type="number" min="0" step="0.01" placeholder="52-wk low ($)" value="' + (st.low52 || '') + '" data-stock-low="' + i + '" aria-label="52 week low">' +
      '</div>' +
      '<canvas class="mini-chart" id="stockChart' + i + '" width="300" height="64" aria-label="Price history chart"></canvas>' +
      '<p class="hint">' + (hist.length ? hist.length + ' logged price' + (hist.length === 1 ? '' : 's') + ' \u2014 tap Log to add more over time.' : 'Log prices over time to build a highs/lows chart.') + '</p>' +
      '<div class="add-row">' +
      '<button class="btn-mini" data-stock-log="' + i + '" type="button">Log today\u2019s price</button>' +
      '<button class="btn-mini danger" data-stock-del="' + i + '" type="button">Remove</button>' +
      '</div>';
    list.appendChild(row);
    drawPriceChart('stockChart' + i, hist);
  });
  renderAlloc();
}

/* ---------- v2.3.0: Earn tab — dorm-friendly ways to make money ----------
   Toggles per option, realistic monthly ranges, combined total bar.
   Side income is a SEPARATE line — never folded into the pay-stub
   paycheck math (monthlyIncome() stays paycheck-derived). */
var EARN_GROUPS = [
  { name: '🧪 User testing sites',
    note: 'Tip: sign up for all — invites are sporadic.',
    options: [
      { id: 'usertesting', name: 'UserTesting', desc: '$10 per ~20-min test · up to $60+ live interviews', lo: 40, hi: 80, math: '\u22484\u20138 tests/mo' },
      { id: 'trymyui', name: 'TryMyUI (Trymata)', desc: '$10 per ~20-min test', lo: 20, hi: 40, math: '\u22482\u20134 tests/mo' },
      { id: 'userlytics', name: 'Userlytics', desc: '$5\u201390 per test', lo: 10, hi: 50, math: '\u22482 tests/mo' },
      { id: 'userinterviews', name: 'User Interviews', desc: '$50\u2013200+ per study', lo: 25, hi: 100, math: '\u22481 study every 2 mo' },
      { id: 'intellizoom', name: 'IntelliZoom (UserZoom)', desc: '$5\u201310 per test', lo: 15, hi: 30, math: '\u22483 tests/mo' },
      { id: 'userbrain', name: 'UserBrain', desc: '$3\u20135 per test', lo: 10, hi: 20, math: '\u22484 tests/mo' },
      { id: 'respondent', name: 'Respondent.io', desc: '$50\u2013200 per session', lo: 15, hi: 65, math: '\u22481 session every 3 mo' },
      { id: 'userfeel', name: 'Userfeel', desc: '$3\u201330 per test', lo: 5, hi: 30, math: '\u22482 tests/mo' },
      { id: 'testbirds', name: 'Testbirds', desc: '\u20AC10\u201350 per test', lo: 10, hi: 50, math: '\u22481 test/mo' },
      { id: 'testingtime', name: 'TestingTime', desc: '\u20AC20\u201355 per test', lo: 20, hi: 55, math: '\u22481 test/mo' },
      { id: 'betatesting', name: 'BetaTesting', desc: '$10\u2013150+ per test', lo: 10, hi: 75, math: '\u22481 test/mo' }
    ] },
  { name: '\u2699\uFE0F Microtasks & research',
    note: null,
    options: [
      { id: 'prolific', name: 'Prolific', desc: 'Academic studies — the best-paying survey site', lo: 20, hi: 60, math: null },
      { id: 'rev', name: 'Rev / TranscribeMe', desc: 'Transcription, paid per audio minute', lo: 30, hi: 80, math: null },
      { id: 'appen', name: 'Appen / Clickworker / Telus', desc: 'Data annotation tasks', lo: 20, hi: 60, math: null },
      { id: 'campusresearch', name: 'Campus research studies', desc: 'Check Plattsburgh psych department postings', lo: 10, hi: 40, math: null }
    ] },
  { name: '\uD83D\uDCBB Freelance & remote',
    note: null,
    options: [
      { id: 'va', name: 'Virtual assistant', desc: '$15\u201325/hr — email, scheduling, data entry', lo: 180, hi: 300, math: '3 hrs/wk \u00D7 $20/hr' },
      { id: 'fiverr', name: 'Fiverr / Upwork', desc: 'Freelance writing and small gigs', lo: 50, hi: 150, math: null },
      { id: 'printify', name: 'Printify', desc: 'Print-on-demand — no inventory needed', lo: 0, hi: 50, math: 'slow ramp' }
    ] },
  { name: '\uD83D\uDCB0 Sell what you know or own',
    note: null,
    options: [
      { id: 'stuvia', name: 'Stuvia / Nexus Notes', desc: 'Sell your class notes', lo: 10, hi: 40, math: null },
      { id: 'sellitems', name: 'Sell owned items', desc: 'Facebook Marketplace — meet on campus in public', lo: 20, hi: 100, math: null },
      { id: 'trackguide', name: 'Track training guide (PDF)', desc: 'Gumroad/Etsy — your own knowledge only, never promise \u201Cguaranteed\u201D results', lo: 10, hi: 60, math: null }
    ] },
  { name: '\uD83C\uDFEB Campus',
    note: null,
    options: [
      { id: 'handshake', name: 'Handshake campus job', desc: '\u2248$16\u201316.50/hr', lo: 260, hi: 300, math: '4 hrs/wk \u00D7 $16.25' },
      { id: 'coaching', name: 'Private sprint coaching', desc: '$30\u201350/hr — MUST clear with Plattsburgh athletics compliance first', lo: 240, hi: 400, math: '2 hrs/wk \u00D7 $40/hr' }
    ] },
  { name: '\uD83C\uDFAE Gaming (PC)',
    note: 'Gaming money is slow except DevEx on a game with players — treat the rest as long shots.',
    options: [
      { id: 'devex', name: 'Pet Power DevEx', desc: 'His published Roblox game — $0.0038/Robux cash-out, 30K Robux minimum (\u2248$114+). Most realistic gaming income since the game is already live.', lo: 0, hi: 100, math: '$114 per 30K Robux cash-out' },
      { id: 'betatesting-game', name: 'BetaTesting — game tests', desc: '$10\u2013150+ per game playtest (game tests appear here too)', lo: 10, hi: 75, math: '\u22481 test/mo' },
      { id: 'remoteqa', name: 'Remote game QA', desc: 'Lionbridge, Keywords Studios — real jobs, usually want experience', lo: 0, hi: 150, math: null },
      { id: 'streaming', name: 'Streaming', desc: 'Twitch/YouTube/TikTok — honest note: $0 for a long while, needs a consistent schedule', lo: 0, hi: 25, math: null },
      { id: 'gamecoaching', name: 'Game coaching', desc: 'Metafy, Gamer Sensei — $10\u201330/hr, only if high-ranked in a popular game', lo: 0, hi: 120, math: '2 hrs/wk \u00D7 $20/hr' },
      { id: 'tournaments', name: 'Small tournaments', desc: 'Battlefy, Challengermode — small prize pools, needs real skill', lo: 0, hi: 40, math: null }
    ] }
];

function earnFind(id){
  for(var g = 0; g < EARN_GROUPS.length; g++){
    for(var i = 0; i < EARN_GROUPS[g].options.length; i++){
      if(EARN_GROUPS[g].options[i].id === id) return EARN_GROUPS[g].options[i];
    }
  }
  return null;
}
function earnTotals(){
  var lo = 0, hi = 0, n = 0;
  Object.keys(S.earn || {}).forEach(function(id){
    if(!S.earn[id]) return;
    var o = earnFind(id);
    if(o){ lo += o.lo; hi += o.hi; n++; }
  });
  return { lo: lo, hi: hi, n: n, mid: Math.round((lo + hi) / 2) };
}
function renderEarn(){
  var host = document.getElementById('earnGroups');
  if(!host) return;
  host.innerHTML = '';
  EARN_GROUPS.forEach(function(g){
    var div = document.createElement('div');
    div.className = 'card earn-group';
    var html = '<h3>' + g.name + '</h3>';
    if(g.note) html += '<p class="earn-group-note">' + g.note + '</p>';
    g.options.forEach(function(o){
      var on = !!(S.earn && S.earn[o.id]);
      html += '<div class="earn-row">' +
        '<div class="earn-info"><div class="earn-name">' + o.name + '</div>' +
        '<div class="earn-desc">' + o.desc + '</div></div>' +
        '<div class="earn-est">$' + o.lo + '\u2013$' + o.hi + '/mo' +
        (o.math ? '<span class="earn-math">' + o.math + '</span>' : '') + '</div>' +
        '<label class="earn-switch"><input type="checkbox" data-earn-toggle="' + o.id + '"' +
        (on ? ' checked' : '') + ' aria-label="I\u2019m doing this: ' + o.name + '">' +
        '<span class="track"></span><span class="thumb"></span></label>' +
        '</div>';
    });
    div.innerHTML = html;
    host.appendChild(div);
  });
  host.querySelectorAll('[data-earn-toggle]').forEach(function(cb){
    cb.addEventListener('change', function(){
      S.earn[cb.getAttribute('data-earn-toggle')] = cb.checked;
      save(); updateEarnTotal();
    });
  });
  updateEarnTotal();
}
function updateEarnTotal(){
  var t = earnTotals();
  var el = document.getElementById('earnTotalNum');
  if(el) el.textContent = '$' + t.lo + '\u2013$' + t.hi + ' / month';
  var note = document.getElementById('earnAddedNote');
  var amt = document.getElementById('earnAddedAmt');
  if(note && amt){
    if(S.earnAdded > 0){ note.hidden = false; amt.textContent = money(S.earnAdded); }
    else note.hidden = true;
  }
  /* Budget tab side-income line — display only, never touches paycheck math */
  var line = document.getElementById('earnLine');
  var lineAmt = document.getElementById('earnLineAmt');
  if(line && lineAmt){
    if(S.earnAdded > 0){ line.hidden = false; setMoneyText(lineAmt, S.earnAdded); }
    else line.hidden = true;
  }
}
function bindEarn(){
  var btn = document.getElementById('earnAddBtn');
  if(btn && !btn._earnBound){
    btn._earnBound = true;
    btn.addEventListener('click', function(){
      var t = earnTotals();
      if(t.n === 0){
        btn.textContent = 'Toggle something first';
        setTimeout(function(){ btn.textContent = 'Add to my monthly income'; }, 1600);
        return;
      }
      /* No standalone monthly-income input exists (income is paycheck-derived),
         so the midpoint is stored as a separate side-income line. */
      S.earnAdded = t.mid;
      save(); updateEarnTotal();
      btn.textContent = '\u2713 Added ' + money(t.mid) + '/mo';
      setTimeout(function(){ btn.textContent = 'Add to my monthly income'; }, 2000);
    });
  }
}

function renderAlloc(){
  var out = document.getElementById('allocOut');
  if(!out) return;
  var amt = num(document.getElementById('allocAmt').value);
  var base = num(S.saved) + num(S.checking);
  if(!(amt > 0)){ out.textContent = 'Type an amount to see what share of your savings that is.'; return; }
  if(!(base > 0)){ out.textContent = 'Add your savings balance in My Money first \u2014 then this shows the share.'; return; }
  var pct = Math.round(amt / base * 1000) / 10;
  out.textContent = money(amt) + ' is ' + pct + '% of your ' + money(base) + ' savings. That leaves ' + money(base - amt) + ' untouched.';
}

bind();
renderAll();
/* pre-fill What's New so the box is never empty, even before any fetch runs */
renderWhatsNewNotes(CHANGELOG_FALLBACK);

/* PWA install: capture the browser's install prompt so the Install button can
   show it. If the browser never fires it (e.g. iPhone Safari), the button shows
   plain instructions instead. If already installed, the button says so. */
var deferredPrompt = null;
function isStandalone(){
  try{ return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || !!window.navigator.standalone; }
  catch(e){ return false; }
}
function updateInstallBtn(){
  /* v2.0.2: when the app is installed, the whole install area hides —
     the prompt only shows on the web. */
  var row = document.getElementById('installRow');
  var btn = document.getElementById('installBtn');
  if(!btn) return;
  if(isStandalone()){
    if(row) row.hidden = true;
    var help = document.getElementById('installHelp');
    if(help) help.hidden = true;
  } else {
    if(row) row.hidden = false;
    btn.textContent = 'Install app';
    btn.disabled = false;
  }
}
window.addEventListener('beforeinstallprompt', function(e){
  e.preventDefault();
  deferredPrompt = e;
  updateInstallBtn();
});
window.addEventListener('appinstalled', function(){
  deferredPrompt = null;
  updateInstallBtn();
});
updateInstallBtn();

/* service worker: cache the app shell so it loads offline once installed.
   Registration is best-effort — if it fails, the app still works fully online. */
if('serviceWorker' in navigator && window.location.protocol !== 'file:'){
  navigator.serviceWorker.register('sw.js').catch(function(){});
}
(function(){
  /* v2.0.3: every visible version string is written at runtime from APP_VERSION */
  var vf = document.getElementById('appVersionFoot');
  if(vf) vf.textContent = 'v' + APP_VERSION;
  try{
    var pend = sessionStorage.getItem('bp.update.pending');
    if(pend && pend === APP_VERSION){
      markUpdateSeen(APP_VERSION);
      sessionStorage.removeItem('bp.update.pending');
    }
  }catch(e){}
})();
checkForUpdate(false);
}
