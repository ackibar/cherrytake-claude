#!/usr/bin/env node
/*
 * CherryTake for Claude - MCP sunucusu (stdio).
 *
 * Claude'un araç çağrılarını CherryTake Premiere paneline iletir. Premiere'e
 * doğrudan dokunmaz: komutu ortak veri yolunun "premiere" kutusuna yazar,
 * panelin yanıtını bu sürecin kendi yanıt kutusundan okur (bkz. aşağıda
 * "yanıt adreslemesi" ve cherrytake-bus.cjs).
 * Ağ yok, port yok, bağımlılık yok - Library ve Circle ile aynı söz.
 *
 * MCP iletisi: satır başına bir JSON-RPC 2.0 iletisi, stdin/stdout.
 * stdout yalnız protokole ayrılır; günlük stderr'e yazılır.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const bus = require('./cherrytake-bus.cjs');

const AD = 'cherrytake';
const SURUM = '0.1.0';
const BEN = 'claude';
/* Ortam değişkenleri yalnız testler içindir (zaman aşımını kısaltmak). */
function msOrtam(ad, varsayilan) {
  const n = parseInt(process.env[ad], 10);
  return n > 0 ? n : varsayilan;
}
const YANIT_SINIRI = {
  kisa: msOrtam('CHERRYTAKE_CLAUDE_KISA_MS', 15000),
  uzun: msOrtam('CHERRYTAKE_CLAUDE_UZUN_MS', 11 * 60 * 1000)
};
const ILERLEME_ARALIK = 5000;

const KADEMELER = { 1: 'Very gentle', 2: 'Gentle', 3: 'Standard', 4: 'Tight', 5: 'Very tight' };
const KAPSAMLAR = ['sequence', 'selection', 'inout'];
/* Araç açıklamalarında yazan varsayılanlar; ARACLAR metinleriyle birlikte değiştirin. */
const VARSAYILAN = { level: 3, scope: 'sequence', mode: 'ripple' };

/* Anthropic dizini her araçta title + readOnlyHint ya da destructiveHint ister. Kesim ve geri alma
   hiçbir şey silmez ama projeyi/aktif sekansı değiştirir; destructiveHint Claude'un her çağrıda onay sormasını sağlar. */
const ARACLAR = [
  {
    name: 'premiere_status',
    description:
      'Check whether Adobe Premiere Pro is open with the CherryTake panel, and report the active sequence, ' +
      'the current cut strength, whether an analysis is ready and whether the last cut can be undone. ' +
      'Call this first when unsure about the state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Premiere status', readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'analyze_silences',
    description:
      'Analyze the active Premiere sequence for silent pauses with CherryTake. Does NOT change the timeline. ' +
      'Returns how many silences were found, how many seconds would be cut and how much shorter the edit gets. ' +
      'Show this result to the user and ask before calling cut_silences. ' +
      'Cut strength levels: 1 Very gentle (only long pauses), 2 Gentle, 3 Standard (recommended default), ' +
      '4 Tight, 5 Very tight (removes almost every pause). If the user does not name a strength, use 3.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'integer', minimum: 1, maximum: 5, description: 'Cut strength 1-5. Default 3 (Standard).' },
        scope: {
          type: 'string', enum: ['sequence', 'selection', 'inout'],
          description: 'sequence = whole sequence (default), selection = only selected clips, inout = only between In and Out points.'
        }
      },
      additionalProperties: false
    },
    annotations: { title: 'Analyze silences', readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  },
  {
    name: 'cut_silences',
    description:
      'Cut the silences found by the last analyze_silences call. Only call this after the user has seen the ' +
      'analysis result and agreed. The cut is made on a NEW copy of the sequence; the original sequence is not ' +
      'changed. mode: ripple = cut and close gaps (default), lift = cut and leave gaps, marker = only add markers.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['ripple', 'lift', 'marker'], description: 'Default ripple.' }
      },
      additionalProperties: false
    },
    annotations: { title: 'Cut silences', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  {
    name: 'undo_last_cut',
    description:
      'Undo the last CherryTake cut: reopens the original sequence. The cut copy stays in the project; nothing is deleted. ' +
      'Ask the user for confirmation first. Works only while the cut sequence is unchanged since the cut.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Undo last cut', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  }
];

