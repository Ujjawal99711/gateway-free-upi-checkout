/**
 * Gateway-free UPI checkout backend.
 *
 * Buyer enters name, email, phone -> gets a personal UPI QR with a unique amount
 * (down to the paisa) -> your bank's "credited" alert lands in Gmail -> this script
 * matches the exact amount to the right buyer -> marks them Paid and emails a
 * confirmation automatically. No payment gateway, no onboarding, no per-transaction fee.
 *
 * Full write-up of how and why this works: see the repo README.
 *
 * ---------------------------------------------------------------------------
 * SETUP (also see README "Setup" section for the full walkthrough)
 * ---------------------------------------------------------------------------
 * 1. Create a Google Sheet with 3 tabs, named exactly: Registrations, Payments, Review
 *    - Registrations header row: Timestamp | Name | Email | Phone | Amount | Status |
 *      PaidAt | Payer | PayerVPA | UTR | InviteSentAt | Notes | Token
 *    - Payments header row:      Timestamp | Amount | Payer | PayerVPA | UTR | MatchedEmail | MessageId
 *    - Review header row:        Timestamp | Reason | Amount | Payer | UTR | Related | Status | Notes
 * 2. Extensions > Apps Script, paste this whole file in.
 * 3. Fill in CONFIG and SITES below with your own UPI ID, name and bank alert sender.
 * 4. Run setup() once from the editor (grants permissions, starts the 1-minute trigger).
 * 5. Deploy > New deployment > Web app > execute as yourself, access "Anyone".
 * 6. Point your frontend's registrationWebhook (see demo/) at the deployed /exec URL.
 * ---------------------------------------------------------------------------
 */

// ---------------- Settings: fill these in for your own payee details ----------------
var CONFIG = {
  UPI_ID: 'yourname@upi',            // your personal or business UPI ID (not a gateway merchant ID)
  PAYEE_NAME: 'Your Name',
  STALE_MINUTES: 45,                 // an unpaid amount can be reused after this many minutes
  BANK_SENDER: 'alerts@yourbank.example.com',  // the From: address your bank sends "credited" alerts from
  TZ: 'Asia/Kolkata'
};

/**
 * One or more "sites" (products/events) can share a single Sheet and backend, because each
 * site is given its own non-overlapping amount range. The buyer's frontend sends which
 * site they're paying for; the script reserves an amount from that site's range only.
 */
var SITES = {
  // "default" is used whenever the frontend doesn't send a recognized site key.
  default: {
    minPaise: 101, maxPaise: 499,     // Rs 1.01 - 4.99: good for testing the flow end-to-end cheaply
    senderName: 'Your Project',
    title: 'Your Product / Event',
    when: '',                         // e.g. 'Sunday, 22 Nov 2026, 5:00 PM IST' (optional)
    link: ''                          // e.g. a Google Meet / Zoom / download link sent after payment
  }
  // Add more entries here for more products/events on the same Sheet, e.g.:
  // workshop: { minPaise: 29001, maxPaise: 29899, senderName: '...', title: '...', when: '...', link: '...' }
};
function siteOf_(key) { return SITES[key] ? key : 'default'; }
function siteForPaise_(paise) {
  for (var k in SITES) if (paise >= SITES[k].minPaise && paise <= SITES[k].maxPaise) return k;
  return 'default';
}

// Column positions (1-based) in each tab — match these to your Sheet's header row
var REG = { AT: 1, NAME: 2, EMAIL: 3, PHONE: 4, AMOUNT: 5, STATUS: 6, PAID_AT: 7, PAYER: 8, PAYER_VPA: 9, UTR: 10, INVITE_AT: 11, NOTES: 12, TOKEN: 13 };
var PAY = { AT: 1, AMOUNT: 2, PAYER: 3, PAYER_VPA: 4, UTR: 5, MATCHED: 6, MSG_ID: 7 };

