import type { LookupAddress } from 'node:dns';
import {
  URL_SECURITY_ERROR_CODES,
  WebUrlSecurity,
} from './web-url-security.util';

const fakeLookup =
  (addresses: LookupAddress[]) => (): Promise<LookupAddress[]> =>
    Promise.resolve(addresses);

describe('WebUrlSecurity', () => {
  describe('synchronous checks', () => {
    it('rejects non-URL input', async () => {
      const security = new WebUrlSecurity();
      await expect(security.assertFetchable('not a url')).resolves.toEqual({
        ok: false,
        error: URL_SECURITY_ERROR_CODES.invalidUrl,
      });
    });

    it.each([
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<h1>x</h1>',
      'ftp://example.com/file',
    ])('rejects unsupported protocol: %s', async (rawUrl) => {
      const security = new WebUrlSecurity();
      await expect(security.assertFetchable(rawUrl)).resolves.toEqual({
        ok: false,
        error: URL_SECURITY_ERROR_CODES.unsupportedProtocol,
      });
    });

    it.each(['http://localhost/', 'http://foo.localhost/'])(
      'rejects localhost hostname: %s',
      async (rawUrl) => {
        const security = new WebUrlSecurity();
        await expect(security.assertFetchable(rawUrl)).resolves.toEqual({
          ok: false,
          error: URL_SECURITY_ERROR_CODES.blockedHost,
        });
      },
    );

    it.each([
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://192.168.1.1/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://169.254.169.254/latest/meta-data/',
      'http://0.0.0.0/',
      'http://[::1]/',
      'http://[fe80::1]/',
      'http://[fc00::1]/',
      'http://[::ffff:192.168.1.1]/',
    ])('rejects blocked private/loopback IP: %s', async (rawUrl) => {
      const security = new WebUrlSecurity();
      await expect(security.assertFetchable(rawUrl)).resolves.toEqual({
        ok: false,
        error: URL_SECURITY_ERROR_CODES.blockedIp,
      });
    });

    it('allows a public direct IP without DNS lookup', async () => {
      const lookup = jest.fn();
      const security = new WebUrlSecurity(lookup);
      const result = await security.assertFetchable('http://172.32.0.1/');
      expect(result).toEqual({
        ok: true,
        normalizedUrl: 'http://172.32.0.1/',
      });
      expect(lookup).not.toHaveBeenCalled();
    });
  });

  describe('DNS resolution checks', () => {
    it('allows a hostname resolving to public IPs', async () => {
      const security = new WebUrlSecurity(
        fakeLookup([{ address: '93.184.216.34', family: 4 }]),
      );
      await expect(
        security.assertFetchable('https://example.com/article'),
      ).resolves.toEqual({
        ok: true,
        normalizedUrl: 'https://example.com/article',
      });
    });

    it('rejects a hostname resolving to a private IP', async () => {
      const security = new WebUrlSecurity(
        fakeLookup([{ address: '127.0.0.1', family: 4 }]),
      );
      await expect(
        security.assertFetchable('https://evil.example.com/'),
      ).resolves.toEqual({
        ok: false,
        error: URL_SECURITY_ERROR_CODES.blockedIp,
      });
    });

    it('rejects when any resolved address is blocked', async () => {
      const security = new WebUrlSecurity(
        fakeLookup([
          { address: '93.184.216.34', family: 4 },
          { address: '10.0.0.5', family: 4 },
        ]),
      );
      await expect(
        security.assertFetchable('https://mixed.example.com/'),
      ).resolves.toEqual({
        ok: false,
        error: URL_SECURITY_ERROR_CODES.blockedIp,
      });
    });

    it('rejects when DNS lookup fails', async () => {
      const security = new WebUrlSecurity(() =>
        Promise.reject(new Error('ENOTFOUND')),
      );
      await expect(
        security.assertFetchable('https://nonexistent.example.com/'),
      ).resolves.toEqual({
        ok: false,
        error: URL_SECURITY_ERROR_CODES.dnsLookupFailed,
      });
    });
  });
});
