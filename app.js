/* Budget Planner v1.1.0 — all data stays in localStorage on this device. */
'use strict';

var APP_VERSION = '1.1.0';

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
/* paycheck: hours per week, rate, ded = {fica, federal, ny} percents,
   freq, calibration = {gross, net} from a real pay stub or null.
   Lines are computed from the rates; if calibrated, an adjustment line
   makes the total taken off match the pay stub's overall rate. */
function calcPaycheck(hours, rate, ded, freq, calibration){
  var weeklyGross = hours * rate;
  var mult = freq === 'biweekly' ? 2 : (freq === 'monthly' ? 52 / 12 : 1);
  var periodGross = weeklyGross * mult;
  var ficaAmt = periodGross * num0(ded && ded.fica) / 100;
  var fedAmt = periodGross * num0(ded && ded.federal) / 100;
  var nyAmt = periodGross * num0(ded && ded.ny) / 100;
  var lineTotal = ficaAmt + fedAmt + nyAmt;
  var calibPct = null, adjustment = 0, totalDed = lineTotal;
  if(calibration && num0(calibration.gross) > 0 && num0(calibration.net) >= 0 && num0(calibration.net) <= num0(calibration.gross)){
    calibPct = (num0(calibration.gross) - num0(calibration.net)) / num0(calibration.gross);
    totalDed = periodGross * calibPct;
    adjustment = totalDed - lineTotal;
  }
  var net = periodGross - totalDed;
  var effRate = periodGross > 0 ? totalDed / periodGross : 0;
  var monthlyNet = weeklyGross * (1 - effRate) * (52 / 12);
  return { weeklyGross: weeklyGross, periodGross: periodGross,
           ficaAmt: ficaAmt, fedAmt: fedAmt, nyAmt: nyAmt, lineTotal: lineTotal,
           adjustment: adjustment, calibPct: calibPct, totalDed: totalDed,
           net: net, effRate: effRate, monthlyNet: monthlyNet,
           periodLabel: freq === 'biweekly' ? 'per 2 weeks' : (freq === 'monthly' ? 'per month' : 'per week') };
}
/* discount stack: sequential % discounts, then cashback on the discounted price */
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

if (typeof module !== 'undefined' && module.exports){
  module.exports = { round2: round2, money: money, money0: money0, calcPaycheck: calcPaycheck,
    calcShiftHours: calcShiftHours, calcShiftPaidHours: calcShiftPaidHours, defaultMeal: defaultMeal,
    toMinutes: toMinutes, compareVersions: compareVersions, parseStatementCSV: parseStatementCSV,
    calcDiscount: calcDiscount, calcSplit: calcSplit, calcUnit: calcUnit, calcTip: calcTip };
}

