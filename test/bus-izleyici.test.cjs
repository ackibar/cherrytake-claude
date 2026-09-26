/*
 * Veri yolu: fs.watch baslatildiktan SONRA 'error' yayarsa surec cokmemeli.
 *
 * Eskiden izleyicinin 'error' olayina dinleyici baglanmiyordu; EventEmitter
 * kurali geregi dinleyicisiz 'error' firlatilir ve uygulama duser. Artik
 * bozulan izleyici kapatilir, teslim yedek taramayla surer, izleyici bir sure
 * sonra yeniden kurulur ve stop() hicbir zamanlayici/tutamak birakmaz.
 *
 * BU DOSYA BUTUN CHERRYTAKE DEPOLARINDA AYNIDIR: veri yolunun .cjs (Electron,
 * MCP) ya da .js (CEP paneli) kopyasini kendisi bulur.
 */
'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const EventEmitter = require('node:events');
const {spawnSync} = require('node:child_process');

const BUS = [
  path.join(__dirname, '..', 'src', 'cherrytake-bus.cjs'),
  path.join(__dirname, '..', 'js', 'cherrytake-bus.js')
].find(f => fs.existsSync(f));
if (!BUS) throw Error('cherrytake-bus kopyasi bulunamadi');

function kur() {
  const kok = fs.mkdtempSync(path.join(os.tmpdir(), 'ctbus-izleyici-'));
  process.env.CHERRYTAKE_SHARED_DIR = kok;
  delete require.cache[require.resolve(BUS)];
  return {kok, bus: require(BUS)};
}
const bekle = ms => new Promise(r => setTimeout(r, ms));
async function bekleKosul(kosul, aciklama, sure = 5000) {
  const bitis = Date.now() + sure;
  while (Date.now() < bitis) { if (kosul()) return; await bekle(10); }
  throw Error('Kosul zamaninda saglanmadi: ' + aciklama);
}

/* fs.watch yerine gecen sahte izleyici: olay yok, yalniz 'error' ve close */
function sahteUretici() {
  const uretilen = [];
  const uret = (dizin, dinle) => {
    const w = new EventEmitter();
    w.dizin = dizin; w.dinle = dinle; w.kapandi = false;
    w.close = () => { w.kapandi = true; };
    uretilen.push(w);
    return w;
  };
  return {uretilen, uret};
}

/* Test sirasinda yakalanmamis hata var mi? (node:test'in kendi dinleyicisinden once) */
function yakalanmamisIzle() {
  const hatalar = [];
  const dinle = e => hatalar.push(e);
  process.prependListener('uncaughtException', dinle);
  return {hatalar, birak: () => process.removeListener('uncaughtException', dinle)};
}

test('Baslatildiktan sonra error yayan izleyici sureci dusurmez; mesajlar taramayla gelir', async () => {
  const {bus} = kur();
  const s = sahteUretici(), y = yakalanmamisIzle();
  const gelen = [], izHatalari = [];
  const kutu = bus.watch('library', m => gelen.push(m.cmd),
    {tarama: 40, yenidenKur: 60000, izleyiciUret: s.uret, izleyiciHata: e => izHatalari.push(e.code)});
  try {
    assert.equal(s.uretilen.length, 1);
    assert.equal(kutu.izleyiciVar, true);

    s.uretilen[0].emit('error', Object.assign(Error('sahte EPERM'), {code: 'EPERM'}));
    assert.equal(s.uretilen[0].kapandi, true, 'bozulan izleyici kapatilmali');
    assert.equal(kutu.izleyiciVar, false);
    assert.deepEqual(izHatalari, ['EPERM'], 'izleyiciHata bildirilmeli');

    /* gec gelen ikinci hata da (dinleyici kapali izleyicide kaldi) dusurmemeli */
    s.uretilen[0].emit('error', Error('ikinci'));

    bus.send('library', {cmd: 'hatadan-sonra'}, {from: 'circle'});
    await bekleKosul(() => gelen.includes('hatadan-sonra'), 'yedek tarama teslim etmeli');
    assert.equal(s.uretilen.length, 1, 'yenidenKur dolmadan yeni izleyici kurulmamali');
    assert.deepEqual(y.hatalar, [], 'yakalanmamis hata olmamali');
  } finally { kutu.stop(); y.birak(); }
});

test('Bozulan izleyici yenidenKur sonra yeniden kurulur ve olaylari yine tarama tetikler', async () => {
  const {bus} = kur();
  const s = sahteUretici(), y = yakalanmamisIzle();
  const gelen = [];
  const kutu = bus.watch('premiere', m => gelen.push(m.cmd), {tarama: 20, yenidenKur: 80, izleyiciUret: s.uret});
  try {
    s.uretilen[0].emit('error', Error('klasor silindi'));
    await bekleKosul(() => s.uretilen.length === 2, 'izleyici yeniden kurulmali');
    assert.equal(kutu.izleyiciVar, true);
    assert.equal(s.uretilen[1].kapandi, false);

    /* yeni izleyicinin olayi turu tetikler */
    bus.send('premiere', {cmd: 'yeni-izleyici'}, {from: 'library'});
    s.uretilen[1].dinle('rename', 'x.json');
    await bekleKosul(() => gelen.includes('yeni-izleyici'), 'yeni izleyiciyle teslim');

    /* eski izleyicinin gec hatasi yenisini dusurmez */
    s.uretilen[0].emit('error', Error('gec'));
    assert.equal(kutu.izleyiciVar, true, 'eski izleyicinin hatasi yenisini kapatmamali');
    assert.deepEqual(y.hatalar, []);
  } finally { kutu.stop(); y.birak(); }
  assert.ok(s.uretilen.every(w => w.kapandi), 'stop butun izleyicileri kapatmali');
});

