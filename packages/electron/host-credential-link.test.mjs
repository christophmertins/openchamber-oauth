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
