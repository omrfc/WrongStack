import { afterEach, describe, expect, it, vi } from 'vitest';

const lookupMock = vi.fn();
vi.mock('node:dns/promises', () => ({ lookup: (...a: unknown[]) => lookupMock(...a) }));

import {
  assertNotPrivateHost,
  expandIPv6,
  isPrivateIPv4,
  isPrivateIPv6,
} from '../../src/utils/ip-guard.js';

describe('isPrivateIPv4', () => {
  it('blocks every reserved/private/loopback range', () => {
    for (const addr of [
      '0.0.0.0',
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254', // cloud metadata
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '192.0.0.1',
      '100.64.0.1', // CGNAT
      '224.0.0.1', // multicast
      '240.0.0.1', // reserved
    ]) {
      expect(isPrivateIPv4(addr), addr).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const addr of ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '93.184.216.34']) {
      expect(isPrivateIPv4(addr), addr).toBe(false);
    }
  });

  it('blocks malformed input defensively', () => {
    expect(isPrivateIPv4('1.2.3')).toBe(true); // too few octets
    expect(isPrivateIPv4('1.2.3.999')).toBe(true); // out of range
    expect(isPrivateIPv4('a.b.c.d')).toBe(true); // NaN
  });
});

describe('expandIPv6', () => {
  it('expands a full 8-group address', () => {
    expect(expandIPv6('2001:db8:0:0:0:0:0:1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
  });

  it('expands :: compression', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('fe80::1')).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('::')).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('returns null on malformed input', () => {
    expect(expandIPv6('::a::b')).toBeNull(); // two '::'
    expect(expandIPv6('12345::')).toBeNull(); // group too long
    expect(expandIPv6('xyz::')).toBeNull(); // non-hex group
    expect(expandIPv6('1:2:3')).toBeNull(); // too few groups, no '::'
    expect(expandIPv6('1:2:3:4:5:6:7:8:9::')).toBeNull(); // fill < 0
  });
});

describe('isPrivateIPv6', () => {
  it('blocks loopback/unspecified', () => {
    expect(isPrivateIPv6('::')).toBe(true);
    expect(isPrivateIPv6('::1')).toBe(true);
  });

  it('blocks unique-local, link-local, and multicast', () => {
    expect(isPrivateIPv6('fc00::1')).toBe(true);
    expect(isPrivateIPv6('fd12:3456::1')).toBe(true);
    expect(isPrivateIPv6('fe80::abcd')).toBe(true);
    expect(isPrivateIPv6('ff02::1')).toBe(true);
  });

  it('blocks IPv4-mapped private addresses', () => {
    expect(isPrivateIPv6('::ffff:7f00:1')).toBe(true); // ::ffff:127.0.0.1
  });

  it('allows IPv4-mapped public and global unicast', () => {
    expect(isPrivateIPv6('::ffff:808:808')).toBe(false); // ::ffff:8.8.8.8
    expect(isPrivateIPv6('2001:db8::1')).toBe(false);
  });

  it('blocks malformed input defensively', () => {
    expect(isPrivateIPv6('12345::xyz')).toBe(true); // expandIPv6 → null
  });
});

describe('assertNotPrivateHost', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    lookupMock.mockReset();
  });

  it('blocks localhost and .localhost', async () => {
    await expect(assertNotPrivateHost('localhost')).rejects.toThrow(/localhost/);
    await expect(assertNotPrivateHost('foo.localhost')).rejects.toThrow(/localhost/);
  });

  it('blocks a private IPv4 literal', async () => {
    await expect(assertNotPrivateHost('127.0.0.1')).rejects.toThrow(/private\/loopback/);
  });

  it('allows a public IPv4 literal', async () => {
    await expect(assertNotPrivateHost('8.8.8.8')).resolves.toBeUndefined();
  });

  it('blocks a bracketed private IPv6 literal', async () => {
    await expect(assertNotPrivateHost('[::1]')).rejects.toThrow(/private\/loopback/);
  });

  it('allows a public IPv6 literal', async () => {
    await expect(assertNotPrivateHost('2001:db8::1')).resolves.toBeUndefined();
  });

  it('rejects a hostname that resolves to a private address', async () => {
    
    lookupMock.mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as never);
    await expect(assertNotPrivateHost('evil.example.com')).rejects.toThrow(/resolved to private/);
  });

  it('rejects a hostname that resolves to a private IPv6 address', async () => {
    
    lookupMock.mockResolvedValue([{ address: 'fc00::1', family: 6 }] as never);
    await expect(assertNotPrivateHost('evil6.example.com')).rejects.toThrow(/resolved to private/);
  });

  it('allows a hostname that resolves to public addresses', async () => {
    
    lookupMock.mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as never);
    await expect(assertNotPrivateHost('example.com')).resolves.toBeUndefined();
  });

  it('swallows a DNS resolution failure (lets fetch surface it)', async () => {
    
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(assertNotPrivateHost('nope.invalid')).resolves.toBeUndefined();
  });
});