test('fs.watch hic kurulamazsa teslim yine taramayla olur', async () => {
  const {bus} = kur();
  const gelen = [];
  const kutu = bus.watch('circle', m => gelen.push(m.cmd),
    {tarama: 30, yenidenKur: 60000, izleyiciUret: () => { throw Object.assign(Error('ENOSYS'), {code: 'ENOSYS'}); }});
  try {
    assert.equal(kutu.izleyiciVar, false);
    bus.send('circle', {cmd: 'izleyicisiz'}, {from: 'library'});
    await bekleKosul(() => gelen.includes('izleyicisiz'), 'izleyicisiz teslim');
  } finally { kutu.stop(); }
});

test('stop sonrasi izleyici kapali, yeniden kurulmaz, isleyici cagrilmaz', async () => {
  const {bus} = kur();
  const s = sahteUretici();
  const gelen = [];
  const kutu = bus.watch('launcher', m => gelen.push(m.cmd), {tarama: 20, yenidenKur: 20, izleyiciUret: s.uret});
  s.uretilen[0].emit('error', Error('bozuldu'));
  kutu.stop();
  kutu.stop();   /* iki kez cagirmak zararsiz */
  bus.send('launcher', {cmd: 'stoptan-sonra'}, {from: 'library'});
  await bekle(150);
  assert.equal(s.uretilen.length, 1, 'stop sonrasi izleyici yeniden kurulmamali');
  assert.ok(s.uretilen[0].kapandi);
  assert.deepEqual(gelen, [], 'stop sonrasi mesaj islenmemeli');
});

/*
 * Tutamak sizintisi ayri surecte olculur: test calistiricisinin kendi
 * zamanlayicilari karismasin. Cocuk zamanlayicilari sayar, GERCEK fs.watch
 * izleyicisine 'error' yayar ve sonunda process.exit cagirmadan kendiliginden
 * kapanabilmeli (acik izleyici ya da zamanlayici kalsa asili kalirdi).
 */
test('Gercek fs.watch hatasi + stop: hic zamanlayici ya da tutamak kalmaz, surec kendiliginden biter', () => {
  const {kok} = kur();
  const cocuk = `
    const fs = require('fs');
    const gSetTimeout = setTimeout, gClearTimeout = clearTimeout, gSetInterval = setInterval, gClearInterval = clearInterval;
    const acik = new Set();
    global.setTimeout = (f, ms, ...a) => { const t = gSetTimeout(() => { acik.delete(t); f(...a); }, ms); acik.add(t); return t; };
    global.clearTimeout = t => { acik.delete(t); gClearTimeout(t); };
    global.setInterval = (f, ms, ...a) => { const t = gSetInterval(f, ms, ...a); acik.add(t); return t; };
    global.clearInterval = t => { acik.delete(t); gClearInterval(t); };
    const bus = require(${JSON.stringify(BUS)});
    let gercek = null, kapandi = false;
    const gelen = [];
    const kutu = bus.watch('library', m => { gelen.push(m.cmd); for (let i = 0; i < 3; i++) kutu.simdiTara(); }, {
      tarama: 30, yenidenKur: 60000,
      izleyiciUret: (d, dinle) => { gercek = fs.watch(d, dinle); const k = gercek.close.bind(gercek); gercek.close = () => { kapandi = true; k(); }; return gercek; }
    });
    /* olay dongusu bosalinca: geriye kalan etkin kaynak olmamali */
    process.once('beforeExit', () => {
      const kaynak = process.getActiveResourcesInfo ? process.getActiveResourcesInfo().filter(r => r !== 'TTYWrap' && r !== 'PipeWrap') : [];
      console.log('KAYNAK=' + JSON.stringify(kaynak));
    });
    process.on('exit', c => { if (c === 0) console.log('CIKIS-TEMIZ'); });
    gSetTimeout(() => {
      gercek.emit('error', Object.assign(new Error('gercek izleyicide sahte hata'), {code: 'EPERM'}));
      console.log('HAYATTA izleyiciVar=' + kutu.izleyiciVar + ' kapandi=' + kapandi);
      bus.send('library', {cmd: 'tarama-ile'}, {from: 'circle'});
      const t0 = Date.now();
      (function bekle() {
        if (gelen.includes('tarama-ile') || Date.now() - t0 > 4000) {
          console.log('TESLIM=' + gelen.includes('tarama-ile'));
          kutu.stop();
          console.log('ACIK-ZAMANLAYICI=' + acik.size);
          return;
        }
        gSetTimeout(bekle, 10);
      })();
    }, 50);
  `;
  const r = spawnSync(process.execPath, ['-e', cocuk], {
    env: Object.assign({}, process.env, {CHERRYTAKE_SHARED_DIR: kok}), encoding: 'utf8', timeout: 15000
  });
  const cikti = r.stdout + r.stderr;
  assert.equal(r.error, undefined, 'cocuk surec asili kaldi (acik tutamak?): ' + cikti);
  assert.equal(r.status, 0, 'cocuk cokmemeli: ' + cikti);
  assert.match(cikti, /HAYATTA izleyiciVar=false kapandi=true/);
  assert.match(cikti, /TESLIM=true/);
  assert.match(cikti, /ACIK-ZAMANLAYICI=0/);
  assert.match(cikti, /KAYNAK=\[\]/);
  assert.match(cikti, /CIKIS-TEMIZ/);
});
