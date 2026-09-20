import { getToken, invalidateToken } from './auth.js';
import { matchKey } from './key.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';
const META_HEADERS = ['From', 'To', 'Subject', 'Date', 'List-Unsubscribe', 'Authentication-Results'];

const CATEGORY_LABELS = {
  CATEGORY_PERSONAL: 'Primary',
  CATEGORY_UPDATES: 'Updates',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_SOCIAL: 'Social',
  CATEGORY_FORUMS: 'Forums'
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, { signal } = {}) {
  let refreshed = false;

  for (let attempt = 0; ; attempt++) {
    const token = await getToken({ interactive: false });
    const res = await fetch(`${BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal
    });

    if (res.ok) return res.json();

    // A cached token that Gmail rejects is worth exactly one retry.
    if (res.status === 401 && !refreshed) {
      refreshed = true;
      await invalidateToken();
      continue;
    }

    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(16_000, 2 ** attempt * 500) + Math.random() * 400;
      await sleep(wait);
      continue;
    }

    const body = await res.text().catch(() => '');
    let detail = '';
    try {
      detail = JSON.parse(body)?.error?.message || '';
    } catch {
      detail = body.slice(0, 200);
    }
    throw new Error(`Gmail API ${res.status}: ${detail || res.statusText}`);
  }
}

export async function getProfile() {
  return call('/profile');
}

/** Page through message IDs until `limit` is reached or Gmail runs out. */
export async function listMessageIds({ query, limit, onProgress, signal }) {
  const ids = [];
  let pageToken = null;

  while (ids.length < limit) {
    const params = new URLSearchParams({
      maxResults: String(Math.min(500, limit - ids.length))
    });
    if (query) params.set('q', query);
    if (pageToken) params.set('pageToken', pageToken);

    const page = await call(`/messages?${params}`, { signal });
    for (const m of page.messages || []) ids.push(m.id);
    onProgress?.(ids.length);

    pageToken = page.nextPageToken;
    if (!pageToken) break;
  }

  return ids.slice(0, limit);
}

/**
 * Did the From domain pass DMARC? Gmail stamps the verdict into
 * Authentication-Results; a pass means the domain in From really sent it.
 * Returns true/false when Gmail recorded a verdict, null when it didn't.
 */
export function senderVerified(payload, fromEmail) {
  const domain = (fromEmail.split('@')[1] || '').toLowerCase();
  const results = (payload?.headers || [])
    .filter((h) => h.name.toLowerCase() === 'authentication-results')
    .map((h) => h.value);
  if (!domain || !results.length) return null;

  let sawVerdict = false;
  for (const value of results) {
    const dmarc = value.match(/\bdmarc=(\w+)/i);
    if (!dmarc) continue;
    sawVerdict = true;
    const headerFrom = (value.match(/header\.from=([^\s;)]+)/i)?.[1] || '').toLowerCase();
    if (dmarc[1].toLowerCase() === 'pass' && (!headerFrom || headerFrom === domain)) return true;
  }
  return sawVerdict ? false : null;
}

function gmailCategory(labelIds) {
  for (const id of labelIds) if (CATEGORY_LABELS[id]) return CATEGORY_LABELS[id];
  return null;
}

function headerMap(payload) {
  const out = {};
  for (const h of payload?.headers || []) out[h.name.toLowerCase()] = h.value;
  return out;
}

/** '"Acme Support" <help@acme.com>' -> { name: 'Acme Support', email: 'help@acme.com' } */
export function parseAddress(raw = '') {
  const angled = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (angled) {
    const name = angled[1].replace(/^["']|["']$/g, '').trim();
    const email = angled[2].trim();
    return { name: name || email.split('@')[0], email };
  }
  const email = raw.trim();
  return { name: email.split('@')[0] || email, email };
}

export async function getMessage(id, { signal } = {}) {
  const params = new URLSearchParams({ format: 'metadata' });
  for (const h of META_HEADERS) params.append('metadataHeaders', h);

  const msg = await call(`/messages/${id}?${params}`, { signal });
  const headers = headerMap(msg.payload);
  const from = parseAddress(headers.from || '');

  const subject = headers.subject || '(no subject)';
  const labelIds = msg.labelIds || [];

  return {
    id: msg.id,
    threadId: msg.threadId,
    matchKey: matchKey(from.email, subject),
    internalDate: Number(msg.internalDate || 0),
    labelIds,
    fromName: from.name,
    fromEmail: from.email,
    to: headers.to || '',
    subject,
    date: headers.date || '',
    snippet: decodeEntities(msg.snippet || ''),
    hasUnsubscribe: Boolean(headers['list-unsubscribe']),
    senderVerified: senderVerified(msg.payload, from.email),
    gmailCategory: gmailCategory(labelIds),
    gmailSpam: labelIds.includes('SPAM'),
    result: null,
    status: 'pending',
    error: null
  };
}

// Gmail snippets arrive HTML-escaped (&amp;, &#39;, ...).
function decodeEntities(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}