// ---------------- Web page (optional: a self-contained checkout page with no external frontend) ----------------
function doGet() {
  return HtmlService.createHtmlOutput(PAGE_HTML)
    .setTitle('Checkout')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * JSON API for an external page (your own landing page, hosted anywhere).
 * POST body, sent as text/plain to avoid a CORS preflight:
 *   {"action":"register","name":"..","email":"..","phone":"..","site":"default","website":""}
 *   {"action":"status","id":12,"token":"...","site":"default"}
 */
function doPost(e) {
  var out;
  try {
    var body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (body.action === 'register') {
      if (body.website) throw new Error('Something went wrong. Please try again.'); // hidden honeypot field: bots fill it
      out = { ok: true, data: register(body) };
    } else if (body.action === 'status') {
      out = { ok: true, data: getStatus(body.id, body.token) };
    } else {
      throw new Error('Unknown action');
    }
  } catch (err) {
    out = { ok: false, error: String(err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

/** Called on checkout start. Saves the buyer and reserves a unique amount for today. */
function register(form) {
  var name = String(form.name || '').trim();
  var email = String(form.email || '').trim().toLowerCase();
  var phone = String(form.phone || '').replace(/[^\d+]/g, '');
  var site = siteOf_(form.site);
  var range = SITES[site];
  if (name.length < 2) throw new Error('Please enter your name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Please enter a valid email.');
  if (phone.replace(/\D/g, '').length < 10) throw new Error('Please enter a valid phone number.');
  var phone10 = phone.replace(/\D/g, '').slice(-10);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_('Registrations');
    var now = new Date();
    var today = dayKey_(now);
    var staleMs = CONFIG.STALE_MINUTES * 60000;
    var taken = {};     // amounts in use today (paid, or pending and still fresh)
    var stale = {};     // amount -> row of an unpaid registration older than STALE_MINUTES
    var last = sh.getLastRow();
    if (last >= 2) {
      var rows = sh.getRange(2, 1, last - 1, REG.TOKEN).getValues();
      for (var i = 0; i < rows.length; i++) {
        var at = rows[i][REG.AT - 1];
        var st = rows[i][REG.STATUS - 1];
        if (!(at instanceof Date) || dayKey_(at) !== today || st === 'Refunded') continue;
        var amt = toPaise_(rows[i][REG.AMOUNT - 1]);
        if (st === 'Pending') {
          // same person retrying while unpaid: give back the same amount, same row (no new slot used)
          if (String(rows[i][REG.EMAIL - 1]).toLowerCase() === email ||
              String(rows[i][REG.PHONE - 1]).replace(/\D/g, '').slice(-10) === phone10) {
            if (amt >= range.minPaise && amt <= range.maxPaise) {
              var tok = String(rows[i][REG.TOKEN - 1] || '');
              if (!tok) { tok = newToken_(); sh.getRange(i + 2, REG.TOKEN).setValue(tok); }
              return regResult_(i + 2, amt / 100, name, tok);
            }
          }
          if (now.getTime() - at.getTime() > staleMs) { stale[amt] = i + 2; continue; }
        }
        if (st === 'Expired') { if (!(amt in stale)) stale[amt] = 0; continue; }
        taken[amt] = true;
      }
    }
    var fresh = [], reusable = [];
    for (var p = range.minPaise; p <= range.maxPaise; p++) {
      if (p % 100 === 0 || taken[p]) continue;   // skip round-rupee amounts: easier for a human to misread back
      if (p in stale) reusable.push(p); else fresh.push(p);
    }
    var paise;
    if (fresh.length) {
      paise = fresh[Math.floor(Math.random() * fresh.length)];
    } else if (reusable.length) {
      paise = reusable[0];
      var oldRow = stale[paise];
      if (oldRow) sh.getRange(oldRow, REG.STATUS, 1, 1).setValue('Expired');
      if (oldRow) sh.getRange(oldRow, REG.NOTES).setValue('Unpaid for ' + CONFIG.STALE_MINUTES + '+ min; amount given to a new buyer');
    } else {
      throw new Error('All payment slots for today are taken. Please try again in a little while.');
    }
    var amount = paise / 100;
    var token = newToken_();
    sh.appendRow([now, name, email, phone, amount, 'Pending', '', '', '', '', '', site === 'default' ? '' : 'site:' + site, token]);
    return regResult_(sh.getLastRow(), amount, name, token);
  } finally {
    lock.releaseLock();
  }
}

function regResult_(row, amount, name, token) {
  return {
    id: row,
    token: token,
    amount: amount.toFixed(2),
    upiUrl: upiUrl_(amount, 'Order ' + name),
    upiId: CONFIG.UPI_ID,
    payee: CONFIG.PAYEE_NAME
  };
}
function newToken_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 20); }

/** Called by the page every few seconds. Also nudges a Gmail check (at most every 20s). */
function getStatus(id, token) {
  id = Number(id);
  var cache = CacheService.getScriptCache();
  if (!cache.get('recentCheck')) {
    cache.put('recentCheck', '1', 20);
    try { checkPayments(1); } catch (e) { console.error(e); }   // only if nobody else is checking right now
  }
  var sh = sheet_('Registrations');
  if (!id || id < 2 || id > sh.getLastRow()) return { status: 'Unknown' };
  var r = sh.getRange(id, 1, 1, REG.TOKEN).getValues()[0];
  var out = { status: r[REG.STATUS - 1] };
  // amount/UTR only go back to the buyer's own page (proven by their token); never names or emails
  if (token && String(token) === String(r[REG.TOKEN - 1]) && out.status === 'Paid') {
    out.amount = Number(r[REG.AMOUNT - 1]).toFixed(2);
    out.utr = String(r[REG.UTR - 1]);
  }
  return out;
}

// ---------------- Payment matching: the core trick ----------------
/** Reads new bank credit alerts from Gmail and matches them to Pending registrations by exact paise amount. */
function checkPayments(lockWaitMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(typeof lockWaitMs === 'number' ? lockWaitMs : 15000)) return;
  try {
    var props = PropertiesService.getScriptProperties();
    var since = Number(props.getProperty('watchSince') || 0);
    var paySh = sheet_('Payments');
    var regSh = sheet_('Registrations');
    var reviewSh = sheet_('Review');

    // message IDs already recorded, so we never double-process the same bank email
    var seen = {};
    var pl = paySh.getLastRow();
    if (pl >= 2) paySh.getRange(2, PAY.MSG_ID, pl - 1, 1).getValues().forEach(function (v) { seen[String(v[0])] = true; });
    var rl = reviewSh.getLastRow();
    if (rl >= 2) reviewSh.getRange(2, 7, rl - 1, 1).getValues().forEach(function (v) {
      var m = String(v[0]).match(/msg:([\w-]+)/); if (m) seen[m[1]] = true;
    });

    // NOTE: the search string and parseBankCredit_() below are written for HDFC Bank's alert
    // format. If you bank elsewhere, adjust both to match your bank's own alert wording —
    // see the README "Adapting to another bank" section for the parsing pattern to follow.
    var threads = GmailApp.search('from:' + CONFIG.BANK_SENDER + ' "successfully credited" newer_than:2d', 0, 30);
    var found = [];
    threads.forEach(function (t) {
      t.getMessages().forEach(function (m) {
        if (seen[m.getId()]) return;
        if (m.getDate().getTime() < since) return;   // ignore alerts from before setup() ran
        found.push(m);
      });
    });
    found.sort(function (a, b) { return a.getDate() - b.getDate(); });

    found.forEach(function (m) {
      var p = parseBankCredit_(htmlToText_(m.getBody()));
      if (!p) { addReview_(reviewSh, m.getDate(), 'Could not parse this bank alert email', '', '', '', '', m.getId()); return; }
      if (!looksAuthentic_(m)) {
        addReview_(reviewSh, m.getDate(), 'Sender could not be verified as your bank (possible fake email)', p.amount, p.payer, p.utr, '', m.getId());
        return;
      }
      // duplicate UTR guard: the same bank reference can never be matched twice
      if (pl >= 2 && paySh.getRange(2, PAY.UTR, paySh.getLastRow() - 1, 1).getValues().some(function (v) { return String(v[0]) === p.utr; })) {
        addReview_(reviewSh, m.getDate(), 'UPI reference already used', p.amount, p.payer, p.utr, '', m.getId());
        return;
      }
      var match = findPending_(regSh, p.paise, m.getDate());
      var matchedEmail = '';
      if (match) {
        matchedEmail = match.email;
        regSh.getRange(match.row, REG.STATUS, 1, 5).setValues([['Paid', m.getDate(), p.payer, p.vpa, p.utr]]);
        try {
          sendConfirmation_(match.name, match.email, p.amount, p.utr, siteForPaise_(p.paise));
          regSh.getRange(match.row, REG.INVITE_AT).setValue(new Date());
        } catch (e) {
          regSh.getRange(match.row, REG.NOTES).setValue('Email failed: ' + e.message);
        }
      } else {
        addReview_(reviewSh, m.getDate(), 'No pending registration with this exact amount today', p.amount, p.payer, p.utr, '', m.getId());
      }
      paySh.appendRow([m.getDate(), p.amount, p.payer, p.vpa, p.utr, matchedEmail || 'No match (see Review)', m.getId()]);
      pl = paySh.getLastRow();
    });
  } finally {
    lock.releaseLock();
  }
}

function findPending_(regSh, paise, paidAt) {
  var last = regSh.getLastRow();
  if (last < 2) return null;
  var rows = regSh.getRange(2, 1, last - 1, REG.NOTES).getValues();
  var paidDay = dayKey_(paidAt);
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    var at = r[REG.AT - 1];
    if (r[REG.STATUS - 1] !== 'Pending' || !(at instanceof Date)) continue;   // late payers of Expired rows fall through to Review
    if (dayKey_(at) !== paidDay) continue;
    if (at.getTime() > paidAt.getTime() + 60000) continue;      // a payment can't come before its own registration
    if (toPaise_(r[REG.AMOUNT - 1]) !== paise) continue;
    return { row: i + 2, name: r[REG.NAME - 1], email: r[REG.EMAIL - 1] };
  }
  return null;
}