/* ---------- app (browser only) ---------- */
if (typeof document !== 'undefined'){

var KEY = 'budgetPlanner.v1';
var COLORS = ['#46d98a','#4db2ff','#f2c14e','#b48cff','#ff7a70','#2dd4bf','#f472b6','#9aa8a0','#6ea8ff','#f2994a'];

var DEFAULTS = {
  hours: 0, rate: 0, freq: 'weekly',
  hoursMode: 'total',
  mealTotal: 0,
  shifts: [
    { day: 'Mon', start: '09:00', end: '13:00', meal: 0 }
  ],
  ded: { fica: 7.65, federal: 0, ny: 0 },
  calibration: null,
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
  bills: [
    { name: 'Example bill', amount: 0, due: '', auto: false, paid: false, note: 'Edit this or add your own bills.' }
  ]
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
if(!S.ded) S.ded = { fica: 7.65, federal: 0, ny: 0 };
if(!S.shifts) S.shifts = JSON.parse(JSON.stringify(DEFAULTS.shifts));
if(!S.hoursMode) S.hoursMode = 'total';
if(S.mealTotal === undefined) S.mealTotal = 0;
if(S.calibration === undefined) S.calibration = null;
if(S.checking === undefined) S.checking = 0;
if(!S.balanceDate) S.balanceDate = '2026-10-14';
/* v1.1.0: shifts saved before meal breaks get the default rule (30 min over 6 hrs) */
S.shifts.forEach(function(sh){
  if(sh.meal === undefined || sh.meal === null) sh.meal = defaultMeal(sh.start, sh.end);
});
if(!S.statementTxns) S.statementTxns = [];
if(S.statementInfo === undefined) S.statementInfo = null;
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
function currentPaycheck(){
  return calcPaycheck(effectiveHours(), S.rate, S.ded, S.freq, S.calibration);
}

function monthlyIncome(){
  return currentPaycheck().monthlyNet;
}
function plannedSpend(){ return S.categories.reduce(function(a, c){ return a + num(c.amount); }, 0); }

function renderAll(){
  renderBudget(); renderPaycheck(); renderMyMoney(); renderBills();
  renderDiscountsStatic(); renderDiscountCalc(); renderCashbackEst();
  renderCalculators();
}

function renderBudget(){
  var income = monthlyIncome();
  var spend = plannedSpend();
  var left = income - spend;
  document.getElementById('incomeLine').textContent = money(income);
  document.getElementById('spendLine').textContent = money(spend);
  document.getElementById('leftLine').textContent = money(left);
  document.getElementById('donutLeft').textContent = money0(left);
  document.getElementById('donutSub').textContent = left >= 0 ? 'left this month' : 'over budget';
  document.getElementById('overBudgetWarn').hidden = left >= 0;

  /* donut: slices = categories, plus a "left" slice when positive */
  var svg = document.getElementById('donutSvg');
  var total = Math.max(spend + Math.max(left, 0), 1);
  var C = 2 * Math.PI * 80;
  var acc = 0, html = '';
  function slice(value, color){
    if(value <= 0) return '';
    var frac = value / total;
    var dash = frac * C;
    var out = '<circle cx="100" cy="100" r="80" fill="none" stroke="' + color + '" stroke-width="34" ' +
      'stroke-dasharray="' + dash.toFixed(1) + ' ' + (C - dash).toFixed(1) + '" stroke-dashoffset="' + (-acc).toFixed(1) + '" />';
    acc += dash;
    return out;
  }
  S.categories.forEach(function(c, i){ html += slice(num(c.amount), COLORS[i % COLORS.length]); });
  if(left > 0) html += slice(left, '#3d4d45');
  svg.innerHTML = html;

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

  /* savings goal */
  document.getElementById('goalAmount').value = S.goal;
  document.getElementById('savedAmount').value = S.saved;
  var toGo = Math.max(S.goal - S.saved, 0);
  var pct = S.goal > 0 ? Math.min(100, Math.round(S.saved / S.goal * 100)) : 0;
  document.getElementById('goalFill').style.width = pct + '%';
  document.getElementById('goalPct').textContent = pct + '%';
  document.getElementById('goalToGo').textContent = money(toGo) + ' to go';
  var weeklySave = (monthlyIncome() - spend) * 12 / 52;
  var pace = document.getElementById('paceLine');
  if(S.saved >= S.goal){ pace.textContent = '🎉 Goal reached — nice work.'; }
  else if(weeklySave <= 0){ pace.textContent = 'At this pace you are not saving — planned spending is at or above your income, so there is no date to show yet.'; }
  else{
    var weeks = Math.ceil(toGo / weeklySave);
    var date = new Date(); date.setDate(date.getDate() + weeks * 7);
    pace.textContent = 'At this pace: saving about ' + money(weeklySave) + ' / week → goal in about ' + weeks +
      ' week' + (weeks === 1 ? '' : 's') + ' (around ' + date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ').';
  }
}

function renderPaycheck(){
  document.getElementById('hoursModeTotal').classList.toggle('active', S.hoursMode !== 'shifts');
  document.getElementById('hoursModeShifts').classList.toggle('active', S.hoursMode === 'shifts');
  document.getElementById('hoursTotalBox').hidden = S.hoursMode === 'shifts';
  document.getElementById('hoursShiftsBox').hidden = S.hoursMode !== 'shifts';
  document.getElementById('hoursSlider').value = S.hours;
  document.getElementById('hoursInput').value = S.hours;
  document.getElementById('rateInput').value = S.rate;
  document.getElementById('freqSelect').value = S.freq;
  document.getElementById('ficaInput').value = S.ded.fica;
  document.getElementById('federalInput').value = S.ded.federal;
  document.getElementById('nyInput').value = S.ded.ny;

  var shiftList = document.getElementById('shiftList');
  shiftList.innerHTML = '';
  var totalLen = 0, totalMeal = 0, totalPaid = 0;
  S.shifts.forEach(function(sh, i){
    var len = calcShiftHours(sh.start, sh.end);
    var meal = (sh.meal === undefined || sh.meal === null) ? defaultMeal(sh.start, sh.end) : num(sh.meal);
    var paid = calcShiftPaidHours(sh.start, sh.end, meal);
    totalLen += len; totalMeal += meal; totalPaid += paid;
    var row = document.createElement('div'); row.className = 'bill-row';
    row.innerHTML = '<span class="bill-name">' + esc(sh.day) + '</span>' +
      '<span>' + esc(fmtTime(sh.start)) + ' – ' + esc(fmtTime(sh.end)) + '</span>' +
      '<label class="field small">Meal (min) <input type="number" min="0" step="5" value="' + meal + '" data-shift-meal="' + i + '" aria-label="Meal break in minutes"></label>' +
      '<button class="btn-mini danger" data-shift-del="' + i + '" type="button">Delete</button>' +
      '<span class="shift-math">' + fmtHrs(len) + ' hrs, meal ' + fmtHrs(meal) + ' min → paid ' + fmtHrs(paid) + ' hrs</span>';
    shiftList.appendChild(row);
  });
  if(!S.shifts.length) shiftList.innerHTML = '<p class="hint">No shifts yet — add one below.</p>';
  document.getElementById('shiftTotalOut').textContent = fmtHrs(totalPaid) + ' hrs / week';
  document.getElementById('shiftMathOut').textContent = S.shifts.length
    ? 'Shift time ' + fmtHrs(totalLen) + ' hrs total − meal ' + fmtHrs(totalMeal) + ' min total → paid ' + fmtHrs(totalPaid) + ' hrs.'
    : '';
  document.getElementById('mealTotalInput').value = S.mealTotal || 0;
  document.getElementById('totalMealMath').textContent = num(S.mealTotal) > 0
    ? fmtHrs(num(S.hours)) + ' hrs − ' + fmtHrs(num(S.mealTotal)) + ' min meal → paid ' + fmtHrs(effectiveHours()) + ' hrs.'
    : 'Paid hours: ' + fmtHrs(effectiveHours()) + ' hrs / week.';

  var p = currentPaycheck();
  document.getElementById('grossOut').textContent = money(p.periodGross);
  document.getElementById('grossPer').textContent = p.periodLabel;
  document.getElementById('ficaOut').textContent = '−' + money(p.ficaAmt);
  document.getElementById('federalOut').textContent = '−' + money(p.fedAmt);
  document.getElementById('nyOut').textContent = '−' + money(p.nyAmt);
  document.getElementById('calibRow').hidden = !S.calibration;
  document.getElementById('calibOut').textContent = (p.adjustment < 0 ? '+' : '−') + money(Math.abs(p.adjustment));
  document.getElementById('takenOffOut').textContent = money(p.totalDed);
  document.getElementById('takenOffPct').textContent = (p.effRate * 100).toFixed(2).replace(/\.?0+$/, '') + '%';
  document.getElementById('takeHomeOut').textContent = money(p.net);
  document.getElementById('takeHomePer').textContent = p.periodLabel;
  document.getElementById('monthlyOut').textContent = money(p.monthlyNet);

  var calibStatus = document.getElementById('calibStatus');
  if(S.calibration){
    calibStatus.textContent = 'Using your pay stub: gross ' + money(S.calibration.gross) + ' → net ' +
      money(S.calibration.net) + ' = ' + (p.calibPct * 100).toFixed(2).replace(/\.?0+$/, '') +
      '% taken off. The breakdown above uses your rates, and the adjustment line makes the total match your stub.';
    document.getElementById('stubGross').value = S.calibration.gross;
    document.getElementById('stubNet').value = S.calibration.net;
  } else {
    calibStatus.textContent = 'No pay stub calibration — the breakdown uses the rates above.';
  }

  var extraH = num(document.getElementById('extraHours').value, 0);
  var extraNet = extraH * S.rate * (1 - p.effRate);
  document.getElementById('extraHoursOut').textContent = '+' + extraH + ' hrs/week → about ' + money(extraNet) +
    ' more take-home per week (' + money(extraNet * 52 / 12) + ' / month).';
  var newRate = num(document.getElementById('newRate').value, 0);
  var newP = calcPaycheck(effectiveHours(), newRate, S.ded, 'weekly', S.calibration);
  var oldP = calcPaycheck(effectiveHours(), S.rate, S.ded, 'weekly', S.calibration);
  document.getElementById('newRateOut').textContent = 'At $' + newRate.toFixed(2) + '/hr with the same hours: ' +
    money(newP.net) + ' take-home / week — that is ' + money(newP.net - oldP.net) +
    ' more per week (' + money((newP.net - oldP.net) * 52 / 12) + ' / month).';
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
  document.getElementById('savingsBalInput').value = S.saved;
  document.getElementById('checkingBalInput').value = S.checking;
  document.getElementById('balanceDateInput').value = S.balanceDate || '';
  var total = num(S.saved) + num(S.checking);
  var bills = unpaidBillsTotal();
  var budget = plannedSpend();
  var canSpend = total - bills - budget;
  document.getElementById('moneyTotal').textContent = money(total);
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

function checkForUpdate(){
  try{
    fetch('version.json', { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(remote){
      if(!remote || !remote.version) return;
      if(compareVersions(remote.version, APP_VERSION) <= 0) return;
      try{ if(localStorage.getItem(UPDATE_SEEN_PREFIX + remote.version)) return; }catch(e){}
      showUpdateBanner(remote.version, remote.notes || []);
    }).catch(function(){ /* no network / local file — fail quietly */ });
  }catch(e){}
}

function openWhatsNew(){
  var body = document.getElementById('whatsNewBody');
  function render(versions){
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
  fetch('changelog.json', { cache: 'no-store' }).then(function(r){ return r.json(); }).then(function(data){
    render((data && data.versions) ? data.versions : CHANGELOG_FALLBACK);
  }).catch(function(){ render(CHANGELOG_FALLBACK); });
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
    var dueTxt = b.due ? new Date(b.due + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'No due date';
    row.innerHTML = '<label class="check"><input type="checkbox" data-bill-paid="' + idx + '"' + (b.paid ? ' checked' : '') + '> Paid</label>' +
      '<span class="bill-name">' + esc(b.name) + '</span>' +
      '<span>' + money(num(b.amount)) + '</span>' +
      '<span class="bill-due">' + dueTxt + '</span>' +
      (b.auto ? '<span class="bill-auto">Auto-pay</span>' : '') +
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
  document.getElementById('clearAllBtn').addEventListener('click', function(){
    if(confirm('Clear all your numbers? Everything you typed will be reset to the starting values.')){
      try{ localStorage.removeItem(KEY); }catch(e){}
      S = JSON.parse(JSON.stringify(DEFAULTS));
      renderAll();
    }
  });

  /* budget inputs */
  document.getElementById('categoryList').addEventListener('input', function(e){
    var t = e.target;
    if(t.dataset.catName !== undefined){ S.categories[+t.dataset.catName].name = t.value; }
    if(t.dataset.catAmt !== undefined){ S.categories[+t.dataset.catAmt].amount = num(t.value); }
    save(); renderBudget(); renderMyMoney();
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
  document.getElementById('goalAmount').addEventListener('input', function(e){ S.goal = num(e.target.value); save(); renderBudget(); });
  document.getElementById('savedAmount').addEventListener('input', function(e){ S.saved = num(e.target.value); save(); renderBudget(); renderMyMoney(); });

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
      start: start, end: end, meal: defaultMeal(start, end) });
    save(); renderAll();
  });
  document.getElementById('shiftList').addEventListener('change', function(e){
    var t = e.target;
    if(t.dataset.shiftMeal !== undefined){
      var m = num(t.value);
      if(m < 0) m = 0;
      S.shifts[+t.dataset.shiftMeal].meal = m;
      save(); renderAll();
    }
  });
  document.getElementById('mealTotalInput').addEventListener('change', function(e){
    var m = num(e.target.value);
    if(m < 0) m = 0;
    S.mealTotal = m;
    save(); renderAll();
  });
  document.getElementById('shiftList').addEventListener('click', function(e){
    var t = e.target;
    if(t.dataset.shiftDel !== undefined){ S.shifts.splice(+t.dataset.shiftDel, 1); save(); renderAll(); }
  });
  document.getElementById('rateInput').addEventListener('input', function(e){ S.rate = num(e.target.value); save(); renderAll(); });
  document.getElementById('freqSelect').addEventListener('change', function(e){ S.freq = e.target.value; save(); renderAll(); });
  document.getElementById('ficaInput').addEventListener('input', function(e){ S.ded.fica = num(e.target.value); save(); renderAll(); });
  document.getElementById('federalInput').addEventListener('input', function(e){ S.ded.federal = num(e.target.value); save(); renderAll(); });
  document.getElementById('nyInput').addEventListener('input', function(e){ S.ded.ny = num(e.target.value); save(); renderAll(); });
  document.getElementById('extraHours').addEventListener('input', renderPaycheck);
  document.getElementById('newRate').addEventListener('input', renderPaycheck);
  document.getElementById('calibrateBtn').addEventListener('click', function(){
    var g = num(document.getElementById('stubGross').value);
    var n = num(document.getElementById('stubNet').value);
    if(g <= 0){ alert('Enter the gross pay from your pay stub first.'); return; }
    if(n < 0 || n > g){ alert('Net pay should be between $0 and the gross pay.'); return; }
    S.calibration = { gross: g, net: n };
    save(); renderAll();
  });
  document.getElementById('clearCalibBtn').addEventListener('click', function(){
    S.calibration = null;
    document.getElementById('stubGross').value = '';
    document.getElementById('stubNet').value = '';
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
    var v = document.getElementById('updateBanner').dataset.version || '';
    markUpdateSeen(v);
    location.reload();
  });
  document.getElementById('updateLaterBtn').addEventListener('click', function(){
    var v = document.getElementById('updateBanner').dataset.version || '';
    markUpdateSeen(v);
    document.getElementById('updateBanner').hidden = true;
  });
  document.getElementById('whatsNewBtn').addEventListener('click', openWhatsNew);
  document.getElementById('whatsNewClose').addEventListener('click', function(){
    document.getElementById('whatsNewModal').hidden = true;
  });
  document.getElementById('whatsNewModal').addEventListener('click', function(e){
    if(e.target === document.getElementById('whatsNewModal')) document.getElementById('whatsNewModal').hidden = true;
  });
  document.getElementById('savingsBalInput').addEventListener('input', function(e){ S.saved = num(e.target.value); save(); renderBudget(); renderMyMoney(); });
  document.getElementById('checkingBalInput').addEventListener('input', function(e){ S.checking = num(e.target.value); save(); renderMyMoney(); });
  document.getElementById('balanceDateInput').addEventListener('change', function(e){ S.balanceDate = e.target.value; save(); renderMyMoney(); });

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
    save(); renderBills(); renderMyMoney();
  });
  document.getElementById('billList').addEventListener('change', function(e){
    var t = e.target;
    if(t.dataset.billPaid !== undefined){ S.bills[+t.dataset.billPaid].paid = t.checked; save(); renderBills(); renderMyMoney(); }
  });
  document.getElementById('billList').addEventListener('click', function(e){
    var t = e.target;
    if(t.dataset.billDel !== undefined){ S.bills.splice(+t.dataset.billDel, 1); save(); renderBills(); renderMyMoney(); }
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
  document.querySelectorAll('.btn-chip').forEach(function(b){
    b.addEventListener('click', function(){
      document.getElementById('tipPct').value = b.dataset.tip;
      document.querySelectorAll('.btn-chip').forEach(function(x){ x.classList.toggle('active', x === b); });
      renderCalculators();
    });
  });
}

bind();
renderAll();
checkForUpdate();
}
