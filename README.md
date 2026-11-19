# Gateway-free UPI checkout

Accept UPI payments on your own site, with automatic payment confirmation, **without a payment
gateway**. No Razorpay/Cashfree merchant onboarding, no per-transaction fees, no KYC wait, no
webhook secrets to manage. Just your own personal or business UPI ID, a Google Sheet, and one
Apps Script file.

Built and battle-tested for a real ₹199 webinar checkout — this repo is the sanitized,
generalized version of that backend, written up so anyone can reuse it.

## The problem this solves

If you want to sell something small and fast — a webinar seat, a digital download, a workshop —
the "proper" way is to sign up with a payment gateway (Razorpay, Cashfree, Instamojo...). That
means business KYC, approval wait times, and a cut of every transaction. For a side project, a
one-off event, or a solo creator testing an idea, that's a lot of friction for ₹199.

UPI already lets you accept money instantly to any personal or business VPA (`yourname@upi`) for
free. The missing piece is **knowing which payment belongs to which buyer**, automatically —
that's normally what the gateway's dashboard and webhooks give you. This project replaces that
missing piece with a trick that needs nothing but your own Gmail inbox.

## The core trick: paisa-level amounts as order IDs

UPI amounts support two decimal places (rupees and paise). Most people pay round numbers —
₹199, ₹500 — so nobody notices if you ask for ₹190.47 instead.

So instead of giving every buyer the same price, this backend gives **each buyer their own
unique decimal amount** within a tight range (e.g. ₹190.01–₹198.99 for a ₹199 product — always
at or under the real price, so nobody overpays). That amount becomes the buyer's order ID,
encoded directly into the one thing a UPI payment can't lose: the amount itself.

When the buyer pays, your bank sends a "₹190.47 credited" email alert, as it always does. A
script watches your Gmail inbox for that alert, reads the exact amount out of it, and matches it
straight back to the buyer who was given that exact amount. No UTR entry, no manual reconciliation,
no gateway needed — the payment confirms itself within about a minute.

```
Buyer A registers → reserved ₹190.47 → pays ₹190.47 → bank email "₹190.47 credited"
Buyer B registers → reserved ₹193.12 → pays ₹193.12 → bank email "₹193.12 credited"
                                                              ↓
                                          script reads the exact amount, matches it to
                                          the one buyer who was given that amount today,
                                          marks them Paid, emails their confirmation
```

Amounts are scoped **per day**, so the same ₹190.47 can be reused tomorrow for a different buyer
— you don't run out of slots. An unpaid reservation frees its amount back up after 45 minutes
(configurable), so a browsed-but-abandoned checkout doesn't permanently burn a slot either.

## Architecture

```
┌─────────────┐      POST /exec       ┌──────────────────────┐
│   Your       │ ───────────────────▶ │  Google Apps Script   │
│  frontend    │   {action:register}  │  (doPost / doGet)     │
│ (any site)   │ ◀─────────────────── │                        │
└─────────────┘   {amount, upiUrl}    │  - reserves amount     │
                                       │  - writes to Sheet     │
       buyer scans QR, pays via       │  - 1-min trigger:      │
       any UPI app directly to        │    checkPayments()     │
       your UPI ID — no gateway       └──────────┬─────────────┘
       sits in the middle                        │ reads
                                                  ▼
                                       ┌──────────────────────┐
                                       │   Gmail inbox         │
                                       │  (your bank's         │
                                       │  "credited" alerts)   │
                                       └──────────┬─────────────┘
                                                  │ match by exact
                                                  │ paisa amount
                                                  ▼
                                       ┌──────────────────────┐
                                       │  Google Sheet          │
                                       │  (Registrations,       │
                                       │   Payments, Review)    │
                                       │  — status flips to     │
                                       │    Paid, confirmation  │
                                       │    email sent          │
                                       └──────────────────────┘
```

Everything runs on free Google infrastructure: Apps Script as the backend/API, a Sheet as the
database, Gmail as the payment-notification channel, and Gmail again to send the confirmation.

## What's in this repo

| Path | What it is |
|---|---|
| `apps-script/Code.gs` | The entire backend. Paste into a Google Sheet's Apps Script editor. |
| `demo/index.html` | A minimal, framework-free checkout page showing how to call the backend as a JSON API from your own site. |