/**
 * Pulls amount, payer, masked VPA and UPI reference out of a bank "credited" alert.
 * Written for HDFC Bank's wording — adapt the regexes for your own bank's alert format.
 */
function parseBankCredit_(text) {
  var a = text.match(/Rs\.?\s*([\d,]+\.\d{2})\s+has been successfully credited/i);
  if (!a) return null;
  var amount = Number(a[1].replace(/,/g, ''));
  var s = text.match(/Sender:\s*(.*?)\s*\(VPA:\s*([^)]+)\)/i);
  var u = text.match(/UPI Reference No\.?:?\s*(\d{12})/i);
  if (!u) return null;
  return { amount: amount, paise: Math.round(amount * 100), payer: s ? s[1].trim() : '', vpa: s ? s[2].trim() : '', utr: u[1] };
}

/** Accept only mail that Gmail authenticated as really coming from your bank's domain (DMARC/DKIM pass). */
function looksAuthentic_(m) {
  var from = String(m.getFrom()).toLowerCase();
  if (from.indexOf(CONFIG.BANK_SENDER) === -1) return false;
  var auth = String(m.getHeader('Authentication-Results') || '').toLowerCase();
  if (!auth) return true;   // header not exposed by Gmail: fall back to the sender-address check above
  var domain = CONFIG.BANK_SENDER.split('@')[1];
  var dmarcOk = /dmarc=pass/.test(auth) && auth.indexOf('header.from=' + domain) !== -1;
  var dkimOk = new RegExp('dkim=pass[^;]*header\\.(i|d)=@?[\\w.-]*' + domain.replace(/\./g, '\\.')).test(auth);
  return dmarcOk || dkimOk;
}

