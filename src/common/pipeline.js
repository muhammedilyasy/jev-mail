import { getProfile, listMessageIds, getMessage } from './gmail.js';
import { classify } from './jev.js';
import { getEmailIds, putEmail, putEmails, getAllEmails, deleteEmails } from './db.js';

/** Bounded worker pool. One item failing never takes the run down. */
async function pool(items, limit, worker, signal) {
  let cursor = 0;
  const width = Math.max(1, Math.min(limit, items.length));

  await Promise.all(
    Array.from({ length: width }, async () => {
      while (cursor < items.length) {
        if (signal?.aborted) return;
        const item = items[cursor++];
        try {
          await worker(item);
        } catch (err) {
          if (err.name === 'AbortError') return;
          await worker.onError?.(item, err);
        }
      }
    })
  );
}

/**
 * Pull message metadata out of Gmail into IndexedDB. Messages already stored are
 * skipped, so re-syncing only costs the new arrivals.
 */
export async function syncInbox(settings, { onEvent, signal }) {
  onEvent({ type: 'stage', stage: 'auth', text: 'Checking Gmail access…' });
  const profile = await getProfile();
  onEvent({ type: 'profile', email: profile.emailAddress, total: profile.messagesTotal });

  onEvent({ type: 'stage', stage: 'listing', text: 'Listing messages…' });
  // 0 means "no ceiling" — page until Gmail runs out of matches.
  const ids = await listMessageIds({
    query: settings.gmailQuery,
    limit: settings.maxEmails > 0 ? settings.maxEmails : Infinity,
    signal,
    onProgress: (count) => onEvent({ type: 'stage', stage: 'listing', text: `Listing messages… ${count}` })
  });

  const known = await getEmailIds();
  const fresh = ids.filter((id) => !known.has(id));

  if (!fresh.length) {
    onEvent({ type: 'stage', stage: 'idle', text: 'Inbox already up to date.' });
    return { added: 0, total: ids.length };
  }

  onEvent({ type: 'stage', stage: 'fetching', text: `Fetching ${fresh.length} messages…` });

  let done = 0;
  let buffer = [];

  const flush = async () => {
    if (!buffer.length) return;
    const batch = buffer;
    buffer = [];
    await putEmails(batch);
    onEvent({ type: 'rows', rows: batch });
  };

  const fetchOne = async (id) => {
    const email = await getMessage(id, { signal });
    buffer.push(email);
    done++;
    if (buffer.length >= 15) await flush();
    onEvent({ type: 'progress', phase: 'fetch', done, total: fresh.length });
  };
  fetchOne.onError = async (id, err) => {
    done++;
    onEvent({ type: 'warn', text: `Could not load message ${id}: ${err.message}` });
    onEvent({ type: 'progress', phase: 'fetch', done, total: fresh.length });
  };

  // Gmail's per-user quota is generous for metadata reads; 10 in flight stays
  // well inside it while keeping the table filling quickly.
  await pool(fresh, 10, fetchOne, signal);
  await flush();
  await reconcileOverlayRows();

  onEvent({ type: 'stage', stage: 'idle', text: `Fetched ${done} messages.` });
  return { added: done, total: ids.length };
}

/**
 * The Gmail overlay stores rows it classified on sight under a `dom:` id, since
 * it never sees a real message id. Once the API delivers the same email, hand
 * the classification over and drop the placeholder.
 */
async function reconcileOverlayRows() {
  const rows = await getAllEmails();
  const byKey = new Map();
  for (const row of rows) {
    if (!row.matchKey) continue;
    const bucket = byKey.get(row.matchKey) || { real: null, placeholders: [] };
    if (row.id.startsWith('dom:')) bucket.placeholders.push(row);
    else if (!bucket.real) bucket.real = row;
    byKey.set(row.matchKey, bucket);
  }

  const merged = [];
  const stale = [];
  for (const { real, placeholders } of byKey.values()) {
    if (!real || !placeholders.length) continue;
    const donor = placeholders.find((p) => p.result);
    if (donor && !real.result) merged.push({ ...real, result: donor.result, status: 'done' });
    stale.push(...placeholders.map((p) => p.id));
  }

  await putEmails(merged);
  await deleteEmails(stale);
}

/**
 * Send every unclassified row to Jev. `rows` defaults to everything in the DB
 * that has no result yet.
 */
export async function classifyAll(settings, { rows, ownerEmail, onEvent, signal }) {
  const targets = (rows || (await getAllEmails())).filter((r) => !r.result);

  if (!targets.length) {
    onEvent({ type: 'stage', stage: 'idle', text: 'Everything is already classified.' });
    return { done: 0, failed: 0, inputTokens: 0 };
  }

  onEvent({ type: 'stage', stage: 'classifying', text: `Classifying ${targets.length} emails…` });

  let done = 0;
  let failed = 0;
  let inputTokens = 0;

  const classifyOne = async (email) => {
    const result = await classify(settings, email, ownerEmail, { signal });
    const updated = { ...email, result, status: 'done', error: null };
    await putEmail(updated);
    inputTokens += result.inputTokens || 0;
    done++;
    onEvent({ type: 'row', row: updated });
    onEvent({ type: 'progress', phase: 'classify', done: done + failed, total: targets.length, inputTokens });
  };
  classifyOne.onError = async (email, err) => {
    failed++;
    const updated = { ...email, status: 'error', error: err.message };
    await putEmail(updated);
    onEvent({ type: 'row', row: updated });
    onEvent({ type: 'warn', text: `${email.subject.slice(0, 60)} — ${err.message}` });
    onEvent({ type: 'progress', phase: 'classify', done: done + failed, total: targets.length, inputTokens });
  };

  await pool(targets, settings.concurrency, classifyOne, signal);

  onEvent({
    type: 'stage',
    stage: 'idle',
    text: failed ? `Classified ${done}, ${failed} failed.` : `Classified ${done} emails.`
  });
  return { done, failed, inputTokens };
}
