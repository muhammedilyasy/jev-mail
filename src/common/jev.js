// TypeSafe Jev client. One request per email carries all four questions: Jev
// ingests the state once and evaluates the questions against it in parallel,
// so four questions cost roughly what one costs.
// https://docs.typesafe.ai/api

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const PRIORITY_LEVELS = ['Low', 'Normal', 'High'];

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
      instructions: 'How urgently does the recipient need to deal with this email?',
      criteria: {
        Low: 'Routine, promotional, automated or purely informational. Nothing goes wrong if it is never opened.',
        Normal: 'Worth reading in the next day or two, but nothing is at stake right now.',
        High: 'Time sensitive or consequential: security and account alerts, outages, payment failures, legal or contractual deadlines, or a person who is blocked waiting on the recipient.'
      }
    },
    spam: {
      type: 'noul',
      instructions: 'Is this email unsolicited spam, a scam, or a phishing attempt?',
      criteria: {
        true: 'Unsolicited bulk mail, cold spam, a scam, phishing, or a sender impersonating someone else.',
        false: 'Legitimate mail the recipient expects or opted into, including transactional mail, receipts and newsletters they subscribed to.'
      }
    },
    reply: {
      type: 'noul',
      instructions: 'Does this email need a written reply from the recipient?',
      criteria: {
        true: 'A real person is waiting on an answer, a decision, or an action that only the recipient can give.',
        false: 'Automated, broadcast or informational mail. No-reply senders, receipts, newsletters and notifications need no response.'
      }
    }
  };
}

export function buildState(email, ownerEmail) {
  const state = {
    from_name: email.fromName,
    from_address: email.fromEmail,
    subject: email.subject,
    received: email.date,
    preview: email.snippet
  };
  if (ownerEmail) state.recipient = ownerEmail;
  if (email.hasUnsubscribe) state.has_unsubscribe_link = true;
  return state;
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

export async function classify(settings, email, ownerEmail, { signal } = {}) {
  const data = await post(
    settings,
    '/systemone',
    {
      model: settings.jevModel,
      state: buildState(email, ownerEmail),
      questions: buildQuestions(settings.categories)
    },
    { signal }
  );

  const a = data.answers || {};
  return {
    category: a.category?.choice ?? 'Other',
    categoryConfidence: a.category?.confidence ?? null,
    priority: a.priority?.choice ?? 'Low',
    priorityConfidence: a.priority?.confidence ?? null,
    spam: typeof a.spam?.noul === 'number' ? a.spam.noul : null,
    reply: typeof a.reply?.noul === 'number' ? a.reply.noul : null,
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
