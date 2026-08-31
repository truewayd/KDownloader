import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const bridgeSource = await readFile(new URL('../content/paw_api_bridge.js', import.meta.url), 'utf8');

function createBridgeHarness(options = {}) {
  let listener = null;
  const requests = [];
  const context = vm.createContext({
    AbortController,
    Blob,
    TextDecoder,
    URL,
    clearTimeout,
    chrome: {
      runtime: {
        onMessage: {
          addListener(value) {
            listener = value;
          },
        },
      },
    },
    fetch: async (url, fetchOptions) => {
      requests.push({ url, options: fetchOptions });
      if (typeof options.fetch === 'function') return options.fetch(url, fetchOptions);
      return {
        ok: true,
        status: 200,
        url,
        headers: {
          get(name) {
            return String(name).toLowerCase() === 'content-type' ? 'application/json' : null;
          },
        },
        async text() {
          return JSON.stringify({ id: 'post-1' });
        },
      };
    },
    location: {
      origin: 'https://pawchive.pw',
    },
    setTimeout,
  });
  const source = Number.isInteger(options.maxResponseBytes)
    ? bridgeSource.replace('16 * 1024 * 1024', String(options.maxResponseBytes))
    : bridgeSource;
  vm.runInContext(source, context);

  return {
    requests,
    async send(message) {
      assert.equal(typeof listener, 'function');
      return new Promise((resolve) => {
        const keepsChannelOpen = listener(message, {}, resolve);
        assert.equal(keepsChannelOpen, message.action === 'pawchive.api.fetch');
      });
    },
  };
}

test('Pawchive bridge performs credentialed same-origin API GETs with safe headers only', async () => {
  const harness = createBridgeHarness();
  const result = await harness.send({
    action: 'pawchive.api.fetch',
    url: 'https://pawchive.pw/api/v1/patreon/user/creator-1',
    headers: {
      Accept: 'application/json',
      Cookie: 'cf_clearance=must-not-cross-the-bridge',
      Referer: 'https://example.invalid/',
      'X-Custom': 'blocked',
    },
  });

  assert.equal(result.success, true);
  assert.equal(JSON.parse(result.response.body).id, 'post-1');
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].options.credentials, 'include');
  assert.equal(harness.requests[0].options.method, 'GET');
  assert.equal(harness.requests[0].options.redirect, 'error');
  assert.deepEqual(
    Object.fromEntries(Object.entries(harness.requests[0].options.headers)),
    { Accept: 'application/json' }
  );
});

test('Pawchive bridge responds to readiness probes without a network request', async () => {
  const harness = createBridgeHarness();
  const response = await harness.send({ action: 'pawchive.api.ping' });
  assert.equal(response.ready, true);
  assert.equal(harness.requests.length, 0);
});

test('Pawchive bridge rejects requests outside the fixed API origin and path', async () => {
  const harness = createBridgeHarness();
  const external = await harness.send({
    action: 'pawchive.api.fetch',
    url: 'https://example.invalid/api/v1/leak',
  });
  const nonApi = await harness.send({
    action: 'pawchive.api.fetch',
    url: 'https://pawchive.pw/icons/patreon/creator-1',
  });
  const credentialed = await harness.send({
    action: 'pawchive.api.fetch',
    url: 'https://user:secret@pawchive.pw/api/v1/leak',
  });

  assert.equal(external.success, false);
  assert.match(external.error, /Rejected non-Pawchive API bridge request/);
  assert.equal(nonApi.success, false);
  assert.equal(credentialed.success, false);
  assert.equal(harness.requests.length, 0);
});

test('Pawchive bridge joins streamed bytes once and preserves the size error if cancellation fails', async () => {
  let cancelCalls = 0;
  const encoder = new TextEncoder();
  const chunks = [encoder.encode('{"'), encoder.encode('id"'), encoder.encode(':1}')];
  const harness = createBridgeHarness({
    maxResponseBytes: 8,
    fetch: async (url) => ({
      ok: true,
      status: 200,
      url,
      headers: { get: () => null },
      body: {
        getReader() {
          let index = 0;
          return {
            async read() {
              return index < chunks.length
                ? { done: false, value: chunks[index++] }
                : { done: true };
            },
            async cancel() {
              cancelCalls += 1;
              throw new Error('cancel failed');
            },
            releaseLock() {},
          };
        },
      },
    }),
  });

  const response = await harness.send({
    action: 'pawchive.api.fetch',
    url: 'https://pawchive.pw/api/v1/test',
  });
  assert.equal(response.success, true);
  assert.equal(response.response.body, '{"id":1}');

  const endpointLimited = await harness.send({
    action: 'pawchive.api.fetch',
    url: 'https://pawchive.pw/api/v1/test',
    maxResponseBytes: 7,
  });
  assert.equal(endpointLimited.success, false);
  assert.match(endpointLimited.error, /too large/);

  chunks.push(encoder.encode('x'));
  const oversized = await harness.send({
    action: 'pawchive.api.fetch',
    url: 'https://pawchive.pw/api/v1/test',
  });
  assert.equal(oversized.success, false);
  assert.match(oversized.error, /too large/);
  assert.equal(cancelCalls, 2);
});
