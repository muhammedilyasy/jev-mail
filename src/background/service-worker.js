// Two jobs:
//   1. Open the dashboard tab. The full-inbox pipeline runs there, not here —
//      MV3 kills idle workers and a full pass takes minutes.
//   2. Serve the Gmail content script, which cannot reach the extension's
//      IndexedDB or the Jev key on its own. Its batches are small (whatever is
//      on screen), so they comfortably fit a worker's lifetime.

import { loadSettings } from '../common/settings.js';
import { classify } from '../common/jev.js';
import { getByMatchKeys, putEmails } from '../common/db.js';

const DASHBOARD_URL = chrome.runtime.getURL('src/dashboard/dashboard.html');

async function openDashboard() {
  // getContexts finds our own tab without needing the "tabs" permission.
  const [existing] = await chrome.runtime.getContexts({
    contextTypes: ['TAB'],
    documentUrls: [DASHBOARD_URL]
  });

  if (existing?.tabId != null && existing.tabId !== chrome.tabs.TAB_ID_NONE) {
    await chrome.tabs.update(existing.tabId, { active: true });
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return;
  }

  await chrome.tabs.create({ url: DASHBOARD_URL });
}

chrome.action.onClicked.addListener(() => {
  openDashboard().catch((err) => console.error('[jev-mail]', err));
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    openDashboard().catch((err) => console.error('[jev-mail]', err));
  }
});

/* ------------------------------------------------------- overlay messaging */

const summarize = (row) =>
  row?.result
    ? {
        category: row.result.category,
        priority: row.result.priority,
        spam: row.result.spam,
        reply: row.result.reply,
        confidence: row.result.categoryConfidence
      }
    : null;

async function handleMessage(msg) {
  const settings = await loadSettings();

  if (msg.type === 'overlay:config') {
    return {
      enabled: settings.overlayEnabled,
      autoClassify: settings.overlayAutoClassify && Boolean(settings.jevApiKey.trim()),
      hasKey: Boolean(settings.jevApiKey.trim())
    };
  }

  if (msg.type === 'overlay:lookup') {
    const found = await getByMatchKeys(msg.keys || []);
    const results = {};
    for (const [key, row] of found) {
      const summary = summarize(row);
      if (summary) results[key] = summary;
    }
    return { results };
  }

  if (msg.type === 'overlay:classify') {
    if (!settings.jevApiKey.trim()) return { results: {}, error: 'No Jev API key set.' };
    if (!settings.overlayAutoClassify) return { results: {} };

    const items = (msg.items || []).slice(0, 40);
    const results = {};
    const rows = [];

    // On-screen batches stay modest so the worker is never mid-flight for long.
    const width = Math.min(settings.concurrency, 4);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(width, items.length) }, async () => {
        while (cursor < items.length) {
          const item = items[cursor++];
          try {
            const email = {
              fromName: item.fromName,
              fromEmail: item.fromEmail,
              subject: item.subject,
              snippet: item.snippet,
              date: item.date || '',
              hasUnsubscribe: false
            };
            const result = await classify(settings, email, msg.ownerEmail || '', {});
            results[item.matchKey] = summarize({ result });
            rows.push({
              id: `dom:${item.matchKey}`,
              threadId: item.threadId || null,
              matchKey: item.matchKey,
              internalDate: item.internalDate || Date.now(),
              labelIds: [],
              fromName: item.fromName,
              fromEmail: item.fromEmail,
              to: '',
              subject: item.subject,
              date: item.date || '',
              snippet: item.snippet,
              hasUnsubscribe: false,
              result,
              status: 'done',
              error: null
            });
          } catch (err) {
            console.warn('[jev-mail] overlay classify failed', err.message);
          }
        }
      })
    );

    await putEmails(rows);
    return { results };
  }

  return { error: `Unknown message ${msg.type}` };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('overlay:')) return false;
  handleMessage(msg)
    .then(sendResponse)
    .catch((err) => sendResponse({ error: err.message }));
  return true; // keep the channel open for the async reply
});