The backend also ships its own optional self-contained checkout page (`doGet()` in `Code.gs`) —
if you don't want to build any frontend at all, you can just share the Apps Script web app URL
directly and it works standalone.

## Setup

1. **Create a Google Sheet** with three tabs, named exactly:
   - `Registrations` — header row: `Timestamp | Name | Email | Phone | Amount | Status | PaidAt | Payer | PayerVPA | UTR | InviteSentAt | Notes | Token`
   - `Payments` — header row: `Timestamp | Amount | Payer | PayerVPA | UTR | MatchedEmail | MessageId`
   - `Review` — header row: `Timestamp | Reason | Amount | Payer | UTR | Related | Status | Notes`
2. **Extensions → Apps Script**, delete the default `Code.gs` stub, paste in this repo's `apps-script/Code.gs`.
3. Edit the `CONFIG` and `SITES` objects at the top with your own UPI ID, payee name, amount
   range, and your bank's alert sender address.
4. Run `setup()` once from the Apps Script editor's function dropdown. Approve the Gmail/Sheets
   permission prompts — this is what lets the script read your inbox and write to the Sheet.
5. **Deploy → New deployment → Web app.** Execute as yourself, access "Anyone." Copy the `/exec`
   URL.
6. Either: share that `/exec` URL directly as your checkout page, or point your own frontend's
   `fetch()` calls at it (see `demo/index.html` for the exact request/response shape).

## Adapting to another bank

`parseBankCredit_()` and the `CONFIG.BANK_SENDER` / Gmail search string in `Code.gs` are written
for HDFC Bank's UPI credit-alert wording. Every bank phrases its alerts differently, so to use
another bank:

1. Send yourself a small UPI payment and look at the actual "credited" email you receive.
2. Update `CONFIG.BANK_SENDER` to that email's `From:` address.
3. Update the regexes in `parseBankCredit_()` to match your bank's actual wording for the amount,
   sender name/VPA, and UPI reference number.
4. `looksAuthentic_()` checks Gmail's own DKIM/DMARC verdict for that sender domain — this
   generally needs no changes, since it just confirms the email domain, not the wording.

## Limitations — read before using this for anything serious

This is a clever personal workaround, **not a licensed payment aggregator**, and it has real
limits worth knowing before you rely on it:

- **Personal/business UPI accounts have transaction limits** (daily count and amount caps set
  by your bank/UPI app) — this isn't built for high volume.
- **No formal dispute resolution or buyer protection layer.** A gateway like Razorpay provides
  chargebacks, refund tooling, and compliance infrastructure that this does not replicate.
- **Depends on your bank's email format staying stable.** If your bank changes its alert
  wording, `parseBankCredit_()` silently stops matching until you update the regex (unmatched
  payments land in the `Review` tab rather than being lost, but they do need a manual look).
- **Apps Script execution quotas apply** (daily trigger-time limits on free Google accounts) —
  fine for low-to-moderate volume, not meant for high-throughput commercial payment processing.
- **Not a substitute for proper compliance** if you're running an actual registered business at
  scale — payment aggregators exist partly for regulatory reasons (RBI guidelines around who can
  facilitate payments on behalf of others), so for serious commercial use, a licensed gateway is
  still the right call.

This is best suited for solo creators, small one-off events, workshops, and side projects — exactly
what it was built for.

## FAQ

**Why not just use a UPI payment link with a fixed amount and ask buyers to paste their UTR?**
You can — that's the common manual approach. This removes the manual UTR-entry and
manual-reconciliation step entirely; the buyer just pays and the page updates itself.

**What if two buyers get assigned the same amount by coincidence?**
They can't — the script checks every amount already in use (paid or still-pending) for the
current day before assigning a new one, so assignments are always unique per day.

**What happens if a payment doesn't match anyone?**
It's logged to the `Review` tab with the reason (no pending registration with that amount,
unverified sender, etc.) rather than silently dropped, so you can reconcile it by hand.

**Can I sell more than one thing with this?**
Yes — add more entries to the `SITES` object in `Code.gs`, each with its own non-overlapping
amount range. One Sheet and one deployment can serve multiple products/events.

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, adapt it; no attribution required (though a star
is always appreciated).
