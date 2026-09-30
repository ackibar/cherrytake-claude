/*
 * Paket tutarlılığı: sürümler ve araç adları dört yerde aynı olmalı.
 * Hem `npm run pack` hem test/paket.test.cjs kullanır.
 */
'use strict';
const fs = require('fs'), path = require('path');
const { spawn } = require('child_process');

const KOK = path.resolve(__dirname, '..');
const oku = ad => JSON.parse(fs.readFileSync(path.join(KOK, ad), 'utf8'));

/* Sunucunun gerçek tools/list yanıtı (panel gerekmez) */
function sunucuAraclari() {
  return new Promise((coz, red) => {
    const cp = spawn(process.execPath, [path.join(KOK, 'src', 'sunucu.cjs')], { stdio: ['pipe', 'pipe', 'ignore'] });
    let tampon = '';
    const zaman = setTimeout(() => { cp.kill(); red(new Error('sunucu tools/list yanıtı vermedi')); }, 5000);
    cp.stdout.setEncoding('utf8');
    cp.stdout.on('data', d => {
      tampon += d;
      let i;
      while ((i = tampon.indexOf('\n')) >= 0) {
        const s = tampon.slice(0, i); tampon = tampon.slice(i + 1);
        let m; try { m = JSON.parse(s); } catch (e) { continue; }
        if (m.id === 2) { clearTimeout(zaman); cp.stdin.end(); coz({ araclar: m.result.tools, surum: sunucuSurum }); }
        if (m.id === 1) sunucuSurum = m.result.serverInfo.version;
      }
    });
    let sunucuSurum = null;
    cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'paketle', version: '0' } } }) + '\n');
    cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  });
}

async function denetle() {
  const sorun = [];
  const man = oku('manifest.json'), eklenti = oku('.claude-plugin/plugin.json'), pk = oku('package.json');
  const { araclar, surum } = await sunucuAraclari();
  const surumler = { 'manifest.json': man.version, 'plugin.json': eklenti.version, 'package.json': pk.version, 'sunucu.cjs SURUM': surum };
  if (new Set(Object.values(surumler)).size !== 1) sorun.push('sürümler farklı: ' + JSON.stringify(surumler));
  const a = araclar.map(t => t.name).sort(), b = (man.tools || []).map(t => t.name).sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) sorun.push('manifest tools ' + b.join(',') + ' <> sunucu ' + a.join(','));
  if (man.server.entry_point !== 'src/sunucu.cjs' || !fs.existsSync(path.join(KOK, man.server.entry_point))) sorun.push('entry_point yok: ' + man.server.entry_point);
  if (man.icon && !fs.existsSync(path.join(KOK, man.icon))) sorun.push('simge yok: ' + man.icon);
  const yoksay = fs.readFileSync(path.join(KOK, '.mcpbignore'), 'utf8').split('\n').map(s => s.trim());
  for (const g of ['test/', 'dist/', 'araclar/']) if (!yoksay.includes(g)) sorun.push('.mcpbignore ' + g + ' içermiyor');
  return sorun;
}

module.exports = { denetle, oku, sunucuAraclari };
