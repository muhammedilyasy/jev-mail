# Jev Mail

A Chrome extension that scores every message in your Gmail with
[TypeSafe's Jev](https://typesafe.ai) model — **category**, **priority**,
**spam %** and **reply %** (how much the message needs an answer from you).

Two ways to see it:

- **Inline in Gmail** — badges appended to each row of your real thread list.
  Needs nothing but a Jev API key.
- **The dashboard** — the whole inbox in one sortable, filterable, exportable
  table. Needs a Gmail API OAuth client.

Read-only: it never sends, deletes, labels or archives anything.

```
Email                     Subject                                Category   Priority  Spam  Reply
• Amazon.com via Inbound   Ordered: 4 Electronics items           Shopping   Low        45%    4%
• OpenAI                   Review needed: safety identifier …     Security   High       20%   17%
• Mohammad Farseen         Re: you missed it                      Marketing  Low        29%   51%
```

## Quick start — in Gmail, no Google Cloud account

1. Open `chrome://extensions`, turn on **Developer mode**, **Load unpacked** →
   pick this folder.
2. Click the toolbar icon, hit the **gear**, paste your key from
   [console.typesafe.ai](https://console.typesafe.ai/), press **Test**, **Save**.
3. Open [Gmail](https://mail.google.com/). Rows get badged as you scroll.

That is the whole setup. The overlay reads the sender, subject and preview line
straight out of Gmail's page — the same three fields the API path sends to Jev —
so it needs no OAuth client and no Gmail API access at all.

What it looks like:

```
☆  OpenAI          Review needed: safety identifier activity  - We noticed…   Security  High    S 20%  R 17%
☆  Amazon.com      Ordered: 4 Electronics items  - Your order has shipped     Shopping  Low     S 45%  R 4%
☆  Linear          ENG-2214 assigned to you  - Can you look before Thursday   Work      Normal  S 2%   R 62%
```

Rows are classified once and cached, so scrolling back is free. Both settings
live under **Settings → In Gmail**: turn the badges off, or keep them on but
stop classifying new rows automatically.

## Full setup — the dashboard

The dashboard needs Gmail API access, which means an OAuth client. Skip this if
the overlay is enough for you.

### 1. Load the extension

Same as the quick start: **Load unpacked** on `chrome://extensions`. Then open
the dashboard, hit the **gear**, and find the **Redirect URL** under *Gmail*. It
looks like `https://<extension-id>.chromiumapp.org/`. Copy it.

### 2. Create a Google OAuth client

1. In [Google Cloud Console](https://console.cloud.google.com/), create (or pick)
   a project and [enable the Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com).
2. Configure the **OAuth consent screen**: type *External* is fine, and add your
   own Google account under **Test users**. That's all an unpublished app needs.
3. **Credentials → Create credentials → OAuth client ID → Web application**.
   Under **Authorized redirect URIs**, paste the redirect URL from step 1.
4. Copy the client ID into **Settings → Gmail → Google OAuth client ID** and
   save. No files to edit, no reload.

### 3. Run it

**Start** authorizes Gmail (once), fetches your messages, and classifies them.
Rows fill in live. **Stop** halts mid-run; anything already classified is kept.

## Using it

| Control       | What it does                                                                 |
| ------------- | ---------------------------------------------------------------------------- |
| **Start**     | Fetches (first run) and classifies everything that has no result yet          |
| **Sync**      | Pulls newly arrived messages only — already-stored ones are skipped           |
| **Export**    | CSV of whatever the current filters show                                      |
| Column header | Click to sort; click again to flip direction                                  |
| Search        | Filters on sender and subject                                                 |

Settings worth knowing:

- **Search query** — any Gmail search string. `in:inbox` by default; try
  `newer_than:30d`, `-category:promotions`, or `is:unread`.
- **Max messages** — how many to pull per run, newest first. Default 500; set it
  to **0** to fetch every message the query matches. There is no hard ceiling —
  the practical limits are time and Gmail's quota, not the extension. A full
  20,000-message inbox is roughly 20 minutes of fetching plus 20 minutes of
  classifying at the default concurrency, and about $1.70 of Jev usage. The table
  renders 400 rows at a time so a large inbox stays responsive.
- **Parallel requests** — Jev allows 1,200 requests/minute; raise this to go
  faster, lower it if you see 429s.
- **Categories** — one per line as `Name: what belongs in it`. The description
  is the rubric Jev scores against, so make it specific to your mail. Edit these
  freely; they are the biggest lever on classification quality.

## How the classification works

Spam is never asked as a question. Jev reads instructions literally and gets
worse when one question hides several judgments
([jaggedness](https://docs.typesafe.ai/model-jaggedness/jev-1.13)), and "is this
spam, a scam, or phishing?" hides three. A genuine *"your payment failed, your
account will be suspended"* notice from Google Cloud reads exactly like a
phishing template, and scored 86% spam under that one question.

So each email gets six narrow questions in one request — Jev ingests the state
once and answers them in parallel:

```json
POST https://api.typesafe.ai/v1/systemone
{
  "model": "jev-latest",
  "state": {
    "from_name": "Google Cloud",
    "from_address": "CloudPlatform-noreply@google.com",
    "subject": "[Action Required] Your billing account has been suspended",
    "preview": "We were unable to process your payment…",
    "gmail_tab": "Updates"
  },
  "questions": {
    "category":        { "type": "choice", "criteria": { "Work": "…", "Finance": "…", "Security": "…" } },
    "priority":        { "type": "choice", "criteria": { "Low": "…", "Normal": "…", "High": "…" } },
    "deceptive":       { "type": "noul", "instructions": "Is this email trying to trick the recipient…" },
    "unsolicited":     { "type": "noul", "instructions": "Is this unsolicited bulk mail…" },
    "official_domain": { "type": "noul", "instructions": "Is the sender's address on an official domain of…" },
    "service_notice":  { "type": "noul", "instructions": "Is this an automated notice about an account… the recipient uses?" },
    "reply":           { "type": "noul", "instructions": "Is a specific person waiting for the recipient to write back?" }
  }
}
```

**Code combines them**, in `compose()` in `src/common/jev.js`, together with two
facts Gmail already knows and Jev cannot see:

- **Did the sender pass DMARC?** Gmail records this in `Authentication-Results`.
  A pass means the From domain really sent the mail.
- **Is it in Gmail's spam folder?**

The rules, all of them readable and unit-tested:

| Rule | Why |
| ---- | --- |
| DMARC pass **and** official domain → scam score drops ~80% | Both together are what clears an alarming but genuine notice |
| Lookalike domain keeps its score even on a DMARC pass | `google-cloud-billing.co` passes DMARC for *its own* domain |
| DMARC fail on an official-looking domain → scam score raised | Someone is forging that brand's address |
| Unsolicited is damped by how much it reads as a service notice | Bulk mail about a service you use is not junk |
| In Gmail's spam folder → at least 90% | Gmail's filter is better than ours |
| `noreply@` → Reply % capped at 3% | Nobody is waiting. `notifications@` is **not** capped: GitHub and Linear turn an emailed reply into a comment |
| Cold outreach damps Reply % | Sales email is written to look like it wants an answer |
| Spam ≥ 50% → Priority forced to Low | Junk never outranks real mail |

Hover the **Spam** cell for the breakdown behind any score:
`scam/phishing 12% · unsolicited 3% · service notice 94% · official domain 97% · sender verified by Gmail`.

Every stored result records which rubric produced it, so changing the questions —
or editing your categories — makes the next run re-score automatically.

Only **metadata** is sent: sender name and address, subject, Gmail's
~200-character preview, and which Gmail tab it is in. Message bodies are never
fetched.

Cost: Jev bills $42 per billion input tokens and nothing for output. The rubric
is about 2,000 tokens per email, so roughly **9 cents per 1,000 emails**. The
running total and elapsed time appear in the status line.

## How the Gmail overlay works

A content script watches Gmail's thread list with a debounced `MutationObserver`,
reads each row, and asks the service worker for a verdict. The worker answers
from IndexedDB, or — when **Classify rows as they appear** is on — sends the
unknown rows to Jev (up to 40 at a time, 4 in flight) and stores the results.

The two views share one store. An email the dashboard fetched is keyed by its
Gmail message id; one the overlay saw first is keyed by `dom:<sender|subject>`.
Both carry a `matchKey` of sender address plus subject, which is the only
identity Gmail's DOM and the Gmail API agree on, so each view recognises what the
other already classified. After an API sync, placeholder rows hand their result
to the real row and delete themselves.

**This part is inherently brittle.** Gmail's class names (`tr.zA`, `span[email]`,
`span.bog`, `td.a4W`) are obfuscated and Google changes them. They have been
stable for years, but when one breaks the overlay renders nothing rather than
damaging the page — it only ever appends one `<span>` per row and never removes
or reorders anything Gmail drew. The selectors are collected in `SEL` at the top
of `src/content/gmail-overlay.js` so there is one place to fix.

Two known limits: the badges reserve 246px at the right of the subject cell, so
long subjects ellipsis earlier than they used to; and two emails with an
identical sender *and* subject (a daily report, say) share one classification.

## Layout

```
manifest.json
src/background/service-worker.js   opens the dashboard; serves the content script
src/common/auth.js                 Gmail OAuth (chrome.identity)
src/common/gmail.js                message list + metadata, retry/backoff
src/common/jev.js                  questions, state shaping, Jev HTTP client
src/common/pipeline.js             worker pool: fetch → classify → store
src/common/db.js                   IndexedDB, one record per email
src/common/key.js                  the sender+subject key shared by both views
src/common/settings.js             defaults + chrome.storage.local
src/content/                       the in-Gmail overlay
src/dashboard/                     the table UI
```

The full-inbox pipeline deliberately runs in the dashboard page rather than the
service worker: MV3 terminates idle workers, and a few thousand emails take
longer than that budget. The page lives as long as its tab does. The overlay's
batches are small enough to serve from the worker.

## Troubleshooting

**"No Google OAuth client ID"** — paste one into Settings → Gmail (step 2
above).

**`redirect_uri_mismatch` from Google** — the client's authorized redirect URI
doesn't match the one shown in Settings. Unpacked extensions get their ID from
the folder's location, so **moving or re-downloading the folder changes the
redirect URL**. Copy the current one from Settings into the client again.

**"Access blocked" or other Gmail authorization failures** — check that the
client type is *Web application* and that your account is listed under the
consent screen's **Test users**. Some managed Workspace accounts block
third-party OAuth clients entirely. If your admin does, the in-Gmail badges
still work, because they don't use OAuth at all.

**Asked to sign in again** — Google's access tokens last an hour. The extension
renews them silently while you're signed in to Google in Chrome. You only see
the popup again if that silent renewal fails, for example after you sign out of
Google.

**429s from Jev** — lower **Parallel requests**. Requests already retry with
exponential backoff, so this only matters when you push concurrency high.

**Badges stopped appearing in Gmail** — most likely Google renamed a class.
Check the `SEL` map in `src/content/gmail-overlay.js` against a row in your
inbox's DOM. Also confirm **Settings → In Gmail** is still enabled.

**Results look wrong for your mail** — rewrite the category descriptions. Jev
scores against the rubric you give it, so `Work: colleagues, clients, projects`
behaves very differently from `Work: anything from an @acme.com address or our
Linear/GitHub notifications`.
