import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const workflowPath = new URL('../n8n/health-hub-workflow.json', import.meta.url);
const legacyWorkflowPath = new URL('../n8n/fitness-workflow.json', import.meta.url);

async function loadWorkflow() {
  return JSON.parse(await readFile(workflowPath, 'utf8'));
}

async function loadLegacyWorkflow() {
  return JSON.parse(await readFile(legacyWorkflowPath, 'utf8'));
}

function nodeByName(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `Expected workflow node "${name}"`);
  return node;
}

test('uses the isolated hub identity and exact webhook-only chain', async () => {
  const workflow = await loadWorkflow();
  const webhook = nodeByName(workflow, 'Webhook');

  assert.equal(workflow.id, 'healthHubGateway001');
  assert.equal(workflow.name, 'Personal Health Data Hub — Google Health gateway');
  assert.equal(webhook.parameters.httpMethod, 'POST');
  assert.equal(webhook.parameters.path, 'health-hub-sync');
  assert.equal(webhook.webhookId, 'health-hub-sync-webhook');
  assert.equal(webhook.parameters.responseMode, 'responseNode');
  assert.equal(webhook.parameters.authentication, 'headerAuth');
  assert.deepEqual(webhook.credentials.httpHeaderAuth, {
    id: 'fitbitTrackerWebhookAuth',
    name: 'FitbitTracker Webhook Auth',
  });
  assert.equal(workflow.active, true);
  assert.equal(
    workflow.nodes.some(({ type }) => type === 'n8n-nodes-base.scheduleTrigger'),
    false,
  );
  assert.deepEqual(
    workflow.nodes.map(({ name, type }) => ({ name, type })),
    [
      { name: 'Webhook', type: 'n8n-nodes-base.webhook' },
      { name: 'Validate and Prepare', type: 'n8n-nodes-base.code' },
      { name: 'Google Health API', type: 'n8n-nodes-base.httpRequest' },
      { name: 'Shape Response', type: 'n8n-nodes-base.code' },
      { name: 'Respond', type: 'n8n-nodes-base.respondToWebhook' },
    ],
  );
  assert.deepEqual(workflow.connections, {
    Webhook: {
      main: [[{ node: 'Validate and Prepare', type: 'main', index: 0 }]],
    },
    'Validate and Prepare': {
      main: [[{ node: 'Google Health API', type: 'main', index: 0 }]],
    },
    'Google Health API': {
      main: [[{ node: 'Shape Response', type: 'main', index: 0 }]],
    },
    'Shape Response': {
      main: [[{ node: 'Respond', type: 'main', index: 0 }]],
    },
  });
});

test('preserves the legacy sleep workflow identity and webhook path', async () => {
  const workflow = await loadLegacyWorkflow();
  const webhook = nodeByName(workflow, 'Webhook');

  assert.equal(workflow.id, 'fitbitTracker001');
  assert.equal(webhook.parameters.path, 'fitness-sync');
});

test('validates the strict operation and metric allow-list before building Google requests', async () => {
  const workflow = await loadWorkflow();
  const prepare = nodeByName(workflow, 'Validate and Prepare');
  const code = prepare.parameters.jsCode;

  assert.doesNotThrow(() => new Function('$input', code));
  assert.match(code, /profile.*identity.*list.*reconcile.*rollUp/s);
  assert.doesNotMatch(code, /dailyRollup/);
  assert.match(code, /sleep.*heart-rate.*daily-resting-heart-rate/s);
  assert.match(code, /total-calories.*active-energy-burned.*basal-energy-burned/s);
  assert.match(code, /Unsupported operation and metric combination/);
  assert.match(code, /https:\/\/health\.googleapis\.com\/v4\/users\/me/);
  assert.match(code, /heart_rate\.sample_time\.civil_time/);
  assert.match(code, /sleep\.interval\.civil_end_time/);
  assert.match(code, /dataPoints:rollUp/);
});

test('uses the dedicated Google OAuth credential and returns the stable gateway contract', async () => {
  const workflow = await loadWorkflow();
  const request = nodeByName(workflow, 'Google Health API');
  const shape = nodeByName(workflow, 'Shape Response');
  const respond = nodeByName(workflow, 'Respond');
  const expectedGoogleCredential = {
    id: 'zTvzoPpvTXOvI3rA',
    name: 'Google account',
  };

  assert.equal(request.parameters.url, '={{ $json.request.url }}');
  assert.equal(request.parameters.method, '={{ $json.request.method }}');
  assert.deepEqual(request.credentials.googleOAuth2Api, expectedGoogleCredential);
  assert.doesNotThrow(() => new Function('$input', '$', shape.parameters.jsCode));
  assert.match(shape.parameters.jsCode, /requestId/);
  assert.match(shape.parameters.jsCode, /nextPageToken/);
  assert.match(shape.parameters.jsCode, /metric/);
  assert.equal(respond.parameters.respondWith, 'firstIncomingItem');
  assert.deepEqual(
    workflow.connections['Shape Response'].main[0][0],
    { node: 'Respond', type: 'main', index: 0 },
  );
});