const TALIMAT =
  'CherryTake edits the video open in Adobe Premiere Pro through the CherryTake panel. ' +
  'Typical flow: premiere_status -> analyze_silences -> show the numbers to the user -> ' +
  'cut_silences only after they agree. Cuts go to a copy of the sequence, so the original is always kept.';

/* ---------- günlük ---------- */

function gunluk(...p) { try { process.stderr.write('[cherrytake] ' + p.join(' ') + '\n'); } catch (e) {} }

/* ---------- JSON-RPC çıkışı ---------- */

function gonder(ileti) { process.stdout.write(JSON.stringify(ileti) + '\n'); }
function sonuc(id, result) { gonder({ jsonrpc: '2.0', id, result }); }
function hata(id, code, message) { gonder({ jsonrpc: '2.0', id, error: { code, message } }); }

function metinSonuc(metin, hataMi) {
  return { content: [{ type: 'text', text: metin }], isError: !!hataMi };
}

/* ---------- veri yolu: komut gönder, yanıtı bekle ---------- */

/*
 * Yanıt adreslemesi (hata 14).
 *
 * Eskiden yanıtlar ortak "claude" kutusundan bus.watch ile okunuyordu. bus.watch
 * kutudaki HER dosyayı sahiplenip siler; iki Claude bağlantısı (iki sunucu
 * süreci) aynı anda çalışınca önce tarayan ötekinin yanıtını da yutuyor, öteki
 * komut uygulanmış olsa bile zaman aşımına düşüyordu.
 *
 * Şimdi her süreç komuta kendi yanıt kutusunun adını koyar (replyBox:
 * "yanit-<pid>-<rnd>", klasörü bus/claude/<ad>/). Yeni panel yanıtı oraya
 * yazar. Alanın adı replyTo değil: bus protokolünde replyTo "hangi komutun
 * yanıtı" demek (komut kimliği), anlamını değiştirmek eski sürümleri bozardı.
 *
 * Uyumluluk:
 *  - Eski panel replyBox'u tanımaz, ortak "claude" kutusuna yazar. Ortak kutu
 *    bus.watch ile DEĞİL, elle taranır: yalnız replyTo'su bu sürecin bekleyen
 *    komutu olan dosya sahiplenilir; başkasınınkine dokunulmaz (yalnız bus'ın
 *    kendi kuralıyla bayatlayan, KOMUT_OMRU'dan eski dosyalar silinir).
 *  - Eski sunucu replyBox göndermez; yeni panel ortak kutuya yazar.
 *  - Alt kutular "claude" kutusunun içinde klasör olduğu için eski sunucuların
 *    bus.watch taraması onları görmez (yalnız *.json dosyalarını işler).
 *
 * Temizlik: alt kutu yalnız bekleyen istek varken durur; son istek bitince
 * ya da zaman aşımına düşünce silinir. Panel olmayan kutuyu yeniden kurmaz,
 * yanıtı atar - geç gelen yanıt hiçbir yerde kalmaz. Süreç çıkarken kutusunu
 * siler; çöken (ölü pid) süreçlerin kutularını sonraki süreç temizler. Eski
 * panelin ortak kutuya geç düşen yanıtı, kimliği "geç kalanlar" listesinde
 * olduğu için tanınıp silinir.
 */

const KUTU_ONEKI = 'yanit-';
const OTURUM = KUTU_ONEKI + process.pid + '-' + Math.random().toString(36).slice(2, 10);
const TARA_ARALIK = 250;
const DOKUN_ARALIK = 30000;             /* canlı kutunun mtime'ı tazelenir */
const SAHIPSIZ_OMRU = 15 * 60 * 1000;   /* canlı pid'li ama bu kadar dokunulmamış kutu da sahipsiz */

const bekleyenler = new Map();   /* komut id -> { coz, zaman } */
const gecKalanlar = new Map();   /* zaman aşımına düşen komut id -> bu tarihe kadar hatırla */
let taraZaman = null;
let sonDokunus = 0;

function ortakKutu() { return bus.busDir(BEN); }
function ozelKutu() { return path.join(ortakKutu(), OTURUM); }

function kutuyuSil(dizin) {
  try { fs.rmSync(dizin, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); } catch (e) {}
}

function pidYasiyorMu(pid) {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return !(e && e.code === 'ESRCH'); }
}