function sendConfirmation_(name, email, amount, utr, siteKey) {
  var key = siteOf_(siteKey);
  var site = SITES[key];
  var first = String(name).split(' ')[0];
  var linkLine = site.link
    ? 'Here is your link: <a href="' + esc_(site.link) + '">' + esc_(site.link) + '</a>'
    : "We'll email you the next steps shortly.";
  var html =
    '<p>Hi ' + esc_(first) + ',</p>' +
    '<p>We have received your payment of <b>Rs ' + Number(amount).toFixed(2) + '</b> (UPI ref ' + esc_(utr) + '). ' +
    'Your order for <b>' + esc_(site.title) + '</b> is confirmed.</p>' +
    (site.when ? '<p><b>When:</b> ' + esc_(site.when) + '</p>' : '') +
    '<p>' + linkLine + '</p>' +
    '<p>Thanks,<br>' + esc_(site.senderName) + '</p>' +
    '<p style="color:#888;font-size:12px">This is an automated confirmation email. Please do not reply.</p>';
  GmailApp.sendEmail(email, 'Payment received - your order is confirmed',
    html.replace(/<[^>]+>/g, '\n'), { name: site.senderName, htmlBody: html });
}

function addReview_(sh, at, reason, amount, payer, utr, related, msgId) {
  sh.appendRow([at, reason, amount, payer, utr || '', related, 'Open (msg:' + msgId + ')', '']);
}

