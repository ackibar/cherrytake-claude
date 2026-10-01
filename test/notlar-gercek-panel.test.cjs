/*
 * Notes köprüsü panelin GERÇEK main.js'iyle (pyEdit'in test/sahte-panel.js'i:
 * index.html + bütün js/* Node içinde). Sahte globallerle geçen testin
 * kaçıracağı şeyi sınar: claude-kopru.js'in aradığı adlar (notDurum,
 * notKaynagiBul, notSekansSuresi, notZamanKodu, NOT_RENK, evalHost, setBusy)
 * main.js'te gerçekten var mı, ve Claude'un koyduğu işaretçi panelin kendi
 * "Place markers" düğmesinin koyduğuyla birebir aynı mı.
 */
'use strict';
const {test, after} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');

const PANEL = process.env.CHERRYTAKE_PANEL || path.join(os.homedir(), 'Documents', 'pyEdit-kaynak');
process.env.CHERRYTAKE_SHARED_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-notlar-gercek-'));
const { kur } = require(path.join(PANEL, 'test', 'sahte-panel.js'));

const c = (bas, son, metin, kim) => ({ bas, son, metin, konusmaci: kim });
const CUMLELER = [
  c(6.0, 9.5, 'Merhaba, bugun konugumuz Ayse Yilmaz.', 'S1'),
  c(15.4, 19.0, 'Ilk sorum su: bu projeye nasil basladiniz?', 'S1'),
  c(19.5, 31.0, 'Aslinda her sey bir prototiple basladi, garajda.', 'S2'),
  c(44.5, 48.0, 'Peki ekip nasil buyudu?', 'S1'),
  c(56.5, 61.0, 'Fiyatlandirma tarafinda ne yaptiniz?', 'S1'),
  c(61.5, 92.0, 'Fiyatlandirmayi uc kez degistirdik.', 'S2')
];
const NOTLAR = 'Ayse: garajdan bahsettigi yer cok uzun\n1:05 sesi kis';

function panel(sekansId) {
  const yazilan = [];
  const p = kur({
    init: true,
    evalScript(ifade) {
      if (ifade.indexOf('sk_seqInfo') === 0) return JSON.stringify({ ok: true, sequence: 'Roportaj', sequenceId: sekansId.deger });
      if (ifade.indexOf('sk_notMarkerYaz') === 0) {
        const cfg = JSON.parse(JSON.parse(ifade.slice(ifade.indexOf('(') + 1, ifade.lastIndexOf(')'))));
        yazilan.push(cfg.markerlar);
        return JSON.stringify({ ok: true, added: cfg.markerlar.length, comments: cfg.markerlar.length, errors: [] });
      }
      return undefined;
    }
  });
  const sb = p.sb;
  vm.runInContext(fs.readFileSync(path.join(PANEL, 'js', 'claude-kopru.js'), 'utf8'), sb);
  sb.state.transkript = { cumleler: CUMLELER, fps: 25, dil: 'tr' };
  sb.state.ranges = [[9.5, 15.4], [31.0, 44.5], [92.0, 104.0]];
  sb.state.zarf = [{ span: [0, 104], silences: [[0, 5.8], [9.5, 15.4], [31.0, 44.5], [92.0, 104.0]], zarf: {} }];
  sb.yetkiVarMi = () => true;
  paneller.push(sb);
  return { p, sb, yazilan };
}

const paneller = [];
/* kutuphane.js ve main.js zamanlayıcı kuruyor; pyEdit testleri gibi açık kapat */
after(() => {
  for (const sb of paneller) { try { (sb.ctKutuphane || sb.pyKutuphane).durdur(); } catch (e) {} }
  setTimeout(() => process.exit(process.exitCode || 0), 100).unref();
});

const claude = (sb, mesaj) => new Promise(coz => (sb.ctClaude || sb.pyClaude).isle(mesaj, coz));

test('gerçek main.js: öneri + yerleştirme, işaretçi panelin kendi düğmesininkiyle aynı', async () => {
  const sekans = { deger: 'seq-1' };
  const { p, sb, yazilan } = panel(sekans);

  const o = await claude(sb, { cmd: 'claude.notOner', notes: NOTLAR });
  assert.ok(o.ok, JSON.stringify(o));
  assert.equal(o.source, 'transkript');
  assert.equal(o.notes.length, 2);
  const zk = o.notes.find(n => /1:05/.test(n.text));
  assert.equal(zk.state, 'likely');
  assert.equal(zk.candidates[0].timecode, '00:01:05:00', 'panelin notZamanKodu kullanıldı');
  assert.equal(yazilan.length, 0, 'öneri işaretçi yazmaz');
  assert.equal(sb.notDurum.sonuclar.length, 0, 'panelin kendi Notes listesine dokunulmaz');

  const y = await claude(sb, { cmd: 'claude.notYaz', proposalId: o.proposalId, confirmed: true,
    placements: o.notes.filter(n => n.candidates.length).map(n => ({ note: n.note, candidate: 1 })) });
  assert.ok(y.ok, JSON.stringify(y));
  assert.equal(yazilan.length, 1);
  assert.equal(sb.state.busy, false, 'setBusy(false) çağrıldı');

  /* Aynı notlar panelin kendi akışıyla: yapıştır, yerleştir, onayla, işaretçi koy */
  p.els.notMetin.value = NOTLAR;
  sb.notlariYerlestir();
  sb.notDurum.sonuclar.forEach(r => { if (r.secili >= 0) r.onayli = true; });
  sb.notlariIsaretciyeYaz();
  assert.equal(yazilan.length, 2);
  assert.deepEqual(yazilan[0], yazilan[1], 'Claude ile panel aynı işaretçiyi yazar');
});

test('gerçek main.js: sekans değişince yazmaz', async () => {
  const sekans = { deger: 'seq-1' };
  const { sb, yazilan } = panel(sekans);
  const o = await claude(sb, { cmd: 'claude.notOner', notes: '1:05 sesi kis' });
  sekans.deger = 'seq-2';
  const y = await claude(sb, { cmd: 'claude.notYaz', proposalId: o.proposalId, confirmed: true, placements: [{ note: 1, candidate: 1 }] });
  assert.equal(y.ok, false);
  assert.match(y.error, /active sequence changed/);
  assert.equal(yazilan.length, 0);
});

test('gerçek main.js: başka sekansın transkripti kullanılmaz', async () => {
  const sekans = { deger: 'seq-1' };
  const { sb } = panel(sekans);
  sb.state.transkript.sekansId = 'seq-9';
  const o = await claude(sb, { cmd: 'claude.notOner', notes: '1:05 sesi kis' });
  assert.equal(o.ok, false);
  assert.match(o.error, /belongs to another sequence/);
});
