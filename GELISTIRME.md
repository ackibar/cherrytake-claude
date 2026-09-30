# CherryTake for Claude — geliştirici notları

Claude'un CherryTake Premiere paneline komut vermesini sağlayan MCP sunucusu (stdio).
Sıfır bağımlılık, ağ yok: komutlar ortak veri yolundan (`~/Library/Application Support/CherryTake/bus/`)
panele gider, yanıt `bus/claude/` kutusundan döner.

## Araçlar

| Araç | Ne yapar |
|---|---|
| `premiere_status` | Panel açık mı, aktif sekans, kademe, geri alınabilir kesim var mı |
| `analyze_silences` | Sessizlik analizi (kademe 1-5, kapsam). Zaman çizgisine dokunmaz |
| `cut_silences` | Son analizi keser (ripple / lift / marker). Kesim KOPYA sekansta yapılır |
| `undo_last_cut` | Orijinal sekansı açar; kesim kopyası projede kalır, hiçbir şey silinmez |
| `propose_note_markers` | Notes: notları ayırır, panelin yerel eşleşme motoruyla aday + gerekçe döndürür. Zaman çizgisine dokunmaz |
| `place_note_markers` | Yalnız kullanıcının onayladığı (not, aday) çiftlerini işaretçiye yazar (`user_confirmed: true` şart) |

Notes kuralı (notes-belirsizlik-kurali): aday listesinde olmayan zaman ve "yer bulunamadı" notu yazılamaz;
sekans öneriden sonra değiştiyse yazılmaz; aynı not iki kez yazılmaz. İşaretçi biçimi panelin
`notlariIsaretciyeYaz`'ı ile birebir aynı (`[efn]` damgası; test bunu gerçek main.js ile karşılaştırır).

İşaretçiyi bu depo DEĞİL, panelin `claude-kopru.js`'indeki `isaretciKur` kurar; sunucu yalnız
(not, aday) çiftini iletir. Bu yüzden main.js'te biçim değişince düzeltme panel dosyasına gider.
30 Eyl: Notes v2 ile main.js işaretçiye `id` alanı ve comments sonuna `\n[efn-id:<id>]` ekledi.
Kimlik `notAnahtarUret`: `(gonderen|metin)` küçük harf + boşluk tekleme → djb2-xor (`h*33 ^ c`, 5381,
>>>0) → `'n' + base36`; aynı listede çakışırsa `-2`, `-3`. Aynı nottan hep aynı kimlik çıkar. İsim başına
`notEylemEtiketi(r)` (yalnız Beta açıkken, `[Renk, Kes]` gibi) da ekleniyor. `claude-kopru.js` henüz
eski biçimde → `notlar-gercek-panel.test.cjs` düşer; panele uygulanacak yama: `id` + `[efn-id]` +
eylem etiketi, kimlik öneri sırasıyla `g('notAnahtarUret')` ile (yoksa aynı algoritmanın kopyası).
Yamalı panel kopyasıyla (`CHERRYTAKE_PANEL=<kopya> npm test`) 33/33 + zincir geçti.
Yetki: `claude` + `notes` birlikte. Panelin yapay zeka adımı (notlar-ai.js) Claude yolunda kullanılmaz.

Panel tarafı: `~/Documents/pyEdit-kaynak/js/claude-kopru.js`. Claude komutları panelin kendi
düğme işlevlerini (`analyze`, `cut`, `undoLastCut`) çağırır, yani elle kesimle aynı kod yolu.

## Kurulum (Claude Code)

    claude mcp add cherrytake -- node ~/cherrytake-claude/src/sunucu.cjs

## Kurulum (Claude Desktop)

`dist/cherrytake-<sürüm>.mcpb` dosyasına çift tıkla. Claude Desktop kendi Node'unu kullanır, PATH gerekmez.

Paketi yeniden üretmek (sürümü `manifest.json`, `.claude-plugin/plugin.json`, `package.json` ve
`src/sunucu.cjs` içindeki `SURUM`'da birlikte artır):

    npm run pack        # -> dist/cherrytake.mcpb

`araclar/paketle.cjs` önce tutarlılığı denetler (dört sürüm aynı mı, manifest `tools` adları sunucunun
`tools/list`'iyle aynı mı; `test/paket.test.cjs` de aynısını ağsız sınar), sonra resmi CLI ile
(`npx @anthropic-ai/mcpb@2.1.2 validate` + `pack`) paketler. İlk çalıştırmada ağ gerekir; npm önbelleği
geçici klasöre yönlenir (~/.npm'deki root sahipli dosyalar yüzünden). `test/`, `dist/`, `araclar/`,
`package.json` pakete girmez (`.mcpbignore`). Manifest şeması: MCPB 0.3 (CLI 2.1.2'de "latest" = 0.3).

## Test

    npm test            # test-zincir.cjs + test/*.test.cjs

Panel yolu `CHERRYTAKE_PANEL` ile değiştirilebilir (varsayılan `~/Documents/pyEdit-kaynak`).
Premiere gerekmez: sunucuyu gerçek süreç olarak açar, panelin gerçek `kutuphane.js` +
`claude-kopru.js` dosyalarını sahte panel işlevleriyle çalıştırır.

## Ortak dosya

`src/cherrytake-bus.cjs` diğer dört depodaki kopyayla birebir aynı olmalı
(`~/editflow-launcher/araclar/ortak-esit.sh`). Bu kopyada uygulama listesine `claude` eklendi.

## ChatGPT masaüstü / Codex (30 Eyl)

Aynı sunucu. `.codex-plugin/plugin.json` + `.codex-mcp.json` (Claude'un `.mcp.json`'u `${CLAUDE_PLUGIN_ROOT}`
kullandığı için ayrı dosya; `mcpServers` alanı yolu gösteriyor) + `.agents/plugins/marketplace.json`
(depo kökü yerel pazar). Başlatıcı `bin/cherrytake-mcp`: ChatGPT.app içindeki `cua_node` (v24) → sistem node.
Yazan araçlar `approval_mode = "prompt"`; `araclar/tutarlilik.cjs` bunu ve beşinci sürümü denetler.
Doğrulama modelsiz ve ücretsiz: `codex app-server` (stdio JSON-RPC) → `initialize` → `mcpServerStatus/list`
(`serverName`) ve `thread/start {ephemeral:true}` → `mcpServer/tool/call`. Eklentiyi denemek için geçici
`CODEX_HOME` ile `codex plugin marketplace add <depo>` + `codex plugin add cherrytake@cherrytake`.
codex yolu: `/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex`.
