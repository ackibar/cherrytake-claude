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

Panel tarafı: `~/Documents/pyEdit-kaynak/js/claude-kopru.js`. Claude komutları panelin kendi
düğme işlevlerini (`analyze`, `cut`, `undoLastCut`) çağırır, yani elle kesimle aynı kod yolu.

## Kurulum (Claude Code)

    claude mcp add cherrytake -- node ~/cherrytake-claude/src/sunucu.cjs

## Kurulum (Claude Desktop)

`dist/cherrytake-<sürüm>.mcpb` dosyasına çift tıkla. Claude Desktop kendi Node'unu kullanır, PATH gerekmez.

Paketi yeniden üretmek (sürümü `manifest.json` ve `src/sunucu.cjs` içindeki `SURUM`'da birlikte artır):

    npx @anthropic-ai/mcpb validate manifest.json
    npx @anthropic-ai/mcpb pack . dist/cherrytake-$(node -p "require('./manifest.json').version").mcpb

`manifest.json` içindeki `tools` listesi `ARACLAR` ile aynı adları taşımalı. `test/` ve `dist/` pakete girmez (`.mcpbignore`).

## Test

    node test/test-zincir.cjs

Premiere gerekmez: sunucuyu gerçek süreç olarak açar, panelin gerçek `kutuphane.js` +
`claude-kopru.js` dosyalarını sahte panel işlevleriyle çalıştırır.

## Ortak dosya

`src/cherrytake-bus.cjs` diğer dört depodaki kopyayla birebir aynı olmalı
(`~/editflow-launcher/araclar/ortak-esit.sh`). Bu kopyada uygulama listesine `claude` eklendi.
