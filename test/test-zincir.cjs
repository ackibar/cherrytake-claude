/*
 * Uçtan uca zincir, Premiere'siz:
 *   MCP istemcisi (bu test) -> sunucu.cjs (gerçek süreç, stdio)
 *   -> veri yolu (geçici klasör) -> panelin GERÇEK kutuphane.js + claude-kopru.js
 *   -> sahte panel işlevleri (analyze/cut/undoLastCut, main.js'teki gibi state.busy ile)
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), vm = require('vm');
const { spawn } = require('child_process');

const KOK = path.resolve(__dirname, '..');
const PANEL = process.env.CHERRYTAKE_PANEL || path.join(os.homedir(), 'Documents', 'pyEdit-kaynak');
const PAYLASILAN = fs.mkdtempSync(path.join(os.tmpdir(), 'cherrytake-claude-test-'));
process.env.CHERRYTAKE_SHARED_DIR = PAYLASILAN;

let fail = 0;
const check = (n, c, x) => { if (!c) { fail++; console.log('HATA ' + n + (x ? '  ' + x : '')); } else console.log('OK   ' + n); };
const bekle = ms => new Promise(r => setTimeout(r, ms));

/* ---------- sahte panel ---------- */

function panelKur() {
  const olaylar = [];
  const el = { status: { textContent: 'Ready', className: 'status' }, mode: { value: 'ripple' } };
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, JSON, Math, Date, String, Number,
    RegExp, Error, Object, Array, parseInt, parseFloat, process, require, global: null,
    document: { getElementById: id => el[id] || null }
  };
  sb.global = sb;
  const durumYaz = (m, c) => { el.status.textContent = m; el.status.className = 'status ' + (c || ''); };
  sb.state = { busy: false, mod: 'notes', level: 3, ranges: [], backup: null, totalCut: 0, clipSpan: 0 };
  sb.levelLabel = () => ({ 1: 'Very gentle', 2: 'Gentle', 3: 'Standard', 4: 'Tight', 5: 'Very tight' })[sb.state.level];
  /* quiet=false olursa panelin kayıtlı ayarı (sk_opts) ezilirdi: olayda ':KAYIT' görünür */
  sb.applyPreset = (l, q) => { olaylar.push('preset:' + l + (q ? '' : ':KAYIT')); sb.state.level = l; sb.state.custom = false; };
  sb.setScope = (s, q) => { olaylar.push('scope:' + s + (q ? '' : ':KAYIT')); sb.kapsam = s; };
  sb.scopeValue = () => sb.kapsam || 'sequence';
  sb.setMod = (m) => { olaylar.push('mod:' + m); sb.state.mod = m; };
  sb.log = () => {};
  sb.yetkiler = ['silence', 'claude'];   /* Pro */
  sb.yetkiVarMi = (ad) => sb.yetkiler.includes(ad);
  sb.sessizlikYok = false;
  sb.analyze = () => {
    if (sb.state.busy) return;
    olaylar.push('analyze');
    sb.state.ranges = [];
    sb.state.busy = true;
    setTimeout(() => {
      if (sb.sessizlikYok) { durumYaz('No silence found', 'warn'); }
      else {
        sb.state.ranges = [[1, 2], [3, 4.5]];
        sb.state.totalCut = 2.5; sb.state.clipSpan = 60;
        durumYaz('Analysis done - ready to cut', 'good');
      }
      sb.state.busy = false;
    }, 400);
  };
  sb.cut = () => {
    if (sb.state.busy || !sb.state.ranges.length) return;
    olaylar.push('cut:' + el.mode.value);
    sb.state.busy = true;
    setTimeout(() => {
      sb.state.backup = { cutName: 'Röportaj — CherryTake Cut 01', origName: 'Röportaj' };
      sb.state.ranges = [];
      durumYaz('2 silences cut', 'good');
      sb.state.busy = false;
    }, 300);
  };
  sb.undoLastCut = () => {
    olaylar.push('undo');
    sb.state.busy = true;
    setTimeout(() => { sb.state.backup = null; durumYaz('Cut undone', 'good'); sb.state.busy = false; }, 200);
  };

  vm.createContext(sb);
  /* Panelin kopyası henüz "claude" adını tanımıyorsa bile zincir bu deponun kopyasıyla sınanır;
     kopyaların eşitliğini ortak-esit.sh denetler. */
  vm.runInContext(fs.readFileSync(path.join(KOK, 'src', 'cherrytake-bus.cjs'), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(PANEL, 'js', 'kutuphane.js'), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(PANEL, 'js', 'claude-kopru.js'), 'utf8'), sb);
  sb.pyKutuphane.baslat({
    bus: sb.cherrytakeBus,
    evalHost: (betik, cb) => cb({ ok: true, sequence: sb.sekansAdi || 'Röportaj', fps: 25, tpf: 10160640000 }),
    yetkiVarMi: () => true,
    log: () => {}
  });
  return { sb, olaylar, el };
}

