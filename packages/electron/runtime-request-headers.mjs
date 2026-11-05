const isReservedRuntimeRequestHeaderName = (name) => {
  return String(name || '').trim().toLowerCase() === 'authorization';
};

export const sanitizeRuntimeRequestHeaders = (headers) => {
  if (!headers || typeof headers !== 'object') return {};
  const next = {};
  for (const [rawName, rawValue] of Object.entries(headers)) {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (!name || !value || /[\r\n:]/.test(name) || /[\r\n]/.test(value)) continue;
    if (isReservedRuntimeRequestHeaderName(name)) continue;
    next[name] = value;
  }
  return next;
};

/**
 * The headers a request for `requestUrl` still needs from a host's stored
 * configuration. A different origin (a sign-in page, another service) never
 * matches, and a header the request already carries stays as it is.
 */
export const hostRequestHeadersToAdd = (requestUrl, apiBaseUrl, requestHeaders, presentHeaderNames = []) => {
  const headers = sanitizeRuntimeRequestHeaders(requestHeaders);
  if (Object.keys(headers).length === 0 || !requestUrl || !apiBaseUrl) return {};
  try {
    if (new URL(requestUrl).origin !== new URL(apiBaseUrl).origin) return {};
  } catch {
    return {};
  }
  const present = new Set((presentHeaderNames || []).map((name) => String(name).toLowerCase()));
  const next = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!present.has(name.toLowerCase())) next[name] = value;
  }
  return next;
};
