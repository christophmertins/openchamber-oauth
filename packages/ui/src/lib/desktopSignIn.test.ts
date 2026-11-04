import { describe, expect, test } from 'bun:test';
import { withDesktopSignInMarker } from './desktopSignIn';

describe('withDesktopSignInMarker', () => {
  test('adds the marker and keeps existing parameters', () => {
    expect(withDesktopSignInMarker('https://login.example/sign-in?returnTo=x'))
      .toBe('https://login.example/sign-in?returnTo=x&openchamber_desktop=1');
  });

  test('rejects addresses a browser must not open', () => {
    expect(withDesktopSignInMarker('file:///etc/passwd')).toBeNull();
    expect(withDesktopSignInMarker('not a url')).toBeNull();
  });
});
