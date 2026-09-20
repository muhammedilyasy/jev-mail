// Settings live in chrome.storage.local. The Jev key never leaves the browser
// except in the Authorization header of a request to api.typesafe.ai.

export const DEFAULT_CATEGORIES = [
  { name: 'Work', description: 'Colleagues, clients and partners writing about projects, deliverables or meetings, plus notifications from work tools such as GitHub, Linear, Jira, Slack or Notion, and terms or policy updates from tools used for work. Not money (Finance), not account access (Security), not a service that is broken (Support).' },
  { name: 'Personal', description: 'Friends, family and private life. Nothing to do with work or with any company.' },
  { name: 'Finance', description: 'Money: invoices, receipts, payments taken or failed, payouts, refunds, bank and card activity, subscription charges and renewals, cloud or SaaS bills, budget alerts and tax. Choose Finance whenever the subject is a charge, bill, refund or payout, even if the sender is a work tool.' },
  { name: 'Shopping', description: 'Things the recipient bought: order confirmations, shipping and delivery updates, returns and exchanges.' },
  { name: 'Marketing', description: 'Anyone selling something: promotions, discounts, product launches, event or webinar promotion, and cold sales outreach — including from companies the recipient already uses. Choose Marketing over Newsletter when the point of the email is to sell.' },
  { name: 'Newsletter', description: 'Recurring content the recipient subscribed to for its own sake: editorial newsletters, product changelogs, digests and roundups.' },
  { name: 'Social', description: 'Social networks and community platforms: mentions, replies, comments, follows, friend requests and forum threads on X, LinkedIn, Instagram, Reddit, Discord and the like.' },
  { name: 'Security', description: 'Who can get into an account: sign-in and new-device alerts, verification and two-factor codes, password resets, suspicious activity warnings, API key or permission changes, and phishing or scam attempts. Choose Security over every other category when the email is about account access.' },
  { name: 'Support', description: 'Something needs fixing or is degraded: support tickets and their replies, bug reports, vendor incident and outage notices, and warnings that a domain, quota, integration or configuration is failing.' },
  { name: 'Events', description: 'Scheduling and attendance: calendar invitations, RSVPs, meeting confirmations and reminders, and conferences or webinars the recipient signed up for. If the email is selling tickets or seats, choose Marketing.' },
  { name: 'Travel', description: 'Flights, hotels, car hire, itineraries, check-in reminders and travel disruption.' },
  { name: 'Other', description: 'Nothing above fits.' }
];

export const DEFAULTS = {
  jevApiKey: '',
  jevModel: 'jev-latest',
  jevBaseUrl: 'https://api.typesafe.ai/v1',
  gmailQuery: 'in:inbox',
  maxEmails: 500, // 0 = every message the query matches
  concurrency: 6,
  categories: DEFAULT_CATEGORIES,
  // "Web application" OAuth client from Google Cloud. Only the dashboard needs
  // it; the in-Gmail badges read the page and never touch the Gmail API.
  googleClientId: '',
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
