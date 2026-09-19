// Settings live in chrome.storage.local. The Jev key never leaves the browser
// except in the Authorization header of a request to api.typesafe.ai.

export const DEFAULT_CATEGORIES = [
  { name: 'Work', description: 'Colleagues, clients, projects, meetings, anything job related.' },
  { name: 'Personal', description: 'Friends, family and private matters.' },
  { name: 'Finance', description: 'Payments, invoices, receipts, payouts, banking, taxes, subscriptions being billed.' },
  { name: 'Shopping', description: 'Orders, shipping and delivery updates for things the recipient bought.' },
  { name: 'Marketing', description: 'Promotions, cold outreach, sales pitches, discounts and offers.' },
  { name: 'Newsletter', description: 'Recurring editorial or product-update mail the recipient subscribed to.' },
  { name: 'Social', description: 'Notifications from social networks, forums and community platforms.' },
  { name: 'Security', description: 'Sign-in alerts, verification codes, password resets, account and infrastructure warnings.' },
  { name: 'Support', description: 'Help desk tickets, service and vendor status, technical issues.' },
  { name: 'Events', description: 'Invitations, calendar items, conferences, webinars and RSVPs.' },
  { name: 'Travel', description: 'Flights, hotels, bookings and itineraries.' },
  { name: 'Other', description: 'Does not fit any other category.' }
];

export const DEFAULTS = {
  jevApiKey: '',
  jevModel: 'jev-latest',
  jevBaseUrl: 'https://api.typesafe.ai/v1',
  gmailQuery: 'in:inbox',
  maxEmails: 500, // 0 = every message the query matches
  concurrency: 6,
  categories: DEFAULT_CATEGORIES,
  // In-Gmail overlay. Works without any Google Cloud setup: the sender, subject
  // and preview line come straight out of Gmail's DOM.
  overlayEnabled: true,
  overlayAutoClassify: true
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get('settings');
  const settings = { ...DEFAULTS, ...(stored.settings || {}) };
  // Left over from builds that offered a web OAuth flow.
  delete settings.authMode;
  delete settings.webClientId;
  if (!Array.isArray(settings.categories) || settings.categories.length < 2) {
    settings.categories = DEFAULT_CATEGORIES;
  }
  return settings;
}

export async function saveSettings(patch) {
  const current = await loadSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