test('maps a statusless transport failure to the stable 502 gateway contract', async () => {
  const workflow = await loadWorkflow();
  const shapeCode = nodeByName(workflow, 'Shape Response').parameters.jsCode;
  const shape = new Function('$input', '$', shapeCode);

  const shaped = shape(
    { first: () => ({ json: { error: 'connect ETIMEDOUT' } }) },
    () => ({
      first: () => ({
        json: { context: { metric: 'heart-rate', requestId: 'transport-request-1' } },
      }),
    }),
  )[0].json;

  assert.deepEqual(shaped, {
    ok: false,
    metric: 'heart-rate',
    status: 502,
    data: null,
    nextPageToken: null,
    requestId: 'transport-request-1',
    message: 'Google Health request failed',
  });
});

test('generated Code nodes execute the list, total-calories, and error contracts', async () => {
  const workflow = await loadWorkflow();
  const prepareCode = nodeByName(workflow, 'Validate and Prepare').parameters.jsCode;
  const shapeCode = nodeByName(workflow, 'Shape Response').parameters.jsCode;
  const prepare = new Function('$input', 'DateTime', prepareCode);
  const fakeDateTime = {
    fromISO(value) {
      const times = {
        '2026-03-08T00:00:00': ['2026-03-08T05:00:00.000Z', 1_773_031_200],
        '2026-03-09T00:00:00': ['2026-03-09T04:00:00.000Z', 1_773_114_000],
      };
      const [iso, seconds] = times[value] ?? ['2026-07-03T04:00:00.000Z', 1_783_051_200];
      return {
        isValid: true,
        toSeconds: () => seconds,
        toUTC: () => ({ toISO: () => iso }),
      };
    },
  };

  const list = prepare({
    first: () => ({
      json: {
        body: {
          operation: 'list',
          metric: 'heart-rate',
          startDate: '2026-07-03',
          endDateExclusive: '2026-07-17',
          pageToken: 'page-2',
        },
      },
    }),
  }, fakeDateTime)[0].json;
  const totalCalories = prepare({
    first: () => ({
      json: {
        body: {
          operation: 'rollUp',
          metric: 'total-calories',
          startDate: '2026-03-08',
          endDateExclusive: '2026-03-09',
          pageToken: null,
          timezone: 'America/Toronto',
        },
      },
    }),
  }, fakeDateTime)[0].json;
  const reconcile = prepare({
    first: () => ({
      json: {
        body: {
          operation: 'reconcile',
          metric: 'sleep',
          startDate: '2026-07-03',
          endDateExclusive: '2026-07-17',
          pageToken: null,
        },
      },
    }),
  }, fakeDateTime)[0].json;

  assert.equal(list.request.method, 'GET');
  assert.match(list.request.url, /dataTypes\/heart-rate\/dataPoints/);
  assert.match(list.request.url, /pageToken=page-2/);
  assert.doesNotMatch(list.request.url, /dataSourceFamily/);
  assert.match(reconcile.request.url, /dataSourceFamily/);
  assert.equal(totalCalories.request.method, 'POST');
  assert.match(totalCalories.request.url, /dataTypes\/total-calories\/dataPoints:rollUp/);
  assert.deepEqual(totalCalories.request.body.range, {
    startTime: '2026-03-08T05:00:00.000Z',
    endTime: '2026-03-09T04:00:00.000Z',
  });
  assert.equal(totalCalories.request.body.windowSize, '3600s');
  assert.throws(
    () =>
      prepare({
        first: () => ({
          json: {
            body: {
              operation: 'dailyRollup',
              metric: 'total-calories',
              startDate: '2026-07-03',
              endDateExclusive: '2026-07-17',
            },
          },
        }),
      }),
    /Unsupported operation and metric combination/,
  );

  const shape = new Function('$input', '$', shapeCode);
  const shaped = shape(
    { first: () => ({ json: { statusCode: 503, body: { error: { message: 'unavailable' } } } }) },
    () => ({
      first: () => ({
        json: { context: { metric: 'heart-rate', requestId: 'request-1' } },
      }),
    }),
  )[0].json;
  assert.deepEqual(shaped, {
    ok: false,
    metric: 'heart-rate',
    status: 503,
    data: null,
    nextPageToken: null,
    requestId: 'request-1',
    message: 'unavailable',
  });
});

test('list requests can be prepared inside the n8n Code-node sandbox', async () => {
  const workflow = await loadWorkflow();
  const prepareCode = nodeByName(workflow, 'Validate and Prepare').parameters.jsCode;
  const prepared = runInNewContext(`(function () { ${prepareCode} })()`, {
    $input: {
      first: () => ({
        json: {
          body: {
            operation: 'list',
            metric: 'heart-rate',
            startDate: '2026-07-16',
            endDateExclusive: '2026-07-17',
            pageToken: 'page-2',
          },
        },
      }),
    },
  });

  assert.equal(prepared[0].json.request.method, 'GET');
  assert.match(prepared[0].json.request.url, /pageToken=page-2/);
});
