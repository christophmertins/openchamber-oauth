// A browser sign-in ends by handing the app a link like
// openchamber://connect-host?d=<base64url JSON>. The page that produces it lives
// outside OpenChamber, so the payload is untrusted input: parse it here, reject
// anything that could not have come from a real server, and keep the token out
// of logs and events.

import { z } from 'zod';

const MAX_LINK_LENGTH = 16_384;
const MAX_TOKEN_LENGTH = 8_192;
const MAX_LABEL_LENGTH = 120;
const MAX_HEADER_LENGTH = 128;

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

const payloadSchema = z.object({
  v: z.literal(1),
  url: z.string().trim().min(1).max(MAX_LINK_LENGTH),
  token: z.string().trim().min(1).max(MAX_TOKEN_LENGTH),
  header: z.string().trim().max(MAX_HEADER_LENGTH).optional(),
  label: z.string().trim().max(MAX_LABEL_LENGTH).optional(),
});

const isLoopbackHostname = (hostname) => {
  const clean = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return clean === 'localhost' || clean === '127.0.0.1' || clean === '::1';
};

const readAddress = (address) => {
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

/** @returns the header name, '' when none was named, or null when it is unusable. */
const readHeader = (header) => {
  if (!header) return '';
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(header)) return null;
  if (RESERVED_HEADERS.has(header.toLowerCase())) return null;
  return header;
};

const decodePayload = (value) => {
  if (!value) return null;
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
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
  const link = String(raw ?? '').trim();
  if (!link || link.length > MAX_LINK_LENGTH) return null;
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== `${protocol}:` || url.hostname !== 'connect-host') return null;

  const parsed = payloadSchema.safeParse(decodePayload(url.searchParams.get('d')));
  if (!parsed.success) return null;

  const address = readAddress(parsed.data.url);
  if (!address) return null;
  const header = readHeader(parsed.data.header);
  if (header === null) return null;

  return {
    url: address,
    token: parsed.data.token,
    header,
    label: parsed.data.label || '',
  };
};
