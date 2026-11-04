// A browser sign-in ends by handing the app a link like
// openchamber://connect-host?d=<base64url JSON>. The page that produces it lives
// outside OpenChamber, so the payload is untrusted input: parse it here, reject
// anything that could not have come from a real server, and keep the token out
// of logs and events.

const MAX_LINK_LENGTH = 16_384;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_LABEL_LENGTH = 120;

// Field names that would let the link change how the request is made rather
// than which server it goes to.
const RESERVED_HEADERS = new Set([
  'cookie',
  'host',
  'content-length',
  'connection',
  'origin',
  'referer',
  'transfer-encoding',
  'te',
  'upgrade',
  'expect',
]);

const readText = (value) => (typeof value === 'string' ? value.trim() : '');

const isLoopbackHostname = (hostname) => {
  const clean = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return clean === 'localhost' || clean === '127.0.0.1' || clean === '::1';
};

const readAddress = (value) => {
  const address = readText(value);
  if (!address) return null;
  let url;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  // A plain-http address is only this machine, never a remote server.
  if (url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) return null;
  return address;
};

const readHeader = (value) => {
  const header = readText(value);
  if (!header) return '';
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(header)) return null;
  if (RESERVED_HEADERS.has(header.toLowerCase())) return null;
  return header;
};

const decodePayload = (value) => {
  if (!value) return null;
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
};

/**
 * @returns {{ url: string, token: string, header: string, label: string } | null}
 * `header` is '' when the payload names none and the token belongs in the
 * bearer slot.
 */
export const parseHostCredentialLink = (raw, { protocol = 'openchamber' } = {}) => {
  const link = readText(raw);
  if (!link || link.length > MAX_LINK_LENGTH) return null;
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== `${protocol}:` || url.hostname !== 'connect-host') return null;

  const payload = decodePayload(readText(url.searchParams.get('d')));
  if (!payload || payload.v !== 1) return null;

  const address = readAddress(payload.url);
  const token = readText(payload.token);
  if (!address || !token || token.length > MAX_TOKEN_LENGTH) return null;

  const header = readHeader(payload.header);
  if (header === null) return null;

  const label = readText(payload.label);
  if (label.length > MAX_LABEL_LENGTH) return null;

  return { url: address, token, header, label };
};
