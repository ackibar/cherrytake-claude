/* Paket tutarlılığı (ağsız): sürümler ve araç adları manifest, plugin.json,
   package.json ve sunucuda aynı; Claude Desktop paketi (.mcpb) bunlara dayanır. */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../araclar/tutarlilik.cjs');

test('manifest, plugin.json, package.json ve sunucu tutarlı', async () => {
  assert.deepEqual(await t.denetle(), []);
});

test('manifest MCPB 0.3 şemasının zorunlu alanlarını taşır', () => {
  const m = t.oku('manifest.json');
  assert.equal(m.manifest_version, '0.3');
  for (const k of ['name', 'version', 'description', 'author', 'server']) assert.ok(m[k], k);
  assert.equal(m.server.type, 'node');
  assert.deepEqual(m.server.mcp_config.args, ['${__dirname}/src/sunucu.cjs']);
  assert.deepEqual(m.compatibility.platforms, ['darwin']);
});
