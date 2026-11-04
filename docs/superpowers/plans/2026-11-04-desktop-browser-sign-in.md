# Desktop browser sign-in implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A desktop user reaches an OpenChamber server that sits behind a browser sign-in (OpenChamber Hosting, Authentik, oauth2-proxy) without minting a token by hand: the probe reports the sign-in URL, the app opens the system browser, and a handover link gives the app the credential.

**Architecture:** The direct probe follows redirects and reports an `authUrl` when the answer is a sign-in page. The connection form opens that URL with an `openchamber_desktop=1` marker. The page that finishes the sign-in hands over `openchamber://connect-host?d=<base64url JSON>` with the server address and a token or header. The desktop shell validates and confirms it, the renderer upserts the host, and the app restarts onto it.

**Tech Stack:** Electron main (ESM `.mjs`, `node:test`), React + TypeScript UI, Bun workspace, `zod` for the IPC payload.

**Spec:** `docs/superpowers/specs/2026-11-04-desktop-browser-sign-in-design.md`

## Global Constraints

- No new dependencies.
- English in code, comments, docs; user-facing strings go through i18n.
- Never log the token, the raw handover link, or any part of the payload.
- The handover is never imported silently: a dialog names the server address first.
- `changelog/` stays untouched.
- Every locale dictionary must expose exactly the same keys as `en` (`packages/ui/src/lib/i18n/messages.test.ts`).
- Worktree setup before Task 1: `ln -s ../../node_modules node_modules` in the worktree root (Bun hoists to the repository root).

## Review Focus

- A proxy that redirects `/api/version` as well as `/auth/session`: a valid version payload behind a redirect stays a normal probe, only a sign-in answer becomes `auth`.
- A redirect that is not a sign-in (a trailing-slash rewrite with a valid payload) must not become `auth`.
- A handover link that arrives while the app is closed: it must be queued and confirmed after launch.
- A link whose `header` is `Authorization` or missing goes to `clientToken`; any other header goes to `requestHeaders`.
- A host that already exists for the same address is updated in place, not duplicated.

---

### Task 1: The probe reports the sign-in URL

**Files:**
- Modify: `packages/electron/electron-host-probe.mjs`
- Test: `packages/electron/electron-host-probe.test.mjs`
- Modify: `packages/ui/src/lib/desktopHosts.ts:206` (`HostProbeResult`) and `:538` (`desktopHostProbe`)

**Interfaces:**
- Produces: `HostProbeResult['authUrl']?: string` in the UI, read from the IPC field `authUrl`.
- The probe result from `probeElectronHostWithDeadline` gains `authUrl` on `status: 'auth'`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/electron/electron-host-probe.test.mjs`:

```js
test('reports the sign-in URL when /auth/session ends on a login page', async () => {
  const result = await baseProbe({
    chromiumFetch: async (url) => url.endsWith('/api/version')
      ? response(200, compatibleVersion)
      : { ...response(200, {}), redirected: true, url: 'https://login.example/sign-in?returnTo=opaque' },
  });

  assert.equal(result.status, 'auth');
  assert.equal(result.authUrl, 'https://login.example/sign-in?returnTo=opaque');
});

test('reports auth for a 401 on the version endpoint with the requested URL', async () => {
  const result = await baseProbe({
    chromiumFetch: async (url) => url.endsWith('/api/version')
      ? { ...response(401), url: 'https://instance.example/api/version' }
      : response(200, {}),
  });

  assert.equal(result.status, 'auth');
  assert.equal(result.authUrl, 'https://instance.example/api/version');
});

