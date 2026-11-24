import { describe, expect, it } from 'vitest';
import { DEV_JWT_ACCESS_SECRET } from '../namespaces/auth.config.js';
import {
  isGoogleApisHost,
  isKnownLocalSecret,
  isLoopbackHost,
  isPublicHttpsUrl,
} from './production-guards.js';

describe('isKnownLocalSecret', () => {
  it('recognises the values this repository publishes, and fill-me-in placeholders', () => {
    for (const value of [
      // docker-compose fallbacks and the local RustFS keys
      'compose-local-access-secret-not-for-production-0001',
      'sk_test_compose_local_not_for_production',
      'whsec_compose_local_not_for_production',
      'rustfsadmin',
      // development defaults
      DEV_JWT_ACCESS_SECRET,
      'sk_test_dev_placeholder',
      'sk_test_placeholder', // a former development default, still refused
      'change-me-before-deploying',
      // the docs' "fill me in" forms (.env.example, CONFIGURATION.md production checklist)
      'whsec_...',
      'sk_live_…',
      '<random>',
      '<from the secret store>',
    ]) {
      expect(isKnownLocalSecret(value), value).toBe(true);
    }
    for (const value of [undefined, 'Zr4mW9vQ2L8kT1xN6pB3yH7cJ5sD0fGa', 'sk_live_51HxRealKey']) {
      expect(isKnownLocalSecret(value), String(value)).toBe(false);
    }
  });
});

describe('isLoopbackHost', () => {
  it('recognises every spelling of a loopback or unspecified address', () => {
    for (const host of [
      'localhost',
      'localhost.',
      'LOCALHOST',
      'api.localhost',
      '127.0.0.1',
      '127.1',
      '127.8.9.10',
      '2130706433',
      '0x7f000001',
      '0.0.0.0',
      '::1',
      '[::1]',
      '0:0:0:0:0:0:0:1',
      '::',
      '::ffff:127.0.0.1',
    ]) {
      expect(isLoopbackHost(host), host).toBe(true);
    }
    for (const host of [
      'db.internal',
      '10.0.0.5',
      'example.com',
      'localhost.example.com',
      '128.0.0.1',
      '::ffff:10.0.0.5',
    ]) {
      expect(isLoopbackHost(host), host).toBe(false);
    }
  });
});

describe('isPublicHttpsUrl', () => {
  it('accepts https on a routable host only', () => {
    expect(isPublicHttpsUrl('https://files.example.com/x')).toBe(true);
    for (const value of [
      'http://files.example.com',
      'https://localhost:9000',
      'https://127.1',
      'https://[::1]:443',
      'not a url',
    ]) {
      expect(isPublicHttpsUrl(value), value).toBe(false);
    }
  });
});

describe('isGoogleApisHost', () => {
  it('matches googleapis.com and its subdomains, on a dot boundary', () => {
    for (const host of ['googleapis.com', 'storage.googleapis.com', 'eu.storage.googleapis.com']) {
      expect(isGoogleApisHost(host), host).toBe(true);
    }
    for (const host of ['evilgoogleapis.com', 'storage.googleapis.com.evil.io', 'localhost']) {
      expect(isGoogleApisHost(host), host).toBe(false);
    }
  });
});
