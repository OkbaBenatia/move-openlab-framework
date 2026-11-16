// "+ Add method" catalogue, template form and CLI equivalents: run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { type CatalogItem, cliCheck, cliNew, cliTest, cliZip, groupCatalog, itemKey, methodId, nameProblem, reasonOf, registerBlock, shq, slug, stepOfError, zipPrecheck } from '../src/lab/pluginCatalog.ts';

const item = (plugin: string, catalog: CatalogItem['catalog'], state: CatalogItem['state'], name = plugin, version = '1.0.0'): CatalogItem =>
  ({ plugin, origin: catalog === 'uploaded' ? 'uploaded' : 'approved', catalog, state, code_sha256: 'a'.repeat(64), metadata: { name, version, method_id: plugin.replace(/_/g, '-') } });

test('the catalogue is grouped as examples, installation, uploads; the upload group is always shown', () => {
  const g = groupCatalog([item('zeta', 'installation', 'available'), item('b', 'example', 'available', 'B'), item('a', 'example', 'registered', 'A')]);
  assert.deepEqual(g.map((x) => x.catalog), ['example', 'installation', 'uploaded']);
  assert.deepEqual(g[0].items.map((x) => x.plugin), ['a', 'b']);
  assert.equal(g[2].items.length, 0);
  assert.deepEqual(groupCatalog([]).map((x) => x.catalog), ['uploaded']);
});

test('the same plug-in name from the folder and from an upload has distinct keys', () => {
  assert.ok(itemKey({ origin: 'approved', plugin: 'x' }) !== itemKey({ origin: 'uploaded', plugin: 'x' }));
});

test('only an available plug-in can be registered, and only where registration is allowed', () => {
  assert.equal(registerBlock(item('a', 'example', 'available'), true, true), null);
  assert.equal(registerBlock(item('a', 'example', 'available'), true, false), 'not-allowed');
  assert.equal(registerBlock(item('a', 'example', 'available'), false, true), 'off');
  assert.equal(registerBlock(item('a', 'example', 'registered'), true, true), 'registered');
  assert.equal(registerBlock(item('a', 'example', 'changed'), true, true), 'changed');
  assert.equal(registerBlock(item('a', 'uploaded', 'taken'), true, true), 'taken');
  assert.equal(registerBlock(item('a', 'example', 'incompatible'), true, true), 'incompatible');
});

test('method names follow the server rule', () => {
  assert.equal(nameProblem('my_method'), null);
  assert.equal(nameProblem(''), 'empty');
  assert.equal(nameProblem('ab'), 'length');
  assert.equal(nameProblem('My-Method'), 'chars');
  assert.equal(nameProblem('1abc'), 'chars');
  assert.equal(slug('My Greedy-Method!'), 'my_greedy_method');
  assert.equal(nameProblem(slug('9 lives')), null);
  assert.equal(methodId('my_greedy'), 'my-greedy');
});

test('CLI equivalents are quoted for the shell', () => {
  assert.equal(shq('plain-name_1'), 'plain-name_1');
  assert.equal(shq("O'Brien"), `'O'\\''Brien'`);
  assert.equal(cliNew({ name: 'my_m', display_name: 'My M', author: '', kind: 'heuristic', description: '' }, 'public-ride-matching'),
    "move-openlab method new my_m --problem public-ride-matching --dir plugins --display-name 'My M'");
  assert.ok(/--author 'A B' --kind learned --description d$/.test(cliNew({ name: 'm_x', display_name: '', author: 'A B', kind: 'learned', description: 'd' }, 'p')));
  assert.equal(cliTest('plugins/m_x'), 'python -m pytest plugins/m_x/test_plugin.py');
  assert.equal(cliCheck('m_x', 'b.zip'), 'move-openlab method check m_x --bundle b.zip');
  assert.equal(cliCheck('m_x'), 'move-openlab method check m_x');
  assert.ok(cliZip('m_x').includes('__pycache__'));
});

test('upload refusals are attributed to the step that failed', () => {
  assert.equal(stepOfError("ZIP refused: '..' not allowed"), 'archive');
  assert.equal(stepOfError('METADATA refused: plugin defines no literal METADATA'), 'metadata');
  assert.equal(stepOfError('403 Forbidden'), 'upload');
  assert.equal(reasonOf('ZIP refused: too big'), 'too big');
  assert.equal(zipPrecheck({ name: 'a.zip', size: 10 }, 100), null);
  assert.equal(zipPrecheck({ name: 'a.tar', size: 10 }, 100), 'not-zip');
  assert.equal(zipPrecheck({ name: 'a.ZIP', size: 101 }, 100), 'too-large');
  assert.equal(zipPrecheck({ name: 'a.zip', size: 0 }, 100), 'empty');
});