test('keeps a redirected version payload that is valid as a normal probe', async () => {
  const result = await baseProbe({
    chromiumFetch: async (url) => url.endsWith('/api/version')
      ? { ...response(200, compatibleVersion), redirected: true, url: 'https://instance.example/api/version' }
      : response(200, {}),
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.authUrl, undefined);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `node --test packages/electron/electron-host-probe.test.mjs`
Expected: FAIL, `result.authUrl` is `undefined` in the first two tests.

- [ ] **Step 3: Implement the classification**

In `probeElectronHostWithDeadline`, add a helper next to `result`:

```js
const authResult = (response, fallbackUrl) => ({ ...result('auth'), authUrl: response?.url || fallbackUrl });
```

Version call: on 401/403 return `authResult(versionResponse, versionUrl)`. Keep `classifyVersionPayload` as the first authority: when the payload classifies `ok`, continue even if `redirected` is true. When it does not classify `ok` and `versionResponse.redirected` is true, return `authResult(versionResponse, versionUrl)`, else the classification.

Session call: on 401/403 return `authResult(sessionResponse, sessionUrl)`; when `sessionResponse.redirected` is true return `authResult(sessionResponse, sessionUrl)` before the `!ok` check.

In `packages/ui/src/lib/desktopHosts.ts`, add `authUrl?: string` to `HostProbeResult` and map it from the probe reply (`raw.authUrl` or `raw.auth_url`, trimmed, only when status is `auth`).

- [ ] **Step 4: Run the tests and watch them pass**

Run: `node --test packages/electron/electron-host-probe.test.mjs`
Expected: PASS.

---

### Task 2: Parse and validate the handover link

**Files:**
- Create: `packages/electron/host-credential-link.mjs`
- Create: `packages/electron/host-credential-link.test.mjs`

**Interfaces:**
- Produces: `parseHostCredentialLink(raw, { protocol }) => { url, token, header, label } | null`, where `header` is `''` when the payload names none and `label` is `''` when absent.
- Link shape: `openchamber://connect-host?d=<base64url of JSON>`; JSON is `{ v: 1, url, token, header?, label? }`.

- [ ] **Step 1: Write the failing tests**

`packages/electron/host-credential-link.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHostCredentialLink } from './host-credential-link.mjs';

const link = (payload) =>
  `openchamber://connect-host?d=${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`;
const parse = (payload) => parseHostCredentialLink(link(payload), { protocol: 'openchamber' });

test('reads address, token, header and label', () => {
  assert.deepEqual(
    parse({ v: 1, url: 'https://oc.example.com/', token: 'secret', header: 'X-Oc-Hosting-Token', label: 'Work' }),
    { url: 'https://oc.example.com/', token: 'secret', header: 'X-Oc-Hosting-Token', label: 'Work' },
  );
});

test('accepts a loopback http address and a missing header and label', () => {
  assert.deepEqual(
    parse({ v: 1, url: 'http://127.0.0.1:4096', token: 'secret' }),
    { url: 'http://127.0.0.1:4096', token: 'secret', header: '', label: '' },
  );
});

test('rejects remote http addresses, reserved headers and broken payloads', () => {
  assert.equal(parse({ v: 1, url: 'http://oc.example.com', token: 'secret' }), null);
  assert.equal(parse({ v: 1, url: 'https://oc.example.com', token: 'secret', header: 'Cookie' }), null);
  assert.equal(parse({ v: 1, url: 'https://oc.example.com', token: 'secret', header: 'X Bad' }), null);
  assert.equal(parse({ v: 1, url: 'https://oc.example.com', token: '' }), null);
  assert.equal(parse({ v: 2, url: 'https://oc.example.com', token: 'secret' }), null);
  assert.equal(parseHostCredentialLink('openchamber://connect-host?d=%%%', { protocol: 'openchamber' }), null);
  assert.equal(parseHostCredentialLink('openchamber://focus/x', { protocol: 'openchamber' }), null);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `node --test packages/electron/host-credential-link.test.mjs`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the parser**

`packages/electron/host-credential-link.mjs`:
- `MAX_LINK_LENGTH = 16_384`, `MAX_TOKEN_LENGTH = 8_192`.
- Parse the URL, require the protocol and hostname `connect-host`, decode `d` with `Buffer.from(value, 'base64url')`, `JSON.parse`.
- Require `v === 1`, `url` http/https, https unless the hostname is `localhost`, `127.0.0.1` or `::1`; require a non-empty `token` within the length limit.
- `header` optional: match `/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/` and reject `cookie`, `host`, `content-length`, `connection`, `origin`, `referer`, `transfer-encoding`, `te`, `upgrade`, `expect`.
- `label` optional, trimmed, at most 120 characters.
- Return `null` on every failure; never throw.

- [ ] **Step 4: Run them and watch them pass**

Run: `node --test packages/electron/host-credential-link.test.mjs`
Expected: PASS.

---

### Task 3: The shell confirms and queues the credential

**Files:**
- Modify: `packages/electron/main.mjs` (`dispatchDeepLink`, imports)
- Modify: `packages/ui/src/lib/desktop.ts:637-646` (pending host action schema)
- Modify: `packages/electron/README.md:200` (deep-link table row)

**Interfaces:**
- Consumes: `parseHostCredentialLink` from Task 2.
- Produces: pending host action `{ type: 'credential', url: string, token: string, header?: string, label?: string }` from `desktop_take_pending_host_actions`.

- [ ] **Step 1: Extend the pending action schema**

In `packages/ui/src/lib/desktop.ts`, add to `pendingHostActionsSchema`:

```ts
z.object({
  type: z.literal('credential'),
  url: z.string().min(1),
  token: z.string().min(1).max(8_192),
  header: z.string().min(1).max(128).optional(),
  label: z.string().min(1).max(120).optional(),
}),
```

- [ ] **Step 2: Handle the deep link in main**

In `dispatchDeepLink`, before the `focus` branch:

```js
if (link.type === 'connect-host') {
  const credential = parseHostCredentialLink(link.raw, { protocol: DEEP_LINK_PROTOCOL });
  if (credential) {
    void confirmConnectDeepLink({
      serverUrl: credential.url,
      label: credential.label || credential.url,
    }).then((confirmed) => {
      if (!confirmed) {
        log.info('[electron] host credential deep-link declined by user');
        return;
      }
      queueHostAction({
        type: 'credential',
        url: credential.url,
        token: credential.token,
        ...(credential.header ? { header: credential.header } : {}),
        ...(credential.label ? { label: credential.label } : {}),
      });
    });
    return;
  }
  log.warn('[electron] invalid host credential deep-link payload');
  return;
}
```

- [ ] **Step 3: Document the link**

Add to the deep-link table in `packages/electron/README.md`: `openchamber://connect-host?d=…` adds a remote host with the credential from a browser sign-in; the shell confirms the address before anything is stored.

- [ ] **Step 4: Check the shell parses**

Run: `node --check packages/electron/main.mjs`
Expected: no output.

---

### Task 4: Upsert the host and restart onto it

**Files:**
- Modify: `packages/ui/src/lib/desktopHosts.ts` (add `mergeHostCredential`)
- Test: `packages/ui/src/lib/desktopHosts.test.ts` (existing file, add a block)
- Modify: `packages/ui/src/lib/desktopHostActions.ts`

**Interfaces:**
- Produces:
  ```ts
  type HostCredential = { url: string; token: string; header?: string; label?: string };
  mergeHostCredential(hosts: DesktopHost[], credential: HostCredential, newId: string): { hosts: DesktopHost[]; hostId: string };
  ```
  A missing or `authorization` header sets `clientToken`; any other header sets `requestHeaders[header]`. An existing host for the same API address is updated in place and keeps its id and other fields.

- [ ] **Step 1: Write the failing tests**

Add to `packages/ui/src/lib/desktopHosts.test.ts`:

```ts
test('adds a host with the credential header', () => {
  const { hosts, hostId } = mergeHostCredential([], { url: 'https://oc.example.com', token: 't', header: 'X-Oc-Hosting-Token', label: 'Work' }, 'host-a');
  expect(hostId).toBe('host-a');
  expect(hosts).toHaveLength(1);
  expect(hosts[0]).toMatchObject({
    id: 'host-a',
    label: 'Work',
    url: 'https://oc.example.com',
    requestHeaders: { 'X-Oc-Hosting-Token': 't' },
  });
  expect(hosts[0].clientToken).toBeUndefined();
});

test('reuses the existing host for the same address and replaces its credential', () => {
  const existing = [{ id: 'host-old', label: 'Old', url: 'https://oc.example.com', apiUrl: 'https://oc.example.com', clientToken: 'stale' }];
  const { hosts, hostId } = mergeHostCredential(existing, { url: 'https://oc.example.com', token: 't', header: 'Authorization' }, 'host-new');
  expect(hostId).toBe('host-old');
  expect(hosts).toHaveLength(1);
  expect(hosts[0]).toMatchObject({ id: 'host-old', label: 'Old', clientToken: 't' });
  expect(hosts[0].requestHeaders).toBeUndefined();
});

test('keeps a host label when the link names none', () => {
  const existing = [{ id: 'host-old', label: 'Home', url: 'https://oc.example.com' }];
  const { hosts } = mergeHostCredential(existing, { url: 'https://oc.example.com', token: 't', label: '' }, 'host-new');
  expect(hosts[0].label).toBe('Home');
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test packages/ui/src/lib/desktopHosts.test.ts` from `packages/ui`
Expected: FAIL, `mergeHostCredential` is not exported.

- [ ] **Step 3: Implement `mergeHostCredential`**

Match by `normalizeHostUrl(getDesktopHostApiUrl(host)) === normalizeHostUrl(credential.url)`. Update the matched host: label only when the credential names one, `clientToken` for a bearer, `requestHeaders` merged for a custom header. Keep `relay`, `sshForwarded`, `requestHeaders` that the new credential does not replace. For a new host, `{ id: newId, label: credential.label || url, url, apiUrl: url }`.

- [ ] **Step 4: Apply it in the host action**

In `desktopHostActions.ts`, add `applyHostCredential`:
- Read the config, `mergeHostCredential(config.hosts, action, 'host-' + Date.now().toString(16))`.
- `desktopHostsSet({ hosts, defaultHostId: hostId, initialHostChoiceCompleted: true })`.
- `restartDesktopApp()`; the stored credential is what the next boot probes with, which is also what makes it work after a restart.
- In `runPendingDesktopHostActions`, dispatch `credential` to it; a failure goes through the same `onFailure` path.

- [ ] **Step 5: Run the tests and watch them pass**

Run: `bun test packages/ui/src/lib/desktopHosts.test.ts` from `packages/ui`
Expected: PASS.

---

### Task 5: Marker for the sign-in URL

**Files:**
- Create: `packages/ui/src/lib/desktopSignIn.ts`
- Create: `packages/ui/src/lib/desktopSignIn.test.ts`

**Interfaces:**
- Produces: `withDesktopSignInMarker(url: string): string | null`, which adds `openchamber_desktop=1` to an http(s) URL and returns `null` for anything else.

- [ ] **Step 1: Write the failing tests**

```ts
test('adds the marker and keeps existing parameters', () => {
  expect(withDesktopSignInMarker('https://login.example/sign-in?returnTo=x'))
    .toBe('https://login.example/sign-in?returnTo=x&openchamber_desktop=1');
});

test('rejects addresses a browser must not open', () => {
  expect(withDesktopSignInMarker('file:///etc/passwd')).toBeNull();
  expect(withDesktopSignInMarker('not a url')).toBeNull();
});
```

- [ ] **Step 2: Run them and watch them fail.**

Run: `bun test packages/ui/src/lib/desktopSignIn.test.ts` from `packages/ui`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement it**, then run the tests again. Expected: PASS.

---

### Task 6: The two forms offer the browser sign-in

**Files:**
- Modify: `packages/ui/src/components/onboarding/RemoteConnectionForm.tsx`
- Modify: `packages/ui/src/components/sections/remote-instances/RemoteInstancesPage.tsx` (Add-host dialog)
- Modify: `packages/ui/src/lib/i18n/messages/en.ts`, `en.settings.ts` and the same key in all 14 other locale pairs

**Interfaces:**
- Consumes: `authUrl` (Task 1), `withDesktopSignInMarker` (Task 5), `openExternalUrl` from `@/lib/url`.

- [ ] **Step 1: Onboarding form**

When `probeResult.status === 'auth'` and `probeResult.authUrl` exists, render a secondary button under the auth warning:

```tsx
<Button variant="outline" onClick={() => { const url = withDesktopSignInMarker(probeResult.authUrl!); if (url) void openExternalUrl(url); }}>
  {t('onboarding.remoteConnection.actions.signInWithBrowser')}
</Button>
```

plus a muted line `onboarding.remoteConnection.status.browserSignInHint` under it. Keep the existing "Connect" path unchanged.

- [ ] **Step 2: Settings add-host dialog**

Add the same button next to the address field. On click, run `desktopHostProbe(normalizeHostUrl(directUrl))`: when the result is `auth` with an `authUrl`, open it with the marker; otherwise toast `settings.remoteInstances.direct.error.signInUnavailable`.

- [ ] **Step 3: Strings**

Add:
- `onboarding.remoteConnection.actions.signInWithBrowser` = `Sign in in browser`
- `onboarding.remoteConnection.status.browserSignInHint` = `Finish signing in in your browser. The app connects when you are done.`
- `settings.remoteInstances.direct.actions.signInWithBrowser` = `Sign in in browser`
- `settings.remoteInstances.direct.error.signInUnavailable` = `This server does not ask for a browser sign-in.`

German (`de.ts`, `de.settings.ts`): `Im Browser anmelden`, `Schließe die Anmeldung im Browser ab. Die App verbindet sich danach.`, `Im Browser anmelden`, `Dieser Server verlangt keine Anmeldung im Browser.`
Every other locale gets the English text for these four keys, so the key-parity test passes.

- [ ] **Step 4: Run the dictionary test**

Run: `bun test packages/ui/src/lib/i18n/messages.test.ts` from `packages/ui`
Expected: PASS.

---

### Task 7: Write the handover contract for proxy operators

**Files:**
- Create: `docs/DESKTOP_SIGN_IN.md`

- [ ] **Step 1: Document**

Short page: what the app does (opens the `authUrl` with `openchamber_desktop=1`), the payload shape, the field rules from Task 2, what happens on confirmation (host stored, app restarts), and one example link generator (a `<script>` that sets `location.href`). Say plainly that a proxy which does not implement the page produces no handover, and the user then uses the token field.

- [ ] **Step 2: Check the links and code fences render**

Read the file once end to end. No build needed.

---

### Task 8: Prove it in the running app

**Files:** none.

- [ ] **Step 1: Start a fake sign-in proxy**

A small Node server on `http://127.0.0.1:<port>` that:
- answers `/api/version` with the compatible version JSON,
- answers `/auth/session` with `302` to `/sign-in` unless the request carries `X-Oc-Hosting-Token: test-token`,
- serves `/sign-in` as a page whose button sets `location.href` to a valid `openchamber://connect-host` link (`url: http://127.0.0.1:<port>`, token `test-token`, header `X-Oc-Hosting-Token`).

- [ ] **Step 2: Run the desktop shell**

`bun run electron:dev` (add the debugging port from `desktop-shell`), enter the fake address in Settings → Remote Instances → Add, click "Sign in in browser".

Expected: the browser opens `/sign-in`; the button brings the app forward with the confirmation dialog; confirming stores the host, restarts, and the app connects (the fake proxy now accepts the header). Restart the app once more and confirm it connects without the browser.

- [ ] **Step 3: Prove the closed-app path**

Quit the app. Open a page in the system browser that sets `location.href` to the same handover link, or run `xdg-open '<link>'` on Linux. Expected: the app launches, shows the confirmation dialog, and after confirming stores the host and restarts onto it.

- [ ] **Step 4: Break it the ordinary ways**

Cancel the confirmation: no host is added. Point the form at an ordinary password server: the button reports that no browser sign-in is offered. Stop the fake server: the probe says unreachable as before.

- [ ] **Step 5: Run the pre-commit gate**

Run: `bun run check:changed`
Expected: PASS.
