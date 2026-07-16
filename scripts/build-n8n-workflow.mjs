import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const normalizerPath = path.join(root, 'lib', 'sleep-normalizer.js');
const workflowPath = path.join(root, 'n8n', 'fitness-workflow.json');

const normalizerSource = (await readFile(normalizerPath, 'utf8')).replace(
  'export function normalizeSleepResponse',
  'function normalizeSleepResponse',
);

const prepCode = `const endDate = DateTime.now().setZone('America/Toronto').startOf('day').plus({ days: 1 });
const startDate = endDate.minus({ days: 7 });

return [{
  json: {
    days: 7,
    timezone: 'America/Toronto',
    startDate: startDate.toFormat('yyyy-MM-dd'),
    endDateExclusive: endDate.toFormat('yyyy-MM-dd'),
    requestedAt: new Date().toISOString(),
  },
}];`;

const normalizeCode = `${normalizerSource}

function extractError(body) {
  if (body == null) return 'No response body';
  if (typeof body === 'string') return body.slice(0, 400);
  if (body.error?.message) return body.error.message;
  if (body.error_description) return body.error_description;
  if (typeof body.error === 'string') return body.error;
  return JSON.stringify(body).slice(0, 400);
}

function pick(nodeName) {
  try {
    const response = $(nodeName).first().json;
    const status = typeof response.statusCode === 'number' ? response.statusCode : null;
    const body = response.body !== undefined ? response.body : response;
    const ok = status !== null ? status >= 200 && status < 300 : !response.error;
    return { ok, status, body };
  } catch (error) {
    return { ok: false, status: null, body: null, error: error.message };
  }
}

const prep = $('Prep').first().json;
const identityCall = pick('Google Health Identity');
const sleepCall = pick('Google Health Sleep');
const sleepBody = sleepCall.body && typeof sleepCall.body === 'object' ? sleepCall.body : {};
const dataPoints = sleepCall.ok && Array.isArray(sleepBody.dataPoints) ? sleepBody.dataPoints : [];
const normalized = normalizeSleepResponse({
  dataPoints,
  startDate: prep.startDate,
  endDateExclusive: prep.endDateExclusive,
  generatedAt: new Date().toISOString(),
});
const sleepError = sleepCall.ok ? null : extractError(sleepCall.body);

return [{
  json: {
    ok: sleepCall.ok,
    message: sleepCall.ok ? null : 'Google Health sleep fetch failed',
    error: sleepError,
    identity: identityCall.ok ? identityCall.body : null,
    ...normalized,
    sections: {
      identity: {
        ok: identityCall.ok,
        status: identityCall.status,
        error: identityCall.ok ? null : extractError(identityCall.body),
      },
      sleep: {
        ok: sleepCall.ok,
        status: sleepCall.status,
        count: dataPoints.length,
        partial: Boolean(sleepBody.nextPageToken),
        error: sleepError,
      },
    },
  },
}];`;

const googleCredential = {
  googleOAuth2Api: {
    id: 'zTvzoPpvTXOvI3rA',
    name: 'Google account',
  },
};

const fullResponseOptions = {
  response: {
    response: {
      fullResponse: true,
      neverError: true,
      responseFormat: 'json',
    },
  },
  timeout: 30_000,
};

const workflow = {
  id: 'fitbitTracker001',
  name: 'FitbitTracker — Google Health sleep',
  nodes: [
    {
      parameters: {
        httpMethod: 'POST',
        path: 'fitness-sync',
        authentication: 'headerAuth',
        responseMode: 'responseNode',
        options: {},
      },
      id: 'node-webhook',
      name: 'Webhook',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [0, 300],
      webhookId: 'fitness-sync-webhook',
      credentials: {
        httpHeaderAuth: {
          id: 'fitbitTrackerWebhookAuth',
          name: 'FitbitTracker Webhook Auth',
        },
      },
    },
    {
      parameters: {
        jsCode: prepCode,
      },
      id: 'node-prep',
      name: 'Prep',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [240, 300],
    },
    {
      parameters: {
        url: 'https://health.googleapis.com/v4/users/me/identity',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'googleOAuth2Api',
        options: fullResponseOptions,
      },
      id: 'node-health-identity',
      name: 'Google Health Identity',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [480, 300],
      credentials: googleCredential,
      onError: 'continueRegularOutput',
      alwaysOutputData: true,
    },
    {
      parameters: {
        url: 'https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints:reconcile',
        authentication: 'predefinedCredentialType',
        nodeCredentialType: 'googleOAuth2Api',
        sendQuery: true,
        specifyQuery: 'keypair',
        queryParameters: {
          parameters: [
            {
              name: 'dataSourceFamily',
              value: 'users/me/dataSourceFamilies/google-wearables',
            },
            {
              name: 'pageSize',
              value: '25',
            },
            {
              name: 'filter',
              value:
                '={{ \'sleep.interval.civil_end_time >= "\' + $(\'Prep\').first().json.startDate + \'" AND sleep.interval.civil_end_time < "\' + $(\'Prep\').first().json.endDateExclusive + \'"\' }}',
            },
          ],
        },
        options: fullResponseOptions,
      },
      id: 'node-health-sleep',
      name: 'Google Health Sleep',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [720, 300],
      credentials: googleCredential,
      onError: 'continueRegularOutput',
      alwaysOutputData: true,
    },
    {
      parameters: {
        jsCode: normalizeCode,
      },
      id: 'node-normalize-sleep',
      name: 'Normalize Sleep',
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: [960, 300],
    },
    {
      parameters: {
        respondWith: 'firstIncomingItem',
        options: {
          responseHeaders: {
            entries: [
              {
                name: 'Cache-Control',
                value: 'no-store',
              },
            ],
          },
        },
      },
      id: 'node-respond',
      name: 'Respond',
      type: 'n8n-nodes-base.respondToWebhook',
      typeVersion: 1.1,
      position: [1200, 300],
    },
  ],
  connections: {
    Webhook: {
      main: [[{ node: 'Prep', type: 'main', index: 0 }]],
    },
    Prep: {
      main: [[{ node: 'Google Health Identity', type: 'main', index: 0 }]],
    },
    'Google Health Identity': {
      main: [[{ node: 'Google Health Sleep', type: 'main', index: 0 }]],
    },
    'Google Health Sleep': {
      main: [[{ node: 'Normalize Sleep', type: 'main', index: 0 }]],
    },
    'Normalize Sleep': {
      main: [[{ node: 'Respond', type: 'main', index: 0 }]],
    },
  },
  active: true,
  settings: {
    executionOrder: 'v1',
  },
  pinData: {},
  tags: [],
};

await writeFile(workflowPath, `${JSON.stringify(workflow, null, 2)}\n`);