// ---------------- Helpers ----------------
function sheet_(name) {
  var sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Tab "' + name + '" not found');
  return sh;
}
function dayKey_(d) { return Utilities.formatDate(d, CONFIG.TZ, 'yyyy-MM-dd'); }
function toPaise_(v) { return Math.round(Number(v) * 100); }
function esc_(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function htmlToText_(h) {
  return String(h).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/[ \t]+/g, ' ');
}
function upiUrl_(amount, note) {
  return 'upi://pay?pa=' + CONFIG.UPI_ID + '&pn=' + encodeURIComponent(CONFIG.PAYEE_NAME) +
    '&am=' + amount.toFixed(2) + '&cu=INR&tn=' + encodeURIComponent(note.slice(0, 40));
}

// ---------------- One-time setup ----------------
/** Run once from the Apps Script editor: grants permissions, starts watching Gmail from now, adds the 1-minute trigger. */
function setup() {
  PropertiesService.getScriptProperties().setProperty('watchSince', String(Date.now()));
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkPayments') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkPayments').timeBased().everyMinutes(1).create();
  GmailApp.getInboxUnreadCount();   // forces the Gmail permission prompt now, not on first real payment
  sheet_('Registrations'); sheet_('Payments'); sheet_('Review');
  Logger.log('Setup done. Now: Deploy > New deployment > Web app.');
}

