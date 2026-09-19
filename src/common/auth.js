// Gmail OAuth through chrome.identity.getAuthToken. Chrome owns the refresh
// cycle and there is no client secret anywhere; the OAuth client must be of
// type "Chrome Extension" and its ID has to sit in manifest.json.

export function manifestClientId() {
  const id = chrome.runtime.getManifest().oauth2?.client_id || '';
  return id.startsWith('REPLACE_ME') ? '' : id;
}

export function extensionId() {
  return chrome.runtime.id;
}

export async function getToken({ interactive = false } = {}) {
  if (!manifestClientId()) {
    throw new Error(
      'No OAuth client ID in manifest.json. Follow the setup steps on the dashboard or in the README.'
    );
  }
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      const err = chrome.runtime.lastError;
      if (err || !token) {
        reject(new Error(err?.message || 'Gmail authorization was dismissed.'));
        return;
      }
      resolve(token);
    });
  });
}

// Called after a 401 so the next getToken mints a fresh one instead of handing
// back the same dead token from cache.
export async function invalidateToken(token) {
  if (!token) return;
  await new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
}

export async function signOut() {
  await new Promise((resolve) => chrome.identity.clearAllCachedAuthTokens(resolve));
}
