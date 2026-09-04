import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const inspectorUi = await import('../public/inspector-ui.js').catch(() => ({}));

const calorieInspector = {
  category: 'calories',
  date: '2026-07-16',
  timezone: 'America/Toronto',
  status: 'available',
  dataAge: {
    lastSuccessfulSync: '2026-07-16T23:30:00.000Z',
    normalizedUpdatedAt: '2026-07-16T23:31:00.000Z',
    sourceUpdatedAt: '2026-07-16T23:31:00.000Z',
  },
  sourceFacts: {
    dataTypes: ['active-energy-burned', 'basal-energy-burned'],
    recordCount: 48,
    window: {
      startTime: '2026-07-16T04:00:00.000Z',
      endTime: '2026-07-17T04:00:00.000Z',
    },
    unit: 'kcal',
    devices: [{ displayName: '<Pixel Watch>', formFactor: 'FORM_FACTOR_WATCH' }],
  },
  normalized: {
    fieldDefinitions: [
      { field: 'metricType', type: 'enum', meaning: 'energy stream' },
      { field: 'kilocalories', type: 'number', unit: 'kcal', meaning: 'interval energy' },
    ],
    summary: {
      totalKcal: 2448,
      activeKcal: 708,
      basalKcal: 1740,
      totalDerived: true,
    },
  },
  derived: [{
    field: 'totalKcal',
    value: 2448,
    unit: 'kcal',
    formula: 'activeKcal + basalKcal',
    inputFields: ['activeKcal', 'basalKcal'],
    inputState: { activeKcal: 'present', basalKcal: 'present' },
  }],
  coverage: {
    storedState: 'source-and-normalized',
    storedCoverageSeconds: 86400,
    civilDaySeconds: 86400,
    streams: [
      {
        name: 'active',
        recordCount: 24,
        coverageSeconds: 86400,
        gapSeconds: 0,
        valueState: 'present',
        zeroSemantics: 'Missing intervals are not measured zero.',
      },
      {
        name: 'basal',
        recordCount: 24,
        coverageSeconds: 82800,
        gapSeconds: 3600,
        valueState: 'present',
        zeroSemantics: 'Missing intervals are not measured zero.',
      },
    ],
    limitations: ['Google does not expose sensor-level attribution.'],
  },
  records: {
    items: [{ metricType: 'active', kilocalories: 29.5 }],
    total: 48,
    nextCursor: 'next-page',
  },
  sourceJson: {
    state: 'original',
    recordCount: 48,
    format: 'redacted JSON',
    reason: null,
  },
};

test('daily inspector markup separates source, normalized, derived, and coverage layers', () => {
  const markup = inspectorUi.inspectorCategoryMarkup?.(calorieInspector);

  assert.match(markup ?? '', /Google \/ source facts/);
  assert.match(markup ?? '', /Google inferred \/ estimated/);
  assert.match(markup ?? '', /Normalized database records/);
  assert.match(markup ?? '', /Application-derived values/);
  assert.match(markup ?? '', /activeKcal \+ basalKcal/);
  assert.match(markup ?? '', /Coverage, gaps, and freshness/);
  assert.match(markup ?? '', /Missing intervals are not measured zero/);
  assert.match(markup ?? '', /Redacted source JSON/);
  assert.match(markup ?? '', /Load more normalized records/);
  assert.doesNotMatch(markup ?? '', /<Pixel Watch>/);
  assert.match(markup ?? '', /&lt;Pixel Watch&gt;/);
});

test('inspector loading is lazy, date-scoped, and uses separate source endpoints', () => {
  assert.equal(
    inspectorUi.needsInspectorLoad?.({
      open: false,
      loadedDate: null,
      selectedDate: '2026-07-16',
    }),
    false,
  );
  assert.equal(
    inspectorUi.needsInspectorLoad?.({
      open: true,
      loadedDate: '2026-07-16',
      selectedDate: '2026-07-16',
    }),
    false,
  );
  assert.equal(
    inspectorUi.needsInspectorLoad?.({
      open: true,
      loadedDate: '2026-07-15',
      selectedDate: '2026-07-16',
    }),
    true,
  );
  assert.equal(
    inspectorUi.inspectorEndpoint?.('heart', '2026-07-16'),
    '/api/inspector/heart?date=2026-07-16&limit=100',
  );
  assert.equal(
    inspectorUi.inspectorEndpoint?.('heart', '2026-07-16', {
      source: true,
      cursor: 'opaque cursor',
    }),
    '/api/inspector/heart/source?date=2026-07-16&limit=20&cursor=opaque%20cursor',
  );
});

test('redacted source JSON is formatted through textContent', () => {
  let innerHtmlWritten = false;
  const target = {
    textContent: '',
    set innerHTML(_value) {
      innerHtmlWritten = true;
    },
  };
  const payload = {
    source: {
      beatsPerMinute: 72,
      note: '</pre><script>throw new Error("unsafe")</script>',
    },
  };

  inspectorUi.renderSourceJson?.(target, payload);

  assert.equal(innerHtmlWritten, false);
  assert.equal(target.textContent, JSON.stringify(payload, null, 2));
});

test('Today includes a full-width inspector board with all categories folded by default', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const board = html.slice(
    html.indexOf('id="dataInspectorBoard"'),
    html.indexOf('</section>', html.indexOf('id="dataInspectorBoard"')) + 10,
  );

  assert.match(board, /Data inspector/);
  assert.match(board, /data-inspector-category="sleep"/);
  assert.match(board, /data-inspector-category="heart"/);
  assert.match(board, /data-inspector-category="calories"/);
  assert.doesNotMatch(board, /<details[^>]*\sopen(?:\s|>)/);
});
