// A sign-in proxy that supports the desktop handover reads this marker on its
// login page and, once the user is signed in, produces an
// openchamber://connect-host link instead of landing on the web UI. Pages that
// do not know it ignore the parameter.
export const DESKTOP_SIGN_IN_MARKER = 'openchamber_desktop';

/** @returns the URL to open, or null when it is not something a browser may load. */
export const withDesktopSignInMarker = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.searchParams.set(DESKTOP_SIGN_IN_MARKER, '1');
  return parsed.toString();
};
