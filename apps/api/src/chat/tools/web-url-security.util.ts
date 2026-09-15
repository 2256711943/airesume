import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';

/**
 * Chat 联网工具的 URL 安全校验（Phase 2）。
 *
 * 约束（对应实施计划书第 7 节安全边界）：
 * - 协议白名单：仅允许 http/https；
 * - SSRF 防护：拒绝本地回环、内网段、链路本地、0.0.0.0、ULA/链路本地 IPv6 等；
 * - 域名场景：通过 DNS 解析后校验解析出的 IP，任一命中黑名单即拒绝；
 * - 重定向复检：抓取后对最终 URL 再次调用 `assertFetchable`，防重定向绕过。
 */

export type HostLookupFn = (hostname: string) => Promise<LookupAddress[]>;

const defaultLookup: HostLookupFn = (hostname) =>
  dnsLookup(hostname, { all: true });

/** 校验结果：成功返回规范化后的 URL；失败返回错误码。 */
export type UrlSecurityResult =
  | { ok: true; normalizedUrl: string }
  | { ok: false; error: string };

/** 校验失败错误码。 */
export const URL_SECURITY_ERROR_CODES = {
  invalidUrl: 'invalid_url',
  unsupportedProtocol: 'unsupported_protocol',
  blockedHost: 'blocked_host',
  blockedIp: 'blocked_ip',
  dnsLookupFailed: 'dns_lookup_failed',
} as const;

export class WebUrlSecurity {
  constructor(private readonly lookup: HostLookupFn = defaultLookup) {}

  /**
   * 校验 URL 是否允许抓取。
   * 先做同步校验（格式 / 协议 / hostname 黑名单 / 直接 IP），
   * 再对域名做异步 DNS 解析校验。
   */
  async assertFetchable(rawUrl: string): Promise<UrlSecurityResult> {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      return { ok: false, error: URL_SECURITY_ERROR_CODES.invalidUrl };
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, error: URL_SECURITY_ERROR_CODES.unsupportedProtocol };
    }

    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
      return { ok: false, error: URL_SECURITY_ERROR_CODES.blockedHost };
    }

    // 直接 IP：无需 DNS，同步判定
    // URL 序列化后的 IPv6 hostname 带方括号（如 `[::1]`），需先剥离再判定
    const literalIp = stripIpv6Brackets(hostname);
    if (isIP(literalIp) !== 0) {
      return isBlockedIp(literalIp)
        ? { ok: false, error: URL_SECURITY_ERROR_CODES.blockedIp }
        : { ok: true, normalizedUrl: url.toString() };
    }

    // 域名：解析后校验所有解析结果，任一内网即拒绝
    try {
      const addresses = await this.lookup(hostname);
      for (const address of addresses) {
        if (isBlockedIp(address.address)) {
          return { ok: false, error: URL_SECURITY_ERROR_CODES.blockedIp };
        }
      }
      return { ok: true, normalizedUrl: url.toString() };
    } catch {
      return { ok: false, error: URL_SECURITY_ERROR_CODES.dnsLookupFailed };
    }
  }
}

/**
 * 剥离 IPv6 字面量的方括号（URL hostname 会保留 `[::1]` 形式）。
 */
function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * 判断 IP 是否命中黑名单。
 * 统一处理 IPv4-mapped IPv6（`::ffff:a.b.c.d`）后按版本判定。
 */
function isBlockedIp(ip: string): boolean {
  const normalized = extractIpv4FromMapped(ip);
  const family = isIP(normalized);

  if (family === 4) {
    return isBlockedIpv4(normalized);
  }
  if (family === 6) {
    return isBlockedIpv6(normalized);
  }
  // 既不是 IPv4 也不是 IPv6：无法解析，保守拒绝
  return true;
}

/** 提取 IPv4-mapped IPv6 中的 IPv4 地址；非映射格式原样返回。 */
function extractIpv4FromMapped(ip: string): string {
  const lower = ip.toLowerCase();
  const marker = '::ffff:';
  if (!lower.startsWith(marker)) {
    return ip;
  }
  const tail = lower.slice(marker.length);
  if (isIP(tail) === 4) {
    return tail;
  }
  // Node/URL 会把映射地址规范化成十六进制形式（如 ::ffff:c0a8:101）
  const groups = tail.split(':');
  if (
    groups.length === 2 &&
    groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))
  ) {
    const high = Number.parseInt(groups[0], 16);
    const low = Number.parseInt(groups[1], 16);
    return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  }
  return ip;
}

/** 私有/保留 IPv4 网段判定。 */
function isBlockedIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);

  if (a === 0) {
    return true; // 0.0.0.0/8
  }
  if (a === 10) {
    return true; // 10.0.0.0/8
  }
  if (a === 127) {
    return true; // 127.0.0.0/8 本地回环
  }
  if (a === 169 && b === 254) {
    return true; // 169.254.0.0/16 链路本地
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true; // 172.16.0.0/12
  }
  if (a === 192 && b === 168) {
    return true; // 192.168.0.0/16
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true; // 100.64.0.0/10 CGNAT
  }

  return false;
}

/** 特殊/私有 IPv6 地址判定。 */
function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  if (lower === '::' || lower === '::1') {
    return true; // 未指定 / 回环
  }
  if (lower.startsWith('fe80:')) {
    return true; // fe80::/10 链路本地
  }
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    return true; // fc00::/7 ULA
  }

  return false;
}