/* Çöken süreçlerden kalan alt kutular */
function sahipsizleriSil() {
  let adlar;
  try { adlar = fs.readdirSync(ortakKutu()); } catch (e) { return; }
  for (const ad of adlar) {
    if (ad === OTURUM || ad.indexOf(KUTU_ONEKI) !== 0) continue;
    const tam = path.join(ortakKutu(), ad);
    let st;
    try { st = fs.statSync(tam); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    const pid = parseInt(ad.slice(KUTU_ONEKI.length), 10);
    if (!pidYasiyorMu(pid) || Date.now() - st.mtimeMs > SAHIPSIZ_OMRU) kutuyuSil(tam);
  }
}

function okuJson(yol) {
  try { return JSON.parse(fs.readFileSync(yol, 'utf8')); } catch (e) { return null; }
}

function teslimEt(mesaj) {
  const b = bekleyenler.get(mesaj.replyTo);
  if (!b) return false;
  bekleyenler.delete(mesaj.replyTo);
  clearTimeout(b.zaman);
  b.coz(mesaj);
  return true;
}

/* Kendi kutumuz: içindeki her şey bizim. Bekleyene aitse teslim, değilse (geç yanıt) at. */
function ozelKutuyuTara() {
  const dizin = ozelKutu();
  let adlar;
  try { adlar = fs.readdirSync(dizin); } catch (e) { return; }
  adlar.sort();
  for (const ad of adlar) {
    const tam = path.join(dizin, ad);
    if (ad.slice(-5) !== '.json') {
      /* panelin yarım bıraktığı .tmp */
      try { if (Date.now() - fs.statSync(tam).mtimeMs > bus.KOMUT_OMRU) fs.unlinkSync(tam); } catch (e) {}
      continue;
    }
    const mesaj = okuJson(tam);
    try { fs.unlinkSync(tam); } catch (e) {}
    if (mesaj && mesaj.replyTo !== undefined) teslimEt(mesaj);
  }
}

/* Ortak kutu (eski panel): yalnız kendi kimliklerimizi al, başkasınınkini bırak. */
function ortakKutuyuTara() {
  const dizin = ortakKutu();
  let adlar;
  try { adlar = fs.readdirSync(dizin); } catch (e) { return; }
  adlar.sort();
  for (const ad of adlar) {
    if (ad.slice(-5) !== '.json') continue;   /* alt kutular, .busy, .tmp: bizim değil */
    const tam = path.join(dizin, ad);
    const mesaj = okuJson(tam);
    const kimlik = mesaj && mesaj.replyTo;
    if (kimlik !== undefined && bekleyenler.has(kimlik)) {
      const benim = tam + '.busy';
      try { fs.renameSync(tam, benim); } catch (e) { continue; }
      try { fs.unlinkSync(benim); } catch (e) {}
      teslimEt(mesaj);
    } else if (kimlik !== undefined && gecKalanlar.has(kimlik)) {
      try { fs.unlinkSync(tam); } catch (e) {}
      gecKalanlar.delete(kimlik);
    } else {
      /* bus'ın kendi bayat kuralı: KOMUT_OMRU'dan eski dosyayı kimse beklemiyor */
      try { if (Date.now() - fs.statSync(tam).mtimeMs > bus.KOMUT_OMRU) fs.unlinkSync(tam); } catch (e) {}
    }
  }
}

function tara() {
  const simdi = Date.now();
  for (const [kimlik, son] of gecKalanlar) if (son < simdi) gecKalanlar.delete(kimlik);
  if (bekleyenler.size) {
    ozelKutuyuTara();
    if (simdi - sonDokunus > DOKUN_ARALIK) {
      sonDokunus = simdi;
      try { fs.utimesSync(ozelKutu(), simdi / 1000, simdi / 1000); } catch (e) {}
    }
  }
  ortakKutuyuTara();
  toparla();
}

/* Bekleyen kalmadıysa alt kutuyu sil; geç kalan da yoksa taramayı durdur. */
function toparla() {
  if (bekleyenler.size) return;
  kutuyuSil(ozelKutu());
  if (!gecKalanlar.size && taraZaman) { clearInterval(taraZaman); taraZaman = null; }
}

function taramayiBaslat() {
  if (taraZaman) return;
  taraZaman = setInterval(tara, TARA_ARALIK);
  if (typeof taraZaman.unref === 'function') taraZaman.unref();
}

function cikista() {
  if (taraZaman) { clearInterval(taraZaman); taraZaman = null; }
  kutuyuSil(ozelKutu());
}
process.on('exit', cikista);
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGHUP', () => process.exit(0));

function panelAcikMi() {
  try { return bus.alive('premiere'); } catch (e) { return false; }
}

function panelKapaliMetni() {
  return 'Premiere Pro is not open with the CherryTake panel. Open Premiere, open a sequence and open ' +
    'Window > Extensions > CherryTake, then try again.';
}

function panelaSor(komut, sinir, ilerleme) {
  return new Promise((coz) => {
    let id;
    try {
      /* Kutu komuttan ÖNCE kurulur: panel olmayan kutuya yazmaz, yanıtı atar. */
      if (!bekleyenler.size) sahipsizleriSil();
      fs.mkdirSync(ozelKutu(), { recursive: true });
      sonDokunus = Date.now();
      id = bus.send('premiere', Object.assign({}, komut, { replyBox: OTURUM }), { from: BEN });
    } catch (e) {
      toparla();
      coz({ ok: false, error: 'Could not reach the panel: ' + e.message });
      return;
    }
    let sayac = null;
    if (ilerleme) {
      let adim = 0;
      sayac = setInterval(() => ilerleme(++adim), ILERLEME_ARALIK);
    }
    const bitir = (m) => { if (sayac) clearInterval(sayac); coz(m); };
    const zaman = setTimeout(() => {
      bekleyenler.delete(id);
      /* eski panelin ortak kutuya geç yazacağı yanıtı tanıyıp silmek için */
      gecKalanlar.set(id, Date.now() + YANIT_SINIRI.uzun);
      toparla();
      bitir({ ok: false, error: 'The CherryTake panel did not answer. Is the panel open in Premiere?' });
    }, sinir);
    bekleyenler.set(id, { coz: bitir, zaman });
    taramayiBaslat();
    tara();
  });
}

/* ---------- araçlar ---------- */

function sn(x) {
  x = Number(x) || 0;
  if (x < 60) return x.toFixed(1) + ' s';
  const d = Math.floor(x / 60), s = Math.round(x - d * 60);
  return d + ' min ' + s + ' s';
}

async function aracCalistir(ad, arg, ilerleme) {
  arg = arg || {};
  if (!panelAcikMi()) return metinSonuc(panelKapaliMetni(), true);

  if (ad === 'premiere_status') {
    const r = await panelaSor({ cmd: 'claude.durum' }, YANIT_SINIRI.kisa);
    if (!r.ok) return metinSonuc(r.error || 'The panel did not answer.', true);
    return metinSonuc([
      'Premiere is open with the CherryTake panel.',
      'Active sequence: ' + (r.sequence || 'none'),
      'Cut strength: ' + (r.levelName || '-') + (r.level ? ' (level ' + r.level + ')' : ''),
      'Analysis ready: ' + (r.analysed ? r.analysed + ' silences waiting to be cut' : 'no'),
      'Last cut can be undone: ' + (r.canUndo ? 'yes' : 'no'),
      'Panel is ' + (r.busy ? 'busy' : 'idle') + (r.status ? ' - "' + r.status + '"' : '')
    ].join('\n'));
  }

  if (ad === 'analyze_silences') {
    /* Açıklamadaki varsayılanlar burada doldurulur (level 3, scope sequence):
       alan boş giderse eski paneller o an seçili ayarı kullanıyordu. */
    const l = (arg.level === undefined || arg.level === null) ? VARSAYILAN.level : parseInt(arg.level, 10);
    if (!KADEMELER[l]) return metinSonuc('level must be between 1 and 5.', true);
    const kapsam = (arg.scope === undefined || arg.scope === null) ? VARSAYILAN.scope : String(arg.scope);
    if (!KAPSAMLAR.includes(kapsam)) return metinSonuc('scope must be one of: ' + KAPSAMLAR.join(', ') + '.', true);
    const komut = { cmd: 'claude.analiz', level: l, scope: kapsam };
    const r = await panelaSor(komut, YANIT_SINIRI.uzun, ilerleme);
    if (!r.ok) return metinSonuc('Analysis failed: ' + (r.error || r.status || 'unknown error'), true);
    if (!r.silences) {
      return metinSonuc('No silence to cut was found in "' + (r.sequence || 'the sequence') + '" at ' +
        (r.levelName || 'this') + ' strength. A higher level (4 or 5) finds shorter pauses.');
    }
    return metinSonuc([
      'Analysis of "' + (r.sequence || 'the sequence') + '" (' + (r.levelName || '') + ', scope: ' + (r.scope || 'sequence') + '):',
      r.silences + ' silences, ' + sn(r.cutSeconds) + ' to cut.',
      'Length: ' + sn(r.lengthSeconds) + ' -> ' + sn(Math.max(0, r.lengthSeconds - r.cutSeconds)) +
        ' (' + r.shorterPercent + '% shorter).',
      'Nothing was changed yet. Ask the user before calling cut_silences.'
    ].join('\n'));
  }

  if (ad === 'cut_silences') {
    const komut = { cmd: 'claude.kes', mode: (arg.mode === undefined || arg.mode === null) ? VARSAYILAN.mode : arg.mode };
    const r = await panelaSor(komut, YANIT_SINIRI.uzun, ilerleme);
    if (!r.ok) return metinSonuc('Cut failed: ' + (r.error || r.status || 'unknown error'), true);
    if (r.mode === 'marker') return metinSonuc('Markers added. ' + (r.status || ''));
    return metinSonuc([
      (r.status || 'Cut done.'),
      r.cutSequence ? 'The cut is in the new sequence "' + r.cutSequence + '".' : '',
      r.originalSequence ? 'The original "' + r.originalSequence + '" was not changed.' : ''
    ].filter(Boolean).join('\n'));
  }

  if (ad === 'undo_last_cut') {
    const r = await panelaSor({ cmd: 'claude.geri' }, YANIT_SINIRI.uzun, ilerleme);
    if (!r.ok) return metinSonuc('Undo failed: ' + (r.error || r.status || 'unknown error'), true);
    /* panel kopyayi artik silmiyor (keptSequence); eski panel removedSequence yollar */
    if (r.removedSequence && !r.keptSequence) {
      return metinSonuc('Undone. "' + r.removedSequence + '" was deleted and "' +
        (r.reopenedSequence || 'the original') + '" is open again.');
    }
    return metinSonuc('Undone. "' + (r.reopenedSequence || 'The original sequence') + '" is open again. ' +
      'The cut copy' + (r.keptSequence ? ' "' + r.keptSequence + '"' : '') + ' stays in the project; nothing was deleted.');
  }

  return null;
}

/* ---------- MCP yöntemleri ---------- */

async function isle(ileti) {
  const { id, method, params } = ileti;
  const bildirimMi = (id === undefined || id === null);

  if (method === 'initialize') {
    const istenen = params && params.protocolVersion;
    return sonuc(id, {
      protocolVersion: istenen || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: AD, title: 'CherryTake for Premiere Pro', version: SURUM },
      instructions: TALIMAT
    });
  }
  if (bildirimMi) return;   /* notifications/initialized, cancelled vb. */
  if (method === 'ping') return sonuc(id, {});
  if (method === 'tools/list') return sonuc(id, { tools: ARACLAR });
  if (method === 'tools/call') {
    const ad = params && params.name;
    const jeton = params && params._meta && params._meta.progressToken;
    const ilerleme = (jeton !== undefined) ? (adim) => gonder({
      jsonrpc: '2.0', method: 'notifications/progress',
      params: { progressToken: jeton, progress: adim, message: 'CherryTake is working in Premiere...' }
    }) : null;
    try {
      const r = await aracCalistir(ad, params && params.arguments, ilerleme);
      if (!r) return hata(id, -32602, 'Unknown tool: ' + ad);
      return sonuc(id, r);
    } catch (e) {
      return sonuc(id, metinSonuc('CherryTake error: ' + e.message, true));
    }
  }
  return hata(id, -32601, 'Method not found: ' + method);
}

/* ---------- stdin ---------- */

let tampon = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (parca) => {
  tampon += parca;
  let i;
  while ((i = tampon.indexOf('\n')) >= 0) {
    const satir = tampon.slice(0, i).trim();
    tampon = tampon.slice(i + 1);
    if (!satir) continue;
    let ileti;
    try { ileti = JSON.parse(satir); }
    catch (e) { hata(null, -32700, 'Parse error'); continue; }
    isle(ileti).catch((e) => gunluk('işlenemedi:', e.message));
  }
});
process.stdin.on('end', () => process.exit(0));   /* 'exit' dinleyicisi alt kutuyu siler */
gunluk('hazır, ortak klasör:', bus.sharedDir());
