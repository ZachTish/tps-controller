import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import './test-calendar-vault-index-roots.mjs';

const parserSource = readFileSync(new URL('../src/services/ical-parser-service.ts', import.meta.url), 'utf8');
const fetchSource = readFileSync(new URL('../src/services/external-calendar-service.ts', import.meta.url), 'utf8');

test('controller calendar sync keeps bounded recurrence and deterministic occurrence identity', () => {
  assert.match(parserSource, /const HARD_MAX_ITERATIONS = 10000/);
  assert.match(parserSource, /Math\.min\(HARD_MAX_ITERATIONS, Math\.max\(baseMax, estimated\)\)/);
  assert.match(parserSource, /icalTimeToStableString\(event\.startDate\)/);
  assert.match(parserSource, /icalTimeToStableString\(event\.recurrenceId\)/);
});

test('controller fetch service retains structured status required by sync decisions', () => {
  assert.match(fetchSource, /export interface ExternalCalendarFetchResult/);
  assert.match(fetchSource, /fetchEventsWithStatus/);
  assert.match(fetchSource, /fromCache:/);
  assert.match(fetchSource, /statusCode:/);
});

test('controller clears the bounded fetch timeout after every settled race', () => {
  assert.match(fetchSource, /let timeoutId: ReturnType<typeof setTimeout> \| undefined;/);
  assert.match(fetchSource, /timeoutId = setTimeout\(/);
  assert.match(fetchSource, /finally \{[\s\S]*if \(timeoutId !== undefined\) clearTimeout\(timeoutId\);[\s\S]*\}/);
});