// ---------------- Built-in checkout page (optional — skip this if you're using your own frontend, see demo/) ----------------
var PAGE_HTML = String.raw`<!DOCTYPE html>
<html><head><base target="_top">
<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js" onerror="var s=document.createElement('script');s.src='https://unpkg.com/qrcode-generator@1.4.4/qrcode.js';document.head.appendChild(s)"></script>
<style>
  *{box-sizing:border-box} body{margin:0;font-family:Arial,Helvetica,sans-serif;background:#f4f5f7;color:#111}
  .wrap{max-width:420px;margin:0 auto;padding:24px 16px}
  .card{background:#fff;border-radius:14px;padding:22px;box-shadow:0 2px 10px rgba(0,0,0,.06)}
  h1{font-size:20px;margin:0 0 4px} .sub{color:#555;font-size:14px;margin:0 0 18px}
  label{display:block;font-size:13px;font-weight:bold;margin:12px 0 6px}
  input{width:100%;padding:12px;border:1px solid #ccd;border-radius:8px;font-size:16px}
  button,.btn{display:block;width:100%;margin-top:18px;padding:14px;border:0;border-radius:8px;background:#5b3df5;color:#fff;font-size:16px;font-weight:bold;text-align:center;text-decoration:none;cursor:pointer}
  button:disabled{opacity:.6}
  .err{color:#b00020;font-size:14px;margin-top:10px;min-height:18px}
  .amt{font-size:34px;font-weight:bold;color:#0a7d32;text-align:center;margin:6px 0 2px}
  .note{font-size:13px;color:#555;text-align:center}
  #qr{display:flex;justify-content:center;margin:14px 0} #qr img{width:230px;height:230px}
  .status{margin-top:16px;padding:12px;border-radius:8px;background:#eef3ff;font-size:14px;text-align:center}
  .ok{background:#e5f4e4;color:#14532d;font-weight:bold}
  .hide{display:none}
</style></head>
<body><div class="wrap">
 <div class="card" id="step1">
  <h1>Checkout</h1>
  <p class="sub">Enter your details to get a payment QR.</p>
  <label for="name">Full name</label><input id="name" autocomplete="name">
  <label for="phone">Phone</label><input id="phone" inputmode="tel" autocomplete="tel">
  <label for="email">Email</label><input id="email" type="email" autocomplete="email">
  <button id="go" onclick="go()">Get my payment QR</button>
  <div class="err" id="err"></div>
  <p class="note">We use your details only to confirm and deliver this order.</p>
 </div>
 <div class="card hide" id="step2">
  <h1>Pay to confirm</h1>
  <div class="amt" id="amt"></div>
  <p class="note">Pay this exact amount. The paise are your personal order code, so please don't round it.</p>
  <div id="qr"></div>
  <p class="note" id="upi"></p>
  <a class="btn" id="paybtn" href="#">Pay with UPI app</a>
  <div class="status" id="status">Waiting for your payment. This page updates on its own within 1-3 minutes of paying.</div>
 </div>
</div>
<script>
var regId=null, timer=null;
function go(){
  var b=document.getElementById('go'), e=document.getElementById('err'); e.textContent=''; b.disabled=true; b.textContent='Please wait...';
  google.script.run.withSuccessHandler(show).withFailureHandler(function(x){e.textContent=x.message.replace(/^Error:\s*/,''); b.disabled=false; b.textContent='Get my payment QR';})
   .register({name:val('name'),phone:val('phone'),email:val('email')});
}
function val(i){return document.getElementById(i).value}
function show(r){
  regId=r.id;
  document.getElementById('step1').classList.add('hide'); document.getElementById('step2').classList.remove('hide');
  document.getElementById('amt').textContent='Rs '+r.amount;
  document.getElementById('upi').textContent='To '+r.payee+' ('+r.upiId+')';
  document.getElementById('paybtn').href=r.upiUrl;
  var q=qrcode(0,'M'); q.addData(r.upiUrl); q.make(); document.getElementById('qr').innerHTML=q.createImgTag(6,8);
  timer=setInterval(poll,6000);
}
function poll(){
  google.script.run.withSuccessHandler(function(s){
    if(s.status==='Paid'){clearInterval(timer);var el=document.getElementById('status');el.className='status ok';
      el.textContent='Payment received! Confirmation sent to '+val('email')+'.';
      document.getElementById('paybtn').classList.add('hide');}
    else if(s.status==='Review'){clearInterval(timer);document.getElementById('status').textContent='We received a payment but need to check it by hand. We will email you shortly.';}
  }).getStatus(regId);
}
</script></body></html>`;
