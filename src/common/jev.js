// TypeSafe Jev client and the email rubric.
//
// One request per email carries every question: Jev ingests the state once and
// evaluates the questions against it in parallel, so extra narrow questions
// cost little. https://docs.typesafe.ai/api
//
// Jev reads literally and struggles when one question hides several judgments
// (https://docs.typesafe.ai/model-jaggedness/jev-1.13), so "spam" is never
// asked directly. It is assembled in code from narrower questions plus hard
// facts Gmail already knows: whether the sender's domain passed DMARC, and
// whether Gmail's own filter put the message in Spam.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PRIORITY_LEVELS = ['Low', 'Normal', 'High'];

// Bump when compose() changes meaning, so stored results get re-scored.
const COMPOSE_VERSION = 2;

export function buildQuestions(categories) {
  const categoryCriteria = {};
  for (const c of categories) {
    const name = (c.name || '').trim();
    if (name) categoryCriteria[name] = (c.description || '').trim() || null;
  }

  return {
    category: {
      type: 'choice',
      instructions: 'Which single category best describes this email?',
      criteria: categoryCriteria
    },

    priority: {
      type: 'choice',
      instructions: 'How soon does the recipient need to act on this email?',
      criteria: {
        Low: {
          meaning: 'Nothing to do, or nothing goes wrong if it waits a week.',
          examples: [
            'A promotion, newsletter or event invitation',
            'A receipt, a shipping update, a usage or analytics report',
            'A terms of service or policy update that asks for nothing',
            'A routine sign-in notice for a device the recipient owns',
            'A deprecation notice with a deadline months away'
          ]
        },
        Normal: {
          meaning: 'Should be handled in the next day or two, but nothing is lost today.',
          examples: [
            'A person asking a question or waiting on a decision',
            'A meeting or invitation to accept or decline',
            'A renewal, bill or trial ending soon but not yet overdue',
            'A support ticket the recipient opened getting a reply'
          ]
        },
        High: {
          meaning: 'Something breaks, stops or is lost if the recipient waits.',
          examples: [
            'A payment failed, or a payout could not be sent',
            'An account or service is suspended, or will be within days',
            'A security alert about activity the recipient may not recognise',
            'A production service is down, disabled or misconfigured right now',
            'A person is blocked until the recipient replies, with a deadline today or tomorrow'
          ]
        }
      }
    },

    // The three judgments that the old single "spam" question blended together.
    deceptive: {
      type: 'noul',
      instructions: 'Is this email trying to trick the recipient, such as a scam, phishing, or a sender pretending to be a company it is not?',
      criteria: {
        true: {
          meaning: 'The email is built to mislead the reader about who sent it or what will happen.',
          examples: [
            'A display name of a known company while the address is on an unrelated or lookalike domain',
            'An unexpected demand to "verify" a password, card or wallet through a link',
            'A fake invoice, delivery fee, prize, giveaway or investment return',
            'A threat of deletion or legal action from a company the recipient has no account with'
          ]
        },
        false: {
          meaning: 'An ordinary email from the company or person it says it is from.',
          examples: [
            'A real service notice from its own domain, even one that is alarming',
            'A receipt, alert, newsletter or promotion from a company the recipient uses',
            'A message from a real person'
          ],
          note: 'Urgent wording such as "action required", "payment failed", "account suspended" or "final notice" is normal in genuine service mail and is not by itself evidence of deception.'
        }
      }
    },
    unsolicited: {
      type: 'noul',
      instructions: 'Is this unsolicited bulk mail: marketing or cold outreach that the recipient did not ask for?',
      criteria: {
        true: {
          meaning: 'Sent to many people who never asked for it.',
          examples: [
            'A cold sales pitch or agency outreach to a stranger',
            'A promotion from a company the recipient has no account with',
            'An unrequested offer of services, leads, developers or manufacturing'
          ]
        },
        false: {
          meaning: 'The recipient has a relationship with the sender, or asked for this mail.',
          examples: [
            'Anything about an account, product or service the recipient already uses',
            'A newsletter the recipient subscribed to',
            'A message a person wrote to the recipient',
            'An enquiry from a potential customer about the recipient\'s own business'
          ]
        }
      }
    },
    // Code needs this to use Gmail's DMARC verdict safely: DMARC proves the
    // From domain sent the mail, not that the domain belongs to the brand named.
    official_domain: {
      type: 'noul',
      instructions: "Is the sender's email address on an official domain of the company or organisation the email says it is from?",
      criteria: {
        true: {
          meaning: 'The address domain is one the named organisation really owns, or a person writing from their own address.',
          examples: ['Google Cloud from google.com', 'AWS from amazon.com', 'Stripe from stripe.com', 'GitHub from github.com', 'A person from their own company or personal address']
        },
        false: {
          meaning: 'The address is on a domain the named organisation does not own.',
          examples: ['"Google Cloud Billing" from google-cloud-billing.co', '"PayPal" from paypa1-secure.com', '"Microsoft 365" from m365-mailbox-upgrade.net']
        }
      }
    },
    service_notice: {
      type: 'noul',
      instructions: 'Is this an automated notice about an account, product or service that the recipient uses?',
      criteria: {
        true: {
          meaning: 'Generated by a system because of the recipient\'s account or usage.',
          examples: [
            'Billing, invoices, payments, payouts and budget alerts',
            'Security and sign-in alerts, verification codes',
            'Usage or analytics reports, quota and configuration changes, outages',
            'Terms of service and policy updates',
            'Order, shipping and delivery updates'
          ]
        },
        false: {
          meaning: 'Written to persuade or to talk to the recipient.',
          examples: ['Marketing and promotions', 'Newsletters and editorial content', 'A message written by a person']
        }
      }
    },

    reply: {
      type: 'noul',
      instructions: 'Is a specific person waiting for the recipient to write back?',
      criteria: {
        true: {
          meaning: 'A named human is waiting on an answer only the recipient can give.',
          examples: [
            'A direct question, or a request for a decision or approval',
            'A proposed time to meet that needs confirming',
            'A customer or colleague blocked until the recipient responds',
            'A reply in a thread the recipient is part of'
          ]
        },
        false: {
          meaning: 'Nobody is waiting; the email is informational or is sent in bulk.',
          examples: [
            'Any automated notice, alert, receipt or report',
            'Newsletters and marketing',
            'Cold sales email that asks a question but was sent to many people',
            'An update sent for information, explicitly needing no action'
          ]
        }
      }
    }
  };
}

