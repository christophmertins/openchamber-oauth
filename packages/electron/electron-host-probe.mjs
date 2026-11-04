import { sanitizeRuntimeRequestHeaders } from './runtime-request-headers.mjs';
import { z } from 'zod';

const optionalIdentity = z.string().catch('').transform((value) => value.trim());
const versionEnvelope = z.object({
  status: z.literal('ok'),
  // Arrays historically classify as incompatible rather than wrong-service.
  compatibility: z.union([z.looseObject({}), z.array(z.unknown())]),
  openchamberVersion: optionalIdentity,
});

const buildProbeUrl = (url, pathname) => {
  try {
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '') || ''}${pathname}`;
    return parsed.toString();
  } catch {
    return null;
  }
};

// A server before 2.0 runs OpenCode 1.x and reports the same API version and
// capabilities as a current one; only its own version tells it apart. A
// version that does not parse says nothing either way.
const isServerBeforeOpenCode2 = (version) => {
  const major = /^(\d+)\./.exec(version)?.[1];
  return major !== undefined && Number(major) < 2;
};

const classifyVersionPayload = (payload) => {
  const parsed = versionEnvelope.safeParse(payload);
  if (!parsed.success) {
    return 'wrong-service';
  }
  const { compatibility, openchamberVersion } = parsed.data;
  if (!Array.isArray(compatibility.capabilities) || !compatibility.capabilities.includes('api.runtime-url.v1')) {
    return 'incompatible';
  }
  if (isServerBeforeOpenCode2(openchamberVersion)) {
    return 'incompatible';
  }
  if (compatibility.apiVersion !== 1 || compatibility.minClientApiVersion > 1) {
    return 'update-recommended';
  }
  return 'ok';
};

export const probeElectronHostWithDeadline = async ({
  url,
  timeoutMs,
  clientToken = '',
  requestHeaders = {},
  expectedServerId = '',
  chromiumFetch,
  isReady,
  now = Date.now,
  scheduleTimeout = setTimeout,
  cancelTimeout = clearTimeout,
}) => {
  const started = now();
  const result = (status) => ({ status, latencyMs: now() - started });
  // A sign-in page in front of the server answers the probes instead of it. The
  // URL is what the user's browser has to open; only a redirect names one. A
  // plain 401 on a password server has no page to open.
  const authResult = (authUrl = '') => {
    const auth = result('auth');
    if (authUrl) auth.authUrl = authUrl;
    return auth;
  };
  if (!isReady()) return result('unreachable');

  const versionUrl = buildProbeUrl(url, '/api/version');
  const sessionUrl = buildProbeUrl(url, '/auth/session');
  if (!versionUrl || !sessionUrl) throw new Error('Invalid URL');

  const controller = new AbortController();
  let rejectDeadline;
  const deadline = new Promise((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = scheduleTimeout(() => {
    controller.abort();
    rejectDeadline(new Error('Host probe deadline exceeded'));
  }, timeoutMs);

  const responses = new Set();
  const discardBody = async (response) => {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
  };
  const fetchProbe = async (requestUrl, headers, { redirect = 'manual' } = {}) => {
    controller.signal.throwIfAborted();
    const response = await chromiumFetch(requestUrl, {
      headers,
      signal: controller.signal,
      redirect,
    });
    if (controller.signal.aborted) {
      await discardBody(response);
      controller.signal.throwIfAborted();
    }
    responses.add(response);
    return response;
  };

  // The stored credential must not travel to whatever origin a sign-in proxy
  // redirects to. The credentialed attempt never follows; when it is stopped by
  // a redirect, the final answer is fetched again without credentials.
  const fetchCredentialed = async (requestUrl, headers) => {
    try {
      const response = await fetchProbe(requestUrl, headers, { redirect: 'manual' });
      return { response, redirected: response.status >= 300 && response.status < 400 };
    } catch (error) {
      // Electron 43 rejects manual redirects instead of returning the 3xx.
      if (error instanceof Error && error.message === 'Redirect was cancelled') {
        return { redirected: true };
      }
      throw error;
    }
  };

  const followWithoutCredentials = async (requestUrl) => {
    const response = await fetchProbe(requestUrl, { Accept: 'application/json' }, { redirect: 'follow' });
    return {
      url: response.url || requestUrl,
      ok: response.ok,
      payload: await response.json().catch(() => null),
      redirected: response.redirected === true,
    };
  };

  const run = async () => {
    const expectedIdentity = optionalIdentity.parse(expectedServerId);
    if (expectedIdentity) {
      const healthUrl = buildProbeUrl(url, '/health');
      if (healthUrl) {
        try {
          const response = await fetchProbe(healthUrl, { Accept: 'application/json' });
          // A redirected identity belongs to another candidate, even if its ID matches.
          if (response.status >= 300 && response.status < 400 || response.redirected) return result('wrong-service');
          if (response.ok) {
            const payload = await response.json().catch(() => null);
            const reported = optionalIdentity.parse(payload?.serverId);
            if (reported && reported !== expectedIdentity) return result('wrong-service');
          }
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // Electron 43 net.fetch rejects manual redirects instead of returning a 3xx response.
          if (error instanceof Error && error.message === 'Redirect was cancelled') return result('wrong-service');
          // Identity is optional on older servers; the authenticated request remains authoritative.
        }
      }
    }

    if (controller.signal.aborted) throw new Error('Host probe deadline exceeded');
    const headers = { ...sanitizeRuntimeRequestHeaders(requestHeaders), Accept: 'application/json' };
    const token = optionalIdentity.parse(clientToken);
    if (token) headers.Authorization = `Bearer ${token}`;

    const versionProbe = await fetchCredentialed(versionUrl, headers);
    if (versionProbe.redirected) {
      // A proxy that guards every path forwards /api/version to its login page.
      // A canonical redirect with a valid payload behind it still counts, and
      // that answer is fetched without the credential.
      const followed = await followWithoutCredentials(versionUrl);
      if (!(followed.ok && classifyVersionPayload(followed.payload) === 'ok')) {
        return authResult(followed.url);
      }
    } else {
      const versionResponse = versionProbe.response;
      if (versionResponse.status === 401 || versionResponse.status === 403) return authResult();
      if (!versionResponse.ok) return result('unreachable');
      const versionStatus = classifyVersionPayload(await versionResponse.json().catch(() => null));
      if (versionStatus !== 'ok') return result(versionStatus);
    }

    const sessionProbe = await fetchCredentialed(sessionUrl, headers);
    if (sessionProbe.redirected) {
      // A sign-in page answers with HTML; a canonical redirect ends on the
      // session JSON and is not a sign-in prompt.
      const followed = await followWithoutCredentials(sessionUrl);
      if (followed.ok && followed.payload) return result('ok');
      return authResult(followed.url);
    }
    const sessionResponse = sessionProbe.response;
    if (sessionResponse.status === 401 || sessionResponse.status === 403) return authResult();
    if (!sessionResponse.ok) return result('unreachable');
    return result('ok');
  };

  try {
    return await Promise.race([run(), deadline]);
  } catch {
    return result('unreachable');
  } finally {
    controller.abort();
    await Promise.allSettled([...responses].map(discardBody));
    cancelTimeout(timer);
  }
};
