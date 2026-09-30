#!/usr/bin/env node
/*
 * npm run pack -> dist/cherrytake.mcpb (Claude Desktop, çift tıkla kurulum).
 *
 * 1. Tutarlılık: manifest.json, .claude-plugin/plugin.json, package.json ve
 *    src/sunucu.cjs (SURUM) aynı sürümde mi; manifest'teki araç adları
 *    sunucunun tools/list yanıtıyla aynı mı. Tutmazsa paket üretilmez.
 * 2. Resmi CLI ile doğrulama ve paketleme: npx @anthropic-ai/mcpb validate / pack.
 *    Sürüm sabit (MCPB_SURUM); bağımlılık depoya girmez. ~/.npm'de root sahipli
 *    dosyalar olabildiği için npm önbelleği geçici klasöre yönlenir (ayarlı değilse).
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');
const tutarlilik = require('./tutarlilik.cjs');

const KOK = path.resolve(__dirname, '..');
const MCPB_SURUM = '2.1.2';
const CIKTI = path.join(KOK, 'dist', 'cherrytake.mcpb');

function dur(m) { console.error('paketle: ' + m); process.exit(1); }

(async () => {
  const sorunlar = await tutarlilik.denetle();
  if (sorunlar.length) dur('tutarsızlık:\n  - ' + sorunlar.join('\n  - '));
  console.log('tutarlılık tamam (sürüm ' + tutarlilik.oku('manifest.json').version + ')');

  const ortam = Object.assign({}, process.env);
  if (!ortam.npm_config_cache) ortam.npm_config_cache = path.join(os.tmpdir(), 'cherrytake-npm-cache');
  const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const cli = (...arg) => {
    const r = spawnSync(npx, ['-y', '@anthropic-ai/mcpb@' + MCPB_SURUM, ...arg], { cwd: KOK, env: ortam, stdio: 'inherit' });
    if (r.error) dur('npx çalıştırılamadı (' + r.error.message + '). Node/npm kurulu ve ağ açık olmalı.');
    if (r.status !== 0) dur('mcpb ' + arg[0] + ' başarısız (çıkış ' + r.status + ')');
  };

  cli('validate', 'manifest.json');
  fs.mkdirSync(path.dirname(CIKTI), { recursive: true });
  try { fs.unlinkSync(CIKTI); } catch (e) {}
  cli('pack', '.', CIKTI);
  if (!fs.existsSync(CIKTI)) dur(CIKTI + ' üretilmedi');
  console.log('hazır: ' + path.relative(KOK, CIKTI) + ' (' + Math.round(fs.statSync(CIKTI).size / 1024) + ' KB)');
})().catch(e => dur(e.stack || e.message));
