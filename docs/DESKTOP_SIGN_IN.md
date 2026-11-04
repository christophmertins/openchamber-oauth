# Signing the desktop app in through a browser

A server behind a sign-in proxy (OpenChamber Hosting, Authentik, oauth2-proxy)
cannot accept the desktop app's token until the user has signed in there. The
app opens the sign-in page in the system browser and takes the credential back
through a handover link. This page is the contract for the proxy side; the app
side is implemented.

## What the app does

1. The host probe answers `auth` and reports the URL of the sign-in page.
2. The user clicks "Sign in in browser" and the app opens that URL with the
   marker `openchamber_desktop=1` added.
3. The sign-in page finishes the browser login as usual, then produces an
   `openchamber://connect-host` link instead of landing on the web UI.
4. The app asks the user to confirm the server address, stores the host, and
   restarts onto it. Later starts use the stored credential.

## The marker

`openchamber_desktop=1` is the only signal that the browser was opened by the
desktop app. A sign-in page that does not read it keeps working as before. A
proxy that supports the handover reads it after login and shows the handover
page.

## The link

```
openchamber://connect-host?d=<base64url(JSON)>
```

The JSON payload:

```json
{
  "v": 1,
  "url": "https://cmertins-openchamber.oc.example.com",
  "token": "<credential>",
  "header": "X-Oc-Hosting-Token",
  "label": "Work environment"
}
```

- `url` is the server address the app saves. `https` is required; plain `http`
  is accepted only for `localhost`, `127.0.0.1` and `::1`.
- `token` is stored in `requestHeaders[header]`. When `header` is missing or
  `Authorization`, the token goes into the bearer slot instead.
- `header` may be any valid HTTP field name except `Cookie`, `Host`,
  `Content-Length`, `Connection`, `Origin`, `Referer`, `Transfer-Encoding`,
  `TE`, `Upgrade` and `Expect`. The app rejects the link otherwise.
- `label` is optional and is only a display name.

## The handover page

A minimal page after the login finished:

```html
<!doctype html>
<meta charset="utf-8">
<title>Continue in OpenChamber</title>
<p>You are signed in. Continue in the OpenChamber app.</p>
<a id="open" href="#">Open OpenChamber</a>
<script>
  const payload = {
    v: 1,
    url: 'https://cmertins-openchamber.oc.example.com',
    token: '<credential>',
    header: 'X-Oc-Hosting-Token',
    label: 'Work environment',
  };
  const link = 'openchamber://connect-host?d=' + btoa(JSON.stringify(payload))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  document.getElementById('open').href = link;
  // The click is what browsers may require; the automatic attempt comes first.
  location.href = link;
</script>
```

Serve the page from the sign-in origin after the session is established, so the
user cannot reach it without logging in. Prefer a short-lived, single-purpose
token over a long-lived one. The app confirms the address before storing
anything, and it never logs the token or the link.

## Limits

- The link is only useful while the `openchamber://` scheme is registered, which
  the desktop app does on install.
- A proxy that cannot run a page of its own cannot hand a token over. The
  desktop token field under Settings → Remote Instances stays the fallback.
- The app does not exchange a code; the link carries the credential itself. A
  proxy that wants a one-time code first needs an exchange endpoint on its side
  and a change in the app.
