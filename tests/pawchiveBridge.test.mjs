import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const bridgeSource = await readFile(new URL('../content/paw_api_bridge.js', import.meta.url), 'utf8');

function createBridgeHarness() {
  let listener = null;
  const requests = [];
  const context = vm.createContext({
    AbortController,
    Blob,
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
    fetch: async (url, options) => {
      requests.push({ url, options });
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
  vm.runInContext(bridgeSource, context);

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

  assert.equal(external.success, false);
  assert.match(external.error, /Rejected non-Pawchive API bridge request/);
  assert.equal(nonApi.success, false);
  assert.equal(harness.requests.length, 0);
});