/* ---------- MCP istemcisi ---------- */

function sunucuBaslat() {
  const cp = spawn(process.execPath, [path.join(KOK, 'src', 'sunucu.cjs')], {
    env: Object.assign({}, process.env, { CHERRYTAKE_SHARED_DIR: PAYLASILAN }),
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let tampon = '', sira = 1;
  const bekleyen = new Map();
  const bildirimler = [];
  const kirli = [];
  cp.stdout.setEncoding('utf8');
  cp.stdout.on('data', d => {
    tampon += d;
    let i;
    while ((i = tampon.indexOf('\n')) >= 0) {
      const s = tampon.slice(0, i); tampon = tampon.slice(i + 1);
      let m; try { m = JSON.parse(s); } catch (e) { kirli.push(s); continue; }
      if (m.id !== undefined && bekleyen.has(m.id)) { bekleyen.get(m.id)(m); bekleyen.delete(m.id); }
      else bildirimler.push(m);
    }
  });
  cp.stderr.on('data', () => {});
  const iste = (method, params) => new Promise(coz => {
    const id = sira++;
    bekleyen.set(id, coz);
    cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const bildir = (method, params) => cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  return { cp, iste, bildir, bildirimler, kirli };
}

const metin = r => (r.result && r.result.content && r.result.content[0].text) || '';

(async () => {
  const S = sunucuBaslat();

  /* 1) el sıkışma */
  const ini = await S.iste('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  check('initialize sürümü geri verir', ini.result && ini.result.protocolVersion === '2025-06-18');
  check('initialize araç yeteneği bildirir', ini.result && ini.result.capabilities && ini.result.capabilities.tools);
  S.bildir('notifications/initialized');

  const liste = await S.iste('tools/list', {});
  const adlar = (liste.result.tools || []).map(t => t.name).sort();
  check('altı araç listelenir', JSON.stringify(adlar) === JSON.stringify(['analyze_silences', 'cut_silences', 'place_note_markers', 'premiere_status', 'propose_note_markers', 'undo_last_cut']), adlar.join(','));
  check('her araçta title ve dizinin istediği işaret var',
    liste.result.tools.every(t => t.annotations && t.annotations.title &&
      (t.annotations.readOnlyHint === true || t.annotations.destructiveHint === true)),
    JSON.stringify(liste.result.tools.map(t => t.annotations)));
  check('bilinmeyen yöntem -32601', (await S.iste('bogus/method', {})).error.code === -32601);

  /* 2) panel kapalıyken */
  const kapali = await S.iste('tools/call', { name: 'premiere_status', arguments: {} });
  check('panel kapalıyken isError', kapali.result.isError === true);
  check('panel kapalıyken yol gösterir', /not open/i.test(metin(kapali)), metin(kapali));

  /* 3) panel açık */
  const P = panelKur();
  await bekle(100);

  const dur = await S.iste('tools/call', { name: 'premiere_status', arguments: {} });
  check('durum başarılı', !dur.result.isError, metin(dur));
  check('durum sekans adını verir', /Röportaj/.test(metin(dur)), metin(dur));
  P.sb.sekansAdi = 'Röportaj (CherryTake)';
  const dur2 = await S.iste('tools/call', { name: 'premiere_status', arguments: {} });
  check('sekans değişince durum yeni adı hemen söyler', /Röportaj \(CherryTake\)/.test(metin(dur2)), metin(dur2));
  P.sb.sekansAdi = null;

  const kesErken = await S.iste('tools/call', { name: 'cut_silences', arguments: {} });
  check('analizsiz kesim reddedilir', kesErken.result.isError && /analysis first/i.test(metin(kesErken)), metin(kesErken));
  check('analizsiz kesimde cut çağrılmaz', !P.olaylar.some(o => o.indexOf('cut') === 0));

  const kotu = await S.iste('tools/call', { name: 'analyze_silences', arguments: { level: 9 } });
  check('geçersiz kademe reddedilir', kotu.result.isError === true);

  const an = await S.iste('tools/call', { name: 'analyze_silences', arguments: { level: 4, scope: 'inout' }, _meta: { progressToken: 'p1' } });
  check('analiz başarılı', !an.result.isError, metin(an));
  check('analiz sayıları doğru', /2 silences, 2\.5 s to cut/.test(metin(an)) && /4% shorter/.test(metin(an)), metin(an));
  check('Silence moduna geçti, kademe ve kapsam kuruldu',
    ['mod:silence', 'preset:4', 'scope:inout', 'analyze'].every(o => P.olaylar.includes(o)), P.olaylar.join(','));
  check('analiz zaman çizgisine dokunmadı', !P.sb.state.backup);

  const kes = await S.iste('tools/call', { name: 'cut_silences', arguments: { mode: 'lift' } });
  check('kesim başarılı', !kes.result.isError, metin(kes));
  check('kesim kipi panele geçti', P.olaylar.includes('cut:lift'));
  check('yeni sekans adını bildirir', /Cut 01/.test(metin(kes)) && /was not changed/.test(metin(kes)), metin(kes));

  const geri = await S.iste('tools/call', { name: 'undo_last_cut', arguments: {} });
  check('geri alma başarılı', !geri.result.isError && P.olaylar.includes('undo'), metin(geri));
  const geri2 = await S.iste('tools/call', { name: 'undo_last_cut', arguments: {} });
  check('ikinci geri alma reddedilir', geri2.result.isError === true, metin(geri2));

  /* varsayılanlar: kullanıcı panelde Very tight + yalnız seçili klipler bırakmış */
  const kullaniciAyari = () => { P.sb.state.level = 5; P.sb.kapsam = 'selection'; P.sb.state.custom = false; };
  const analizEt = async (args) => {
    kullaniciAyari();
    const bas = P.olaylar.length;
    const r = await S.iste('tools/call', { name: 'analyze_silences', arguments: args });
    return { r, ev: P.olaylar.slice(bas) };
  };

  let a = await analizEt({});
  check('parametresiz: level 3 + sequence uygulanır', !a.r.result.isError && P.sb.state.level === 3 && P.sb.scopeValue() === 'sequence',
    a.ev.join(',') + ' | ' + metin(a.r));
  check('parametresiz: sonuç metni Standard/sequence der', /Standard, scope: sequence/.test(metin(a.r)), metin(a.r));

  a = await analizEt({ level: 2 });
  check('yalnız level: level 2 + varsayılan sequence', P.sb.state.level === 2 && P.sb.scopeValue() === 'sequence', a.ev.join(','));

  a = await analizEt({ scope: 'inout' });
  check('yalnız scope: varsayılan level 3 + inout', P.sb.state.level === 3 && P.sb.scopeValue() === 'inout', a.ev.join(','));

  a = await analizEt({ level: 5, scope: 'selection' });
  check('hepsi verildi: aynen uygulanır (değişmeyen ayar yeniden kurulmaz)',
    P.sb.state.level === 5 && P.sb.scopeValue() === 'selection' && !a.ev.some(o => /^(preset|scope):/.test(o)), a.ev.join(','));

  a = await analizEt({ level: 1, scope: 'sequence' });
  check('hepsi verildi: level 1 + sequence', P.sb.state.level === 1 && P.sb.scopeValue() === 'sequence', a.ev.join(','));

  const gecersizKapsam = await analizEt({ scope: 'everything' });
  check('geçersiz scope reddedilir, panel ayarına dokunulmaz',
    gecersizKapsam.r.result.isError && P.sb.state.level === 5 && P.sb.scopeValue() === 'selection' && !gecersizKapsam.ev.length,
    gecersizKapsam.ev.join(',') + ' | ' + metin(gecersizKapsam.r));

  check('Claude hiçbir ayarı panelin kayıtlı ayarına yazmadı (quiet)', !P.olaylar.some(o => /:KAYIT$/.test(o)), P.olaylar.join(','));

  /* eski sunucu (alan göndermeyen) yeni panelle konuşursa: köprü kendisi doldurur */
  const eskiSunucu = (m) => new Promise(coz => { kullaniciAyari(); P.sb.pyClaude.isle(m, coz); });
  let y = await eskiSunucu({ cmd: 'claude.analiz' });
  check('köprü: alan yoksa level 3 + sequence', y.ok && P.sb.state.level === 3 && y.scope === 'sequence', JSON.stringify(y));
  y = await eskiSunucu({ cmd: 'claude.analiz', level: 4 });
  check('köprü: yalnız level', y.ok && P.sb.state.level === 4 && y.scope === 'sequence', JSON.stringify(y));
  y = await eskiSunucu({ cmd: 'claude.analiz', scope: 'inout' });
  check('köprü: yalnız scope', y.ok && P.sb.state.level === 3 && y.scope === 'inout', JSON.stringify(y));
  y = await eskiSunucu({ cmd: 'claude.analiz', level: 9 });
  check('köprü: geçersiz level reddedilir, ayar değişmez', !y.ok && P.sb.state.level === 5 && P.sb.scopeValue() === 'selection', JSON.stringify(y));

  /* cut_silences: kip verilmezse ripple (panelde lift seçili kalmış olsa bile) */
  P.el.mode.value = 'lift';
  await analizEt({});
  const kesV = await S.iste('tools/call', { name: 'cut_silences', arguments: {} });
  check('cut parametresiz: ripple', !kesV.result.isError && P.olaylar[P.olaylar.length - 1] === 'cut:ripple', P.olaylar.slice(-3).join(','));
  await analizEt({});
  P.el.mode.value = 'ripple';
  const kesE = await new Promise(coz => P.sb.pyClaude.isle({ cmd: 'claude.kes' }, coz));
  check('köprü cut: alan yoksa ripple', kesE.ok && kesE.mode === 'ripple', JSON.stringify(kesE));
  P.sb.state.backup = null;

  P.sb.sessizlikYok = true;
  const bos = await S.iste('tools/call', { name: 'analyze_silences', arguments: {} });
  check('sessizlik yoksa hata değil, öneri verir', !bos.result.isError && /No silence/.test(metin(bos)), metin(bos));

  /* meşgulken */
  P.sb.state.busy = true;
  const mesgul = await S.iste('tools/call', { name: 'analyze_silences', arguments: {} });
  check('meşgulken reddedilir', mesgul.result.isError && /busy/i.test(metin(mesgul)), metin(mesgul));
  P.sb.state.busy = false;

  /* lisans: yetki yoksa panel islevleri HIC cagrilmaz */
  P.sb.yetkiler = [];
  const once = P.olaylar.length;
  const kilitA = await S.iste('tools/call', { name: 'analyze_silences', arguments: {} });
  const kilitK = await S.iste('tools/call', { name: 'cut_silences', arguments: {} });
  check('yetkisiz analiz reddedilir', kilitA.result.isError && /plan/i.test(metin(kilitA)), metin(kilitA));
  check('yetkisiz kesim reddedilir', kilitK.result.isError && /plan/i.test(metin(kilitK)), metin(kilitK));
  check('yetkisizken panel işlevi çağrılmadı', P.olaylar.length === once, P.olaylar.slice(once).join(','));
  const kilitD = await S.iste('tools/call', { name: 'premiere_status', arguments: {} });
  check('durum sorgusu lisanssız da çalışır', !kilitD.result.isError, metin(kilitD));

  /* Basic: panelde sessizlik açık ama Claude'dan kullanım yok */
  P.sb.yetkiler = ['silence'];
  const b0 = P.olaylar.length;
  const basicA = await S.iste('tools/call', { name: 'analyze_silences', arguments: {} });
  const basicG = await S.iste('tools/call', { name: 'undo_last_cut', arguments: {} });
  check('Basic: Claude analizi reddedilir, Pro/Studio önerilir', basicA.result.isError && /Pro and Studio/.test(metin(basicA)), metin(basicA));
  check('Basic: Claude geri alması reddedilir', basicG.result.isError && /Pro and Studio/.test(metin(basicG)), metin(basicG));
  check('Basic: panel işlevi çağrılmadı', P.olaylar.length === b0, P.olaylar.slice(b0).join(','));
  check('lisans reddi "Analysis failed:" önekiyle bulanıklaşmaz', /^Using CherryTake from Claude/.test(metin(basicA)), metin(basicA));
  const basicD = await S.iste('tools/call', { name: 'premiere_status', arguments: {} });
  check('Basic: durum lisansın Claude kullanımını içermediğini söyler', /Licence: does not include CherryTake from Claude/.test(metin(basicD)), metin(basicD));
  P.sb.yetkiler = ['silence', 'claude'];

  const durumPro = await S.iste('tools/call', { name: 'premiere_status', arguments: {} });
  check('Pro (notes yok): durum Notes\'un dahil olmadığını söyler', /Licence: includes CherryTake from Claude \(Notes not included\)/.test(metin(durumPro)), metin(durumPro));
  const kotuKip = await S.iste('tools/call', { name: 'cut_silences', arguments: { mode: 'shred' } });
  check('geçersiz kesim kipi sunucuda reddedilir', kotuKip.result.isError && /mode must be one of/.test(metin(kotuKip)), metin(kotuKip));
  check('panel kapalı metni doğru menü adını verir', /Window > Extensions > CherryTake Core/.test(metin(kapali)), metin(kapali));

  check('stdout yalnız JSON-RPC', S.kirli.length === 0, S.kirli.join(' | '));

  S.cp.stdin.end();
  P.sb.pyKutuphane.durdur();
  fs.rmSync(PAYLASILAN, { recursive: true, force: true });
  console.log(fail ? '\n' + fail + ' HATA' : '\nHepsi geçti.');
  process.exit(fail ? 1 : 0);
})();