// Only what the questions need. Jev loses accuracy on irrelevant state, so the
// date, recipient and raw headers stay out.
export function buildState(email) {
  const state = {
    from_name: email.fromName,
    from_address: email.fromEmail,
    subject: email.subject,
    preview: email.snippet
  };
  if (email.gmailCategory) state.gmail_tab = email.gmailCategory;
  return state;
}

// FNV-1a over the questions: any change to the rubric, including a user
// editing their categories, gives stored results a different id and they get
// re-scored on the next run instead of lingering.
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export function rubricId(categories) {
  return `${COMPOSE_VERSION}.${hash(JSON.stringify(buildQuestions(categories)))}`;
}

// Addresses that cannot receive a reply. Deliberately excludes notifications@
// and alerts@: GitHub, Linear and others turn an emailed reply into a comment.
const NO_REPLY = /(^|[._+-])(no-?reply|do-?not-?reply|mailer-daemon|bounces?)([._+-]|@)/i;

export function isNoReplyAddress(address = '') {
  return NO_REPLY.test(address.toLowerCase());
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));

/**
 * Turn Jev's answers plus Gmail's facts into the four numbers the UI shows.
 * Every rule here is deliberate code, not model judgment, so it can be read,
 * tested and tuned.
 */
export function compose(answers, email) {
  const noul = (key) => (typeof answers[key]?.noul === 'number' ? answers[key].noul : 0);

  let deceptive = noul('deceptive');
  const unsolicited = noul('unsolicited');
  const serviceNotice = noul('service_notice');
  const officialDomain = noul('official_domain');

  // DMARC pass proves the From domain sent this; official_domain says whether
  // that domain is the brand's own. Only both together clear an alarming but
  // genuine notice. A lookalike domain passes DMARC too — it keeps its score.
  if (email.senderVerified === true) deceptive *= 1 - 0.8 * officialDomain;

  // DMARC fail on a brand's own domain is someone forging that brand's address.
  if (email.senderVerified === false) deceptive = Math.max(deceptive, 0.6 * officialDomain);

  // Bulk mail about a service the recipient uses is not junk.
  const unwanted = unsolicited * (1 - 0.7 * serviceNotice);

  let spam = Math.max(deceptive, unwanted);
  if (email.gmailSpam === true) spam = Math.max(spam, 0.9);
  spam = clamp01(spam);

  // Cold outreach is written to look like it wants an answer. Damp rather than
  // zero it: an unexpected customer enquiry is unsolicited-ish and still matters.
  let reply = noul('reply') * (1 - 0.6 * unsolicited);
  // Nobody can be waiting on a reply to an address that doesn't take replies.
  if (isNoReplyAddress(email.fromEmail)) reply = Math.min(reply, 0.03);

  // More likely junk than not: never let it outrank real mail.
  let priority = answers.priority?.choice ?? 'Low';
  if (spam >= 0.5) priority = 'Low';

  return {
    category: answers.category?.choice ?? 'Other',
    categoryConfidence: answers.category?.confidence ?? null,
    priority,
    priorityConfidence: answers.priority?.confidence ?? null,
    spam,
    reply: clamp01(reply),
    signals: {
      deceptive: noul('deceptive'),
      unsolicited,
      serviceNotice,
      officialDomain,
      senderVerified: email.senderVerified ?? null,
      gmailSpam: email.gmailSpam ?? null
    }
  };
}

