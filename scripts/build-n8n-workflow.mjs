import { writeFile } from 'node:fs/promises';

const workflowPath = new URL('../n8n/health-hub-workflow.json', import.meta.url);

const prepareCode = `const input = $input.first().json.body ?? {};
const operations = ['profile', 'identity', 'list', 'reconcile', 'dailyRollup'];
const metrics = [
  'sleep',
  'heart-rate',
  'daily-resting-heart-rate',
  'total-calories',
  'active-energy-burned',
  'basal-energy-burned',
];
const combinations = {
  profile: ['sleep'],
  identity: ['sleep'],
  list: [
    'heart-rate',
    'daily-resting-heart-rate',
    'active-energy-burned',
    'basal-energy-burned',
  ],
  reconcile: ['sleep'],
  dailyRollup: ['total-calories'],
};

if (
  !operations.includes(input.operation) ||
  !metrics.includes(input.metric) ||
  !combinations[input.operation]?.includes(input.metric)
) {
  throw new Error('Unsupported operation and metric combination');
}

const datePattern = /^\\d{4}-\\d{2}-\\d{2}$/;
if (
  !['profile', 'identity'].includes(input.operation) &&
  (!datePattern.test(input.startDate) ||
    !datePattern.test(input.endDateExclusive) ||
    input.startDate >= input.endDateExclusive)
) {
  throw new Error('A valid closed-open date range is required');
}

const base = 'https://health.googleapis.com/v4/users/me';
const snake = {
  'heart-rate': 'heart_rate',
  'daily-resting-heart-rate': 'daily_resting_heart_rate',
  'active-energy-burned': 'active_energy_burned',
  'basal-energy-burned': 'basal_energy_burned',
};
const filterField = {
  sleep: 'sleep.interval.civil_end_time',
  'heart-rate': 'heart_rate.sample_time.civil_time',
  'daily-resting-heart-rate': 'daily_resting_heart_rate.date',
  'active-energy-burned': 'active_energy_burned.interval.civil_start_time',
  'basal-energy-burned': 'basal_energy_burned.interval.civil_start_time',
};

function dateObject(value) {
  const [year, month, day] = value.split('-').map(Number);
  return { year, month, day };
}

function requestId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

let request;
if (input.operation === 'profile' || input.operation === 'identity') {
  request = {
    method: 'GET',
    url: \`\${base}/\${input.operation}\`,
    body: null,
  };
} else if (input.operation === 'dailyRollup') {
  request = {
    method: 'POST',
    url: \`\${base}/dataTypes/\${input.metric}/dataPoints:dailyRollUp\`,
    body: {
      range: {
        start: { date: dateObject(input.startDate), time: {} },
        end: { date: dateObject(input.endDateExclusive), time: {} },
      },
      windowSizeDays: 1,
      pageSize: 10000,
      pageToken: input.pageToken || undefined,
      dataSourceFamily: 'users/me/dataSourceFamilies/google-wearables',
    },
  };
} else {
  const suffix = input.operation === 'reconcile' ? 'dataPoints:reconcile' : 'dataPoints';
  const query = new URLSearchParams({
    dataSourceFamily: 'users/me/dataSourceFamilies/google-wearables',
    pageSize: input.metric === 'sleep' ? '25' : '10000',
    filter: \`\${filterField[input.metric]} >= "\${input.startDate}" AND \${filterField[input.metric]} < "\${input.endDateExclusive}"\`,
  });
  if (input.pageToken) query.set('pageToken', input.pageToken);
  request = {
    method: 'GET',
    url: \`\${base}/dataTypes/\${input.metric}/\${suffix}?\${query.toString()}\`,
    body: null,
  };
}

return [{
  json: {
    request,
    context: {
      operation: input.operation,
      metric: input.metric,
      startDate: input.startDate ?? null,
      endDateExclusive: input.endDateExclusive ?? null,
      pageToken: input.pageToken ?? null,
      requestId: requestId(),
      filterName: snake[input.metric] ?? null,
    },
  },
}];`;

const shapeCode = `const context = $('Validate and Prepare').first().json.context;
const response = $input.first().json;
const status = Number(response.statusCode ?? response.status ?? 200);
const body = response.body !== undefined ? response.body : response;
const ok = status >= 200 && status < 300 && !body?.error;

return [{
  json: {
    ok,
    metric: context.metric,
    status,
    data: ok ? body : null,
    nextPageToken: ok ? (body?.nextPageToken ?? null) : null,
    requestId: context.requestId,
    message: ok ? null : (body?.error?.message ?? body?.message ?? 'Google Health request failed'),
  },
}];`;

const googleCredential = {
  googleOAuth2Api: {
    id: 'zTvzoPpvTXOvI3rA',
    name: 'Google account',
  },
};

const workflow = {
  id: 'healthHubGateway001',
  name: 'Personal Health Data Hub — Google Health gateway',
  nodes: [
    {
      parameters: {
        httpMethod: 'POST',
        path: 'health-hub-sync',
        authentication: 'headerAuth',
        responseMode: 'responseNode',
        options: {},
      },
      id: 'node-webhook',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 300],
      webhookId: 'health-hub-sync-webhook',
      credentials: {
        httpHeaderAuth: {
          id: 'fitbitTrackerWebhookAuth',
          name: 'FitbitTracker Webhook Auth',
        },
      },
    },
    {
      parameters: {
        jsCode: prepareCode,
      },
      id: 'node-validate-prepare',
      name: 'Validate and Prepare',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [280, 300],
    },
    {
      parameters: {
        method: '={{ $json.request.method }}',
        url: '={{ $json.request.url }}',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'googleOAuth2Api',
        sendBody: '={{ $json.request.method === "POST" }}',
        contentType: 'raw',
        rawContentType: 'application/json',
        body: '={{ JSON.stringify($json.request.body || {}) }}',
        options: {
          response: {
            response: {
              fullResponse: true,
              neverError: true,
              responseFormat: 'json',
            },
          },
          timeout: 30_000,
        },
      },
      id: 'node-google-health-api',
      name: 'Google Health API',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [570, 300],
      credentials: googleCredential,
      onError: 'continueRegularOutput',
      alwaysOutputData: true,
    },
    {
      parameters: {
        jsCode: shapeCode,
      },
      id: 'node-shape-response',
      name: 'Shape Response',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [860, 300],
    },
    {
      parameters: {
        respondWith: 'firstIncomingItem',
        options: {
          responseHeaders: {
            entries: [
              { name: 'Cache-Control', value: 'no-store' },
              { name: 'Content-Type', value: 'application/json' },
            ],
          },
        },
      },
      id: 'node-respond',
      name: 'Respond',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.1,
      position: [1140, 300],
    },
  ],
  connections: {
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
  },
  active: true,
  settings: {
    executionOrder: 'v1',
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'none',
  },
  pinData: {},
  tags: [],
};

await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
