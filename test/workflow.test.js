import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowPath = new URL('../n8n/fitness-workflow.json', import.meta.url);

async function loadWorkflow() {
  return JSON.parse(await readFile(workflowPath, 'utf8'));
}

function nodeByName(workflow, name) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `Expected workflow node "${name}"`);
  return node;
}

test('keeps the production workflow identity and protects its webhook with Header Auth', async () => {
  const workflow = await loadWorkflow();
  const webhook = nodeByName(workflow, 'Webhook');

  assert.equal(workflow.id, 'fitbitTracker001');
  assert.equal(webhook.parameters.httpMethod, 'POST');
  assert.equal(webhook.parameters.path, 'fitness-sync');
  assert.equal(webhook.parameters.responseMode, 'responseNode');
  assert.equal(webhook.parameters.authentication, 'headerAuth');
  assert.deepEqual(webhook.credentials.httpHeaderAuth, {
    id: 'fitbitTrackerWebhookAuth',
    name: 'FitbitTracker Webhook Auth',
  });
});

test('uses Google Health identity and reconciled sleep endpoints with the dedicated OAuth credential', async () => {
  const workflow = await loadWorkflow();
  const serialized = JSON.stringify(workflow);
  const identity = nodeByName(workflow, 'Google Health Identity');
  const sleep = nodeByName(workflow, 'Google Health Sleep');
  const expectedGoogleCredential = {
    id: 'zTvzoPpvTXOvI3rA',
    name: 'Google account',
  };

  assert.equal(identity.parameters.url, 'https://health.googleapis.com/v4/users/me/identity');
  assert.equal(
    sleep.parameters.url,
    'https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints:reconcile',
  );
  assert.deepEqual(identity.credentials.googleOAuth2Api, expectedGoogleCredential);
  assert.deepEqual(sleep.credentials.googleOAuth2Api, expectedGoogleCredential);
  assert.equal(sleep.parameters.sendQuery, true);

  const query = Object.fromEntries(
    sleep.parameters.queryParameters.parameters.map(({ name, value }) => [name, value]),
  );
  assert.equal(query.dataSourceFamily, 'users/me/dataSourceFamilies/google-wearables');
  assert.equal(query.pageSize, '25');
  assert.match(query.filter, /sleep\.interval\.civil_end_time/);
  assert.match(query.filter, /\$\('Prep'\)\.first\(\)\.json\.startDate/);
  assert.match(query.filter, /\$\('Prep'\)\.first\(\)\.json\.endDateExclusive/);
  assert.doesNotMatch(serialized, /googleapis\.com\/fitness/);
});

test('normalizes sleep and responds through the explicit response node', async () => {
  const workflow = await loadWorkflow();
  const prep = nodeByName(workflow, 'Prep');
  const normalize = nodeByName(workflow, 'Normalize Sleep');
  const respond = nodeByName(workflow, 'Respond');
  const code = normalize.parameters.jsCode;

  assert.doesNotThrow(() => new Function('DateTime', '$input', '$', prep.parameters.jsCode));
  assert.doesNotThrow(() => new Function('$input', '$', code));
  assert.match(code, /minutesInSleepPeriod/);
  assert.match(code, /civilEndTime/);
  assert.match(code, /metadata\?\.nap/);
  assert.match(code, /averageStageMinutes/);
  assert.equal(respond.parameters.respondWith, 'firstIncomingItem');

  assert.deepEqual(
    workflow.connections['Normalize Sleep'].main[0][0],
    { node: 'Respond', type: 'main', index: 0 },
  );
});
