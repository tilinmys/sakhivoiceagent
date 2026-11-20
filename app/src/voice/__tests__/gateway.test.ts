import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// The HTTP side of the network layer (voice/gateway.ts): timeouts, the
// circuit breaker (3 failures -> offline 30 s), busy (429) never trips it,
// error classification, and no provider key or token where it should not be.

type Fetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; method?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; arrayBuffer: () => Promise<ArrayBuffer> }>;
const mockFetch = jest.fn<Fetch>();
jest.mock('expo/fetch', () => ({ fetch: (...args: Parameters<Fetch>) => mockFetch(...args) }));

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => new ArrayBuffer(8) });
const status = (code: number) => Promise.resolve({ ok: false, status: code, json: async () => ({ error: 'x' }), arrayBuffer: async () => new ArrayBuffer(0) });
const wavBody = new Uint8Array([82, 73, 70, 70]);

function load(env: Record<string, string> = {}) {
  process.env.EXPO_PUBLIC_SAKHI_GATEWAY = 'https://gw.test/api/sakhi';
  delete process.env.EXPO_PUBLIC_SAKHI_GATEWAY_TOKEN;
  delete process.env.EXPO_PUBLIC_SAKHI_GATEWAY_LAN;
  Object.assign(process.env, env);
  let mod!: typeof import('../gateway');
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('../gateway');
  });
  return mod;
}

beforeEach(() => {
  mockFetch.mockReset();
});

