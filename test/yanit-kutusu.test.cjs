/*
 * Yanit adreslemesi (hata 14): ayni anda calisan iki MCP sunucusu birbirinin
 * yanitini okuyup silmemeli.
 *
 * Eskiden her sunucu yaniti ortak "claude" kutusundan bus.watch ile aliyordu;
 * bus.watch kutudaki HER dosyayi sahiplenip siler. Iki sunucu varsa once
 * tarayan ikisinin yanitini da yutar, oteki komut uygulanmis olsa bile zaman
 * asimina duser. Simdi her sunucu sureci kendi alt kutusunu (bus/claude/
 * yanit-<pid>-<rnd>/) komutun replyBox alaninda bildirir; panel oraya yazar.
 * Eski panel alani tanimaz, ortak kutuya yazar: sunucu orada yalniz kendi
 * komut kimligine ait yaniti alir, baskasininkine dokunmaz.
 *
 * Gercek sunucu sureci (stdio) + gecici ortak klasor + panelin GERCEK
 * kutuphane.js/claude-kopru.js'i (vm). Premiere yok, gercek CherryTake
 * klasorune dokunulmaz.
 */
'use strict';
const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const {spawn, spawnSync} = require('node:child_process');

const KOK = path.resolve(__dirname, '..');
const BUS = path.join(KOK, 'src', 'cherrytake-bus.cjs');
const PANEL = process.env.CHERRYTAKE_PANEL || path.join(os.homedir(), 'Documents', 'pyEdit-kaynak');
const bekle = ms => new Promise(r => setTimeout(r, ms));
const temizlenecek = [];
after(() => { for (const f of temizlenecek) { try { f(); } catch (e) {} } });

function kokKur() {
  const kok = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-yanit-kutusu-'));
  process.env.CHERRYTAKE_SHARED_DIR = kok;
  delete require.cache[require.resolve(BUS)];
  const bus = require(BUS);
  temizlenecek.push(() => fs.rmSync(kok, {recursive: true, force: true}));
  return {kok, bus, ortak: path.join(kok, 'bus', 'claude')};
}

function kutuIcerigi(ortak) {
  try { return fs.readdirSync(ortak); } catch (e) { return []; }
}
const altKutular = ortak => kutuIcerigi(ortak).filter(a => /^yanit-/.test(a));

/* Panelin gercek kodu, sahte panel islevleriyle (test-zincir.cjs'teki gibi) */
function panelKur(kok, secenek = {}) {
  const el = { status: { textContent: 'Ready', className: 'status' }, mode: { value: 'ripple' } };
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, JSON, Math, Date, String, Number,
    RegExp, Error, Object, Array, parseInt, parseFloat, process, require, global: null,
    document: { getElementById: id => el[id] || null }
  };
  sb.global = sb;
  sb.state = { busy: false, mod: 'silence', level: 3, ranges: [], backup: null, totalCut: 0, clipSpan: 0 };
  sb.levelLabel = () => 'Standard';
  sb.applyPreset = (l) => { sb.state.level = l; };
  sb.setScope = (s) => { sb.kapsam = s; };
  sb.scopeValue = () => sb.kapsam || 'sequence';
  sb.setMod = (m) => { sb.state.mod = m; };
  sb.log = () => {};
  sb.yetkiVarMi = () => true;
  sb.analizSuresi = secenek.analizSuresi || 100;
  sb.analyze = () => {
    sb.state.busy = true;
    setTimeout(() => {
      sb.state.ranges = [[1, 2]]; sb.state.totalCut = 1; sb.state.clipSpan = 10;
      el.status.textContent = 'Analysis done'; el.status.className = 'status good';
      sb.state.busy = false;
    }, sb.analizSuresi);
  };
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(BUS, 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(PANEL, 'js', 'kutuphane.js'), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(PANEL, 'js', 'claude-kopru.js'), 'utf8'), sb);
  sb.pyKutuphane.baslat({
    bus: sb.cherrytakeBus,
    evalHost: (b, cb) => cb({ ok: true, sequence: 'Röportaj', fps: 25, tpf: 10160640000 }),
    yetkiVarMi: () => true,
    log: () => {}
  });
  temizlenecek.push(() => sb.pyKutuphane.durdur());
  return sb;
}

