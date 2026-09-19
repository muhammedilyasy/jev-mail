// Stable identity for an email across the two ways we see it: the Gmail API
// (which gives us a message id) and Gmail's DOM (which gives us neither a
// message id nor, reliably, a thread id). Sender address plus subject is the
// one thing both views agree on.
export function matchKey(fromEmail, subject) {
  const who = String(fromEmail || '').trim().toLowerCase();
  const what = String(subject || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return `${who}|${what}`;
}
