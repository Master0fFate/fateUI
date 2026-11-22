const browserActionFallback = 'The browser action failed. Reopen the Browser workspace and try again.';

export function browserActionMessage(cause: unknown, fallback = browserActionFallback): string {
  const raw = typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '';
  let message = raw.trim();
  const wrapped = /^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/u.exec(message);
  if (wrapped) message = message.slice(wrapped[0].length);
  if (message.startsWith('{') && message.length <= 8192) {
    try {
      const payload: unknown = JSON.parse(message);
      message = payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string' ? payload.message.trim() : '';
    } catch {
      return fallback;
    }
  } else if (wrapped) return fallback;
  if (!message || message.startsWith('{') || message.startsWith('[')
    || /^(?:Error invoking remote method|No handler registered|\w*Error:|(?:net::)?ERR_[A-Z_]+)/u.test(message)
    || / is not a function$|\n\s*at /u.test(message)) return fallback;
  const text = message.replace(/[\u0000-\u001f\u007f\s]+/gu, ' ').trim();
  return text.length > 400 ? `${text.slice(0, 399)}…` : text || fallback;
}