/* Eski panel: claude-kopru replyBox'u bilmez, bus'in verdigi yanit() ortak "claude" kutusuna yazar */
function eskiPanelKur(bus, gecikme = 0) {
  const kalp = bus.heartbeat('premiere');
  const kutu = bus.watch('premiere', (m, yanit) => {
    const cevap = { cmd: m.cmd, ok: true, sequence: 'Eski panel', level: 3, levelName: 'Standard' };
    if (gecikme) setTimeout(() => yanit(cevap), gecikme); else yanit(cevap);
  }, { tarama: 100 });
  const durdur = () => { kutu.stop(); kalp.stop(); };
  temizlenecek.push(durdur);
  return { durdur };
}

function sunucuBaslat(kok, ekOrtam = {}) {
  const cp = spawn(process.execPath, [path.join(KOK, 'src', 'sunucu.cjs')], {
    env: Object.assign({}, process.env, { CHERRYTAKE_SHARED_DIR: kok }, ekOrtam),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let tampon = '', sira = 1;
  const bekleyen = new Map();
  cp.stdout.setEncoding('utf8');
  cp.stdout.on('data', d => {
    tampon += d;
    let i;
    while ((i = tampon.indexOf('\n')) >= 0) {
      const s = tampon.slice(0, i); tampon = tampon.slice(i + 1);
      let m; try { m = JSON.parse(s); } catch (e) { continue; }
      if (m.id !== undefined && bekleyen.has(m.id)) { bekleyen.get(m.id)(m); bekleyen.delete(m.id); }
    }
  });
  cp.stderr.on('data', () => {});
  const bitti = new Promise(r => cp.on('exit', r));
  const iste = (method, params) => new Promise(coz => {
    const id = sira++;
    bekleyen.set(id, coz);
    cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const arac = (name, args) => iste('tools/call', { name, arguments: args || {} });
  const kapat = async () => { try { cp.stdin.end(); } catch (e) {} await bitti; };
  temizlenecek.push(() => { try { cp.kill('SIGKILL'); } catch (e) {} });
  return { cp, iste, arac, kapat, bitti };
}

const metin = r => (r.result && r.result.content && r.result.content[0].text) || '';
const basarili = r => r.result && !r.result.isError;

async function bekleKosul(kosul, sure = 4000) {
  const bitis = Date.now() + sure;
  while (Date.now() < bitis) { if (kosul()) return true; await bekle(20); }
  return kosul();
}

/* ---------- 1) asil hata: iki sunucu, bir panel ---------- */

test('iki sunucu ayni anda: her biri kendi yanitini alir, hicbiri zaman asimina dusmez', async () => {
  const {kok, ortak} = kokKur();
  panelKur(kok);
  const ortam = { CHERRYTAKE_CLAUDE_KISA_MS: '4000', CHERRYTAKE_CLAUDE_UZUN_MS: '6000' };
  const A = sunucuBaslat(kok, ortam), B = sunucuBaslat(kok, ortam);
  await bekle(150);
  const istekler = [];
  for (let i = 0; i < 4; i++) { istekler.push(A.arac('premiere_status')); istekler.push(B.arac('premiere_status')); }
  const sonuc = await Promise.all(istekler);
  const kotu = sonuc.filter(r => !basarili(r)).map(metin);
  assert.deepEqual(kotu, [], 'zaman asimina dusen istek var');
  sonuc.forEach(r => assert.match(metin(r), /Röportaj/));

  /* biri uzun is (analiz) beklerken oteki durum sorar */
  const [an, du] = await Promise.all([A.arac('analyze_silences'), B.arac('premiere_status')]);
  assert.ok(basarili(an), metin(an));
  assert.match(metin(an), /1 silences/);
  assert.ok(basarili(du), metin(du));

  await Promise.all([A.kapat(), B.kapat()]);
  assert.deepEqual(kutuIcerigi(ortak), [], 'ortak kutuda artik dosya ya da alt kutu kalmamali');
});

/* ---------- 2) gec yanit ---------- */

test('zaman asimindan sonra gelen yanit (yeni panel): atilir, alt kutu kalmaz, panel kutuyu yeniden kurmaz', async () => {
  const {kok, ortak} = kokKur();
  panelKur(kok, { analizSuresi: 1200 });
  const S = sunucuBaslat(kok, { CHERRYTAKE_CLAUDE_UZUN_MS: '400' });
  await bekle(150);
  const r = await S.arac('analyze_silences');
  assert.ok(!basarili(r) && /did not finish within .*may still be running/.test(metin(r)), metin(r));
  assert.deepEqual(altKutular(ortak), [], 'zaman asiminda bekleyen kalmadiysa alt kutu silinmeli');
  await bekle(1400);   /* panel simdi yanit veriyor */
  assert.deepEqual(kutuIcerigi(ortak), [], 'gec yanit hicbir kutuda kalmamali');
  /* sunucu hala calisiyor ve sonraki istek yine dogru yanit aliyor */
  const d = await S.arac('premiere_status');
  assert.ok(basarili(d), metin(d));
  await S.kapat();
});

test('alt kutuya bilinmeyen kimlikle dusen yanit silinir, bekleyen istek bozulmaz', async () => {
  const {kok, ortak} = kokKur();
  panelKur(kok, { analizSuresi: 800 });
  const S = sunucuBaslat(kok);
  await bekle(150);
  const analiz = S.arac('analyze_silences');
  assert.ok(await bekleKosul(() => altKutular(ortak).length === 1), 'alt kutu kurulmali');
  const alt = path.join(ortak, altKutular(ortak)[0]);
  const sahte = path.join(alt, '1-gec.json');
  fs.writeFileSync(sahte, JSON.stringify({ v: 1, id: '1-gec', from: 'premiere', cmd: 'claude.durum', replyTo: 'coktan-bitti', ok: true }));
  assert.ok(await bekleKosul(() => !fs.existsSync(sahte), 2000), 'gec yanit alt kutudan silinmeli');
  const r = await analiz;
  assert.ok(basarili(r), metin(r));
  await S.kapat();
  assert.deepEqual(kutuIcerigi(ortak), []);
});

test('zaman asimindan sonra gelen yanit (eski panel, ortak kutu): sunucu onu tanir ve siler', async () => {
  const {kok, bus, ortak} = kokKur();
  eskiPanelKur(bus, 1000);
  const S = sunucuBaslat(kok, { CHERRYTAKE_CLAUDE_KISA_MS: '400' });
  await bekle(150);
  const r = await S.arac('premiere_status');
  assert.ok(!basarili(r), metin(r));
  await bekle(900);   /* yanit ortak kutuya dustu */
  assert.ok(await bekleKosul(() => kutuIcerigi(ortak).filter(a => a.endsWith('.json')).length === 0, 2000),
    'gec yanit ortak kutuda kalmamali: ' + kutuIcerigi(ortak).join(','));
  await S.kapat();
});

/* ---------- 3) uyumluluk ---------- */

test('yeni sunucu + eski panel: iki sunucu ortak kutuda yalniz kendi yanitini alir', async () => {
  const {kok, bus, ortak} = kokKur();
  eskiPanelKur(bus);
  /* baska bir istemcinin taze yaniti (bizim degil): dokunulmamali */
  fs.mkdirSync(ortak, { recursive: true });
  const yabanci = path.join(ortak, '9-yabanci.json');
  fs.writeFileSync(yabanci, JSON.stringify({ v: 1, id: '9-yabanci', from: 'premiere', cmd: 'x', replyTo: 'baskasinin-komutu' }));
  /* eski panel ortak kutuyu tarayarak cevapliyor; 6 es zamanli istekte yuklu
     makinede 4 sn sinirina birkac ms ile takiliyordu (olculdu: 4161 ms) */
  const ortam = { CHERRYTAKE_CLAUDE_KISA_MS: '10000' };
  const A = sunucuBaslat(kok, ortam), B = sunucuBaslat(kok, ortam);
  await bekle(150);
  const istekler = [];
  for (let i = 0; i < 3; i++) { istekler.push(A.arac('premiere_status')); istekler.push(B.arac('premiere_status')); }
  const sonuc = await Promise.all(istekler);
  assert.deepEqual(sonuc.filter(r => !basarili(r)).map(metin), []);
  sonuc.forEach(r => assert.match(metin(r), /Eski panel/));
  assert.ok(fs.existsSync(yabanci), 'baskasina ait yanit silinmemeli');
  await Promise.all([A.kapat(), B.kapat()]);
  assert.deepEqual(kutuIcerigi(ortak), ['9-yabanci.json']);
});

test('eski sunucu + yeni panel: replyBox yoksa yanit ortak "claude" kutusuna gider', async () => {
  const {kok, bus} = kokKur();
  panelKur(kok);
  await bekle(100);
  /* eski sunucunun yaptigi: from=claude ile gonder, "claude" kutusunu bus.watch ile oku */
  const gelen = [];
  const kutu = bus.watch('claude', m => gelen.push(m), { tarama: 50 });
  temizlenecek.push(() => kutu.stop());
  const id = bus.send('premiere', { cmd: 'claude.durum' }, { from: 'claude' });
  assert.ok(await bekleKosul(() => gelen.length > 0), 'yanit gelmedi');
  assert.equal(gelen[0].replyTo, id);
  assert.equal(gelen[0].ok, true);
  kutu.stop();
});

test('yeni panel: gecersiz replyBox ortak kutuya duser, silinmis alt kutu yeniden kurulmaz', async () => {
  const {kok, ortak} = kokKur();
  const sb = panelKur(kok);
  const sor = (m) => new Promise(coz => {
    const yedek = (y) => { coz({ yol: 'ortak', y }); return null; };
    sb.pyClaude.isle(Object.assign({ v: 1, id: '1-x', from: 'claude', ts: Date.now() }, m), yedek);
    setTimeout(() => coz({ yol: 'yok' }), 300);
  });
  /* yol gezintisi denemesi: ozel kutuya yazilmaz, ortak yanitciya duser */
  let s = await sor({ cmd: 'claude.durum', replyBox: '../../premiere' });
  assert.equal(s.yol, 'ortak');
  s = await sor({ cmd: 'claude.durum', replyBox: 'yanit-1-abc/../..' });
  assert.equal(s.yol, 'ortak');
  /* gecerli ad ama kutu yok (sunucu cikmis/zaman asimi): yanit atilir, klasor acilmaz */
  s = await sor({ cmd: 'claude.durum', replyBox: 'yanit-123-abc' });
  assert.equal(s.yol, 'yok');
  assert.ok(!fs.existsSync(path.join(ortak, 'yanit-123-abc')));
  /* kutu varsa oraya yazilir */
  fs.mkdirSync(path.join(ortak, 'yanit-123-abc'), { recursive: true });
  s = await sor({ cmd: 'claude.durum', replyBox: 'yanit-123-abc' });
  assert.equal(s.yol, 'yok');
  const dosyalar = fs.readdirSync(path.join(ortak, 'yanit-123-abc'));
  assert.equal(dosyalar.length, 1);
  const y = JSON.parse(fs.readFileSync(path.join(ortak, 'yanit-123-abc', dosyalar[0]), 'utf8'));
  assert.equal(y.replyTo, '1-x');
  assert.equal(y.from, 'premiere');
  assert.equal(y.ok, true);
});

/* ---------- 4) temizlik ---------- */

test('SIGTERM ile bekleyen istek varken cikan sunucu alt kutusunu siler', async () => {
  const {kok, ortak} = kokKur();
  panelKur(kok, { analizSuresi: 3000 });
  const S = sunucuBaslat(kok);
  await bekle(150);
  S.arac('analyze_silences');
  assert.ok(await bekleKosul(() => altKutular(ortak).length === 1), 'alt kutu kurulmali');
  S.cp.kill('SIGTERM');
  await S.bitti;
  assert.deepEqual(altKutular(ortak), []);
});

test('coken (olu pid) sunucunun sahipsiz alt kutusu sonraki sunucu tarafindan silinir', async () => {
  const {kok, ortak} = kokKur();
  panelKur(kok);
  const olu = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
  const sahipsiz = path.join(ortak, 'yanit-' + olu + '-olmus');
  fs.mkdirSync(sahipsiz, { recursive: true });
  fs.writeFileSync(path.join(sahipsiz, '1-a.json'), '{}');
  const S = sunucuBaslat(kok);
  await bekle(150);
  const d = await S.arac('premiere_status');
  assert.ok(basarili(d), metin(d));
  assert.ok(!fs.existsSync(sahipsiz), 'olu surecin alt kutusu kalmamali');
  await S.kapat();
  assert.deepEqual(kutuIcerigi(ortak), []);
});
