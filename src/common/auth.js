// Gmail OAuth through chrome.identity.launchWebAuthFlow, using a "Web
// application" OAuth client whose ID the user pastes into Settings.
//
// chrome.identity.getAuthToken would handle refresh for us, but it only reads
// the client ID from manifest.json — and nobody downloading this from GitHub
// should have to edit that file. The trade: Google hands back an access token
// good for an hour, which we cache and re-mint silently with prompt=none.

import { loadSettings } from './settings.js';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const CACHE_KEY = 'gmailToken';

export function extensionId() {
  return chrome.runtime.id;
}

/** What goes into the OAuth client's "Authorized redirect URIs". */
export function redirectUrl() {
  return chrome.identity.getRedirectURL();
}

async function clientId() {
  return (await loadSettings()).googleClientId.trim();
}

// chrome.storage.session outlives a dashboard reload but not the browser, and
// is only readable by extension pages — never by the Gmail content script.
async function cachedToken(id) {
  const { [CACHE_KEY]: cached } = await chrome.storage.session.get(CACHE_KEY);
  if (!cached || cached.clientId !== id) return null;
  return cached.expiresAt - 60_000 > Date.now() ? cached.token : null;
}

export async function getToken({ interactive = false } = {}) {
  const id = await clientId();
  if (!id) throw new Error('No Google OAuth client ID. Add one in Settings → Gmail.');

  const cached = await cachedToken(id);
  if (cached) return cached;

  const params = new URLSearchParams({
    client_id: id,
    response_type: 'token',
    redirect_uri: redirectUrl(),
    scope: SCOPE,
    include_granted_scopes: 'true',
    prompt: interactive ? 'select_account' : 'none'
  });

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      interactive,
      // Google's silent flow redirects after its first page load. Without these,
      // Chrome abandons a non-interactive flow before the token ever arrives.
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: 10_000
    });
  } catch (err) {
    throw new Error(interactive ? `Gmail authorization failed: ${err.message}` : 'Gmail is not connected.');
  }

  const fragment = new URLSearchParams((responseUrl || '').split('#')[1] || '');
  const token = fragment.get('access_token');
  if (!token) {
    const reason = fragment.get('error_description') || fragment.get('error') || 'no access token returned';
    throw new Error(`Gmail authorization failed: ${reason}`);
  }

  const ttl = Number(fragment.get('expires_in') || 3600) * 1000;
  await chrome.storage.session.set({
    [CACHE_KEY]: { token, clientId: id, expiresAt: Date.now() + ttl }
  });
  return token;
}

// Called after a 401 so the next getToken mints a fresh token instead of
// handing back the dead one from cache.
export async function invalidateToken() {
  await chrome.storage.session.remove(CACHE_KEY);
}

export async function signOut() {
  let token = null;
  try {
    token = await getToken({ interactive: false });
  } catch {
    // Not connected, or the grant is already gone.
  }
  await invalidateToken();

  // Clearing the cache alone isn't a sign-out: the silent flow would walk
  // straight back in on the next page load. Revoking the grant is what sticks.
  if (token) {
    await fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token })
    }).catch(() => {});
  }
}
