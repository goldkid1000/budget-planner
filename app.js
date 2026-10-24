/* Budget Planner v2.4.0 — all data stays in localStorage on this device. */
'use strict';

var APP_VERSION = '2.18.0';

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
/* v2.7.0: exact durations — integer minutes between two "HH:MM" times
   (overnight rolls past midnight, same rule as calcShiftHours) */
function exactMinutes(startStr, endStr){
  var s = toMinutes(startStr), e = toMinutes(endStr);
  if(e <= s) e += 1440;
  return e - s;
}
/* "50 min" / "1 hr" / "1 hr 20 min" / "2 hrs" */
function fmtMinutes(mins){
  var m = Math.round(num0(mins));
  if(m < 0) m = 0;
  var h = Math.floor(m / 60), r = m % 60;
  if(h === 0) return m + ' min';
  var hs = h + (h === 1 ? ' hr' : ' hrs');
  return r === 0 ? hs : hs + ' ' + r + ' min';
}
/* exact hours, 2 decimals trimmed: 0.83, 4.5, 7.5 */
function fmtHrsExact(h){
  var v = Number(h); if(!isFinite(v)) v = 0;
  return String(Math.round(v * 100) / 100);
}
/* minutes since midnight -> "HH:MM" */
function minsToHHMM(mins){
  var m = Math.round(num0(mins));
  if(m < 0) m = 0; if(m > 1439) m = 1439;
  var h = Math.floor(m / 60), r = m % 60;
  return (h < 10 ? '0' : '') + h + ':' + (r < 10 ? '0' : '') + r;
}
/* v2.14.0: the ✨ Suggest weekly target is typeable, not just the
   12 / 16 / 20 chips — any value from 2 to 30 paid hrs, rounded to
   the nearest half hour. Returns null for anything unusable so
   callers fall back to the last valid target (default 16). */
function normSuggestTarget(v){
  var n = parseFloat(v);
  if(!isFinite(n)) return null;
  n = Math.round(n * 2) / 2;
  if(n < 2) n = 2;
  if(n > 30) n = 30;
  return n;
}
/* v2.8.0: "Suggest my work hours" — pure week planner. Fits work
   shifts around his schedule inside a 07:00–22:00 window: Sundays and
   Meet-tagged days stay off, every entry keeps a 30-minute buffer on
   both sides, shifts run 2–6 hrs in 30-min steps placed at the start
   of the day's longest free stretch, and two passes spread the paid
   target across Mon–Sat (up to 4 hrs each first, then top up to each
   day's capacity). Deterministic — no clock, no randomness — so the
   same week always gets the same suggestion.
   v2.9.0: the entries are classes AND practices (any timed schedule
   entry blocks time the same way — kind never reaches this function).
   v2.10.0: busy-day guard — a 4th argument, busyThresholdHrs
   (4 / 5 / 6, default 5). A day whose merged scheduled load
   (classes, practices + workouts) reaches the cutoff is BUSY:
   no work is suggested on it.
   v2.14.0: a day with NOTHING scheduled at all starts its shift
   at 10:00 instead of the 07:00 window open (EMPTY_DAY_START) —
   days with entries keep start-of-longest-free-interval.
   classes: [{ days:[Mon=0..Sun=6], s:'HH:MM', e:'HH:MM' }];
   schoolTags: [[tag,...] ×7]. Returns { days: [{s,e,paid}|null ×7],
   totalPaid, capacity (hrs), shortfall (hrs vs the target),
   dayInfo: [{ state, scheduledMinutes } ×7] }. */
function suggestWorkWeek(classes, schoolTags, targetHours, busyThresholdHrs){
  var WIN_S = 420, WIN_E = 1320, BUF = 30, STEP = 30;
  var EMPTY_DAY_START = 600; /* v2.14.0: 10:00 for entry-free days */
  var MIN_LEN = 120, MAX_LEN = 360, PASS1_CAP = 240;
  var targetMin = Math.max(0, Math.round(num0(targetHours) * 60 / STEP) * STEP);
  var threshHrs = [4, 5, 6].indexOf(+busyThresholdHrs) >= 0 ? +busyThresholdHrs : 5;
  var threshMin = threshHrs * 60;
  var list = Array.isArray(classes) ? classes : [];
  var tags = Array.isArray(schoolTags) ? schoolTags : [];
  /* v2.10.0: scheduled load per day — every entry that day with
     overlapping blocks merged; NO buffer and NO window cap for this
     measurement, so a 7–9 PM practice counts its full 2 hours. */
  function dayBlocks(d){
    var blocks = [];
    list.forEach(function(c){
      if(!c || !Array.isArray(c.days) || c.days.indexOf(d) === -1) return;
      var s = toMinutes(c.s), e = toMinutes(c.e);
      if(e <= s) e += 1440;
      if(s < e) blocks.push([s, e]);
    });
    blocks.sort(function(a, b){ return a[0] - b[0] || a[1] - b[1]; });
    var merged = [];
    blocks.forEach(function(b){
      var last = merged[merged.length - 1];
      if(last && b[0] <= last[1]){ if(b[1] > last[1]) last[1] = b[1]; }
      else merged.push([b[0], b[1]]);
    });
    return merged;
  }
  var schedMin = [], dayStates = [];
  for(var sd = 0; sd < 7; sd++){
    var sm = 0;
    dayBlocks(sd).forEach(function(b){ sm += b[1] - b[0]; });
    schedMin.push(sm);
    dayStates.push('off');
  }
  var caps = [], starts = [];
  for(var d = 0; d < 7; d++){
    caps.push(0); starts.push(-1);
    if(d === 6){ dayStates[d] = 'sunday'; continue; } /* Sundays always off */
    var dayTags = Array.isArray(tags[d]) ? tags[d] : [];
    if(dayTags.indexOf('meet') >= 0){ dayStates[d] = 'meet'; continue; } /* Meet days off */
    if(schedMin[d] >= threshMin){ dayStates[d] = 'busy'; continue; } /* busy-day guard */
    /* this day's blocks, ends capped at the window end so a late
       class can't leak past 22:00 */
    var rawBlocks = dayBlocks(d);
    var merged = rawBlocks.map(function(b){
      return [b[0], Math.min(b[1], WIN_E)];
    }).filter(function(b){ return b[0] < b[1]; });
    /* buffer both sides: work starts ≥30 min after a class ends and
       ends ≥30 min before the next one starts */
    var blocked = merged.map(function(b){
      return [Math.max(WIN_S, b[0] - BUF), Math.min(WIN_E, b[1] + BUF)];
    });
    /* free intervals = window minus blocked; the shift takes the
       longest one and starts at its start */
    var free = [], cur = WIN_S;
    blocked.forEach(function(b){
      if(b[0] > cur) free.push([cur, b[0]]);
      if(b[1] > cur) cur = b[1];
    });
    if(cur < WIN_E) free.push([cur, WIN_E]);
    var bestStart = -1, bestLen = 0;
    free.forEach(function(f){
      var len = Math.floor((f[1] - f[0]) / STEP) * STEP;
      if(len > bestLen){ bestLen = len; bestStart = f[0]; }
    });
    if(bestLen >= MIN_LEN){
      caps[d] = Math.min(MAX_LEN, bestLen);
      starts[d] = bestStart;
      /* v2.14.0: a day with no entries at all (its free interval is
         the whole window) starts at 10:00, not 07:00 — an empty
         Saturday shouldn't default to a 7 AM shift */
      if(rawBlocks.length === 0) starts[d] = EMPTY_DAY_START;
    }
  }
  var capacityMin = 0;
  caps.forEach(function(c){ capacityMin += c; });
  /* Pass 1: up to 4h per workable day. Pass 2: top up to capacity. */
  var alloc = [0, 0, 0, 0, 0, 0, 0], remaining = targetMin;
  for(var p = 0; p < 2 && remaining > 0; p++){
    for(var i = 0; i < 6 && remaining > 0; i++){
      if(caps[i] <= 0) continue;
      var room = (p === 0 ? Math.min(PASS1_CAP, caps[i]) : caps[i]) - alloc[i];
      if(room <= 0) continue;
      var give = Math.min(room, remaining);
      alloc[i] += give; remaining -= give;
    }
  }
  /* paid hours for a block, same meal rule as calcShiftPaidHours with
     defaultMeal (30 min unpaid over 6 hrs) — unreachable at the 6-hr
     cap, but coded so the rule stays consistent everywhere */
  function paidFor(lenMin){
    var meal = lenMin > 360 ? 30 : 0;
    var paid = lenMin - meal;
    return paid > 0 ? paid / 60 : 0;
  }
  var days = [], totalPaid = 0;
  for(var j = 0; j < 7; j++){
    if(alloc[j] > 0){
      var paid = paidFor(alloc[j]);
      days.push({ s: minsToHHMM(starts[j]), e: minsToHHMM(starts[j] + alloc[j]), paid: paid });
      totalPaid += paid;
    } else days.push(null);
  }
  var dayInfo = [];
  for(var k = 0; k < 7; k++){
    if(alloc[k] > 0) dayStates[k] = 'work';
    dayInfo.push({ state: dayStates[k], scheduledMinutes: schedMin[k] });
  }
  return { days: days, totalPaid: totalPaid, capacity: capacityMin / 60,
           shortfall: Math.max(0, num0(targetHours) - totalPaid),
           dayInfo: dayInfo };
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
/* v2.12.0: sanitize a Work Log week's stored pay breakdown (built by
   wlPayBreakdown in the app section from one calcPaycheck run). Returns
   null for anything unusable so the renderer can fall back to computing
   the breakdown live from the week's logged hours. */
function wlNormPay(v){
  if(!v || typeof v !== 'object' || Array.isArray(v)) return null;
  function lines(a){
    if(!Array.isArray(a) || !a.length) return null;
    var out = [];
    for(var i = 0; i < a.length; i++){
      var l = a[i];
      if(!l || typeof l.label !== 'string' || !l.label) return null;
      out.push({ label: l.label, amt: round2(num0(l.amt)) });
    }
    return out;
  }
  var taxes = lines(v.taxes), deductions = lines(v.deductions);
  if(!taxes || !deductions) return null;
  return { gross: round2(num0(v.gross)), regHrs: num0(v.regHrs),
           otHrs: num0(v.otHrs), otAmt: round2(num0(v.otAmt)),
           taxes: taxes, taxesTotal: round2(num0(v.taxesTotal)),
           deductions: deductions, dedTotal: round2(num0(v.dedTotal)),
           totalTaken: round2(num0(v.totalTaken)), net: round2(num0(v.net)),
           estimate: !!v.estimate };
}
/* v2.18.0: add whole months without overflowing into the month after.
   Plain setMonth() rolls over: Oct 31 + 1 month lands on Dec 1 (there is
   no Nov 31), so a goal checked on the 29th–31st showed a month late and
   a monthly payday on the 31st skipped February entirely. Clamp to the
   last day of the target month instead, keeping the anchor day whenever
   the target month has it. Pure date math; no state. */
function addMonthsClamped(fromDate, months){
  var d = new Date(fromDate.getFullYear(), fromDate.getMonth(), fromDate.getDate(), 12);
  var day = d.getDate();
  var target = new Date(d.getFullYear(), d.getMonth() + months, 1, 12);
  var lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate();
  target.setDate(Math.min(day, lastDay));
  return target;
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
    var date = addMonthsClamped(new Date(), months);
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
    deriveDedFromStub: deriveDedFromStub, wlNormPay: wlNormPay,
    calcShiftHours: calcShiftHours, calcShiftPaidHours: calcShiftPaidHours, defaultMeal: defaultMeal,
    toMinutes: toMinutes, compareVersions: compareVersions, parseStatementCSV: parseStatementCSV,
    calcDiscount: calcDiscount, calcSplit: calcSplit, calcUnit: calcUnit, calcTip: calcTip,
    calcBracketTax: calcBracketTax, calcEstimateTaxes: calcEstimateTaxes,
    calcGoalProjection: calcGoalProjection, addMonthsClamped: addMonthsClamped, watchlistStatus: watchlistStatus, employerForKey: employerForKey, syncEncode: syncEncode, syncDecode: syncDecode,
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
  earnAdded: 0,
  /* v2.5.0: Possible Hours planner — two saved weeks (school / break),
     7 numbers each, Mon..Sun hours he COULD work (what-if, not actuals) */
  planHours: { term: 'school',
               school: [0, 0, 0, 0, 0, 0, 0],
               break:  [0, 0, 0, 0, 0, 0, 0],
               /* v2.6.0: school day tags (per day: 'class' | 'practice' |
                  'meet' — v2.11.0 adds 'workout'), last school-week
                  template applied, the break
                  being built in the Break Calendar, and saved breaks
                  ({ id, name, start, end, days: { 'YYYY-MM-DD': hours } }) */
               schoolTags: [[], [], [], [], [], [], []],
               weekType: 'normal',
               breakCal: { id: null, name: '', start: '', end: '', days: {}, selected: '' },
               savedBreaks: [],
               /* v2.6.1: optional per-day shift times ({ s, e } 'HH:MM')
                  for both plan weeks + per-date times in the calendar.
                  When both are set, the day's hours fill from the shift
                  length with the Paycheck tab's meal rule. */
               schoolTimes: [{s:'',e:''},{s:'',e:''},{s:'',e:''},{s:'',e:''},{s:'',e:''},{s:'',e:''},{s:'',e:''}],
               breakTimes:  [{s:'',e:''},{s:'',e:''},{s:'',e:''},{s:'',e:''},{s:'',e:''},{s:'',e:''},{s:'',e:''}],
               /* v2.8.0: ✨ Suggest-my-work-hours weekly target (paid
                  hrs) — picked with chips in the Class Schedule card.
                  v2.14.0: also typeable — any 2–30 hrs in half-hour
                  steps (normSuggestTarget), not just 12 / 16 / 20 */
               suggestTarget: 16,
               /* v2.10.0: busy-day guard cutoff (scheduled hrs of
                  class + practice at/above which Suggest puts no
                  work on that day) — one of 4 / 5 / 6 */
               busyThresholdHrs: 5,
               /* v2.11.0: which tab of the schedule builder is open —
                  'class' | 'practice' | 'workout'; the tab fixes the
                  kind of the entry being added */
               schedTab: 'class' },
  /* v2.16.0: 😴 Sleep schedule — when wake + lights-out are set, the
     athlete guardrail judges a plan by the user's real sleep window
     (and his wind-down after work), not by hours alone. Blank wake or
     bed = not configured; the planner falls back to the plain
     hours-based caution. Defaults are EMPTY/generic on purpose. */
  sleep: { wake: '', bed: '', goalHrs: 8, windDownMin: 90 },
  /* v2.6.1: Work Log — weeks he ACTUALLY worked, saved to look back on.
     Entries: { id, week (Monday 'YYYY-MM-DD'), days [7], times [7 {s,e}],
     total, gross, net } — pay frozen at save time via planScenarioPaycheck. */
  workLog: [],
  wlDraft: { week: '',
             days: [0, 0, 0, 0, 0, 0, 0],
             times: [{s:'',e:''},{s:'',e:''},{s:'',e:''},{s:'',e:''},{s:'',e:''},{s:'',e:''},{s:'',e:''}] },
  /* v2.7.0: Class Schedule — every class he takes, planned against
     work. Entries: { id, name, days [Mon=0..Sun=6], s, e ('HH:MM') }.
     Class durations are exact to the minute — the meal deduction is a
     paid-work rule and never applies to a class. */
  classes: []
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
function normTimePair(v){
  function ok(s){ return typeof s === 'string' && /^\d{2}:\d{2}$/.test(s) ? s : ''; }
  if(!v || typeof v !== 'object') return { s: '', e: '' };
  return { s: ok(v.s), e: ok(v.e) };
}

function normWeekTimes(v){
  var out = [];
  for(var i = 0; i < 7; i++) out.push(normTimePair(Array.isArray(v) ? v[i] : null));
  return out;
}

function normSleep(v){
  function okTime(s){ return typeof s === 'string' && /^\d{2}:\d{2}$/.test(s) ? s : ''; }
  if(!v || typeof v !== 'object') v = {};
  var g = parseFloat(v.goalHrs); if(!isFinite(g)) g = 8;
  g = Math.min(12, Math.max(5, g));
  var w = Math.round(parseFloat(v.windDownMin)); if(!isFinite(w)) w = 90;
  w = Math.min(240, Math.max(0, w));
  return { wake: okTime(v.wake), bed: okTime(v.bed), goalHrs: g, windDownMin: w };
}

function newClassId(){
  return 'cl' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36);
}

function normClasses(v){
  if(!Array.isArray(v)) return [];
  var out = [];
  v.forEach(function(c){
    if(!c || typeof c !== 'object') return;
    var name = typeof c.name === 'string' ? c.name.trim() : '';
    if(!name) return;
    var days = [];
    (Array.isArray(c.days) ? c.days : []).forEach(function(d){
      var n = parseInt(d, 10);
      if(isFinite(n) && n >= 0 && n <= 6 && days.indexOf(n) === -1) days.push(n);
    });
    if(!days.length) return;
    days.sort(function(a, b){ return a - b; });
    var pair = normTimePair({ s: c.s, e: c.e });
    if(!pair.s || !pair.e) return;
    out.push({ id: (typeof c.id === 'string' && c.id) ? c.id : newClassId(),
               kind: ['class', 'practice', 'workout'].indexOf(c.kind) >= 0 ? c.kind : 'class',
               name: name, days: days, s: pair.s, e: pair.e });
  });
  return out;
}

function normalizeState(){
  /* v2.17.0: ONE normalization for first load AND sync import.
     An imported state may predate any field below (planner, Work
     Log, sleep schedule, ded split...) — every piece is backfilled
     here so both paths always land on the same complete shape. */
  if(!Array.isArray(S.categories)) S.categories = [];
  if(!Array.isArray(S.bills)) S.bills = [];
/* fill in fields added in later versions so old saved data keeps working */
if(!S.ded) S.ded = { ss: 6.2, medicare: 1.45, federal: 0, ny: 0, fli: 0, k401: 0, membership: 0, stockContrib: 0, stockPurch: 0 };
/* v2.3.0: Earn tab state */
if(!S.earn || typeof S.earn !== 'object') S.earn = {};
if(S.earnAdded === undefined || S.earnAdded === null) S.earnAdded = 0;
/* v2.5.0: Possible Hours planner state — backfill + normalize to 7 days */
if(!S.planHours || !Array.isArray(S.planHours.school) || !Array.isArray(S.planHours.break)){
  S.planHours = JSON.parse(JSON.stringify(DEFAULTS.planHours));
}
if(S.planHours.term !== 'break') S.planHours.term = 'school';
['school', 'break'].forEach(function(t){
  var a = S.planHours[t].slice(0, 7);
  while(a.length < 7) a.push(0);
  S.planHours[t] = a.map(function(v){ var n = num(v); return n > 0 ? n : 0; });
});
/* v2.6.0: backfill + normalize tags / week type / break calendar state */
(function(){
  var ph = S.planHours, VALID_TAGS = ['class', 'practice', 'workout', 'meet'];
  var rawTags = Array.isArray(ph.schoolTags) ? ph.schoolTags : [];
  var normTags = [];
  for(var ti = 0; ti < 7; ti++){
    var src = Array.isArray(rawTags[ti]) ? rawTags[ti] : [];
    normTags.push(src.filter(function(t, ix){ return VALID_TAGS.indexOf(t) >= 0 && src.indexOf(t) === ix; }));
  }
  ph.schoolTags = normTags;
  if(['normal', 'meet', 'exam'].indexOf(ph.weekType) < 0) ph.weekType = 'normal';
  if(!ph.breakCal || typeof ph.breakCal !== 'object'){
    ph.breakCal = { id: null, name: '', start: '', end: '', days: {}, selected: '' };
  }
  var bc = ph.breakCal;
  if(bc.id === undefined) bc.id = null;
  if(typeof bc.name !== 'string') bc.name = '';
  if(typeof bc.start !== 'string') bc.start = '';
  if(typeof bc.end !== 'string') bc.end = '';
  if(!bc.days || typeof bc.days !== 'object' || Array.isArray(bc.days)) bc.days = {};
  if(typeof bc.selected !== 'string') bc.selected = '';
  if(!Array.isArray(ph.savedBreaks)) ph.savedBreaks = [];
  ph.savedBreaks = ph.savedBreaks.filter(function(b){
    return b && typeof b.start === 'string' && typeof b.end === 'string' &&
           b.days && typeof b.days === 'object' && !Array.isArray(b.days);
  }).map(function(b){
    return { id: b.id || ('bk' + String(b.start) + String(b.end)),
             name: typeof b.name === 'string' ? b.name : '',
             start: b.start, end: b.end, days: b.days,
             times: (b.times && typeof b.times === 'object' && !Array.isArray(b.times)) ? b.times : {} };
  });
})();
/* v2.6.1: backfill per-day shift times (planner weeks + break calendar)
   and the Work Log. Old saves without any of these load untouched —
   times simply start blank and hours stay exactly as they were. */
/* v2.16.0: 😴 sleep schedule — times must be real 'HH:MM' strings or
   blank (= not configured); goal clamps to 5–12 hrs (default 8),
   wind-down to 0–240 min (default 90). Anything unusable falls back
   to the default, so old saves without a sleep block load cleanly. */
(function(){
  var ph = S.planHours;
  ph.schoolTimes = normWeekTimes(ph.schoolTimes);
  ph.breakTimes = normWeekTimes(ph.breakTimes);
  /* v2.16.0: 😴 sleep schedule backfill + normalize */
  S.sleep = normSleep(S.sleep);
  /* v2.8.0: suggest-my-work-hours target. v2.14.0: any 2–30 hrs in
     half-hour steps (typed or chipped); unusable → default 16 */
  var nst = normSuggestTarget(ph.suggestTarget);
  ph.suggestTarget = nst === null ? 16 : nst;
  /* v2.10.0: busy-day guard cutoff — 4, 5 or 6, else 5 */
  if([4, 5, 6].indexOf(ph.busyThresholdHrs) === -1) ph.busyThresholdHrs = 5;
  /* v2.11.0: schedule builder tab — class / practice / workout */
  if(['class', 'practice', 'workout'].indexOf(ph.schedTab) === -1) ph.schedTab = 'class';
  if(!ph.breakCal.times || typeof ph.breakCal.times !== 'object' || Array.isArray(ph.breakCal.times)) ph.breakCal.times = {};
  Object.keys(ph.breakCal.times).forEach(function(k){ ph.breakCal.times[k] = normTimePair(ph.breakCal.times[k]); });
  if(!Array.isArray(S.workLog)) S.workLog = [];
  S.workLog = S.workLog.filter(function(w){
    return w && typeof w.week === 'string' && Array.isArray(w.days);
  }).map(function(w){
    var days = [];
    for(var i = 0; i < 7; i++){ var n = num(w.days[i]); days.push(n > 0 ? Math.min(12, n) : 0); }
    return { id: w.id || ('wl' + w.week), week: w.week, days: days,
             times: normWeekTimes(w.times),
             total: num(w.total) || days.reduce(function(a, v){ return a + v; }, 0),
             gross: num(w.gross), net: num(w.net),
             /* v2.12.0: the week's full pay breakdown, when saved */
             pay: wlNormPay(w.pay) };
  });
  if(!S.wlDraft || typeof S.wlDraft !== 'object') S.wlDraft = JSON.parse(JSON.stringify(DEFAULTS.wlDraft));
  if(typeof S.wlDraft.week !== 'string') S.wlDraft.week = '';
  var dd = [];
  for(var j = 0; j < 7; j++){ var dn = num((S.wlDraft.days || [])[j]); dd.push(dn > 0 ? Math.min(12, dn) : 0); }
  S.wlDraft.days = dd;
  S.wlDraft.times = normWeekTimes(S.wlDraft.times);
})();
/* v2.7.0: Class Schedule backfill + normalize. Malformed entries are
   dropped, days deduped + sorted, times must be real HH:MM pairs.
   v2.9.0: entries carry a kind — 'class' or 'practice'. Anything
   missing or not exactly 'practice' becomes 'class', so schedules
   saved before practices existed load unchanged. This one function
   serves BOTH normalize paths: the load-time backfill below and the
   sync-import guard.
   v2.11.0: 'workout' is a third valid kind; anything that isn't
   exactly 'class', 'practice' or 'workout' still becomes 'class'. */
S.classes = normClasses(S.classes);
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
}
normalizeState();

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
  /* monthly: same calendar date next month, rolling forward while past.
     Stepped from the anchor (not from the previous candidate) so a 31st
     payday clamps to Feb 28 and comes back to Mar 31 instead of skipping
     February — see addMonthsClamped. */
  var t2 = atNoon(today);
  var steps = 1, m = addMonthsClamped(anchor, steps);
  while(m <= t2){ steps++; m = addMonthsClamped(anchor, steps); }
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

/* ---------- v2.5.0: Possible Hours planner ----------
   A what-if week: hours he COULD work each day around school and track.
   Pay previews run through the SAME calcPaycheck pipeline as the real
   Paycheck tab (same rate, same deduction profile, same estimate/stub
   mode) — forced to weekly, since the planner is a single week. */
var PLAN_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
var PLAN_DAY_FULL = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/* one-tap scenarios: arrays are Mon..Sun. Sundays stay 0 in every preset. */
var PLAN_PRESETS = {
  light:   { label: 'Light',   term: 'school', days: [3, 0, 3, 0, 3, 3, 0] },
  typical: { label: 'Typical', term: 'school', days: [4, 0, 4, 0, 4, 4, 0] },
  max:     { label: 'Max',     term: 'school', days: [4, 4, 4, 4, 4, 0, 0] },
  breakwk: { label: 'Break week', term: 'break', days: [6, 6, 6, 6, 4, 0, 0] }
};
function planScenarioPaycheck(hours){
  if(!S.stubSaved) return calcPaycheck(hours, S.rate, S.ded, 'weekly', { stateCode: S.stateCode || 'NY' });
  return calcPaycheck(hours, S.rate, S.ded, 'weekly');
}
function planTotal(days){
  return days.reduce(function(a, v){ return a + num(v); }, 0);
}
function planTermDays(){
  return S.planHours[S.planHours.term === 'break' ? 'break' : 'school'];
}
function fmtPlanHrs(h){
  var n = Math.round(num(h) * 10) / 10;
  return (n % 1 === 0 ? String(n) : n.toFixed(1)) + 'h';
}
/* ---------- v2.6.1: type-in hours + optional shift times ----------
   Hours are typed, not dragged: fields accept 0–12, clamped on
   commit. v2.7.0: rounding is to the MINUTE, not the quarter hour —
   the old quarter-hour rounding turned a 50-minute class (8:00–8:50)
   into 0.75 hrs when the real answer is 0.83. Optional start/end times per
   day fill the hours from the shift length using the Paycheck tab's
   own rule — calcShiftPaidHours with defaultMeal (30 min unpaid meal
   when the shift runs over 6 hrs; the 15-min breaks are paid, so they
   never come off). Times persist next to the hours; old plans without
   times load exactly as before. */
function planClampHrs(v){
  var n = num(v);
  if(n < 0) n = 0;
  if(n > 12) n = 12;
  return Math.round(n * 60) / 60;
}
function fmtHrsInput(v){
  var n = Math.round(num(v) * 100) / 100;
  return String(n);
}
function fmtTimeShort(t){
  var m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
  if(!m) return '';
  var h = +m[1], ap = h >= 12 ? 'p' : 'a';
  var h12 = h % 12; if(h12 === 0) h12 = 12;
  return h12 + (m[2] === '00' ? '' : ':' + m[2]) + ap;
}
function emptyWeekTimes(){
  var out = [];
  for(var i = 0; i < 7; i++) out.push({ s: '', e: '' });
  return out;
}
function planTermKey(){ return S.planHours.term === 'break' ? 'break' : 'school'; }
function planDayTime(term, i){
  var arr = S.planHours[term + 'Times'];
  return (arr && arr[i]) || { s: '', e: '' };
}
function planTimesNoteFor(pair, hoursVal){
  if(pair && pair.s && pair.e){
    var meal = defaultMeal(pair.s, pair.e);
    var dur = exactMinutes(pair.s, pair.e);
    var paid = planClampHrs(calcShiftPaidHours(pair.s, pair.e, meal));
    return fmtMinutes(dur) + ' (' + fmtHrsExact(dur / 60) + ' hrs)' +
      (meal > 0 ? ' − ' + meal + ' min meal (unpaid)' : ' · no meal break') +
      ' → ' + fmtHrsExact(paid) + ' paid hrs filled in. Typing hours above overrides.';
  }
  if(pair && (pair.s || pair.e)) return 'Add the other time too and the hours fill in from the shift.';
  return 'Optional — set a start and an end and the hours fill in automatically (30 min meal off shifts over 6 hrs, same as the Paycheck tab).';
}
/* if both times are set, (re)fill the day's hours from the shift */
function planFillFromTimes(term, i){
  var pair = planDayTime(term, i);
  if(pair.s && pair.e){
    S.planHours[term][i] = planClampHrs(calcShiftPaidHours(pair.s, pair.e, defaultMeal(pair.s, pair.e)));
  }
}
/* ---------- v2.6.0: school week types + day tags ----------
   One-tap templates for the school week, and per-day tags (Class /
   Practice / Meet) he toggles so work is planned AROUND his real load.
   Tags persist with the school plan; a Meet day starts at 0 hrs. */
var PLAN_TAGS = [
  { key: 'class', label: 'Class' },
  { key: 'practice', label: 'Practice' },
  { key: 'workout', label: 'Workout' },
  { key: 'meet', label: 'Meet' }
];
/* templates are Mon..Sun hours. Meet week: Friday lightened for travel,
   Saturday zeroed (compete day, auto-tagged Meet). Exam week ≈ 9h. */
var PLAN_WEEK_TYPES = {
  normal: { label: 'Normal Week', days: [4, 0, 4, 0, 4, 4, 0] },
  meet:   { label: 'Meet Week',   days: [3, 0, 3, 0, 2, 0, 0] },
  exam:   { label: 'Exam Week',   days: [2, 0, 2, 0, 2, 3, 0] }
};
function planDayTags(i){ return S.planHours.schoolTags[i] || []; }
function planHasTag(i, key){ return planDayTags(i).indexOf(key) >= 0; }
function planLoadLineText(){
  var total = planTotal(S.planHours.school);
  var practice = 0, meets = [];
  for(var i = 0; i < 7; i++){
    if(planHasTag(i, 'practice')) practice++;
    if(planHasTag(i, 'meet')) meets.push(PLAN_DAYS[i]);
  }
  return 'Work ' + fmtPlanHrs(total) + ' · Practice days: ' + practice +
         ' · Meet: ' + (meets.length ? meets.join(', ') : '—');
}
function applyWeekType(key){
  var t = PLAN_WEEK_TYPES[key];
  if(!t) return;
  S.planHours.term = 'school';
  S.planHours.weekType = key;
  S.planHours.school = t.days.slice();
  S.planHours.schoolTimes = emptyWeekTimes(); /* template hours aren't shift-derived */
  if(key === 'meet' && !planHasTag(5, 'meet')){
    /* Saturday is the meet: tag it (its hours are already 0 above) */
    S.planHours.schoolTags[5].push('meet');
  }
  save(); renderPlanHours(true);
}
function togglePlanTag(i, key){
  var tags = S.planHours.schoolTags[i];
  var ix = tags.indexOf(key);
  if(ix >= 0) tags.splice(ix, 1);
  else {
    tags.push(key);
    /* a day tagged Meet starts at 0 work hours — still editable after */
    if(key === 'meet'){ S.planHours.school[i] = 0; S.planHours.schoolTimes[i] = { s: '', e: '' }; }
  }
  save(); renderPlanHours(true);
}
/* months-to-goal line for one scenario, reusing the Budget tab's own
   projection. Monthly leftover swaps the current paycheck for the
   scenario's monthly take-home; bills + planned spending stay his real
   ones. No goal set → fall back to the monthly surplus itself. */
function planGoalLine(hours){
  var p = planScenarioPaycheck(hours);
  var monthlyNet = round2(p.net * 52 / 12);
  var leftover = round2(monthlyNet - unpaidBillsTotal() - plannedSpend());
  if(!(num(S.goal) > 0)){
    return 'Surplus ≈ ' + money(leftover) + '/mo after your bills + planned spending';
  }
  var proj = calcGoalProjection(S.goal, S.saved, leftover, S.rate, p.effRate);
  if(proj.status === 'reached') return 'Goal already reached 🎉';
  if(proj.status === 'date') return 'Hits ' + money0(S.goal) + ' in ≈ ' + proj.months + ' mo · ' + proj.dateStr;
  if(proj.status === 'far') return 'Goal would take 50+ yrs at this pace';
  return 'Not saving yet at this pace — short ' + money(proj.shortfall) + '/mo';
}
/* ---------- v2.6.0: Break Calendar ----------
   He picks a break's start + return dates; every day in the range is a
   tappable calendar cell. Days default from his break-week pattern
   (Sundays off). Whole-break pay chunks the range into Mon–Sun calendar
   weeks and runs each week's hours through the SAME planScenarioPaycheck
   (calcPaycheck) as everything else — no separate tax math. Dates are
   handled at local midnight so DST never shifts a day. */
var BK_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
                 'August', 'September', 'October', 'November', 'December'];
