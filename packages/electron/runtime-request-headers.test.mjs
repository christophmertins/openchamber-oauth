import { describe, expect, test } from 'bun:test';
import { hostRequestHeadersToAdd, sanitizeRuntimeRequestHeaders } from './runtime-request-headers.mjs';

describe('sanitizeRuntimeRequestHeaders', () => {
  test('preserves safe custom headers', () => {
    expect(sanitizeRuntimeRequestHeaders({
      ' CF-Access-Client-Id ': ' client-id ',
      'X-Custom-Header': 'value',
    })).toEqual({
      'CF-Access-Client-Id': 'client-id',
      'X-Custom-Header': 'value',
    });
  });

  test('drops invalid and reserved headers', () => {
    expect(sanitizeRuntimeRequestHeaders({
      Authorization: 'Bearer proxy-token',
      'authorization': 'Bearer lower-token',
      'Bad:Name': 'value',
      'Bad\nName': 'value',
      'Bad-Value': 'line\nbreak',
      Empty: '',
      Good: 'ok',
    })).toEqual({ Good: 'ok' });
  });
});

describe('hostRequestHeadersToAdd', () => {
  test('adds the host headers to a request on the same origin', () => {
    expect(hostRequestHeadersToAdd(
      'https://env.example/api/session',
      'https://env.example',
      { 'X-Oc-Hosting-Token': 'secret' },
      [],
    )).toEqual({ 'X-Oc-Hosting-Token': 'secret' });
  });

  test('leaves another origin untouched', () => {
    expect(hostRequestHeadersToAdd(
      'https://login.example/sign-in',
      'https://env.example',
      { 'X-Oc-Hosting-Token': 'secret' },
      [],
    )).toEqual({});
  });

  test('does not overwrite a header the request already carries', () => {
    expect(hostRequestHeadersToAdd(
      'https://env.example/api/session',
      'https://env.example',
      { 'X-Oc-Hosting-Token': 'stored' },
      ['x-oc-hosting-token'],
    )).toEqual({});
  });
});