describe('gateway', () => {
  it('a phone on the same Wi-Fi as the PC: both routes are raced, the faster carries STT; a dead LAN falls back to the tunnel', async () => {
    const { gateway } = load({ EXPO_PUBLIC_SAKHI_GATEWAY_LAN: 'http://192.168.0.12:8787/api/sakhi' });
    const later = (ms: number, body: unknown) => new Promise<Awaited<ReturnType<Fetch>>>((r) => setTimeout(() => r({ ok: true, status: 200, json: async () => body, arrayBuffer: async () => new ArrayBuffer(0) }), ms));
    mockFetch.mockImplementation((url) => (url.startsWith('http://192.168') ? later(5, { stt: true, tts: true }) : later(60, { stt: true, tts: true })));
    await expect(gateway.health()).resolves.toEqual({ stt: true, tts: true });
    expect(gateway.route).toBe('http://192.168.0.12:8787/api/sakhi');
    mockFetch.mockReset();
    mockFetch.mockImplementation((url) => (url.startsWith('http://192.168') ? Promise.reject(new Error('Network request failed')) : ok({ text: 'ok', en: '', ms: 200 })));
    await expect(gateway.stt(wavBody, 'kn')).rejects.toMatchObject({ retryable: true });
    expect(gateway.route).toBe('https://gw.test/api/sakhi');
    await expect(gateway.stt(wavBody, 'kn')).resolves.toMatchObject({ text: 'ok' }); // the retry goes over the tunnel
    expect(gateway.offline).toBe(false);
  });

  it('the LAN route is not reachable: the tunnel wins the race', async () => {
    const { gateway } = load({ EXPO_PUBLIC_SAKHI_GATEWAY_LAN: 'http://192.168.0.12:8787/api/sakhi' });
    mockFetch.mockImplementation((url) => (url.startsWith('http://192.168') ? Promise.reject(new Error('timeout')) : ok({ stt: true, tts: true })));
    await expect(gateway.health()).resolves.toEqual({ stt: true, tts: true });
    expect(gateway.route).toBe('https://gw.test/api/sakhi');
  });

  it('warm(): one tiny request on an idle connection, none while it is in use', async () => {
    const { gateway } = load();
    mockFetch.mockReturnValue(ok({ stt: true, tts: true }));
    await gateway.health();
    mockFetch.mockClear();
    gateway.warm(); // just used by health(): still warm
    expect(mockFetch).not.toHaveBeenCalled();
    const now = Date.now();
    const spy = jest.spyOn(Date, 'now').mockReturnValue(now + 11_000);
    gateway.warm();
    gateway.warm();
    spy.mockRestore();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('https://gw.test/api/sakhi/health');
  });

  it('health: ok, HTTP errors and a dead network all give a definite answer', async () => {
    const { gateway } = load();
    mockFetch.mockReturnValueOnce(ok({ stt: true, tts: true, provider: 'gnani' }));
    await expect(gateway.health()).resolves.toEqual({ stt: true, tts: true });
    mockFetch.mockReturnValueOnce(status(500));
    await expect(gateway.health()).resolves.toEqual({ stt: false, tts: false });
    mockFetch.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(gateway.health()).resolves.toEqual({ stt: false, tts: false });
  });

  it('stt: 3 network failures in a row open the breaker (offline)', async () => {
    const { gateway } = load();
    mockFetch.mockRejectedValue(new Error('network down'));
    for (let i = 0; i < 3; i++) await expect(gateway.stt(wavBody, 'kn')).rejects.toMatchObject({ retryable: true });
    expect(gateway.offline).toBe(true);
    // while open: no network call at all, straight to the outbox
    const calls = mockFetch.mock.calls.length;
    await expect(gateway.stt(wavBody, 'kn')).rejects.toMatchObject({ message: 'offline' });
    expect(mockFetch.mock.calls.length).toBe(calls);
  });

  it('busy (429) is retryable but never trips the breaker', async () => {
    const { gateway } = load();
    mockFetch.mockReturnValue(status(429));
    for (let i = 0; i < 5; i++) await expect(gateway.stt(wavBody, 'kn')).rejects.toMatchObject({ message: 'stt 429', retryable: true });
    expect(gateway.offline).toBe(false);
  });

  it('a 4xx is not retryable (retrying cannot fix a bad request)', async () => {
    const { gateway } = load();
    mockFetch.mockReturnValueOnce(status(400));
    await expect(gateway.stt(wavBody, 'kn')).rejects.toMatchObject({ retryable: false });
  });

  it('a success resets the failure count', async () => {
    const { gateway } = load();
    mockFetch.mockRejectedValueOnce(new Error('x')).mockRejectedValueOnce(new Error('x')).mockReturnValueOnce(ok({ text: 'ok', en: '', ms: 300 }));
    await expect(gateway.stt(wavBody, 'kn')).rejects.toBeTruthy();
    await expect(gateway.stt(wavBody, 'kn')).rejects.toBeTruthy();
    await expect(gateway.stt(wavBody, 'kn')).resolves.toMatchObject({ text: 'ok' });
    mockFetch.mockRejectedValueOnce(new Error('x'));
    await expect(gateway.stt(wavBody, 'kn')).rejects.toBeTruthy();
    expect(gateway.offline).toBe(false); // 1 failure since the success, not 3
  });

  it('a slow server times out (retryable), it does not hang the turn', async () => {
    jest.useFakeTimers();
    const { gateway } = load();
    mockFetch.mockImplementation((_url, init) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))));
    const p = gateway.stt(wavBody, 'kn', 1000);
    const failed = expect(p).rejects.toMatchObject({ message: 'timeout', retryable: true });
    await jest.advanceTimersByTimeAsync(1000);
    await failed;
    jest.useRealTimers();
  });

  it('TTS URLs are stable per text (cacheable) and carry no secret', () => {
    const { gateway } = load({ EXPO_PUBLIC_SAKHI_GATEWAY_TOKEN: 'secret-token' });
    const url = gateway.ttsUrl('ತಾಯಿಯ ಬಿಪಿ?', 'kn');
    expect(url).toBe(gateway.ttsUrl('ತಾಯಿಯ ಬಿಪಿ?', 'kn'));
    expect(url).not.toContain('secret-token');
    expect(gateway.ttsHeaders('now')).toEqual({ Authorization: 'Bearer secret-token', 'X-Sakhi-Priority': 'now' });
  });

  it('the WebSocket URL carries no token on a phone', () => {
    const { gateway } = load({ EXPO_PUBLIC_SAKHI_GATEWAY_TOKEN: 'secret-token' });
    expect(gateway.wsUrl).toBe('wss://gw.test/api/sakhi/ws');
  });

  it('not configured: says so, never calls the network', async () => {
    process.env.EXPO_PUBLIC_SAKHI_GATEWAY = '';
    let mod!: typeof import('../gateway');
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mod = require('../gateway');
    });
    expect(mod.gateway.configured).toBe(false);
    await expect(mod.gateway.health()).resolves.toEqual({ stt: false, tts: false });
    await expect(mod.gateway.stt(wavBody, 'kn')).rejects.toMatchObject({ retryable: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