/** Human-readable breakdown of a spam score, for tooltips. */
export function explainSpam(result) {
  const s = result?.signals;
  if (!s) return '';
  const pct = (n) => `${Math.round(n * 100)}%`;
  const parts = [
    `scam/phishing ${pct(s.deceptive)}`,
    `unsolicited ${pct(s.unsolicited)}`,
    `service notice ${pct(s.serviceNotice)}`,
    `official domain ${pct(s.officialDomain ?? 0)}`
  ];
  if (s.senderVerified === true) parts.push('sender verified by Gmail');
  if (s.senderVerified === false) parts.push('sender NOT verified');
  if (s.gmailSpam) parts.push("in Gmail's spam folder");
  return parts.join(' · ');
}

async function post(settings, path, body, { signal } = {}) {
  const url = `${settings.jevBaseUrl.replace(/\/$/, '')}${path}`;

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${settings.jevApiKey.trim()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (attempt >= 4) throw new Error(`Could not reach ${url}: ${err.message}`);
      await sleep(Math.min(16_000, 2 ** attempt * 600) + Math.random() * 400);
      continue;
    }

    if (res.ok) return res.json();

    // 429 rate limit and 529 overloaded are both "come back shortly".
    if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(20_000, 2 ** attempt * 800) + Math.random() * 500;
      await sleep(wait);
      continue;
    }

    throw new Error(`Jev ${res.status}: ${await errorDetail(res)}`);
  }
}

async function errorDetail(res) {
  const text = await res.text().catch(() => '');
  try {
    const json = JSON.parse(text);
    return json.error?.message || json.detail || json.message || text.slice(0, 200);
  } catch {
    return text.slice(0, 200) || res.statusText;
  }
}

export async function classify(settings, email, { signal } = {}) {
  const data = await post(
    settings,
    '/systemone',
    {
      model: settings.jevModel,
      state: buildState(email),
      questions: buildQuestions(settings.categories)
    },
    { signal }
  );

  return {
    ...compose(data.answers || {}, email),
    rubric: rubricId(settings.categories),
    model: data.model || settings.jevModel,
    inputTokens: data.usage?.input_tokens ?? 0
  };
}

/** Cheap credential check for the Settings dialog. */
export async function listModels(settings) {
  const url = `${settings.jevBaseUrl.replace(/\/$/, '')}/models`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${settings.jevApiKey.trim()}` }
  });
  if (!res.ok) throw new Error(`Jev ${res.status}: ${await errorDetail(res)}`);
  const data = await res.json();
  return data.models || [];
}