var BK_MON_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
var BK_MAX_DAYS = 120;
function bkParseDate(str){
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str || ''));
  if(!m) return null;
  var d = new Date(+m[1], +m[2] - 1, +m[3]);
  if(d.getFullYear() !== +m[1] || d.getMonth() !== +m[2] - 1 || d.getDate() !== +m[3]) return null;
  return d;
}
function bkFmtDate(d){
  function p(n){ return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function bkAddDays(d, n){
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
function bkDowIdx(d){ return (d.getDay() + 6) % 7; } /* Mon=0 .. Sun=6 */
function bkShortLabel(d){ return BK_MON_SHORT[d.getMonth()] + ' ' + d.getDate(); }
function bkDayLabel(d, withYear){
  return PLAN_DAYS[bkDowIdx(d)] + ', ' + bkShortLabel(d) + (withYear ? ', ' + d.getFullYear() : '');
}
function bkDefaultHours(d){
  if(bkDowIdx(d) === 6) return 0; /* Sundays off, like every preset */
  return num(S.planHours.break[bkDowIdx(d)]);
}
function bkDraft(){ return S.planHours.breakCal; }
/* v2.6.1: countdown status for a break range, from local dates via the
   same bk helpers — day-accurate across month boundaries and DST
   (both endpoints are local midnights, the diff is rounded). Shown in
   the card for the break being edited and as a short tag on every
   saved break. Refreshed on every render; no ticking timer. */
function bkCountdown(cal){
  var start = bkParseDate(cal && cal.start), end = bkParseDate(cal && cal.end);
  if(!start || !end || end < start) return null;
  var now = new Date();
  var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  function daysTo(d){ return Math.round((d - today) / 86400000); }
  if(today < start){
    var n = daysTo(start);
    return { kind: 'future',
             text: '⏳ Starts in ' + n + (n === 1 ? ' day' : ' days') + (n <= 7 ? ' — ' + bkDayLabel(start, false) : ''),
             short: 'starts in ' + n + (n === 1 ? ' day' : ' days') };
  }
  if(today <= end){
    var left = daysTo(end);
    return { kind: 'now',
             text: left === 0 ? '🌴 Happening now — last day today' :
                   '🌴 Happening now — ends in ' + left + (left === 1 ? ' day' : ' days'),
             short: left === 0 ? 'ends today' : left + (left === 1 ? ' day' : ' days') + ' left' };
  }
  return { kind: 'past', text: 'Ended ' + bkDayLabel(end, false), short: 'done' };
}
/* fill any in-range date that has no entry yet with the pattern default,
   drop dates outside the range, clamp hours to 0–10 */
function bkSyncDraftDays(){
  var cal = bkDraft();
  var start = bkParseDate(cal.start), end = bkParseDate(cal.end);
  if(!start || !end || end < start) return false;
  var keep = {};
  for(var d = start; d <= end; d = bkAddDays(d, 1)){
    var k = bkFmtDate(d);
    keep[k] = (cal.days[k] === undefined || cal.days[k] === null)
      ? bkDefaultHours(d)
      : planClampHrs(cal.days[k]);
  }
  cal.days = keep;
  /* v2.6.1: keep only in-range per-date times, normalized */
  var keepT = {};
  Object.keys(cal.times || {}).forEach(function(k){
    if(keep.hasOwnProperty(k)) keepT[k] = normTimePair(cal.times[k]);
  });
  cal.times = keepT;
  if(cal.selected && !keep.hasOwnProperty(cal.selected)) cal.selected = '';
  return true;
}
/* v2.6.1: the selected calendar day's optional shift times */
var bkTimesOpen = false, bkLastSelected = '';
function bkDayTime(ds){ return normTimePair((bkDraft().times || {})[ds]); }
function bkSetDayTime(which, val){
  var cal = bkDraft();
  if(!cal.selected) return;
  if(!cal.times) cal.times = {};
  var pair = bkDayTime(cal.selected);
  pair[which] = val || '';
  cal.times[cal.selected] = pair;
  if(pair.s && pair.e){
    cal.days[cal.selected] = planClampHrs(calcShiftPaidHours(pair.s, pair.e, defaultMeal(pair.s, pair.e)));
  }
  save(); renderBreakCal();
}
/* totals for one break-shaped object ({ start, end, days }): work days,
   hours, gross + net — net summed week by week through calcPaycheck */
function bkSummary(cal){
  var start = bkParseDate(cal.start), end = bkParseDate(cal.end);
  if(!start || !end || end < start) return null;
  var byWeek = {}, order = [], workDays = 0, totalHours = 0;
  for(var d = start; d <= end; d = bkAddDays(d, 1)){
    var h = num(cal.days[bkFmtDate(d)]);
    if(h > 0) workDays++;
    totalHours += h;
    var monday = bkAddDays(d, -bkDowIdx(d));
    var key = bkFmtDate(monday);
    if(!byWeek[key]){ byWeek[key] = { monday: monday, hours: 0 }; order.push(key); }
    byWeek[key].hours += h;
  }
  var gross = 0, net = 0, weeks = [];
  order.forEach(function(k){
    var w = byWeek[k];
    var p = planScenarioPaycheck(w.hours);
    gross = round2(gross + p.weeklyGross);
    net = round2(net + p.net);
    weeks.push({ monday: w.monday, sunday: bkAddDays(w.monday, 6),
                 hours: w.hours, gross: p.weeklyGross, net: p.net });
  });
  return { workDays: workDays, totalHours: totalHours, gross: gross, net: net, weeks: weeks };
}
function bkTapDay(ds){
  var cal = bkDraft();
  var d = bkParseDate(ds);
  if(!d) return;
  var cur = num(cal.days[ds]);
  if(cal.selected !== ds){
    cal.selected = ds;
    if(!(cur > 0)){
      var def = bkDefaultHours(d);
      cal.days[ds] = def > 0 ? def : 4; /* explicit tap = wants to work it */
    }
  } else if(cur > 0){
    cal.days[ds] = 0; /* tapping the selected working day switches it off */
  } else {
    var def2 = bkDefaultHours(d);
    cal.days[ds] = def2 > 0 ? def2 : 4;
  }
  save(); renderBreakCal();
}
/* v2.6.1: typed hours for the selected calendar day (was steppers) */
function bkSetSelectedHours(raw){
  var cal = bkDraft();
  if(!cal.selected) return;
  var str = String(raw === undefined || raw === null ? '' : raw).trim();
  if(str === ''){ cal.days[cal.selected] = 0; save(); renderBreakCal(); return; }
  var v = parseFloat(str);
  if(!isFinite(v)) return; /* invalid — the field resets on blur/commit */
  cal.days[cal.selected] = planClampHrs(v);
  save(); renderBreakCal();
}
function bkSaveBreak(){
  var cal = bkDraft();
  var note = document.getElementById('bkSaveNote');
  if(!bkSyncDraftDays()){
    if(note) note.textContent = 'Pick a valid start and end date first, then save.';
    return;
  }
  var start = bkParseDate(cal.start), end = bkParseDate(cal.end);
  var name = (cal.name || '').trim() ||
    'Break ' + bkShortLabel(start) + ' – ' + bkShortLabel(end);
  var entry = { id: cal.id || ('bk' + Date.now()), name: name,
                start: cal.start, end: cal.end,
                days: JSON.parse(JSON.stringify(cal.days)),
                times: JSON.parse(JSON.stringify(cal.times || {})) };
  var ix = -1;
  S.planHours.savedBreaks.forEach(function(b, i){ if(b.id === entry.id) ix = i; });
  if(ix >= 0) S.planHours.savedBreaks[ix] = entry; else S.planHours.savedBreaks.push(entry);
  cal.id = entry.id; cal.name = name;
  save(); renderBreakCal();
  if(note) note.textContent = 'Saved “' + name + '” — it stays on this device.';
}
function bkLoadBreak(id){
  var found = null;
  S.planHours.savedBreaks.forEach(function(b){ if(b.id === id) found = b; });
  if(!found) return;
  S.planHours.breakCal = { id: found.id, name: found.name, start: found.start, end: found.end,
                           days: JSON.parse(JSON.stringify(found.days)), selected: '',
                           times: JSON.parse(JSON.stringify(found.times || {})) };
  save(); renderBreakCal();
}
function bkDeleteBreak(id){
  S.planHours.savedBreaks = S.planHours.savedBreaks.filter(function(b){ return b.id !== id; });
  if(bkDraft().id === id) bkDraft().id = null; /* draft keeps its content, now unsaved */
  save(); renderBreakCal();
}
function bkNewBreak(){
  S.planHours.breakCal = { id: null, name: '', start: '', end: '', days: {}, selected: '', times: {} };
  var note = document.getElementById('bkSaveNote');
  if(note) note.textContent = '';
  save(); renderBreakCal();
}
function renderSavedBreaks(){
  var el = document.getElementById('bkSaved');
  if(!el) return;
  var list = S.planHours.savedBreaks;
  if(!list.length){ el.innerHTML = ''; return; }
  var html = '<h4 class="bk-saved-head">Saved breaks</h4>';
  list.forEach(function(b){
    var s = bkSummary(b);
    var st = bkParseDate(b.start), en = bkParseDate(b.end);
    var bcd = bkCountdown(b);
    var sub = (st && en ? bkShortLabel(st) + ' – ' + bkShortLabel(en) + ', ' + en.getFullYear() : '') +
      (s ? ' · ' + s.workDays + ' work days · ' + fmtPlanHrs(s.totalHours) + ' · ' + money(s.net) + ' take-home' : '');
    var cdHtml = bcd ? ' · <span class="bk-saved-count ' + bcd.kind + '">' + esc(bcd.short) + '</span>' : '';
    html += '<div class="bk-saved-row">' +
      '<div class="bk-saved-info"><strong>' + esc(b.name || 'Break') + '</strong>' +
      '<div class="bk-saved-sub">' + esc(sub) + cdHtml + '</div></div>' +
      '<div class="bk-saved-actions">' +
      '<button class="btn-mini bk-mini" type="button" data-bk-load="' + esc(b.id) + '">Load</button>' +
      '<button class="btn-mini danger bk-mini" type="button" data-bk-del="' + esc(b.id) + '">Delete</button>' +
      '</div></div>';
  });
  el.innerHTML = html;
}
function renderBreakCal(){
  var wrap = document.getElementById('bkCalWrap');
  if(!wrap) return;
  var cal = bkDraft();
  var nameEl = document.getElementById('bkName');
  if(nameEl && document.activeElement !== nameEl) nameEl.value = cal.name || '';
  var startEl = document.getElementById('bkStart'), endEl = document.getElementById('bkEnd');
  if(startEl && startEl.value !== (cal.start || '')) startEl.value = cal.start || '';
  if(endEl && endEl.value !== (cal.end || '')) endEl.value = cal.end || '';
  var hint = document.getElementById('bkRangeHint');
  var summaryEl = document.getElementById('bkSummary');
  var weeksEl = document.getElementById('bkWeeks');
  var editor = document.getElementById('bkEditor');
  var cdEl = document.getElementById('bkCountdown');
  function clearAll(msg){
    hint.textContent = msg;
    wrap.innerHTML = ''; summaryEl.innerHTML = ''; weeksEl.innerHTML = '';
    editor.hidden = true;
    if(cdEl){ cdEl.hidden = true; cdEl.textContent = ''; }
    renderSavedBreaks();
  }
  var start = bkParseDate(cal.start), end = bkParseDate(cal.end);
  if(!start || !end){ clearAll('Choose a start and end date to lay out your break.'); return; }
  if(end < start){ clearAll('⚠️ The end date is before the start date — swap them and the calendar appears.'); return; }
  var dayCount = Math.round((end - start) / 86400000) + 1;
  if(dayCount > BK_MAX_DAYS){
    clearAll('⚠️ That range is ' + dayCount + ' days — keep a break under about 4 months so the calendar stays usable.');
    return;
  }
  bkSyncDraftDays();
  /* v2.6.1: countdown chip for the break being viewed/edited */
  var cd = bkCountdown(cal);
  if(cdEl){
    if(cd){
      cdEl.hidden = false;
      cdEl.className = 'bk-countdown ' + cd.kind;
      cdEl.textContent = cd.text;
    } else {
      cdEl.hidden = true; cdEl.textContent = '';
    }
  }
  var monthsTxt = (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear())
    ? BK_MONTHS[start.getMonth()] + ' ' + start.getFullYear()
    : BK_MONTHS[start.getMonth()] + ' ' + start.getFullYear() + ' – ' + BK_MONTHS[end.getMonth()] + ' ' + end.getFullYear();
  hint.textContent = dayCount + ' days · ' + bkDayLabel(start, true) + ' → ' + bkDayLabel(end, true) +
    '. Tap a day to select it (tap the selected day again to switch it off), then type its hours or set shift times below.';
  wrap.innerHTML = '';
  var cap = document.createElement('p');
  cap.className = 'bk-months';
  cap.textContent = monthsTxt;
  wrap.appendChild(cap);
  var grid = document.createElement('div');
  grid.className = 'bk-cal';
  ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach(function(L){
    var hd = document.createElement('div');
    hd.className = 'bk-dow';
    hd.textContent = L;
    grid.appendChild(hd);
  });
  var gridStart = bkAddDays(start, -bkDowIdx(start));
  var gridEnd = bkAddDays(end, 6 - bkDowIdx(end));
  for(var d = gridStart; d <= gridEnd; d = bkAddDays(d, 1)){
    if(d < start || d > end){
      var blank = document.createElement('div');
      blank.className = 'bk-cell empty';
      grid.appendChild(blank);
      continue;
    }
    var ds = bkFmtDate(d), h = num(cal.days[ds]);
    var cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'bk-cell' + (h > 0 ? ' on' : '') + (cal.selected === ds ? ' sel' : '');
    cell.dataset.bkDay = ds;
    cell.setAttribute('aria-label', bkDayLabel(d, true) + (h > 0 ? ', working ' + fmtPlanHrs(h) : ', off'));
    cell.innerHTML = '<span class="bk-num">' + d.getDate() + '</span>' +
                     '<span class="bk-hrs">' + (h > 0 ? fmtPlanHrs(h) : 'off') + '</span>';
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);
  /* selected-day editor — v2.6.1: type the hours, optional shift times */
  var sel = cal.selected ? bkParseDate(cal.selected) : null;
  if(sel && sel >= start && sel <= end){
    editor.hidden = false;
    document.getElementById('bkEditorLabel').textContent = bkDayLabel(sel, true);
    var bkInp = document.getElementById('bkHrsInput');
    if(bkInp && document.activeElement !== bkInp) bkInp.value = fmtHrsInput(num(cal.days[cal.selected]));
    var pair = bkDayTime(cal.selected);
    var hasT = !!(pair.s || pair.e);
    if(cal.selected !== bkLastSelected){
      bkLastSelected = cal.selected;
      bkTimesOpen = hasT; /* reopen showing times that are already set */
    }
    var tBtn = document.getElementById('bkTimesBtn');
    tBtn.classList.toggle('has', hasT);
    tBtn.classList.toggle('open', bkTimesOpen);
    tBtn.setAttribute('aria-expanded', bkTimesOpen ? 'true' : 'false');
    tBtn.textContent = hasT ? '🕑 ' + fmtTimeShort(pair.s) + '–' + fmtTimeShort(pair.e) : '＋ times';
    var tRow = document.getElementById('bkTimesRow');
    tRow.hidden = !bkTimesOpen;
    if(bkTimesOpen){
      var sInp = document.getElementById('bkStartTime'), eInp = document.getElementById('bkEndTime');
      if(document.activeElement !== sInp) sInp.value = pair.s || '';
      if(document.activeElement !== eInp) eInp.value = pair.e || '';
      document.getElementById('bkTimesNote').textContent = planTimesNoteFor(pair, num(cal.days[cal.selected]));
    }
  } else {
    editor.hidden = true;
  }
  /* whole-break summary + per-week breakdown */
  var sum = bkSummary(cal);
  if(sum){
    summaryEl.innerHTML =
      '<div class="plan-pay-grid bk-sum-grid">' +
      '<div class="plan-pay-cell"><p class="plan-pay-label">Work days</p><p class="plan-pay-num">' + sum.workDays + '</p></div>' +
      '<div class="plan-pay-cell"><p class="plan-pay-label">Total hours</p><p class="plan-pay-num">' + fmtPlanHrs(sum.totalHours) + '</p></div>' +
      '<div class="plan-pay-cell"><p class="plan-pay-label">Gross · whole break</p><p class="plan-pay-num">' + money(sum.gross) + '</p></div>' +
      '<div class="plan-pay-cell"><p class="plan-pay-label">Take-home · whole break</p><p class="plan-pay-num">' + money(sum.net) + '</p></div>' +
      '</div>' +
      (num(S.rate) > 0 ? '' : '<p class="explain">Set your hourly rate on the Paycheck tab and these previews fill in with your real rate and deductions.</p>');
    var whtml = '';
    var workedWeeks = sum.weeks.filter(function(w){ return w.hours > 0; });
    if(workedWeeks.length > 1){
      workedWeeks.forEach(function(w){
        var lo = w.monday < start ? start : w.monday;
        var hi = w.sunday > end ? end : w.sunday;
        whtml += '<div class="plan-compare-row">' +
          '<div class="plan-compare-head"><strong>' + bkShortLabel(lo) + ' – ' + bkShortLabel(hi) + '</strong>' +
          '<span class="plan-compare-net">' + money(w.net) + '</span></div>' +
          '<div class="plan-compare-sub">' + fmtPlanHrs(w.hours) + ' · gross ' + money(w.gross) + ' · take-home ' + money(w.net) + '</div></div>';
      });
    }
    weeksEl.innerHTML = whtml;
  } else {
    summaryEl.innerHTML = ''; weeksEl.innerHTML = '';
  }
  renderSavedBreaks();
}

/* v2.6.1: which planner rows have their shift-times editor open,
   keyed 'school0'..'break6' — view state only, never saved */
var planTimesExpanded = {};
function planDayRowHTML(term, i, hrsVal){
  var pair = planDayTime(term, i);
  var hasT = !!(pair.s || pair.e);
  var open = !!planTimesExpanded[term + i];
  return '<span class="plan-day-name">' + PLAN_DAYS[i] + '</span>' +
    '<button class="plan-step" type="button" data-plan-dec="' + i + '" aria-label="Fewer hours ' + PLAN_DAY_FULL[i] + '">−</button>' +
    '<span class="plan-hrs-wrap"><input class="plan-hrs" type="number" inputmode="decimal" min="0" max="12" step="0.01" value="' + fmtHrsInput(hrsVal) + '" data-plan-hrs="' + i + '" aria-label="' + PLAN_DAY_FULL[i] + ' hours — type a number"><span class="plan-hrs-unit">hrs</span></span>' +
    '<button class="plan-step" type="button" data-plan-inc="' + i + '" aria-label="More hours ' + PLAN_DAY_FULL[i] + '">+</button>' +
    '<button class="plan-times-btn' + (hasT ? ' has' : '') + (open ? ' open' : '') + '" type="button" data-plan-times="' + i + '" aria-expanded="' + (open ? 'true' : 'false') + '" aria-label="Shift times for ' + PLAN_DAY_FULL[i] + '">' +
      (hasT ? '🕑 ' + fmtTimeShort(pair.s) + '–' + fmtTimeShort(pair.e) : '＋ times') + '</button>';
}
function planTimesRowHTML(term, i){
  var pair = planDayTime(term, i);
  return '<label class="plan-time-field">Start <input type="time" value="' + esc(pair.s || '') + '" data-plan-start="' + i + '" aria-label="' + PLAN_DAY_FULL[i] + ' shift start"></label>' +
    '<label class="plan-time-field">End <input type="time" value="' + esc(pair.e || '') + '" data-plan-end="' + i + '" aria-label="' + PLAN_DAY_FULL[i] + ' shift end"></label>' +
    '<button class="plan-times-clear" type="button" data-plan-clear-times="' + i + '">Clear times</button>' +
    '<span class="plan-times-note" id="planTimesNote' + i + '">' + esc(planTimesNoteFor(pair)) + '</span>';
}
/* ---------- v2.16.0: 😴 sleep check ----------
   The athlete guardrail used to judge a school week by hours alone
   (anything over 20h = "heavy for track season"). When the user has
   set a sleep schedule, the plan is judged by his REAL sleep instead:
   the nightly window from lights-out to wake-up against his goal,
   and whether any shift ends so late it eats into the wind-down he
   needs before bed. Days planned by hours only (no shift times) can't
   be end-checked — the check says so instead of guessing. */
/* the school plan as sleep-checkable days: paid hrs + shift end in
   minutes since midnight (overnight ends roll past 1440), or endMin
   null when the day has no complete pair of shift times */
function planDaysForSleep(){
  var out = [];
  for(var i = 0; i < 7; i++){
    var pair = planDayTime('school', i);
    var endMin = null;
    if(pair.s && pair.e){
      var sMin = toMinutes(pair.s), eMin = toMinutes(pair.e);
      if(eMin <= sMin) eMin += 1440;
      endMin = eMin;
    }
    out.push({ day: i, paid: num(S.planHours.school[i]), endMin: endMin });
  }
  return out;
}
function sleepCheck(plan, sleep){
  var sl = normSleep(sleep);
  if(!sl.wake || !sl.bed) return { configured: false };
  var wakeMin = toMinutes(sl.wake), bedMin = toMinutes(sl.bed);
  var sleepMin = wakeMin - bedMin; if(sleepMin <= 0) sleepMin += 1440;
  var goalMin = Math.round(sl.goalHrs * 60);
  var safeEnd = bedMin - sl.windDownMin; if(safeEnd < 0) safeEnd += 1440;
  var overruns = [], untimed = [], latestEnd = null, worst = null;
  (plan || []).forEach(function(d){
    if(!(num(d.paid) > 0)) return;
    if(d.endMin === null || d.endMin === undefined){ untimed.push(d.day); return; }
    if(latestEnd === null || d.endMin > latestEnd) latestEnd = d.endMin;
    if(d.endMin > safeEnd){
      var ov = { day: d.day, endMin: d.endMin, overrun: d.endMin - safeEnd,
                 slippedSleep: sleepMin - (d.endMin - safeEnd) };
      overruns.push(ov);
      if(!worst || ov.overrun > worst.overrun) worst = ov;
    }
  });
  var baseShort = sleepMin < goalMin;
  return { configured: true, sleep: sl, sleepMin: sleepMin, goalMin: goalMin,
           latestSafeEnd: safeEnd, overruns: overruns, worstDay: worst,
           latestEnd: latestEnd, untimedDays: untimed, baseShort: baseShort,
           sleepOk: !baseShort && overruns.length === 0 };
}
/* guardrail lines for a CONFIGURED sleep check — [{ kind, text }]
   with exact numbers throughout; 'ok' is the truth line that replaces
   the old blanket warning when the plan protects the user's sleep */
function sleepGuardrailMsgs(total, sc){
  var sl = sc.sleep, out = [];
  var sleepTxt = fmtMinutes(sc.sleepMin);
  var goalTxt = fmtHrsExact(sl.goalHrs);
  if(sc.baseShort){
    out.push({ kind: 'warn', text: '😴 <strong>Your sleep window is ' + sleepTxt +
      '</strong> (lights-out ' + fmtTime(sl.bed) + ' → wake ' + fmtTime(sl.wake) +
      ') — under your ' + goalTxt + ' hr goal before work even starts.' });
  }
  sc.overruns.forEach(function(ov){
    var txt = '😴 <strong>Sleep check ⚠️ ' + PLAN_DAYS[ov.day] + ' ends ' +
      fmtTime(minsToHHMM(ov.endMin % 1440)) + '</strong> — ' + ov.overrun +
      ' min past your ' + fmtTime(minsToHHMM(sc.latestSafeEnd)) +
      ' safe end (lights-out ' + fmtTime(sl.bed) + ' minus ' + sl.windDownMin +
      ' min wind-down). Sleep would slip to ' + fmtMinutes(ov.slippedSleep);
    txt += ov.slippedSleep < sc.goalMin ? ', under your ' + goalTxt + ' hr goal.' : '.';
    out.push({ kind: 'warn', text: txt });
  });
  if(!sc.baseShort && !sc.overruns.length && total > 0){
    var t;
    if(sc.latestEnd !== null){
      var wdLeft = (toMinutes(sl.bed) - (sc.latestEnd % 1440) + 1440) % 1440;
      t = '😴 <strong>Sleep check ✅</strong> — ' + fmtPlanHrs(total) +
        ' week: latest work end ' + fmtTime(minsToHHMM(sc.latestEnd % 1440)) +
        ' still leaves ' + fmtMinutes(wdLeft) + ' before lights-out ' +
        fmtTime(sl.bed) + '; ' + sleepTxt + ' of sleep before your ' +
        fmtTime(sl.wake) + ' wake-up (goal ' + fmtPlanHrs(sl.goalHrs) +
        '). This plan protects your sleep.';
    } else {
      t = '😴 <strong>Sleep check ✅</strong> — ' + fmtPlanHrs(total) +
        ' week: your sleep window is ' + sleepTxt + ' (lights-out ' +
        fmtTime(sl.bed) + ' → wake ' + fmtTime(sl.wake) +
        '), meeting your ' + fmtPlanHrs(sl.goalHrs) + ' goal.';
    }
    if(sc.untimedDays.length){
      t += ' Add shift times to check ' +
        sc.untimedDays.map(function(d){ return PLAN_DAYS[d]; }).join(', ') +
        ' exactly — those days are planned by hours only.';
    }
    out.push({ kind: 'ok', text: t });
  }
  return out;
}

function renderPlanHours(rebuildDays){
  var schoolBtn = document.getElementById('planTermSchool');
  if(!schoolBtn) return;
  var term = S.planHours.term === 'break' ? 'break' : 'school';
  var days = S.planHours[term];
  schoolBtn.classList.toggle('active', term === 'school');
  document.getElementById('planTermBreak').classList.toggle('active', term === 'break');

  /* day rows — typed hour fields (v2.6.1, sliders removed). Typing
     only ever triggers the light update below, never a rebuild, so
     focus and the caret are safe; rebuilds happen on structural taps
     (times toggle, tags, templates, term switch). */
  var daysEl = document.getElementById('planDays');
  if(rebuildDays){
    daysEl.innerHTML = '';
    PLAN_DAYS.forEach(function(name, i){
      var block = document.createElement('div');
      block.className = 'plan-day-block';
      var row = document.createElement('div');
      row.className = 'plan-day' + (num(days[i]) > 8 ? ' over' : '');
      row.innerHTML = planDayRowHTML(term, i, days[i]);
      block.appendChild(row);
      if(planTimesExpanded[term + i]){
        var trow = document.createElement('div');
        trow.className = 'plan-day-times';
        trow.innerHTML = planTimesRowHTML(term, i);
        block.appendChild(trow);
      }
      /* v2.6.0: school days carry toggleable load tags under the row */
      if(term === 'school'){
        var tagRow = document.createElement('div');
        tagRow.className = 'plan-day-tags';
        PLAN_TAGS.forEach(function(tag){
          var on = planHasTag(i, tag.key);
          var chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'plan-tag' + (on ? ' active' : '');
          chip.textContent = tag.label;
          chip.dataset.planTagDay = i;
          chip.dataset.planTag = tag.key;
          chip.setAttribute('aria-pressed', on ? 'true' : 'false');
          chip.setAttribute('aria-label', PLAN_DAY_FULL[i] + ' tagged ' + tag.label);
          tagRow.appendChild(chip);
        });
        block.appendChild(tagRow);
      }
      daysEl.appendChild(block);
    });
  } else {
    /* light update: field values (never the focused one), over-8 flags,
       times-button labels and shift notes */
    var rowEls = daysEl.querySelectorAll('.plan-day');
    days.forEach(function(v, i){
      var inp = daysEl.querySelector('[data-plan-hrs="' + i + '"]');
      if(inp && document.activeElement !== inp) inp.value = fmtHrsInput(v);
      if(rowEls[i]) rowEls[i].classList.toggle('over', num(v) > 8);
      var pair = planDayTime(term, i);
      var hasT = !!(pair.s || pair.e);
      var tb = daysEl.querySelector('[data-plan-times="' + i + '"]');
      if(tb){
        tb.classList.toggle('has', hasT);
        tb.textContent = hasT ? '🕑 ' + fmtTimeShort(pair.s) + '–' + fmtTimeShort(pair.e) : '＋ times';
      }
      var note = document.getElementById('planTimesNote' + i);
      if(note) note.textContent = planTimesNoteFor(pair);
    });
  }

  /* v2.6.0: school extras (week types + load line) show in school mode;
     the Break Calendar card shows in break mode */
  var wtEl = document.getElementById('planWeekTypes');
  if(wtEl) wtEl.style.display = term === 'school' ? '' : 'none';
  ['normal', 'meet', 'exam'].forEach(function(k){
    var tb = document.getElementById('planType' + k.charAt(0).toUpperCase() + k.slice(1));
    if(tb) tb.classList.toggle('active', term === 'school' && S.planHours.weekType === k);
  });
  var loadEl = document.getElementById('planLoadLine');
  if(loadEl){
    loadEl.style.display = term === 'school' ? '' : 'none';
    if(term === 'school') loadEl.textContent = planLoadLineText();
  }
  var bkCard = document.getElementById('breakCalCard');
  if(bkCard){
    bkCard.hidden = term !== 'break';
    if(term === 'break') renderBreakCal();
  }

  /* totals + pay preview */
  var total = planTotal(days);
  document.getElementById('planTotalOut').textContent = fmtPlanHrs(total) + ' / week';
  var p = planScenarioPaycheck(total);
  var monthlyNet = round2(p.net * 52 / 12);
  document.getElementById('planNetWeek').textContent = money(p.net);
  document.getElementById('planGrossWeek').textContent = money(p.weeklyGross);
  document.getElementById('planNetPayday').textContent = money(p.net);
  document.getElementById('planNetMonth').textContent = money(monthlyNet);
  var note = document.getElementById('planPayNote');
  if(!(num(S.rate) > 0)){
    note.textContent = 'Set your hourly rate on the Paycheck tab and these previews fill in with your real rate and deductions.';
  } else {
    note.textContent = 'Same math as your Paycheck tab at ' + money(S.rate) + '/hr' +
      (p.estimateUsed ? ' (taxes estimated from the 2025 brackets — enter a pay stub there for exact numbers)' : ' (using your saved pay-stub deductions)') +
      '. Monthly is the weekly take-home × 52 ÷ 12.';
  }

  /* athlete guardrails — v2.16.0: when a 😴 sleep schedule is set,
     the school plan is judged by the user's real sleep (sleepCheck)
     instead of the blanket hours warning; unset sleep keeps the
     original plain-hours caution plus a hint to set the schedule.
     The over-8h single-day flag and the break-week exemption are
     unchanged. */
  var warn = document.getElementById('planWarn');
  var warnMsgs = [], okMsgs = [], hintHtml = '';
  if(term === 'school'){
    var sc = sleepCheck(planDaysForSleep(), S.sleep);
    if(sc.configured){
      sleepGuardrailMsgs(total, sc).forEach(function(m){
        (m.kind === 'ok' ? okMsgs : warnMsgs).push(m.text);
      });
    } else {
      if(total > 20){
        warnMsgs.push('🏃 <strong>' + fmtPlanHrs(total) + ' in a school week is heavy for track season</strong> — that pace eats into sleep and recovery. Around 20 hrs is the ceiling that still protects your training.');
      }
      if(total > 0){
        hintHtml = '<p class="hint plan-sleep-hint">😴 Set your sleep schedule (below) and the app will check your real sleep instead of just counting hours.</p>';
      }
    }
  }
  var heavy = [];
  days.forEach(function(v, i){ if(num(v) > 8) heavy.push(PLAN_DAY_FULL[i] + ' (' + fmtPlanHrs(v) + ')'); });
  if(heavy.length){
    warnMsgs.push('⚠️ Long day' + (heavy.length > 1 ? 's' : '') + ' over 8 hrs: ' + heavy.join(', ') + ' — a single shift that long is rough on a practice day.');
  }
  var warnHtml = '';
  if(warnMsgs.length) warnHtml += '<div class="warning plan-warning">' + warnMsgs.join('<br>') + '</div>';
  if(okMsgs.length) warnHtml += '<div class="plan-sleep-ok">' + okMsgs.join('<br>') + '</div>';
  warn.innerHTML = warnHtml + hintHtml;

  /* v2.16.0: 😴 sleep schedule fields mirror S.sleep (never the
     field being typed in, so focus and caret stay put) */
  var swEl = document.getElementById('sleepWake'), sbEl = document.getElementById('sleepBed'),
      sgEl = document.getElementById('sleepGoal'), swdEl = document.getElementById('sleepWind');
  if(swEl && document.activeElement !== swEl) swEl.value = normSleep(S.sleep).wake;
  if(sbEl && document.activeElement !== sbEl) sbEl.value = normSleep(S.sleep).bed;
  if(sgEl && document.activeElement !== sgEl) sgEl.value = normSleep(S.sleep).goalHrs;
  if(swdEl && document.activeElement !== swdEl) swdEl.value = normSleep(S.sleep).windDownMin;

  /* compare strip: the three school paces side by side */
  var cmp = document.getElementById('planCompare');
  cmp.innerHTML = '';
  ['light', 'typical', 'max'].forEach(function(key){
    var preset = PLAN_PRESETS[key];
    var hrs = planTotal(preset.days);
    var pp = planScenarioPaycheck(hrs);
    var row = document.createElement('div');
    row.className = 'plan-compare-row';
    row.innerHTML =
      '<div class="plan-compare-head"><strong>' + preset.label + ' · ' + fmtPlanHrs(hrs) + '/wk</strong>' +
      '<span class="plan-compare-net">' + money(pp.net) + ' /wk</span></div>' +
      '<div class="plan-compare-sub">' + money(round2(pp.net * 52 / 12)) + ' take-home/mo · ' + planGoalLine(hrs) + '</div>';
    cmp.appendChild(row);
  });

  /* v2.7.0: keep the Class Schedule week view in step with the plan —
     safe during typing: renderSchedule never rewrites form values */
  renderSchedule();
}
function bindPlanHours(){
  var daysEl = document.getElementById('planDays');
  if(!daysEl) return;
  /* v2.14.0: "✨ Plan from my schedule" — jumps from the planner to
     the Suggest box in the schedule card and runs a fresh preview
     with the current target (the shared runSuggest handler; with an
     empty schedule it lands on the honest add-something note) */
  var planBtn = document.getElementById('planFromScheduleBtn');
  if(planBtn) planBtn.addEventListener('click', function(){
    var box = document.getElementById('suggestBox') || document.getElementById('suggestBtn');
    if(box && box.scrollIntoView) box.scrollIntoView({ block: 'center' });
    runSuggest();
  });
  /* v2.16.0: 😴 sleep schedule fields — commit on change, normalize
     (clamps/defaults), save, and re-judge the plan by real sleep */
  function bindSleep(id, apply){
    var el = document.getElementById(id);
    if(!el) return;
    el.addEventListener('change', function(){
      if(!S.sleep || typeof S.sleep !== 'object') S.sleep = {};
      apply(el.value);
      S.sleep = normSleep(S.sleep);
      save();
      renderPlanHours(false);
    });
  }
  bindSleep('sleepWake', function(v){ S.sleep.wake = v || ''; });
  bindSleep('sleepBed', function(v){ S.sleep.bed = v || ''; });
  bindSleep('sleepGoal', function(v){ S.sleep.goalHrs = v; });
  bindSleep('sleepWind', function(v){ S.sleep.windDownMin = v; });
  function setDay(i, v){
    var days = planTermDays();
    days[i] = planClampHrs(v);
    save();
    renderPlanHours(false);
  }
  /* v2.6.1: typed hours — blank counts as 0, anything unparseable is
     ignored (the field snaps back to the last good value on commit) */
  function setDayTyped(i, raw){
    var str = String(raw === undefined || raw === null ? '' : raw).trim();
    var days = planTermDays();
    if(str === ''){ days[i] = 0; save(); renderPlanHours(false); return; }
    var v = parseFloat(str);
    if(!isFinite(v)) return;
    days[i] = planClampHrs(v);
    save();
    renderPlanHours(false);
  }
  function setDayTime(i, which, val){
    var term = planTermKey();
    var pair = planDayTime(term, i);
    pair[which] = val || '';
    S.planHours[term + 'Times'][i] = pair;
    planFillFromTimes(term, i);
    save();
    renderPlanHours(false);
  }
  daysEl.addEventListener('input', function(e){
    var t = e.target;
    if(!t.dataset) return;
    if(t.dataset.planHrs !== undefined) setDayTyped(+t.dataset.planHrs, t.value);
    else if(t.dataset.planStart !== undefined) setDayTime(+t.dataset.planStart, 's', t.value);
    else if(t.dataset.planEnd !== undefined) setDayTime(+t.dataset.planEnd, 'e', t.value);
  });
  /* on commit, normalize the field itself (clamped/rounded value, or
     back to the last valid one if the entry was invalid) — no rebuild,
     so tabbing through the days never loses focus */
  daysEl.addEventListener('change', function(e){
    var t = e.target;
    if(!t.dataset) return;
    var term = planTermKey();
    if(t.dataset.planHrs !== undefined) t.value = fmtHrsInput(planTermDays()[+t.dataset.planHrs]);
    else if(t.dataset.planStart !== undefined) t.value = planDayTime(term, +t.dataset.planStart).s || '';
    else if(t.dataset.planEnd !== undefined) t.value = planDayTime(term, +t.dataset.planEnd).e || '';
  });
  daysEl.addEventListener('click', function(e){
    var t = e.target;
    if(!t.dataset) return;
    /* v2.6.0: day tag chips (school mode) */
    if(t.dataset.planTag !== undefined && t.dataset.planTagDay !== undefined){
      togglePlanTag(+t.dataset.planTagDay, t.dataset.planTag);
      return;
    }
    /* v2.6.1: shift-times toggle + clear */
    if(t.dataset.planTimes !== undefined){
      var tk = planTermKey() + (+t.dataset.planTimes);
      planTimesExpanded[tk] = !planTimesExpanded[tk];
      renderPlanHours(true);
      return;
    }
    if(t.dataset.planClearTimes !== undefined){
      var ci = +t.dataset.planClearTimes, cterm = planTermKey();
      S.planHours[cterm + 'Times'][ci] = { s: '', e: '' };
      save(); renderPlanHours(true);
      return;
    }
    var days = planTermDays();
    if(t.dataset.planDec !== undefined) setDay(+t.dataset.planDec, num(days[+t.dataset.planDec]) - 0.5);
    if(t.dataset.planInc !== undefined) setDay(+t.dataset.planInc, num(days[+t.dataset.planInc]) + 0.5);
  });
  /* v2.6.0: school week-type templates */
  ['normal', 'meet', 'exam'].forEach(function(k){
    var b = document.getElementById('planType' + k.charAt(0).toUpperCase() + k.slice(1));
    if(b) b.addEventListener('click', function(){ applyWeekType(k); });
  });
  /* v2.6.0: Break Calendar bindings */
  var bkNameEl = document.getElementById('bkName');
  if(bkNameEl){
    bkNameEl.addEventListener('input', function(){ bkDraft().name = bkNameEl.value; save(); });
    document.getElementById('bkStart').addEventListener('change', function(e){
      bkDraft().start = e.target.value; bkDraft().selected = ''; save(); renderBreakCal();
    });
    document.getElementById('bkEnd').addEventListener('change', function(e){
      bkDraft().end = e.target.value; bkDraft().selected = ''; save(); renderBreakCal();
    });
    document.getElementById('bkCalWrap').addEventListener('click', function(e){
      var cell = e.target.closest ? e.target.closest('[data-bk-day]') : null;
      if(cell) bkTapDay(cell.dataset.bkDay);
    });
    /* v2.6.1: typed hours + shift times for the selected calendar day */
    var bkHrsEl = document.getElementById('bkHrsInput');
    bkHrsEl.addEventListener('input', function(){ bkSetSelectedHours(bkHrsEl.value); });
    bkHrsEl.addEventListener('change', function(){
      var cal = bkDraft();
      if(cal.selected) bkHrsEl.value = fmtHrsInput(num(cal.days[cal.selected]));
      renderBreakCal();
    });
    document.getElementById('bkTimesBtn').addEventListener('click', function(){
      bkTimesOpen = !bkTimesOpen; renderBreakCal();
    });
    document.getElementById('bkStartTime').addEventListener('input', function(e){ bkSetDayTime('s', e.target.value); });
    document.getElementById('bkEndTime').addEventListener('input', function(e){ bkSetDayTime('e', e.target.value); });
    document.getElementById('bkClearTimes').addEventListener('click', function(){
      var cal = bkDraft();
      if(cal.selected && cal.times) delete cal.times[cal.selected];
      save(); renderBreakCal();
    });
    document.getElementById('bkSave').addEventListener('click', bkSaveBreak);
    document.getElementById('bkNew').addEventListener('click', bkNewBreak);
    document.getElementById('bkSaved').addEventListener('click', function(e){
      var t = e.target;
      var loadBtn = t.closest ? t.closest('[data-bk-load]') : null;
      if(loadBtn){ bkLoadBreak(loadBtn.dataset.bkLoad); return; }
      var delBtn = t.closest ? t.closest('[data-bk-del]') : null;
      if(delBtn) bkDeleteBreak(delBtn.dataset.bkDel);
    });
  }
  function setTerm(term){
    S.planHours.term = term; save(); renderPlanHours(true);
  }
  document.getElementById('planTermSchool').addEventListener('click', function(){ setTerm('school'); });
  document.getElementById('planTermBreak').addEventListener('click', function(){ setTerm('break'); });
  Object.keys(PLAN_PRESETS).forEach(function(key){
    var btnId = key === 'breakwk' ? 'planPresetBreak' : 'planPreset' + key.charAt(0).toUpperCase() + key.slice(1);
    var btn = document.getElementById(btnId);
    if(!btn) return;
    btn.addEventListener('click', function(){
      var preset = PLAN_PRESETS[key];
      S.planHours.term = preset.term;
      S.planHours[preset.term] = preset.days.slice();
      S.planHours[preset.term + 'Times'] = emptyWeekTimes(); /* preset hours aren't shift-derived */
      save(); renderPlanHours(true);
    });
  });
}

/* ---------- v2.6.1: Work Log ----------
   The planner is what he COULD work; this logs what he ACTUALLY
   worked, week by week, so he can look back: most hours in a week,
   averages, totals. Pay is computed once at save time through the
   same planScenarioPaycheck (calcPaycheck) as everything else and
   stored with the entry — later rate changes never rewrite history.
   v2.12.0: each entry also stores the FULL pay breakdown from that
   same single run (gross, every tax/deduction line, total taken,
   net), shown under a "💵 Pay" toggle in the week's detail, and
   "Your records" totals gross + taken across all logged weeks.
   Because the breakdown, the row's gross and the row's net all come
   out of the one run, they can never disagree. Weeks logged before
   v2.12.0 have no stored breakdown — theirs is computed live from
   the logged hours through the identical path. */
var wlTimesExpanded = {}, wlOpenEntry = null, wlPayOpen = {};
/* the full pay picture for one week's paid hours, from the SAME
   planScenarioPaycheck (calcPaycheck) path as the Paycheck tab and
   the planner preview — line names/order mirror the Paycheck tab. */
function wlPayBreakdown(hours){
  var p = planScenarioPaycheck(hours);
  var st = STATE_TAX_2025[S.stateCode || 'NY'];
  var stateName = st ? st.name : (NO_TAX_STATE_NAMES[S.stateCode || 'NY'] || 'this state');
  return { gross: p.weeklyGross, regHrs: p.regHrs, otHrs: p.otHrs, otAmt: p.otAmt,
    taxes: [
      { label: 'Social Security', amt: p.ssAmt },
      { label: 'Medicare', amt: p.medicareAmt },
      { label: 'Federal tax', amt: p.fedAmt },
      { label: stateName + ' state tax', amt: p.nyAmt },
      { label: 'NY FLI', amt: p.fliAmt }
    ],
    taxesTotal: p.taxesTotal,
    deductions: [
      { label: '401K', amt: p.k401Amt },
      { label: 'Membership fee (W+)', amt: p.memberAmt },
      { label: 'Company stock contribution', amt: p.stockContribAmt },
      { label: 'Stock purchase', amt: p.stockPurchAmt }
    ],
    dedTotal: p.dedTotal, totalTaken: p.totalDed, net: p.net,
    estimate: !!p.estimateUsed };
}
/* an entry's breakdown: the one stored at save time when present,
   else computed live from its logged (paid) hours — same path either
   way, so the numbers always match the engine exactly. */
function wlEntryPay(w){
  var stored = wlNormPay(w && w.pay);
  return stored || wlPayBreakdown(num(w && w.total));
}
function wlMondayStr(d){
  var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return bkFmtDate(bkAddDays(x, -bkDowIdx(x)));
}
function wlDraftWeek(){
  var d = bkParseDate(S.wlDraft.week);
  if(d) return bkFmtDate(bkAddDays(d, -bkDowIdx(d)));
  return wlMondayStr(new Date());
}
function wlDraftTotal(){ return planTotal(S.wlDraft.days); }
function wlSetDay(i, v){
  S.wlDraft.days[i] = planClampHrs(v);
  save(); renderWorkLog(false);
}
function wlSetDayTyped(i, raw){
  var str = String(raw === undefined || raw === null ? '' : raw).trim();
  if(str === ''){ S.wlDraft.days[i] = 0; save(); renderWorkLog(false); return; }
  var v = parseFloat(str);
  if(!isFinite(v)) return;
  S.wlDraft.days[i] = planClampHrs(v);
  save(); renderWorkLog(false);
}
function wlSetDayTime(i, which, val){
  var pair = normTimePair(S.wlDraft.times[i]);
  pair[which] = val || '';
  S.wlDraft.times[i] = pair;
  if(pair.s && pair.e){
    S.wlDraft.days[i] = planClampHrs(calcShiftPaidHours(pair.s, pair.e, defaultMeal(pair.s, pair.e)));
  }
  save(); renderWorkLog(false);
}
function wlSaveWeek(){
  var note = document.getElementById('wlNote');
  var week = wlDraftWeek();
  var total = wlDraftTotal();
  /* one calcPaycheck run feeds the row's gross, the row's net AND
     the stored breakdown — they can never disagree (v2.12.0) */
  var bd = wlPayBreakdown(total);
  var entry = { id: 'wl' + week, week: week,
                days: S.wlDraft.days.slice(),
                times: JSON.parse(JSON.stringify(S.wlDraft.times)),
                total: total, gross: bd.gross, net: bd.net, pay: bd };
  var ix = -1;
  S.workLog.forEach(function(w, i){ if(w.week === week) ix = i; });
  var updated = ix >= 0;
  if(updated) S.workLog[ix] = entry; else S.workLog.push(entry);
  S.workLog.sort(function(a, b){ return a.week < b.week ? 1 : (a.week > b.week ? -1 : 0); });
  S.wlDraft.days = [0, 0, 0, 0, 0, 0, 0];
  S.wlDraft.times = emptyWeekTimes();
  wlOpenEntry = entry.id;
  save(); renderWorkLog(true);
  if(note) note.textContent = (updated ? 'Updated' : 'Logged') + ' the week of ' + bkDayLabel(bkParseDate(week), true) +
    ' — ' + fmtPlanHrs(total) + ', ' + money(bd.net) + ' take-home.';
}
function wlCopyPlan(){
  S.wlDraft.days = S.planHours.school.slice();
  S.wlDraft.times = JSON.parse(JSON.stringify(S.planHours.schoolTimes));
  if(!bkParseDate(S.wlDraft.week)) S.wlDraft.week = wlMondayStr(new Date());
  save(); renderWorkLog(true);
  var note = document.getElementById('wlNote');
  if(note) note.textContent = 'Copied your school plan in as worked — fix any day that was different, then save the week.';
}
function wlDelete(id){
  S.workLog = S.workLog.filter(function(w){ return w.id !== id; });
  if(wlOpenEntry === id) wlOpenEntry = null;
  delete wlPayOpen[id];
  save(); renderWorkLog(true);
}
function wlStats(){
  var n = S.workLog.length;
  if(!n) return null;
  var totH = 0, totGross = 0, totTaken = 0, totNet = 0, best = null;
  S.workLog.forEach(function(w){
    /* v2.12.0: money totals sum the per-week breakdowns (the stored
       ones — for saved weeks bd.net IS w.net, same single run) */
    var bd = wlEntryPay(w);
    totH += num(w.total); totGross += bd.gross; totTaken += bd.totalTaken; totNet += bd.net;
    if(!best || num(w.total) > num(best.total)) best = w;
  });
  return { count: n, totalHours: totH, totalGross: round2(totGross),
           totalTaken: round2(totTaken), totalNet: round2(totNet),
           avg: Math.round((totH / n) * 10) / 10, best: best };
}
function renderWorkLog(rebuildRows){
  var daysEl = document.getElementById('wlDays');
  if(!daysEl) return;
  var weekEl = document.getElementById('wlWeek');
  if(weekEl && document.activeElement !== weekEl) weekEl.value = wlDraftWeek();
  var draft = S.wlDraft;
  if(rebuildRows){
    daysEl.innerHTML = '';
    PLAN_DAYS.forEach(function(name, i){
      var pair = normTimePair(draft.times[i]);
      var hasT = !!(pair.s || pair.e);
      var open = !!wlTimesExpanded[i];
      var block = document.createElement('div');
      block.className = 'plan-day-block';
      var row = document.createElement('div');
      row.className = 'plan-day' + (num(draft.days[i]) > 8 ? ' over' : '');
      row.innerHTML =
        '<span class="plan-day-name">' + name + '</span>' +
        '<button class="plan-step" type="button" data-wl-dec="' + i + '" aria-label="Fewer hours ' + PLAN_DAY_FULL[i] + '">−</button>' +
        '<span class="plan-hrs-wrap"><input class="plan-hrs" type="number" inputmode="decimal" min="0" max="12" step="0.01" value="' + fmtHrsInput(draft.days[i]) + '" data-wl-hrs="' + i + '" aria-label="' + PLAN_DAY_FULL[i] + ' hours worked — type a number"><span class="plan-hrs-unit">hrs</span></span>' +
        '<button class="plan-step" type="button" data-wl-inc="' + i + '" aria-label="More hours ' + PLAN_DAY_FULL[i] + '">+</button>' +
        '<button class="plan-times-btn' + (hasT ? ' has' : '') + (open ? ' open' : '') + '" type="button" data-wl-times="' + i + '" aria-expanded="' + (open ? 'true' : 'false') + '" aria-label="Shift times for ' + PLAN_DAY_FULL[i] + '">' +
          (hasT ? '🕑 ' + fmtTimeShort(pair.s) + '–' + fmtTimeShort(pair.e) : '＋ times') + '</button>';
      block.appendChild(row);
      if(open){
        var trow = document.createElement('div');
        trow.className = 'plan-day-times';
        trow.innerHTML =
          '<label class="plan-time-field">Start <input type="time" value="' + esc(pair.s || '') + '" data-wl-start="' + i + '" aria-label="' + PLAN_DAY_FULL[i] + ' shift start"></label>' +
          '<label class="plan-time-field">End <input type="time" value="' + esc(pair.e || '') + '" data-wl-end="' + i + '" aria-label="' + PLAN_DAY_FULL[i] + ' shift end"></label>' +
          '<button class="plan-times-clear" type="button" data-wl-clear-times="' + i + '">Clear times</button>' +
          '<span class="plan-times-note" id="wlTimesNote' + i + '">' + esc(planTimesNoteFor(pair)) + '</span>';
        block.appendChild(trow);
      }
      daysEl.appendChild(block);
    });
  } else {
    var rowEls = daysEl.querySelectorAll('.plan-day');
    draft.days.forEach(function(v, i){
      var inp = daysEl.querySelector('[data-wl-hrs="' + i + '"]');
      if(inp && document.activeElement !== inp) inp.value = fmtHrsInput(v);
      if(rowEls[i]) rowEls[i].classList.toggle('over', num(v) > 8);
      var pair = normTimePair(draft.times[i]);
      var hasT = !!(pair.s || pair.e);
      var tb = daysEl.querySelector('[data-wl-times="' + i + '"]');
      if(tb){
        tb.classList.toggle('has', hasT);
        tb.textContent = hasT ? '🕑 ' + fmtTimeShort(pair.s) + '–' + fmtTimeShort(pair.e) : '＋ times';
      }
      var note = document.getElementById('wlTimesNote' + i);
      if(note) note.textContent = planTimesNoteFor(pair);
    });
  }
  var total = wlDraftTotal();
  var p = planScenarioPaycheck(total);
  document.getElementById('wlTotalLine').innerHTML =
    'Total: <strong>' + fmtPlanHrs(total) + '</strong> · take-home ≈ <strong>' + money(p.net) + '</strong>' +
    (num(S.rate) > 0 ? '' : ' <span class="hint">(set your rate on the Paycheck tab for real numbers)</span>');
  /* records header */
  var statsEl = document.getElementById('wlStats');
  var st = wlStats();
  if(!st){
    statsEl.innerHTML = '<p class="hint">No weeks logged yet — log your first week above and your records will build up here: most hours in a week, your average, and everything you\'ve earned.</p>';
  } else {
    var bd = bkParseDate(st.best.week);
    statsEl.innerHTML =
      '<div class="plan-pay-grid wl-stats-grid">' +
      '<div class="plan-pay-cell"><p class="plan-pay-label">Most hours in a week</p><p class="plan-pay-num">' + fmtPlanHrs(st.best.total) + '</p><p class="wl-stat-sub">week of ' + (bd ? bkDayLabel(bd, false) : st.best.week) + '</p></div>' +
      '<div class="plan-pay-cell"><p class="plan-pay-label">Average / week</p><p class="plan-pay-num">' + fmtPlanHrs(st.avg) + '</p><p class="wl-stat-sub">across ' + st.count + ' logged week' + (st.count === 1 ? '' : 's') + '</p></div>' +
      '<div class="plan-pay-cell"><p class="plan-pay-label">Total hours logged</p><p class="plan-pay-num">' + fmtPlanHrs(st.totalHours) + '</p><p class="wl-stat-sub">' + st.count + ' week' + (st.count === 1 ? '' : 's') + ' on record</p></div>' +
      '<div class="plan-pay-cell"><p class="plan-pay-label">Total gross logged</p><p class="plan-pay-num">' + money(st.totalGross) + '</p><p class="wl-stat-sub">before anything was taken out</p></div>' +
      '<div class="plan-pay-cell"><p class="plan-pay-label">Total taken</p><p class="plan-pay-num">' + money(st.totalTaken) + '</p><p class="wl-stat-sub">taxes + deductions, all weeks</p></div>' +
      '<div class="plan-pay-cell"><p class="plan-pay-label">Total take-home logged</p><p class="plan-pay-num">' + money(st.totalNet) + '</p><p class="wl-stat-sub">at the rates when each week was saved</p></div>' +
      '</div>';
  }
  /* history list, newest first (workLog is kept sorted desc) */
  var listEl = document.getElementById('wlList');
  if(!st){ listEl.innerHTML = ''; return; }
  var html = '';
  S.workLog.forEach(function(w){
    var wd = bkParseDate(w.week);
    var open = wlOpenEntry === w.id;
    /* v2.17.0 fix: the row, the detail line and the 💵 breakdown all
       read from wlEntryPay — for pre-v2.12 weeks (no stored breakdown)
       the stored gross/net could disagree with the live breakdown
       after a rate change; now every number on the entry matches. */
    var bd = wlEntryPay(w);
    var hasStoredPay = !!wlNormPay(w.pay);
    html += '<div class="wl-entry">' +
      '<div class="wl-entry-headrow">' +
      '<button class="wl-entry-head" type="button" data-wl-expand="' + esc(w.id) + '" aria-expanded="' + (open ? 'true' : 'false') + '">' +
      '<span><strong>Week of ' + (wd ? bkDayLabel(wd, true) : esc(w.week)) + '</strong></span>' +
      '<span class="wl-entry-sum">' + fmtPlanHrs(w.total) + ' · ' + money(bd.net) + ' take-home ' + (open ? '▴' : '▾') + '</span></button>' +
      '<button class="btn-mini danger bk-mini" type="button" data-wl-del="' + esc(w.id) + '">Delete</button>' +
      '</div>';
    if(open){
      var parts = [];
      for(var i = 0; i < 7; i++){
        var h = num(w.days[i]);
        var tp = normTimePair((w.times || [])[i]);
        var lbl = PLAN_DAYS[i] + ' ' + (h > 0 ? fmtPlanHrs(h) : '—');
        if(h > 0 && tp.s && tp.e) lbl += ' (' + fmtTime(tp.s) + '–' + fmtTime(tp.e) + ')';
        parts.push(lbl);
      }
      html += '<div class="wl-entry-detail">' + esc(parts.join(' · ')) +
        '<br>Gross ' + money(bd.gross) + ' · take-home ' + money(bd.net) +
        (hasStoredPay ? ' — figured with your pay-stub math when this week was saved.'
                      : ' — figured live from the logged hours with your current pay-stub math (this week predates saved breakdowns).');
      /* v2.12.0: the full pay picture for this week, same engine */
      var payOpen = !!wlPayOpen[w.id];
      html += '<br><button class="btn-chip wl-pay-btn" type="button" data-wl-pay="' + esc(w.id) + '" aria-expanded="' + (payOpen ? 'true' : 'false') + '">💵 Pay breakdown ' + (payOpen ? '▴' : '▾') + '</button>';
      if(payOpen){
        function payRow(label, amt, cls){
          return '<div class="wl-pay-row' + (cls ? ' ' + cls : '') + '"><span>' + esc(label) + '</span><span>' + amt + '</span></div>';
        }
        html += '<div class="wl-pay">' +
          payRow('Gross pay', money(bd.gross), 'wl-pay-grossrow');
        if(num(bd.otHrs) > 0.001){
          html += '<p class="wl-pay-ot">Includes ' + fmtHrs(bd.otHrs) + ' hrs overtime at 1.5× (overtime added ' + money(bd.otAmt) + ' of gross).</p>';
        }
        html += '<p class="wl-pay-sec">Taxes</p>';
        bd.taxes.forEach(function(l){ html += payRow(l.label, '−' + money(l.amt)); });
        html += payRow('Taxes total', money(bd.taxesTotal), 'wl-pay-sub');
        html += '<p class="wl-pay-sec">Deductions</p>';
        bd.deductions.forEach(function(l){ html += payRow(l.label, '−' + money(l.amt)); });
        html += payRow('Deductions total', money(bd.dedTotal), 'wl-pay-sub');
        html += payRow('Total taken', money(bd.totalTaken), 'wl-pay-taken');
        html += payRow('Net pay — take-home', money(bd.net), 'wl-pay-net');
        if(bd.estimate) html += '<p class="hint wl-pay-note">Estimated from tax tables — set up your pay stub in the Paycheck tab for exact numbers.</p>';
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div>';
  });
  listEl.innerHTML = html;
}
function bindWorkLog(){
  var daysEl = document.getElementById('wlDays');
  if(!daysEl) return;
  document.getElementById('wlWeek').addEventListener('change', function(e){
    S.wlDraft.week = e.target.value; save(); renderWorkLog(false);
  });
  daysEl.addEventListener('input', function(e){
    var t = e.target;
    if(!t.dataset) return;
    if(t.dataset.wlHrs !== undefined) wlSetDayTyped(+t.dataset.wlHrs, t.value);
    else if(t.dataset.wlStart !== undefined) wlSetDayTime(+t.dataset.wlStart, 's', t.value);
    else if(t.dataset.wlEnd !== undefined) wlSetDayTime(+t.dataset.wlEnd, 'e', t.value);
  });
  daysEl.addEventListener('change', function(e){
    var t = e.target;
    if(!t.dataset) return;
    if(t.dataset.wlHrs !== undefined) t.value = fmtHrsInput(S.wlDraft.days[+t.dataset.wlHrs]);
    else if(t.dataset.wlStart !== undefined) t.value = normTimePair(S.wlDraft.times[+t.dataset.wlStart]).s || '';
    else if(t.dataset.wlEnd !== undefined) t.value = normTimePair(S.wlDraft.times[+t.dataset.wlEnd]).e || '';
  });
  daysEl.addEventListener('click', function(e){
    var t = e.target;
    if(!t.dataset) return;
    if(t.dataset.wlTimes !== undefined){
      var i = +t.dataset.wlTimes;
      wlTimesExpanded[i] = !wlTimesExpanded[i];
      renderWorkLog(true);
      return;
    }
    if(t.dataset.wlClearTimes !== undefined){
      S.wlDraft.times[+t.dataset.wlClearTimes] = { s: '', e: '' };
      save(); renderWorkLog(true);
      return;
    }
    if(t.dataset.wlDec !== undefined) wlSetDay(+t.dataset.wlDec, num(S.wlDraft.days[+t.dataset.wlDec]) - 0.5);
    if(t.dataset.wlInc !== undefined) wlSetDay(+t.dataset.wlInc, num(S.wlDraft.days[+t.dataset.wlInc]) + 0.5);
  });
  document.getElementById('wlSave').addEventListener('click', wlSaveWeek);
  document.getElementById('wlCopyPlan').addEventListener('click', wlCopyPlan);
  document.getElementById('wlList').addEventListener('click', function(e){
    var t = e.target;
    var del = t.closest ? t.closest('[data-wl-del]') : null;
    if(del){ wlDelete(del.dataset.wlDel); return; }
    var pay = t.closest ? t.closest('[data-wl-pay]') : null;
    if(pay){
      var pid = pay.dataset.wlPay;
      wlPayOpen[pid] = !wlPayOpen[pid];
      renderWorkLog(false);
      return;
    }
    var exp = t.closest ? t.closest('[data-wl-expand]') : null;
    if(exp){
      wlOpenEntry = wlOpenEntry === exp.dataset.wlExpand ? null : exp.dataset.wlExpand;
      renderWorkLog(false);
    }
  });
}

/* ---------- v2.7.0: Class Schedule ----------
   Every class he takes (unlimited — add as many as he has), each with
   the days it meets and exact start/end times, lined up against the
   SCHOOL work plan in a week view that flags overlaps. Class time is
   exact to the minute and never gets a meal deduction — the 30-min
   meal rule belongs to paid work shifts only. The add/edit draft and
   the editing id live in module vars; only saved classes persist.
   v2.9.0: entries are classes OR practices (entry.kind). Practices
   are first-class timed entries: the suggester and the overlap
   checker route around them exactly like classes. A bare 'practice'
   day TAG in the planner carries no times, so on its own it blocks
   nothing here — the copy says practices need times added here.
   v2.11.0: the builder is TABBED — 🎓 Classes / 🏃 Practices /
   💪 Workouts (S.planHours.schedTab). The active tab fixes the kind
   of the entry being added and filters the list below the form, so
   he can stack up classes one after another, then switch tabs and
   do the same for practices and solo workouts. 'workout' is a third
   entry kind: it blocks suggested work, counts toward busy days,
   gets overlap warnings, and auto-tags its days 'workout' — exactly
   like the other kinds. */
var SCHED_KINDS = ['class', 'practice', 'workout'];
var SCHED_TABS = {
  class:    { icon: '🎓', plural: 'Classes',   word: 'class',
              nameLabel: 'Class name',    placeholder: 'Class name — e.g. ENV 350',
              addLabel: 'Add class',    giveName: 'Give the class a name first.',
              empty: 'No classes yet — add your first one above.' },
  practice: { icon: '🏃', plural: 'Practices', word: 'practice',
              nameLabel: 'Practice name', placeholder: 'Practice name — e.g. Track Practice',
              addLabel: 'Add practice', giveName: 'Give the practice a name first.',
              empty: 'No practices yet — add your first one above.' },
  workout:  { icon: '💪', plural: 'Workouts',  word: 'workout',
              nameLabel: 'Workout name',  placeholder: 'Workout name — e.g. Solo Workout',
              addLabel: 'Add workout',  giveName: 'Give the workout a name first.',
              empty: 'No workouts yet — add your first one above.' }
};
function schedTab(){
  var t = S.planHours && S.planHours.schedTab;
  return SCHED_KINDS.indexOf(t) >= 0 ? t : 'class';
}
function schedTabDef(kind){ return SCHED_TABS[SCHED_KINDS.indexOf(kind) >= 0 ? kind : 'class']; }
var classDraft = { kind: 'class', name: '', days: [], s: '08:00', e: '08:50' };
var classEditingId = null;
/* per-kind display bits: marker, capitalized label for pills/lines,
   and the lowercase word for sentences ("overlaps a practice") */
function entryKind(c){ return c && SCHED_KINDS.indexOf(c.kind) >= 0 ? c.kind : 'class'; }
function entryMarker(c){ return schedTabDef(entryKind(c)).icon; }
function entryKindLabel(c){ return entryKind(c) === 'practice' ? 'Practice' : (entryKind(c) === 'workout' ? 'Workout' : 'Class'); }
/* v2.8.0: the pending work-hours suggestion preview ({ target, result }
   from suggestWorkWeek) — module state only, never saved; it's stale
   the moment the classes or the target change, so those paths clear it */
var suggestPreviewData = null;
function suggestTargetHrs(){
  var t = normSuggestTarget(S.planHours && S.planHours.suggestTarget);
  return t === null ? 16 : t;
}
/* v2.14.0: run a fresh ✨ Suggest preview with the current target —
   shared by the Suggest button and the planner's "Plan from my
   schedule" shortcut, so both produce the identical preview */
function runSuggest(){
  var note = document.getElementById('suggestNote');
  if(!getClasses().length){
    suggestPreviewData = null;
    renderSuggest();
    if(note) note.textContent = 'Add at least one class, practice or workout first so I know what to work around.';
    return;
  }
  var tgt = suggestTargetHrs();
  suggestPreviewData = { target: tgt,
    result: suggestWorkWeek(getClasses(), S.planHours.schoolTags, tgt, suggestBusyThresholdHrs()) };
  if(note) note.textContent = '';
  renderSuggest();
}
/* v2.10.0: busy-day guard cutoff — scheduled hrs at/above which a
   day gets no suggested work */
function suggestBusyThresholdHrs(){
  var t = num(S.planHours && S.planHours.busyThresholdHrs, 5);
  return [4, 5, 6].indexOf(t) >= 0 ? t : 5;
}
function getClasses(){ return Array.isArray(S.classes) ? S.classes : []; }
function classById(id){
  var list = getClasses();
  for(var i = 0; i < list.length; i++) if(list[i].id === id) return list[i];
  return null;
}
/* minute-based overlap between two 'HH:MM' ranges (overnight rolls) */
function timesOverlap(s1, e1, s2, e2){
  var a1 = toMinutes(s1), b1 = toMinutes(e1); if(b1 <= a1) b1 += 1440;
  var a2 = toMinutes(s2), b2 = toMinutes(e2); if(b2 <= a2) b2 += 1440;
  return a1 < b2 && a2 < b1;
}
function classPreviewText(){
  if(classDraft.s && classDraft.e){
    var mins = exactMinutes(classDraft.s, classDraft.e);
    return fmtTime(classDraft.s) + ' – ' + fmtTime(classDraft.e) + ' · ' +
           fmtMinutes(mins) + ' (' + fmtHrsExact(mins / 60) + ' hrs)';
  }
  return 'Set a start and an end time to see the exact length.';
}
function resetClassForm(){
  /* the draft's kind is whatever tab is open — the tab IS the kind */
  classDraft = { kind: schedTab(), name: '', days: [], s: '08:00', e: '08:50' };
  classEditingId = null;
  var n = document.getElementById('classNameInput'); if(n) n.value = '';
  var st = document.getElementById('classStart'); if(st) st.value = '08:00';
  var en = document.getElementById('classEnd'); if(en) en.value = '08:50';
  var note = document.getElementById('classNote'); if(note) note.textContent = '';
}
/* v2.11.0: load an entry into the form for editing — jumps to the
   entry's own tab first, wherever the Edit tap came from */
function startClassEdit(c){
  if(!c) return;
  if(S.planHours.schedTab !== entryKind(c)){ S.planHours.schedTab = entryKind(c); save(); }
  classEditingId = c.id;
  classDraft = { kind: entryKind(c), name: c.name, days: c.days.slice(), s: c.s, e: c.e };
  document.getElementById('classNameInput').value = c.name;
  document.getElementById('classStart').value = c.s;
  document.getElementById('classEnd').value = c.e;
  document.getElementById('classNote').textContent = '';
  renderSchedule();
  var nameEl = document.getElementById('classNameInput');
  if(nameEl && nameEl.scrollIntoView) nameEl.scrollIntoView({ block: 'center' });
}
/* v2.15.0: the week view's data, computed ONCE — renderSchedule
   draws it as HTML and the week export (text file + PNG) draws the
   very same lines, so an export can never disagree with what is on
   screen. Items carry their plain-text form plus the bits the HTML
   renderer needs (entry id for tap-to-edit, work/conflict flags).
   The overlap check covers ALL kinds (v2.9.0 practices, v2.11.0
   workouts), exactly as the inline code did before this split. */
function weekViewData(){
  var classes = getClasses();
  var conflicts = [];
  var totalClassMins = 0, totalPracticeMins = 0, totalWorkoutMins = 0;
  classes.forEach(function(c){
    var m = exactMinutes(c.s, c.e) * c.days.length;
    var k = entryKind(c);
    if(k === 'practice') totalPracticeMins += m;
    else if(k === 'workout') totalWorkoutMins += m;
    else totalClassMins += m;
  });
  var workTotal = planTotal(S.planHours.school);
  var days = [];
  var hasContent = false;
  for(var i = 0; i < 7; i++){
    var dayClasses = classes.filter(function(c){ return c.days.indexOf(i) >= 0; })
      .slice().sort(function(a, b){ return a.s < b.s ? -1 : (a.s > b.s ? 1 : 0); });
    var pair = planDayTime('school', i);
    var items = [];
    dayClasses.forEach(function(c){
      items.push({ text: entryMarker(c) + ' ' + c.name + ' · ' + fmtTime(c.s) + ' – ' + fmtTime(c.e) +
        ' · ' + fmtMinutes(exactMinutes(c.s, c.e)), id: c.id, work: false, conflict: false });
    });
    /* v2.17.0 fix: a timed shift only counts as work when the day
       actually has planned hours — zeroing a day's hours (typing
       overrides, per the planner note) used to leave its old times
       showing a shift here and in the week export. The paid figure
       is the planned hours, the same number every total uses. */
    if(pair.s && pair.e && num(S.planHours.school[i]) > 0){
      var paid = num(S.planHours.school[i]);
      var hits = dayClasses.filter(function(c){ return timesOverlap(pair.s, pair.e, c.s, c.e); });
      hits.forEach(function(c){
        conflicts.push(PLAN_DAYS[i] + ': Work ' + fmtTime(pair.s) + ' – ' + fmtTime(pair.e) +
          ' overlaps ' + c.name + ' (' + fmtTime(c.s) + ' – ' + fmtTime(c.e) + ')');
      });
      var hitKinds = [];
      hits.forEach(function(c){ if(hitKinds.indexOf(entryKind(c)) === -1) hitKinds.push(entryKind(c)); });
      var hitText = ' — overlaps ' + hitKinds.map(function(k){ return 'a ' + k; }).join(' + ');
      items.push({ text: (hits.length ? '⚠️ ' : '💼 ') + 'Work ' + fmtTime(pair.s) + ' – ' + fmtTime(pair.e) +
        ' · ' + fmtHrsExact(paid) + ' paid hrs' + (hits.length ? hitText : ''), id: null, work: true, conflict: !!hits.length });
    } else if(num(S.planHours.school[i]) > 0){
      items.push({ text: '💼 Work · ' + fmtHrsExact(num(S.planHours.school[i])) +
        ' hrs planned (no times set — add them in the planner above to check overlaps)', id: null, work: true, conflict: false });
    }
    if(items.length) hasContent = true;
    days.push({ name: PLAN_DAY_FULL[i], items: items });
  }
  var totalsText = 'Classes: ' + fmtMinutes(totalClassMins) + ' / week · Practice: ' + fmtMinutes(totalPracticeMins) +
    ' / week · Workouts: ' + fmtMinutes(totalWorkoutMins) +
    ' / week · Work planned: ' + fmtHrsExact(workTotal) + ' hrs / week';
  return { days: days, totalsText: totalsText, conflicts: conflicts,
           workTotal: workTotal, hasContent: hasContent };
}

/* ---------- v2.15.0: export your week (📸 image / 📄 text file) ----------
   Both formats are built from weekViewData() — the same lines the
   on-screen week view renders — plus one pay line from the same
   wlPayBreakdown the Work Log and Suggest preview use. */
var WEEK_EXPORT_TITLE = '🗓️ Your week — classes, practices, workouts + work';

function weekVerdictLines(wv){
  if(wv.conflicts.length) return wv.conflicts.map(function(c){ return '⚠️ ' + c; });
  return ['No overlaps — work fits around your classes, practices and workouts. ✅'];
}
function weekPayLine(workTotal){
  var bd = wlPayBreakdown(workTotal);
  return '💵 Work pays: ' + money(bd.gross) + ' gross → ' + money(bd.totalTaken) + ' taken → ' +
    money(bd.net) + ' take-home / week' +
    (bd.estimate ? ' (estimate — set up your pay stub for exact numbers)' : '');
}
function buildWeekText(wv){
  var out = [WEEK_EXPORT_TITLE, ''];
  wv.days.forEach(function(day){
    out.push(day.name);
    if(day.items.length){
      day.items.forEach(function(it){ out.push(it.text); });
    } else out.push('Nothing scheduled');
    out.push('');
  });
  out.push(wv.totalsText);
  weekVerdictLines(wv).forEach(function(l){ out.push(l); });
  out.push(weekPayLine(wv.workTotal));
  return out.join('\n') + '\n';
}
function downloadBlob(blob, filename){
  if(!blob) return;
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(function(){
    if(a.parentNode) a.parentNode.removeChild(a);
    URL.revokeObjectURL(url);
  }, 500);
}
function weekExportNote(msg){
  var note = document.getElementById('weekExportNote');
  if(note) note.textContent = msg;
}

/* PNG card: drawn by hand on Canvas 2D (no libraries). Deep
   ink-navy ground, parchment text, copper day headings — the
   Sovereign palette as a shareable picture, 1080 wide, as tall as
   the week needs. Layout is measured BEFORE anything is drawn:
   every line's font steps down (20px floor; 14px hard floor for a
   rare line that still overflows there) until its measured width
   fits inside the margins, so nothing clips. */
var WEEK_PNG_STYLE = {
  title:   { size: 46, serif: true,  bold: true,  color: '#f4ecd9', indent: 0,  lh: 62, gap: 0 },
  day:     { size: 35, serif: true,  bold: true,  color: '#cf9455', indent: 0,  lh: 48, gap: 30 },
  item:    { size: 30, serif: false, bold: false, color: '#f4ecd9', indent: 30, lh: 44, gap: 2 },
  none:    { size: 30, serif: false, bold: false, color: '#a89a7d', indent: 30, lh: 44, gap: 2 },
  totals:  { size: 29, serif: false, bold: true,  color: '#f4ecd9', indent: 0,  lh: 44, gap: 32 },
  verdict: { size: 29, serif: false, bold: false, color: '#a89a7d', indent: 0,  lh: 44, gap: 4 },
  pay:     { size: 33, serif: true,  bold: true,  color: '#cf9455', indent: 0,  lh: 50, gap: 18 }
};
function weekPngFont(st, size){
  return (st.bold ? '700 ' : '') + size + 'px ' +
    (st.serif ? 'Georgia, "Times New Roman", serif' : '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif');
}
function weekImageLines(wv){
  var lines = [{ text: WEEK_EXPORT_TITLE, kind: 'title' }];
  wv.days.forEach(function(day){
    lines.push({ text: day.name, kind: 'day' });
    if(day.items.length){
      day.items.forEach(function(it){
        lines.push({ text: it.text, kind: it.conflict ? 'conflict' : 'item' });
      });
    } else lines.push({ text: 'Nothing scheduled', kind: 'none' });
  });
  lines.push({ text: wv.totalsText, kind: 'totals' });
  weekVerdictLines(wv).forEach(function(l){ lines.push({ text: l, kind: 'verdict' }); });
  lines.push({ text: weekPayLine(wv.workTotal), kind: 'pay' });
  return lines;
}
function drawWeekPng(wv, canvas){
  var W = 1080, M = 60, TOP = 54, BOT = 54;
  var lines = weekImageLines(wv);
  canvas.width = W;
  canvas.height = 10; /* re-set once measured — resets ctx state, so all styling happens after */
  var ctx = canvas.getContext('2d');
  var laid = lines.map(function(l){
    var st = WEEK_PNG_STYLE[l.kind] || WEEK_PNG_STYLE.item;
    if(l.kind === 'conflict') st = WEEK_PNG_STYLE.item;
    var size = st.size;
    ctx.font = weekPngFont(st, size);
    var maxW = W - M - st.indent - M;
    /* step down toward the 20px floor; a rare line that STILL does
       not fit there (the totals line runs ~110 chars) may continue
       to a 14px hard floor — an unclipped smaller line beats a
       bigger one running off the card */
    while(size > 14 && ctx.measureText(l.text).width > maxW){
      size = Math.max(14, size - 2);
      ctx.font = weekPngFont(st, size);
    }
    return { text: l.text, st: st, size: size, conflict: l.kind === 'conflict' };
  });
  var h = TOP + BOT;
  laid.forEach(function(l, i){ h += l.st.lh + (i ? l.st.gap : 0); });
  h += 29; /* the copper rule under the title: 12 gap + 3 rule + 14 gap */
  canvas.height = h;
  ctx.fillStyle = '#0c1424';
  ctx.fillRect(0, 0, W, h);
  ctx.strokeStyle = 'rgba(207, 148, 85, .45)';
  ctx.lineWidth = 2;
  if(ctx.strokeRect) ctx.strokeRect(19, 19, W - 38, h - 38);
  ctx.textBaseline = 'top';
  var y = TOP;
  laid.forEach(function(l, i){
    if(i) y += l.st.gap;
    ctx.font = weekPngFont(l.st, l.size);
    ctx.fillStyle = l.conflict ? '#f0b35e' : l.st.color;
    ctx.fillText(l.text, M + l.st.indent, y + Math.round((l.st.lh - l.size) / 2));
    y += l.st.lh;
    if(i === 0){
      y += 12;
      ctx.fillStyle = '#cf9455';
      ctx.fillRect(M, y, W - M * 2, 3);
      y += 14;
    }
  });
  return canvas;
}
function shareOrDownloadPng(blob){
  var file = null;
  try { file = new File([blob], 'my-week-plan.png', { type: 'image/png' }); } catch(e){ file = null; }
  if(file && typeof navigator !== 'undefined' && navigator.canShare && navigator.share){
    var ok = false;
    try { ok = !!navigator.canShare({ files: [file] }); } catch(e){ ok = false; }
    if(ok){
      var done = false;
      try {
        var p = navigator.share({ files: [file] });
        if(p && typeof p.catch === 'function'){
          p.catch(function(err){
            if(err && err.name === 'AbortError') return; /* he closed the sheet — his call, stay silent */
            if(!done){ done = true; downloadBlob(blob, 'my-week-plan.png'); }
          });
        }
      } catch(e){ downloadBlob(blob, 'my-week-plan.png'); }
      return;
    }
  }
  downloadBlob(blob, 'my-week-plan.png');
}
function exportWeek(kind){
  var wv = weekViewData();
  if(!wv.hasContent){
    weekExportNote('Add classes or plan work first, then export your week.');
    return;
  }
  weekExportNote('');
  if(kind === 'text'){
    downloadBlob(new Blob([buildWeekText(wv)], { type: 'text/plain;charset=utf-8' }), 'my-week-plan.txt');
    return;
  }
  var canvas = document.createElement('canvas');
  drawWeekPng(wv, canvas);
  if(canvas.toBlob){
    canvas.toBlob(function(blob){ if(blob) shareOrDownloadPng(blob); }, 'image/png');
  }
}

function renderSchedule(){
  var listEl = document.getElementById('classList');
  if(!listEl) return;
  /* form chrome only — the name/time input VALUES are never rewritten
     here, so typing in the form is never clobbered by a re-render */
  var chipsEl = document.getElementById('classDayChips');
  if(chipsEl){
    var chips = chipsEl.querySelectorAll('[data-class-day]');
    for(var ci = 0; ci < chips.length; ci++){
      var on = classDraft.days.indexOf(+chips[ci].dataset.classDay) >= 0;
      chips[ci].classList.toggle('active', on);
      chips[ci].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  /* v2.11.0: tab row — highlight the open tab; the form's name field
     and Add button follow the tab (the tab fixes the entry kind) */
  var tab = schedTab(), tabDef = schedTabDef(tab);
  var tabsEl = document.getElementById('schedTabs');
  if(tabsEl){
    var tChips = tabsEl.querySelectorAll('[data-sched-tab]');
    for(var ti = 0; ti < tChips.length; ti++){
      var tOn = tChips[ti].dataset.schedTab === tab;
      tChips[ti].classList.toggle('active', tOn);
      tChips[ti].setAttribute('aria-pressed', tOn ? 'true' : 'false');
    }
  }
  var nameLabel = document.getElementById('classNameLabel');
  if(nameLabel) nameLabel.textContent = tabDef.nameLabel;
  var nameInput = document.getElementById('classNameInput');
  if(nameInput) nameInput.placeholder = tabDef.placeholder;
  var prev = document.getElementById('classPreview');
  if(prev) prev.textContent = classPreviewText();
  var addBtn = document.getElementById('classAddBtn');
  if(addBtn) addBtn.textContent = classEditingId ? 'Save changes' : tabDef.addLabel;
  var cancelBtn = document.getElementById('classCancelEdit');
  if(cancelBtn) cancelBtn.hidden = !classEditingId;
  var anotherBtn = document.getElementById('classAddAnother');
  if(anotherBtn) anotherBtn.textContent = '＋ Add another ' + tabDef.word;

  /* saved entries — ONLY the open tab's kind, sorted by name, then
     first day, then start time; each row keeps its kind pill */
  var classes = getClasses();
  var tabEntries = classes.filter(function(c){ return entryKind(c) === tab; })
    .slice().sort(function(a, b){
      var an = a.name.toLowerCase(), bn = b.name.toLowerCase();
      if(an !== bn) return an < bn ? -1 : 1;
      var ad = a.days.length ? a.days[0] : 7, bd = b.days.length ? b.days[0] : 7;
      if(ad !== bd) return ad - bd;
      return a.s < b.s ? -1 : (a.s > b.s ? 1 : 0);
    });
  if(!tabEntries.length){
    listEl.innerHTML = '<p class="hint">' + tabDef.empty + '</p>';
  } else {
    var html = '';
    tabEntries.forEach(function(c){
      var mins = exactMinutes(c.s, c.e);
      var daysStr = c.days.map(function(d){ return PLAN_DAYS[d]; }).join('/');
      html += '<div class="class-row">' +
        '<div class="class-row-info"><strong>' + entryMarker(c) + ' ' + esc(c.name) + '</strong>' +
        '<div class="class-row-sub"><span class="class-kind-pill ' + entryKind(c) + '">' + entryKindLabel(c) + '</span> ' +
        esc(daysStr) + ' · ' + esc(fmtTime(c.s)) + ' – ' + esc(fmtTime(c.e)) +
        ' · ' + fmtMinutes(mins) + ' (' + fmtHrsExact(mins / 60) + ' hrs)</div></div>' +
        '<div class="class-row-actions">' +
        '<button class="btn-mini bk-mini" type="button" data-class-edit="' + esc(c.id) + '">Edit</button>' +
        '<button class="btn-mini danger bk-mini" type="button" data-class-del="' + esc(c.id) + '">Delete</button>' +
        '</div></div>';
    });
    listEl.innerHTML = html;
  }

  /* week view: classes, practices + workouts vs the school work
     plan, day by day — computed by weekViewData() (v2.15.0) so the
     on-screen view and the week export always agree */
  var wv = weekViewData();
  var weekEl = document.getElementById('classWeek');
  if(weekEl){
    var wHtml = '';
    wv.days.forEach(function(day){
      var lines = '';
      day.items.forEach(function(it){
        if(it.id){
          lines += '<div class="class-week-line" data-class-edit="' + esc(it.id) + '" title="Tap to edit">' + esc(it.text) + '</div>';
        } else {
          lines += '<div class="class-week-line work' + (it.conflict ? ' conflict' : '') + '">' + esc(it.text) + '</div>';
        }
      });
      wHtml += '<div class="class-week-day"><span class="class-week-name">' + day.name + '</span>' +
        (lines || '<div class="class-week-line none">Nothing scheduled</div>') + '</div>';
    });
    weekEl.innerHTML = wHtml;
  }
  var sumEl = document.getElementById('classSummary');
  if(sumEl){
    if(wv.conflicts.length){
      sumEl.innerHTML = esc(wv.totalsText) + '<br>' +
        wv.conflicts.map(function(c){ return '⚠️ ' + esc(c); }).join('<br>');
    } else {
      sumEl.innerHTML = esc(wv.totalsText) + '<br>No overlaps — work fits around your classes, practices and workouts. ✅';
    }
  }
  renderSuggest();
}
/* v2.8.0: ✨ Suggest my work hours — target chips + preview. The
   preview is a proposal only: nothing in the school plan changes
   until Apply is tapped, and Apply says so right in the preview. */
function renderSuggest(){
  var chipsEl = document.getElementById('suggestTargets');
  if(chipsEl){
    var chips = chipsEl.querySelectorAll('[data-suggest-target]');
    for(var ci = 0; ci < chips.length; ci++){
      var on = +chips[ci].dataset.suggestTarget === suggestTargetHrs();
      chips[ci].classList.toggle('active', on);
      chips[ci].setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  /* v2.14.0: the typeable target mirrors the saved value — except
     while it's focused, so re-renders never fight his typing */
  var tgtInput = document.getElementById('suggestTargetInput');
  if(tgtInput && document.activeElement !== tgtInput) tgtInput.value = suggestTargetHrs();
  /* v2.10.0: busy-day cutoff chips + the explainer line, which
     always names the current cutoff */
  var busyEl = document.getElementById('suggestBusyThreshold');
  if(busyEl){
    var bChips = busyEl.querySelectorAll('[data-suggest-busy]');
    for(var bi = 0; bi < bChips.length; bi++){
      var bOn = +bChips[bi].dataset.suggestBusy === suggestBusyThresholdHrs();
      bChips[bi].classList.toggle('active', bOn);
      bChips[bi].setAttribute('aria-pressed', bOn ? 'true' : 'false');
    }
  }
  var busyNote = document.getElementById('suggestBusyNote');
  if(busyNote) busyNote.textContent = 'Busy-day guard: if a day\u2019s classes, practice + workouts add up to ' +
    suggestBusyThresholdHrs() + '+ hrs, Suggest won\u2019t put work on it — that day stays yours.';
  var prevEl = document.getElementById('suggestPreview');
  if(!prevEl) return;
  if(!suggestPreviewData){ prevEl.innerHTML = ''; return; }
  var res = suggestPreviewData.result, tgt = suggestPreviewData.target;
  var html = '';
  res.days.forEach(function(dy, i){
    var offHtml = '<span class="suggest-off">off</span>';
    if(!dy && res.dayInfo && res.dayInfo[i]){
      var info = res.dayInfo[i];
      if(info.state === 'sunday') offHtml = '<span class="suggest-off">off — rest day</span>';
      else if(info.state === 'meet') offHtml = '<span class="suggest-off">off — meet day</span>';
      else if(info.state === 'busy') offHtml = '<span class="suggest-busy">🚫 no work — busy day (' +
        esc(fmtMinutes(info.scheduledMinutes)) + ' of classes, practice + workouts)</span>';
    }
    html += '<div class="suggest-line"><span class="suggest-day">' + PLAN_DAYS[i] + '</span>' +
      (dy ? '<span>' + esc(fmtTime(dy.s)) + ' – ' + esc(fmtTime(dy.e)) + ' · ' + fmtHrsExact(dy.paid) + ' paid hrs</span>'
          : offHtml) + '</div>';
  });
  html += '<p class="suggest-total">Total: <strong>' + fmtHrsExact(res.totalPaid) + ' paid hrs</strong> (target ' + tgt + 'h)</p>';
  if(res.shortfall > 0){
    html += '<p class="suggest-warn">Your classes and practices only leave room for ~' + fmtHrsExact(res.totalPaid) +
      ' paid hrs — short of the ' + tgt + 'h target.</p>';
  }
  /* v2.14.0: 💵 This plan pays — the full real pay for the plan's
     ACTUAL paid hrs, from the same wlPayBreakdown the Work Log
     uses: gross, every tax/deduction line, total taken, net, and
     about per month. Rendered with the Work Log's pay classes so
     the two breakdowns always look identical. */
  var bd = wlPayBreakdown(res.totalPaid);
  function sgPayRow(label, amt, cls){
    return '<div class="wl-pay-row' + (cls ? ' ' + cls : '') + '"><span>' + esc(label) + '</span><span>' + amt + '</span></div>';
  }
  html += '<div class="wl-pay suggest-pay"><p class="suggest-pay-head">💵 This plan pays</p>' +
    sgPayRow('Gross pay', money(bd.gross), 'wl-pay-grossrow');
  if(num(bd.otHrs) > 0.001){
    html += '<p class="wl-pay-ot">Includes ' + fmtHrs(bd.otHrs) + ' hrs overtime at 1.5× (overtime added ' + money(bd.otAmt) + ' of gross).</p>';
  }
  html += '<p class="wl-pay-sec">Taxes</p>';
  bd.taxes.forEach(function(l){ html += sgPayRow(l.label, '−' + money(l.amt)); });
  html += sgPayRow('Taxes total', money(bd.taxesTotal), 'wl-pay-sub');
  html += '<p class="wl-pay-sec">Deductions</p>';
  bd.deductions.forEach(function(l){ html += sgPayRow(l.label, '−' + money(l.amt)); });
  html += sgPayRow('Deductions total', money(bd.dedTotal), 'wl-pay-sub');
  html += sgPayRow('Total taken', money(bd.totalTaken), 'wl-pay-taken');
  html += sgPayRow('Net pay — take-home', money(bd.net), 'wl-pay-net');
  html += sgPayRow('Take-home / month (avg)', '≈ ' + money0(bd.net * 52 / 12), 'wl-pay-sub');
  if(bd.estimate) html += '<p class="hint wl-pay-note">Estimated from tax tables — set up your pay stub in the Paycheck tab for exact numbers.</p>';
  html += '</div>';
  html += '<p class="hint">Applying replaces your current school-week plan — the hours and the shift times. You can still edit any day in the planner afterwards.</p>' +
    '<div class="bk-actions">' +
    '<button class="btn-primary" type="button" id="suggestApply">Apply to my school plan</button>' +
    '<button class="btn-chip" type="button" id="suggestDiscard">Discard</button></div>';
  prevEl.innerHTML = html;
  document.getElementById('suggestApply').addEventListener('click', applySuggestion);
  document.getElementById('suggestDiscard').addEventListener('click', function(){
    suggestPreviewData = null;
    renderSuggest();
  });
}
function applySuggestion(){
  if(!suggestPreviewData) return;
  var res = suggestPreviewData.result;
  S.planHours.term = 'school';
  res.days.forEach(function(dy, i){
    if(dy){ S.planHours.school[i] = dy.paid; S.planHours.schoolTimes[i] = { s: dy.s, e: dy.e }; }
    else { S.planHours.school[i] = 0; S.planHours.schoolTimes[i] = { s: '', e: '' }; }
  });
  suggestPreviewData = null;
  save();
  renderPlanHours(true);
  renderSchedule();
  var note = document.getElementById('suggestNote');
  if(note) note.textContent = 'Suggested week applied to your school plan.';
}
function bindSchedule(){
  var chipsEl = document.getElementById('classDayChips');
  if(!chipsEl) return;
  /* v2.11.0: schedule tabs — the open tab fixes the kind of the
     entry being added and filters the list. Switching tabs cancels
     any in-progress edit cleanly; saved entries are never touched. */
  var tabsEl = document.getElementById('schedTabs');
  if(tabsEl) tabsEl.addEventListener('click', function(e){
    var t = e.target;
    var chip = t.closest ? t.closest('[data-sched-tab]') : null;
    if(!chip) return;
    var k = chip.dataset.schedTab;
    if(SCHED_KINDS.indexOf(k) === -1 || k === schedTab()) return;
    S.planHours.schedTab = k;
    resetClassForm(); /* draft now belongs to the new tab; edit cleared */
    save();
    renderSchedule();
  });
  chipsEl.addEventListener('click', function(e){
    var t = e.target;
    if(!t.dataset || t.dataset.classDay === undefined) return;
    var d = +t.dataset.classDay;
    var ix = classDraft.days.indexOf(d);
    if(ix >= 0) classDraft.days.splice(ix, 1); else classDraft.days.push(d);
    classDraft.days.sort(function(a, b){ return a - b; });
    renderSchedule();
  });
  var nameEl = document.getElementById('classNameInput');
  /* typing updates the draft only — no re-render, focus stays put */
  nameEl.addEventListener('input', function(){ classDraft.name = nameEl.value; });
  var sEl = document.getElementById('classStart'), eEl = document.getElementById('classEnd');
  function onTime(){
    classDraft.s = sEl.value || '';
    classDraft.e = eEl.value || '';
    var prev = document.getElementById('classPreview');
    if(prev) prev.textContent = classPreviewText();
  }
  sEl.addEventListener('input', onTime); sEl.addEventListener('change', onTime);
  eEl.addEventListener('input', onTime); eEl.addEventListener('change', onTime);
  document.getElementById('classCancelEdit').addEventListener('click', function(){
    resetClassForm(); renderSchedule();
  });
  document.getElementById('classAddBtn').addEventListener('click', function(){
    var note = document.getElementById('classNote');
    var name = String(classDraft.name || '').trim();
    /* v2.11.0: the kind is fixed by the open tab */
    var kind = schedTab();
    var tabDef = schedTabDef(kind);
    if(!name){ note.textContent = tabDef.giveName; return; }
    if(!classDraft.days || !classDraft.days.length){ note.textContent = 'Pick at least one day.'; return; }
    var pair = normTimePair({ s: classDraft.s, e: classDraft.e });
    if(!pair.s || !pair.e){ note.textContent = 'Set a start and an end time.'; return; }
    if(!Array.isArray(S.classes)) S.classes = [];
    var days = classDraft.days.slice().sort(function(a, b){ return a - b; });
    var existing = classEditingId ? classById(classEditingId) : null;
    var wasEdit = !!existing;
    if(existing){
      existing.kind = kind;
      existing.name = name; existing.days = days; existing.s = pair.s; existing.e = pair.e;
    } else {
      S.classes.push({ id: newClassId(), kind: kind, name: name, days: days, s: pair.s, e: pair.e });
    }
    /* tag those days in the school plan with the entry's own kind —
       'class', 'practice' or 'workout' (add-only, never removed —
       deleting an entry leaves the tags alone) */
    days.forEach(function(d){
      var tags = S.planHours.schoolTags[d];
      if(Array.isArray(tags) && tags.indexOf(kind) === -1) tags.push(kind);
    });
    suggestPreviewData = null; /* entries changed — any preview is stale */
    save();
    resetClassForm(); /* form clears, stays on the same tab */
    renderPlanHours(true);
    renderSchedule();
    /* add-another flow: confirm the add and invite the next one */
    var note2 = document.getElementById('classNote');
    if(note2) note2.textContent = wasEdit ? (name + ' updated.') : ('Added ' + name + ' — add another, or switch tabs.');
  });
  /* v2.11.0: "＋ Add another …" under the list — back to the form */
  var anotherBtn = document.getElementById('classAddAnother');
  if(anotherBtn) anotherBtn.addEventListener('click', function(){
    var nameEl2 = document.getElementById('classNameInput');
    if(nameEl2){
      if(nameEl2.scrollIntoView) nameEl2.scrollIntoView({ block: 'center' });
      nameEl2.focus();
    }
  });
  document.getElementById('classList').addEventListener('click', function(e){
    var t = e.target;
    var editBtn = t.closest ? t.closest('[data-class-edit]') : null;
    if(editBtn){
      startClassEdit(classById(editBtn.dataset.classEdit));
      return;
    }
    var delBtn = t.closest ? t.closest('[data-class-del]') : null;
    if(delBtn){
      var id = delBtn.dataset.classDel;
      S.classes = getClasses().filter(function(c){ return c.id !== id; });
      if(classEditingId === id) resetClassForm();
      suggestPreviewData = null; /* classes changed — preview is stale */
      save();
      renderSchedule();
    }
  });
  /* v2.11.0: tapping an entry line in the week view edits it too */
  var weekEl2 = document.getElementById('classWeek');
  if(weekEl2) weekEl2.addEventListener('click', function(e){
    var t = e.target;
    var line = t.closest ? t.closest('[data-class-edit]') : null;
    if(line) startClassEdit(classById(line.dataset.classEdit));
  });
  /* v2.15.0: export the week view — 📸 image (share sheet when the
     browser offers one, else a PNG download) or 📄 text file */
  var expImg = document.getElementById('weekExportImg');
  if(expImg) expImg.addEventListener('click', function(){ exportWeek('image'); });
  var expTxt = document.getElementById('weekExportTxt');
  if(expTxt) expTxt.addEventListener('click', function(){ exportWeek('text'); });
  /* v2.8.0: suggest-target chips + the Suggest button */
  var sugChips = document.getElementById('suggestTargets');
  if(sugChips) sugChips.addEventListener('click', function(e){
    var t = e.target;
    if(!t.dataset || t.dataset.suggestTarget === undefined) return;
    var v = +t.dataset.suggestTarget;
    if([12, 16, 20].indexOf(v) === -1) return;
    S.planHours.suggestTarget = v;
    suggestPreviewData = null; /* a different target makes the preview stale */
    save();
    renderSuggest();
  });
  /* v2.10.0: busy-day cutoff chips */
  var busyChips = document.getElementById('suggestBusyThreshold');
  if(busyChips) busyChips.addEventListener('click', function(e){
    var t = e.target;
    if(!t.dataset || t.dataset.suggestBusy === undefined) return;
    var bv = +t.dataset.suggestBusy;
    if([4, 5, 6].indexOf(bv) === -1) return;
    S.planHours.busyThresholdHrs = bv;
    suggestPreviewData = null; /* a different cutoff makes the preview stale */
    save();
    renderSuggest();
  });
  var sugBtn = document.getElementById('suggestBtn');
  if(sugBtn) sugBtn.addEventListener('click', runSuggest);
  /* v2.14.0: typeable target — committing the field (blur / Enter)
     normalizes it: 2–30 hrs, half-hour steps. Garbage snaps back to
     the last valid target instead of saving nonsense. */
  var sugInput = document.getElementById('suggestTargetInput');
  if(sugInput) sugInput.addEventListener('change', function(){
    var v = normSuggestTarget(sugInput.value);
    if(v === null){ sugInput.value = suggestTargetHrs(); return; }
    S.planHours.suggestTarget = v;
    suggestPreviewData = null; /* a different target makes the preview stale */
    save();
    renderSuggest();
  });
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
    el.textContent = fmtFn(target); el._moneyCurrent = target;
    if(el.id === 'donutLeft') fitDonutValue();
    return;
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
    else { el._moneyRaf = 0; el._moneyCurrent = target; el.textContent = fmtFn(target); if(el.id === 'donutLeft') fitDonutValue(); }
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
      c._fresh = true; /* v2.17.0: brand-new slice — sweeps in below */
      svg.appendChild(c);
      donutCircleEls.push(c);
    }
    c.setAttribute('stroke', s.color);
    var dashStr = dash.toFixed(1) + ' ' + (C - dash).toFixed(1);
    var offStr = (-acc).toFixed(1);
    if(c._fresh && !REDUCED_MOTION && typeof requestAnimationFrame !== 'undefined'){
      /* start the new slice empty and let the CSS transition glide it
         to size on the next frame; the token stops a stale frame from
         overwriting a newer render */
      var tok = (c._animToken || 0) + 1; c._animToken = tok;
      c.setAttribute('stroke-dasharray', '0 ' + C.toFixed(1));
      c.setAttribute('stroke-dashoffset', offStr);
      (function(cc, ds, os, tk){
        requestAnimationFrame(function(){
          if(cc._animToken === tk){ cc.setAttribute('stroke-dasharray', ds); cc.setAttribute('stroke-dashoffset', os); }
        });
      })(c, dashStr, offStr, tok);
    } else {
      c._animToken = (c._animToken || 0) + 1;
      c.setAttribute('stroke-dasharray', dashStr);
      c.setAttribute('stroke-dashoffset', offStr);
    }
    c._fresh = false;
    acc += dash;
    /* v2.0.0: tap/hover a slice to see its details.
       v2.17.0 fix: circles are REUSED across renders, so the label /
       value / total are refreshed on the element every render and the
       (once-bound) handler reads the current ones — binding the first
       render's numbers into the closure left taps showing stale
       details after any edit. */
    c._sliceLabel = s.label || 'Slice';
    c._sliceValue = s.value;
    c._sliceTotal = total;
    if(!c._detailBound){
      c._detailBound = true;
      c.style.cursor = 'pointer';
      var showDetail = function(){
        var d = document.getElementById('donutDetail');
        var t = c._sliceTotal, v = c._sliceValue;
        if(d && t > 0) d.textContent = c._sliceLabel + ' — ' + money(v) + ' (' + Math.round(v / t * 100) + '% of ' + money(t) + ')';
      };
      c.addEventListener('click', showDetail);
      c.addEventListener('mouseover', showDetail);
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
  renderPlanHours(true);
  renderWorkLog(true);
  renderSchedule();
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

/* v2.4.3: auto-shrink the donut center amount so big numbers never
   overflow the hole and touch the ring. Canvas-measured, serif kept. */
var _donutFitCanvas = null;
var _donutFitBasePx = 0;
function fitDonutValue(){
  if(!fitDonutValue._bound){
    fitDonutValue._bound = true;
    window.addEventListener('resize', fitDonutValue);
    window.addEventListener('orientationchange', fitDonutValue);
  }
  var dl = document.getElementById('donutLeft');
  var wrap = document.querySelector('.donut-wrap');
  if(!dl || !wrap || !wrap.clientWidth) return;
  if(!_donutFitCanvas){ _donutFitCanvas = document.createElement('canvas'); }
  var ctx = _donutFitCanvas.getContext('2d');
  if(!ctx) return;
  if(!_donutFitBasePx){
    var basePx = 29.6;
    try{ basePx = parseFloat(window.getComputedStyle(dl).fontSize) || 29.6; }catch(e){}
    _donutFitBasePx = basePx;
  }
  var text = dl.textContent || '';
  /* donut hole = 126/200 of the wrap width; keep an 8% margin inside it */
  var maxW = wrap.clientWidth * 0.63 * 0.92;
  var size = _donutFitBasePx, MIN = 11, guard = 0;
  ctx.font = '';
  while(size > MIN && guard++ < 40){
    ctx.font = '700 ' + size + 'px Georgia,"Times New Roman",serif';
    if(ctx.measureText(text).width <= maxW) break;
    size -= 1;
  }
  dl.style.fontSize = size + 'px';
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
  /* v2.17.0: per-day pace — what's left spread over the days left in
     the month, so a monthly leftover becomes a daily number he can
     actually steer by. Pure display math; no state. */
  var pdEl = document.getElementById('perDayLine');
  if(pdEl){
    var nowD = new Date();
    var daysLeftInMonth = new Date(nowD.getFullYear(), nowD.getMonth() + 1, 0).getDate() - nowD.getDate() + 1;
    if(left > 0){
      pdEl.hidden = false;
      pdEl.textContent = 'That\u2019s about ' + money(round2(left / daysLeftInMonth)) + ' a day for the rest of the month (' + daysLeftInMonth + (daysLeftInMonth === 1 ? ' day' : ' days') + ' left, today included).';
    } else if(left < 0){
      pdEl.hidden = false;
      pdEl.textContent = 'To get back to zero by month\u2019s end, trim about ' + money(round2(-left / daysLeftInMonth)) + ' a day for the next ' + daysLeftInMonth + (daysLeftInMonth === 1 ? ' day' : ' days') + '.';
    } else pdEl.hidden = true;
  }
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
  document.getElementById('donutSub').textContent = left >= 0 ? 'this month' : 'over budget';
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
    : 'No income yet — set your hours and rate in the Paycheck tab.';
  /* live stamp: proves the numbers just re-rendered */
  var stampEl = document.getElementById('budgetUpdatedStamp');
  if(stampEl) stampEl.textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  /* starting-money source: an override, once typed, wins over the balances
     until cleared — make that visible instead of silent */
  var overrideActive = (S.startingMoney !== null && S.startingMoney !== undefined && S.startingMoney !== '' && isFinite(Number(S.startingMoney)));
  var srcEl = document.getElementById('startingMoneySource');
  if(srcEl) srcEl.textContent = overrideActive
    ? 'Using what you typed (' + money(S.startingMoney) + '). My Money won\u2019t change this until you clear it.'
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
  if(!S.categories.length){
    /* v2.17.0: an empty list said nothing — name the one next action */
    list.innerHTML = '<p class="hint">No spending categories yet — add one below and this becomes your monthly plan.</p>';
    return;
  }
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
  /* v2.17.0: smooth-scroll only when motion is welcome */
  window.scrollTo({ top: 0, behavior: REDUCED_MOTION ? 'auto' : 'smooth' });
}

function bind(){
  document.querySelectorAll('.nav-btn').forEach(function(b){
    b.addEventListener('click', function(){ switchView(b.dataset.view); });
  });
  bindEarn();
  bindPlanHours();
  bindWorkLog();
  bindSchedule();
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
    /* v2.17.0: an imported state gets the SAME normalization as a
       first load (normalizeState) — a code made by an older version
       may predate the Class Schedule, the planner fields, the Work
       Log, the 😴 sleep schedule or the ded split, and patching only
       some of them here left the rest undefined and broke renders. */
    normalizeState();
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
      { id: 'usertesting', url: 'https://www.usertesting.com/get-paid-to-test', name: 'UserTesting', desc: '$10 per ~20-min test · up to $60+ live interviews', lo: 40, hi: 80, math: '\u22484\u20138 tests/mo' },
      { id: 'trymyui', url: 'https://trymata.com/testers', name: 'TryMyUI (Trymata)', desc: '$10 per ~20-min test', lo: 20, hi: 40, math: '\u22482\u20134 tests/mo' },
      { id: 'userlytics', url: 'https://www.userlytics.com/tester/', name: 'Userlytics', desc: '$5\u201390 per test', lo: 10, hi: 50, math: '\u22482 tests/mo' },
      { id: 'userinterviews', url: 'https://www.userinterviews.com/become-a-participant', name: 'User Interviews', desc: '$50\u2013200+ per study', lo: 25, hi: 100, math: '\u22481 study every 2 mo' },
      { id: 'intellizoom', url: 'https://www.intellizoom.com/testers', name: 'IntelliZoom (UserZoom)', desc: '$5\u201310 per test', lo: 15, hi: 30, math: '\u22483 tests/mo' },
      { id: 'userbrain', url: 'https://userbrain.com/tester', name: 'UserBrain', desc: '$3\u20135 per test', lo: 10, hi: 20, math: '\u22484 tests/mo' },
      { id: 'respondent', url: 'https://app.respondent.io/participants', name: 'Respondent.io', desc: '$50\u2013200 per session', lo: 15, hi: 65, math: '\u22481 session every 3 mo' },
      { id: 'userfeel', url: 'https://www.userfeel.com/en/testers', name: 'Userfeel', desc: '$3\u201330 per test', lo: 5, hi: 30, math: '\u22482 tests/mo' },
      { id: 'testbirds', url: 'https://www.testbirds.com/tester/', name: 'Testbirds', desc: '\u20AC10\u201350 per test', lo: 10, hi: 50, math: '\u22481 test/mo' },
      { id: 'testingtime', url: 'https://www.testingtime.com/become-a-test-user', name: 'TestingTime', desc: '\u20AC20\u201355 per test', lo: 20, hi: 55, math: '\u22481 test/mo' },
      { id: 'betatesting', url: 'https://betatesting.com/beta-testers', name: 'BetaTesting', desc: '$10\u2013150+ per test', lo: 10, hi: 75, math: '\u22481 test/mo' }
    ] },
  { name: '\u2699\uFE0F Microtasks & research',
    note: null,
    options: [
      { id: 'prolific', url: 'https://www.prolific.com/', name: 'Prolific', desc: 'Academic studies — the best-paying survey site', lo: 20, hi: 60, math: null },
      { id: 'rev', url: 'https://www.rev.com/freelancers/transcription', name: 'Rev / TranscribeMe', desc: 'Transcription, paid per audio minute', lo: 30, hi: 80, math: null },
      { id: 'appen', url: 'https://appen.com/jobs/', name: 'Appen / Clickworker / Telus', desc: 'Data annotation tasks', lo: 20, hi: 60, math: null },
      { id: 'campusresearch', name: 'Campus research studies', desc: 'Check Plattsburgh psych department postings', lo: 10, hi: 40, math: null }
    ] },
  { name: '\uD83D\uDCBB Freelance & remote',
    note: null,
    options: [
      { id: 'va', name: 'Virtual assistant', desc: '$15\u201325/hr — email, scheduling, data entry', lo: 180, hi: 300, math: '3 hrs/wk \u00D7 $20/hr' },
      { id: 'fiverr', url: 'https://www.fiverr.com/', name: 'Fiverr / Upwork', desc: 'Freelance writing and small gigs', lo: 50, hi: 150, math: null },
      { id: 'printify', url: 'https://www.printify.com/', name: 'Printify', desc: 'Print-on-demand — no inventory needed', lo: 0, hi: 50, math: 'slow ramp' }
    ] },
  { name: '\uD83D\uDCB0 Sell what you know or own',
    note: null,
    options: [
      { id: 'stuvia', url: 'https://www.stuvia.com/', name: 'Stuvia / Nexus Notes', desc: 'Sell your class notes', lo: 10, hi: 40, math: null },
      { id: 'sellitems', url: 'https://www.facebook.com/marketplace/', name: 'Sell owned items', desc: 'Facebook Marketplace — meet on campus in public', lo: 20, hi: 100, math: null },
      { id: 'trackguide', url: 'https://gumroad.com/', name: 'Track training guide (PDF)', desc: 'Gumroad/Etsy — your own knowledge only, never promise \u201Cguaranteed\u201D results', lo: 10, hi: 60, math: null }
    ] },
  { name: '\uD83C\uDFEB Campus',
    note: null,
    options: [
      { id: 'handshake', url: 'https://joinhandshake.com/', name: 'Handshake campus job', desc: '\u2248$16\u201316.50/hr', lo: 260, hi: 300, math: '4 hrs/wk \u00D7 $16.25' },
      { id: 'coaching', name: 'Private sprint coaching', desc: '$30\u201350/hr — MUST clear with Plattsburgh athletics compliance first', lo: 240, hi: 400, math: '2 hrs/wk \u00D7 $40/hr' }
    ] },
  { name: '\uD83C\uDFAE Gaming (PC)',
    note: 'Gaming money is slow except DevEx on a game with players — treat the rest as long shots.',
    options: [
      { id: 'devex', url: 'https://create.roblox.com/docs/production/monetization/developer-exchange', name: 'Pet Power DevEx', desc: 'His published Roblox game — $0.0038/Robux cash-out, 30K Robux minimum (\u2248$114+). Most realistic gaming income since the game is already live.', lo: 0, hi: 100, math: '$114 per 30K Robux cash-out' },
      { id: 'betatesting-game', url: 'https://betatesting.com/beta-testers', name: 'BetaTesting — game tests', desc: '$10\u2013150+ per game playtest (game tests appear here too)', lo: 10, hi: 75, math: '\u22481 test/mo' },
      { id: 'remoteqa', url: 'https://www.lionbridgegames.com/', name: 'Remote game QA', desc: 'Lionbridge, Keywords Studios — real jobs, usually want experience', lo: 0, hi: 150, math: null },
      { id: 'streaming', url: 'https://www.twitch.tv/', name: 'Streaming', desc: 'Twitch/YouTube/TikTok — honest note: $0 for a long while, needs a consistent schedule', lo: 0, hi: 25, math: null },
      { id: 'gamecoaching', url: 'https://metafy.gg/', name: 'Game coaching', desc: 'Metafy, Gamer Sensei — $10\u201330/hr, only if high-ranked in a popular game', lo: 0, hi: 120, math: '2 hrs/wk \u00D7 $20/hr' },
      { id: 'tournaments', url: 'https://battlefy.com/', name: 'Small tournaments', desc: 'Battlefy, Challengermode — small prize pools, needs real skill', lo: 0, hi: 40, math: null }
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
        '<div class="earn-info"><div class="earn-name">' + (o.url ? '<a class="earn-link" href="' + o.url + '" target="_blank" rel="noopener">' + o.name + '</a>' : o.name) + '</div>' +
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
