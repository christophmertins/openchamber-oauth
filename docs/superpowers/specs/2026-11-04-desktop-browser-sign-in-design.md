# Desktop sign-in through the browser

## Why

The desktop app connects to a remote OpenChamber with a bearer token
(`clientToken`) or custom request headers (`requestHeaders`). A server behind a
sign-in proxy (OpenChamber Hosting, Authentik, oauth2-proxy) answers the probe
with a redirect to a browser login. Today that shows up as "unreachable" or as
the password gate, and the user has to mint a long-lived token in the portal and
paste it into the app.

The browser login already produces the credential the proxy accepts. The app
only has to open the browser and take the credential back.

## What the user does

1. Enters the server address in the connection form.
2. The probe reports that the server needs a sign-in, with the URL to open.
3. Clicks "Sign in in browser". The system browser opens at the login URL.
4. Signs in there. The page that finishes the login hands the app a host link.
5. The app asks for confirmation (server address and label) and stores the host.
   The runtime switches to it in place.
6. After a restart the host connects with the stored credential, with no browser.

## Non-goals

- OpenChamber does not become an OIDC client. The credential stays whatever the
  fronting sign-in issues.
- No relay changes. Relay pairing keeps its current flow.
- The page that hands over the credential lives on the proxy side. For
  OpenChamber Hosting that is a small change in `openchamber-hosting`; this PR
  defines the contract and implements the app half.

## Contract

- The app opens the login URL with `openchamber_desktop=1` appended. A login
  page that supports the flow reads the marker and, after authenticating,
  continues to a handover page instead of its normal landing page.
- The handover page links to
  `openchamber://host?d=<base64url JSON>`, with
  `{ v: 1, url, header?, token, label? }`.
  `url` is the server address the app should store. `token` goes into
  `requestHeaders[header]`, or into `clientToken` when `header` is missing or
  `Authorization`.
- Any page may produce the link. The app therefore never imports it silently:
  it shows the same warning dialog as a connect link and only then queues the
  host change.

## Approaches considered

1. **Loopback sign-in route in the OpenChamber server.** The browser returns a
   one-time code to `127.0.0.1`. Rejected: the fronting dispatcher checks its
   own token or cookie, so an OpenChamber client token does not pass, and the
   route would still need the proxy to know about the desktop flow.
2. **OpenChamber as an OIDC client (`OPENCHAMBER_OIDC_*`).** The desktop does a
   standard loopback flow with PKCE. Rejected for this change: it needs a
   Keycloak client per environment and replaces the portal's role.
3. **Browser handover link (chosen).** The proxy's own login ends in a deep link
   the app consumes. The app side is generic; the proxy adds one page.

## Pieces

**Probe** (`packages/electron/electron-host-probe.mjs`,
`packages/ui/src/lib/desktopHosts.ts`)

- Any probe response that was redirected counts as `auth`, not `unreachable` or
  `wrong-service`; the final response URL becomes the new `authUrl`.
- A `/auth/session` answer that is HTML instead of JSON also counts as `auth`,
  because a followed redirect can end in a 200 login page.
- `HostProbeResult` gains an optional `authUrl`.

**Desktop shell** (`packages/electron/main.mjs`)

- New deep-link type `host` (`openchamber://host?d=…`). It is parsed, validated
  (https address or loopback, header name syntax, token non-empty, size limit),
  confirmed in a dialog that names the address, and then queued as a pending host
  action. The token is never logged and never put into a window event.
- The deep link works when it arrives at a cold start: it goes into
  `pendingDeepLinks` like a session link and is dispatched once the main window
  listens.

**Renderer** (`packages/ui`)

- `desktopHostActions.ts` handles the new action: upsert a host by address with
  the token or header, make it the default only when no default is set, then
  activate it with `switchRuntimeEndpoint`, as relay activation already does.
  No restart is needed; the switch happens in place.
- `RemoteConnectionForm` and the auth gate show "Sign in in browser" when the
  probe reports `auth` with an `authUrl`, open it with `openExternalUrl`, and
  show a waiting state until the host action runs.
- New i18n keys in `en`.

**Tests**

- Probe: redirect to a login page yields `auth` + `authUrl`; unrelated 3xx still
  classifies as before.
- Deep link: valid payload parses; oversized payload, `http:` address in a
  non-loopback host, invalid header name, missing token are rejected.
- Host action: upsert keeps an existing default, adds the header or bearer token
  in the right field, and does not duplicate an existing host for the same
  address.

**Docs**

- `docs/` gets the link contract and the `openchamber_desktop=1` marker, so a
  proxy operator can implement the handover page.

## Risks

- The credential travels in a custom-scheme URL, which the OS URL handler and
  the process command line can see. The hosting token is already long-lived and
  visible in the portal; the app never logs the link and never echoes the token.
  If a proxy prefers, the link can carry a short-lived code instead. The app
  would then need an exchange call, which is not part of this change.
- A web page can trigger the link. The confirmation dialog names the address and
  is the guard, the same as for connect links.

## Open point

The feature needs an accepted feature request before the pull request, per
`CONTRIBUTING.md`. The hosting handover page is a second, small change in
`openchamber-hosting`.
