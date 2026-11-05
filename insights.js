/* Budget Planner — Spending insights (v2.29.0).
 *
 * Reads the transactions from your imported bank statements (already stored
 * on this device in S.statementTxns) and shows where the money actually went:
 *  - money in / money out / net / average spent per day for the period
 *  - spending by category (auto-sorted by the merchant text on each line)
 *  - top places you spent
 *  - subscriptions & repeat charges (same merchant, similar amount, about a
 *    month apart — or a well-known subscription service), with the yearly cost
 *  - one tap to set this month's planned spending from your real average
 * Nothing leaves the device. Categories are a best guess from the text on
 * your statement; every number here comes from your own transactions.
 */
(function(){
'use strict';
if(typeof S === 'undefined' || !window.BudgetApp || !document.getElementById('insightsCard')) return;

/* Category rules: first match wins. Names line up with the Budget tab's
 * default categories (Food, Transport, Fun, Subscriptions, Clothes, Other)
 * so "Use as my plan" can fill them directly. Bills/Income/Transfers are
 * shown but never put into planned spending (bills live on the Bills tab). */
var RULES = [
  ['Income',        /payroll|direct dep|dir dep|salary|paycheck|\bpay ?roll\b|adp\b|gusto|tax refund|irs treas|interest paid|cashback|refund/],
  ['Transfers',     /transfer|xfer|zelle|venmo|cash app|cashapp|paypal|apple cash|to savings|from savings|to checking|from checking/],
  ['Cash',          /\batm\b|cash withdrawal|withdrawal/],
  ['Subscriptions', /netflix|spotify|hulu|disney|youtube|yt premium|apple\.com|itunes|icloud|amazon prime|prime video|audible|max\.com|hbo|paramount|peacock|crunchyroll|xbox|playstation|psn|nintendo|game pass|chatgpt|openai|adobe|microsoft 365|dropbox|patreon|twitch|discord|duolingo|onlyfans|siriusxm|tidal|deezer|chegg|quizlet|grammarly|notion/],
  ['Bills',         /verizon|t-mobile|tmobile|at&t|\batt\b|sprint|mint mobile|visible|cricket|boost mobile|comcast|xfinity|spectrum|optimum|con ?ed|national grid|electric|utility|water bill|insurance|geico|progressive|state farm|allstate|\brent\b|landlord|tuition|student loan|navient|nelnet|mohela|sallie|loan pmt|credit card pmt|card payment|autopay/],
  ['Food',          /grubhub|doordash|uber ?eats|seamless|postmates|instacart|mcdonald|burger king|wendy|chipotle|starbucks|dunkin|subway|taco bell|kfc|popeyes|chick-fil|chickfil|domino|pizza|shake shack|panera|sweetgreen|cava|five guys|wingstop|restaurant|cafe|coffee|\bdeli\b|bagel|bakery|diner|grill|kitchen|sushi|ramen|halal|bodega|grocery|market|trader joe|whole foods|aldi|lidl|kroger|safeway|stop & shop|stop and shop|shoprite|wegmans|publix|food|costco|bj'?s wholesale|key food|c-town|ctown|fairway|7-eleven|7 eleven|wawa|sheetz|dining/],
  ['Transport',     /uber(?! ?eats)|lyft|mta|omny|metrocard|nj transit|lirr|metro-north|amtrak|\bpath\b|transit|\bbus\b|subway fare|shell|exxon|mobil|chevron|bp\b|sunoco|citgo|\bgas\b|fuel|parking|toll|e-zpass|ezpass|citi bike|lime|bird/],
  ['Clothes',       /nike|adidas|h&m|zara|uniqlo|\bgap\b|old navy|foot locker|champs|finish line|shein|asos|forever 21|urban outfitters|lululemon|under armour|new balance|tj ?maxx|marshalls|\bross\b|burlington|macy|nordstrom|kohl/],
  ['Fun',           /steam|epic games|riot|valve|gamestop|cinema|movie|amc|regal|ticketmaster|stubhub|seatgeek|concert|bowling|arcade|bar\b|pub\b|club|lounge|tavern|brewery|liquor|wine|vape|smoke shop|dispensary|event|museum|theater|theatre/],
  ['Shopping',      /amazon|amzn|target|walmart|best buy|ebay|etsy|temu|apple store|ikea|home depot|lowe|bed bath|cvs|walgreens|duane reade|rite aid|dollar|five below|staples|barnes|bookstore/],
  ['Fees',          /\bfees?\b|overdraft|nsf|service charge|late charge|interest charge|finance charge/]
];
var PLAN_MAP = { Cash:'Other', Food:'Food', Transport:'Transport', Fun:'Fun', Subscriptions:'Subscriptions', Clothes:'Clothes', Shopping:'Other', Fees:'Other', Other:'Other' };
var COLORS = { Food:'#d4af6a', Transport:'#7cc4ff', Fun:'#c792ea', Subscriptions:'#ff8a65', Clothes:'#f06292', Shopping:'#4fe08e', Bills:'#fbbf24', Cash:'#80cbc4', Fees:'#f87171', Other:'#9d8c6e' };
var KNOWN_SUBS = RULES[3][1];

function $(id){ return document.getElementById(id); }
function m$(n){ return typeof money === 'function' ? money(n) : '$' + Number(n).toFixed(2); }
function e$(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
var TWO_WORD = /^(trader joe|uber eats|whole foods|taco bell|burger king|best buy|home depot|old navy|foot locker|five guys|shake shack|key food|stop shop|bed bath|dollar tree|dollar general|five below|urban outfitters|new balance|under armour|apple cash|cash app|game stop|epic games|state farm|national grid|con ed|mint mobile|boost mobile|seven eleven|duane reade|rite aid|panda express|jersey mike|jimmy john|little caesars|papa john|dunkin donuts|chick fil|sweet green|amazon prime|prime video|apple music|youtube premium|disney plus|paramount plus)$/;
function categorize(t){
  var d = String(t.description || '').toLowerCase();
  if(t.amount > 0){
    /* money in: income unless it is clearly a transfer between your own accounts */
    for(var k = 0; k < 2; k++) if(RULES[k][1].test(d)) return RULES[k][0];
    return 'Income';
  }
  for(var i = 1; i < RULES.length; i++) if(RULES[i][1].test(d)) return RULES[i][0];
  return 'Other';
}
/* "POS DEBIT 10/14 STARBUCKS #1234 NEW YORK NY" -> "starbucks" */
function merchantKey(desc){
  var d = String(desc || '').toLowerCase()
    .replace(/(pos|debit|credit|card|purchase|recurring|checkcard|visa|mastercard|ach|web|online|payment|pmt|ppd|id:?)\b/g, ' ')
    .replace(/\d{1,2}\/\d{1,2}(\/\d{2,4})?/g, ' ')
    .replace(/[#*][\w-]*/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/[^a-z&. ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  var words = d.split(' ').map(function(w){ return w.replace(/\.(com|net|org|co)$/,'').replace(/^www\./,''); })
    .filter(function(w){ return w.length > 1 && !/^(com|inc|llc|usa|us|ny|nj|ca|wa|tx|fl|help|bill|store|the)$/.test(w); });
  if(!words.length) return d || 'unknown';
  var two = words.slice(0, 2).join(' ');
  return TWO_WORD.test(two) ? two : words[0];
}
function prettyMerchant(desc){
  var k = merchantKey(desc);
  return k.replace(/\b\w/g, function(c){ return c.toUpperCase(); });
}
function dayNum(iso){ return Math.round(new Date(iso + 'T12:00:00').getTime() / 864e5); }

function analyze(txns){
  var list = txns.filter(function(t){ return t && t.date && isFinite(t.amount); })
    .sort(function(a, b){ return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  if(!list.length) return null;
  var first = list[0].date, last = list[list.length - 1].date;
  var days = Math.max(1, dayNum(last) - dayNum(first) + 1);
  var inc = 0, out = 0, cats = {}, merch = {}, groups = {};
  list.forEach(function(t){
    var c = categorize(t);
    if(c === 'Transfers') return;           /* moving your own money isn't spending */
    if(t.amount > 0){ inc += t.amount; return; }
    var a = -t.amount; out += a;
    cats[c] = (cats[c] || 0) + a;
    var k = merchantKey(t.description);
    if(!merch[k]) merch[k] = { name: prettyMerchant(t.description), total: 0, n: 0, cat: c };
    merch[k].total += a; merch[k].n++;
    (groups[k] = groups[k] || []).push({ date: t.date, amt: a, desc: t.description, cat: c });
  });
  /* recurring: ≥2 charges 25–35 days apart with amounts within 15%,
     or one charge from a well-known subscription service. */
  var subs = [];
  Object.keys(groups).forEach(function(k){
    var g = groups[k], known = KNOWN_SUBS.test(String(g[0].desc).toLowerCase());
    var monthly = false;
    for(var i = 1; i < g.length; i++){
      var gap = dayNum(g[i].date) - dayNum(g[i - 1].date);
      var close = Math.abs(g[i].amt - g[i - 1].amt) <= Math.max(1, 0.15 * g[i - 1].amt);
      if(gap >= 25 && gap <= 35 && close){ monthly = true; break; }
    }
    if(monthly || known){
      var lastC = g[g.length - 1];
      subs.push({ name: merch[k].name, amount: lastC.amt, last: lastC.date, count: g.length, sure: monthly, cat: g[0].cat });
    }
  });
  subs.sort(function(a, b){ return b.amount - a.amount; });
  var catList = Object.keys(cats).map(function(c){ return { name: c, total: cats[c] }; }).sort(function(a, b){ return b.total - a.total; });
  var top = Object.keys(merch).map(function(k){ return merch[k]; }).sort(function(a, b){ return b.total - a.total; }).slice(0, 5);
  return { first: first, last: last, days: days, inc: inc, out: out, cats: catList, top: top, subs: subs, count: list.length };
}

var lastPlanSnapshot = null;
function render(){
  var box = $('insightsBody'); if(!box) return;
  var all = (S.statementTxns || []).slice();
  var months = {}; all.forEach(function(t){ if(t.date) months[t.date.slice(0, 7)] = 1; });
  var monthKeys = Object.keys(months).sort().reverse();
  var sel = $('insMonth'), pick = sel ? sel.value : 'all';
  if(sel){
    sel.innerHTML = '<option value="all">All imported</option>' + monthKeys.map(function(m){
      var d = new Date(m + '-15T12:00:00'); return '<option value="' + m + '">' + d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) + '</option>';
    }).join('');
    sel.value = monthKeys.indexOf(pick) !== -1 ? pick : 'all';
    pick = sel.value;
    sel.parentElement.hidden = monthKeys.length < 2;
  }
  var txns = pick === 'all' ? all : all.filter(function(t){ return t.date && t.date.slice(0, 7) === pick; });
  var a = analyze(txns);
  /* repeat charges are found across ALL imported months, even when one month is shown */
  if(a && pick !== 'all'){ var whole = analyze(all); if(whole) a.subs = whole.subs; }
  if(!a){
    box.innerHTML = '<p class="hint">Import a bank statement above (My money → Import a bank statement) and this card shows where your money went — by category, top places, and every subscription that keeps charging you. It all stays on this device.</p>';
    return;
  }
  var perDay = a.out / a.days, perMonth = perDay * 30.44;
  var html = '<p class="hint ins-period">' + e$(fmt(a.first)) + ' – ' + e$(fmt(a.last)) + ' · ' + a.days + ' day' + (a.days === 1 ? '' : 's') + ' · ' + a.count + ' transactions (transfers between your own accounts are left out)</p>';
  html += '<div class="ins-kpis">' +
    kpi('Money in', m$(a.inc), 'pos') + kpi('Money out', m$(a.out), 'neg') +
    kpi('Net', (a.inc - a.out >= 0 ? '+' : '−') + m$(Math.abs(a.inc - a.out)), a.inc - a.out >= 0 ? 'pos' : 'neg') +
    kpi('Spent per day', m$(perDay), '') + '</div>';
  /* categories */
  var max = a.cats.length ? a.cats[0].total : 1;
  html += '<h4 class="ins-h">Where it went</h4><div class="ins-bars">' + a.cats.map(function(c){
    var pct = a.out ? Math.round(c.total / a.out * 100) : 0;
    return '<div class="ins-bar"><div class="ins-bar-top"><span><i style="background:' + (COLORS[c.name] || '#9d8c6e') + '"></i>' + e$(c.name) + '</span><b>' + m$(c.total) + ' <small>' + pct + '%</small></b></div>' +
      '<div class="ins-track"><div class="ins-fill" style="width:' + Math.max(2, c.total / max * 100) + '%;background:' + (COLORS[c.name] || '#9d8c6e') + '"></div></div></div>';
  }).join('') + '</div>';
  /* top places */
  if(a.top.length){
    html += '<h4 class="ins-h">Top places</h4><ol class="ins-top">' + a.top.map(function(t){
      return '<li><span>' + e$(t.name) + ' <small>· ' + t.n + '×</small></span><b>' + m$(t.total) + '</b></li>';
    }).join('') + '</ol>';
  }
  /* subscriptions */
  html += '<h4 class="ins-h">Subscriptions &amp; repeat charges</h4>';
  if(a.subs.length){
    var subMonthly = a.subs.reduce(function(s, x){ return s + x.amount; }, 0);
    html += '<ul class="ins-subs">' + a.subs.map(function(s){
      return '<li><span>' + e$(s.name) + '<small>' + (s.sure ? 'charged monthly' : 'known subscription') + ' · last ' + e$(fmt(s.last)) + '</small></span><b>' + m$(s.amount) + '<small>/mo</small></b></li>';
    }).join('') + '</ul><p class="result-line ins-subtotal">≈ ' + m$(subMonthly) + ' a month · <strong>' + m$(subMonthly * 12) + ' a year</strong>. Cancel one you don\'t use and that money is back in your budget.</p>';
  } else html += '<p class="hint">No repeat charges found in these transactions.</p>';
  /* plan from real spending */
  if(a.days >= 21){
    html += '<div class="ins-plan"><p>Your real spending works out to about <strong>' + m$(perMonth) + ' a month</strong>. Set this month\'s planned spending on the Budget tab from it?</p>' +
      '<div class="add-row"><button class="btn-primary" type="button" id="insPlanBtn">Use my real spending as my plan</button>' +
      '<button class="btn-mini" type="button" id="insPlanUndo"' + (lastPlanSnapshot ? '' : ' hidden') + '>Undo</button></div><p class="hint" id="insPlanMsg"></p></div>';
  } else {
    html += '<p class="hint">Import at least 3 weeks of transactions to turn this into a monthly plan — a few days of spending is too short to judge a month by.</p>';
  }
  box.innerHTML = html;
  box.dataset.perMonthJson = JSON.stringify(a.cats.map(function(c){ return [c.name, c.total / a.days * 30.44]; }));
}
function kpi(label, val, cls){ return '<div class="ins-kpi"><span>' + label + '</span><b class="' + cls + '">' + val + '</b></div>'; }
function fmt(iso){ return new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }

function applyPlan(){
  var rows = JSON.parse($('insightsBody').dataset.perMonthJson || '[]');
  var target = {};
  rows.forEach(function(r){
    var name = PLAN_MAP[r[0]]; if(!name) return; /* Bills/Income/Fees→Other only */
    target[name] = (target[name] || 0) + r[1];
  });
  lastPlanSnapshot = JSON.parse(JSON.stringify(S.categories));
  Object.keys(target).forEach(function(name){
    var amt = Math.round(target[name]);
    var hit = null;
    S.categories.forEach(function(c){ if(String(c.name).trim().toLowerCase() === name.toLowerCase()) hit = c; });
    if(hit) hit.amount = amt; else S.categories.push({ name: name, amount: amt });
  });
  window.BudgetApp.save(); window.BudgetApp.renderAll(); render();
  $('insPlanMsg').textContent = 'Done — planned spending now matches your real average (bills stay on the Bills tab). Tweak any amount on the Budget tab.';
}
function undoPlan(){
  if(!lastPlanSnapshot) return;
  S.categories = lastPlanSnapshot; lastPlanSnapshot = null;
  window.BudgetApp.save(); window.BudgetApp.renderAll(); render();
}

document.addEventListener('click', function(e){
  if(e.target.id === 'insPlanBtn') applyPlan();
  else if(e.target.id === 'insPlanUndo') undoPlan();
});
var sel = $('insMonth'); if(sel) sel.addEventListener('change', render);
/* Re-render whenever the app re-renders (statement imported, undo, sync). */
window.onBudgetRender = render;
window.BudgetInsights = { categorize: categorize, merchantKey: merchantKey, analyze: analyze, render: render };
render();
})();
