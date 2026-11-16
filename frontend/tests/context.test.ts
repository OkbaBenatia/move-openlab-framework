// Public Workspace vs private-research context: which context an address belongs to, the transitions (enter, confirmed
// exit, Back / Forward), and the request header that keeps restricted records out of the public context. `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextHeader, contextOf, nextInResearch } from '../src/api/context.ts';

const O = 'http://127.0.0.1:8765';
const RECORDS = { 'c-priv': 'restricted-problem', 'c-pub': 'public-ride-matching' };
const base = { recordProblem: RECORDS, restrictedIds: ['restricted-problem'] };

test('an account without a granted restricted problem is always in the public context', () => {
  for (const section of ['workspace', 'research', 'data']) for (const inResearch of [true, false])
    assert.equal(contextOf({ section, record: 'c-priv', recordProblem: RECORDS, restrictedIds: [], inResearch }).research, false);
  assert.equal(nextInResearch(true, { section: 'research', known: null, exiting: false, hasRestricted: false }), false);
});

test('the context follows the record that is shown, whatever the tab was in', () => {
  assert.deepEqual(contextOf({ ...base, section: 'workspace', record: 'c-priv', inResearch: false }), { research: true, known: 'private' });
  assert.deepEqual(contextOf({ ...base, section: 'workspace', record: 'c-pub', inResearch: true }), { research: false, known: 'public' });
  assert.deepEqual(contextOf({ ...base, section: 'methods', record: 'c-priv', inResearch: false }), { research: true, known: 'private' });
});

test('the research overview is research; an address without a known record keeps the context of the tab', () => {
  assert.equal(contextOf({ ...base, section: 'research', record: '', inResearch: false }).research, true);
  for (const inResearch of [true, false]) {
    assert.equal(contextOf({ ...base, section: 'data', record: '', inResearch }).research, inResearch);
    assert.equal(contextOf({ ...base, section: 'workspace', record: 'c-made-a-moment-ago', inResearch }).research, inResearch);
  }
});

test('transitions: enter by a research address, stay on a list, leave on a public record', () => {
  let ctx = false;
  ctx = nextInResearch(ctx, { section: 'research', known: null, exiting: false, hasRestricted: true }); assert.equal(ctx, true);
  ctx = nextInResearch(ctx, { section: 'workspace', known: 'private', exiting: false, hasRestricted: true }); assert.equal(ctx, true);
  ctx = nextInResearch(ctx, { section: 'data', known: null, exiting: false, hasRestricted: true }); assert.equal(ctx, true);
  ctx = nextInResearch(ctx, { section: 'workspace', known: 'public', exiting: false, hasRestricted: true }); assert.equal(ctx, false);      // Back to a public record
  ctx = nextInResearch(ctx, { section: 'workspace', known: null, exiting: false, hasRestricted: true }); assert.equal(ctx, false);
});

test('a confirmed exit is not undone while the address still shows the private record', () => {
  // Exit to Workspace sets the tab public first; the private address is still shown until the navigation lands
  assert.equal(nextInResearch(false, { section: 'workspace', known: 'private', exiting: true, hasRestricted: true }), false);
  assert.equal(nextInResearch(false, { section: 'workspace', known: 'public', exiting: false, hasRestricted: true }), false);
  // without a confirmed exit the same address enters the context (a bookmark, Forward)
  assert.equal(nextInResearch(false, { section: 'workspace', known: 'private', exiting: false, hasRestricted: true }), true);
});

test('request header: every same-origin API request of the public context says so; the research context sends none', () => {
  assert.deepEqual(contextHeader('/api/lab/experiments', 'public', undefined, O), { 'X-Move-Context': 'public' });
  assert.deepEqual(contextHeader(`${O}/api/campaigns/c-1/export`, 'public', undefined, O), { 'X-Move-Context': 'public' });
  assert.deepEqual(contextHeader('/api/lab/experiments', 'research', undefined, O), {});
});

test('request header: never on other origins or non-API paths, and an explicit choice of the caller is kept', () => {
  assert.deepEqual(contextHeader('https://tile.example.org/1/2/3.png', 'public', undefined, O), {});
  assert.deepEqual(contextHeader('/assets/index.js', 'public', undefined, O), {});
  assert.deepEqual(contextHeader('/api/info', 'public', { 'X-Move-Context': 'all' }, O), {});
  assert.deepEqual(contextHeader('/api/info', 'public', [['x-move-context', 'all']], O), {});
});
