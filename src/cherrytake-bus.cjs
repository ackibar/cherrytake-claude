/*
 * CherryTake ortak veri yolu (posta kutusu)
 *
 * Uc uygulama - Premiere paneli (CEP), CherryTake Circle ve CherryTake Library -
 * birbirine paylasilan bir klasordeki dosyalarla haber verir. Soket, port ya
 * da ag istegi yok: hicbir bagimlilik gerekmiyor, baslama sirasi onemsiz,
 * Circle'in "ag yok" sozu bozulmuyor ve CEP'in DevTools portlariyla (8088/
 * 8089) cakisma olmuyor.
 *
 *   <kok>/presence/<uygulama>.json   kalp atisi (kim acik)
 *   <kok>/bus/<hedef>/<ts>-<rnd>.json  komut dosyalari
 *
 * BU DOSYA BES DEPODA BIREBIR AYNIDIR (~/editflow-launcher/araclar/ortak-esit.sh dogrular).
 * Bu yuzden ES5 yazildi: CEP'in eski motoru da, Electron da, Node da okur.
 */
(function (root) {
    var fs = require('fs');
    var path = require('path');
    var os = require('os');

    var SURUM = 1;
    var UYGULAMALAR = { premiere: 1, circle: 1, library: 1, launcher: 1, claude: 1 };
    var KALP_ARALIK = 5000;      /* kalp atisi periyodu */
    var KALP_TOLERANS = 15000;   /* bu kadar eski kalp atisi "kapali" sayilir */
    var KOMUT_OMRU = 60000;      /* bayat komut: Premiere kapanip acilinca gec yerlesmesin */
    var TARAMA_ARALIK = 1500;    /* fs.watch kacirirsa diye yedek tarama */
    var YENIDEN_KUR = 10000;     /* bozulan fs.watch'i yeniden kurmayi deneme araligi */
    var EN_BUYUK_KOMUT = 2097152; /* 2 MB: daha buyuk komut dosyasi okunmaz, atilir */

    /* ---------- klasorler ---------- */

    /*
     * Paylasilan kok. Testler CHERRYTAKE_SHARED_DIR ile baska bir yere alabilir;
     * uc uygulama da ayni degiskene bakar, boylece tek bir tmp klasorunde
     * ucunu birden sinamak mumkun.
     */
    var eskiKokBakildi = false;
    function sharedDir() {
        var env = (typeof process !== 'undefined' && process.env) ? process.env : {};
        if (env.CHERRYTAKE_SHARED_DIR) return env.CHERRYTAKE_SHARED_DIR;
        var destek = (process.platform === 'win32')
            ? (env.APPDATA || path.join(env.USERPROFILE || os.homedir(), 'AppData', 'Roaming'))
            : path.join(env.HOME || os.homedir(), 'Library', 'Application Support');
        var kok = path.join(destek, 'CherryTake');
        if (!eskiKokBakildi) { eskiKokBakildi = true; eskiKokuTasi(path.join(destek, 'EditFlow'), kok); }
        return kok;
    }

    /*
     * Urunun onceki adi EditFlow'du. Eski "EditFlow" klasoru (panelin
     * modelleri, onbellegi, lisansi, kesim gecmisi dahil) ilk calismada
     * "CherryTake"e tasinir - hangi uygulama once acilirsa o tasir, surec
     * basina bir kez bakilir. Yeni klasor zaten varsa eski klasordeki parcalar
     * TEK TEK tasinir, yeni tarafta ayni adla duran bir parcaya dokunulmaz.
     * Ayni kural panelin platform.js'inde de var.
     */
    function eskiKokuTasi(eski, yeni) {
        try {
            if (!fs.existsSync(eski)) return;
            if (!fs.existsSync(yeni)) {
                fs.mkdirSync(path.dirname(yeni), { recursive: true });
                fs.renameSync(eski, yeni);
                return;
            }
            fs.readdirSync(eski).forEach(function (ad) {
                var hedef = path.join(yeni, ad);
                if (!fs.existsSync(hedef)) fs.renameSync(path.join(eski, ad), hedef);
            });
            if (!fs.readdirSync(eski).length) fs.rmdirSync(eski);
        } catch (e) {}
    }

    function ensureDir(dir) {
        try { fs.mkdirSync(dir, { recursive: true, mode: 448 }); return true; }   /* 0700 */
        catch (e) { try { return fs.existsSync(dir); } catch (e2) { return false; } }
    }

    /*
     * Posta kutusu ve kalp atisi klasorleri yalniz kullanicinin (0700): baska
     * bir hesap komut birakamasin, okuyamasin. Onceden 0755 kurulmus klasor
     * surec basina bir kez daraltilir. Windows'ta izin bitleri yok, atlanir.
     */
    var daraltilan = {};
    function ozelKlasor(dir) {
        ensureDir(dir);
        if (daraltilan[dir] || process.platform === 'win32') return dir;
        daraltilan[dir] = true;
        try {
            var st = fs.lstatSync(dir);
            if (st.isDirectory() && (st.mode & 63) !== 0) fs.chmodSync(dir, 448);
        } catch (e) {}
        return dir;
    }

    function presenceDir() { return ozelKlasor(path.join(sharedDir(), 'presence')); }
    function busDir(hedef) { ozelKlasor(path.join(sharedDir(), 'bus')); return ozelKlasor(path.join(sharedDir(), 'bus', hedef)); }

    function gecerliAd(ad) {
        if (!UYGULAMALAR.hasOwnProperty(String(ad))) throw new Error('Bilinmeyen CherryTake uygulamasi: ' + ad);
        return String(ad);
    }

    /* ---------- atomik yazma ---------- */

    /*
     * Once .tmp yazilir, sonra rename edilir. Rename atomik oldugu icin
     * izleyen taraf hicbir zaman yarim dosya gormez (Circle'in writeConfig
     * deseninin aynisi).
     */
    function atomikYaz(hedefYol, veri) {
        /* 'wx': onceden konmus bir dosya/sembolik bag izlenmez; 0600: yalniz kullanici */
        var tmp = hedefYol + '.' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.tmp';
        fs.writeFileSync(tmp, veri, { mode: 384, flag: 'wx' });
        try { fs.renameSync(tmp, hedefYol); }
        catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} throw e; }
    }

    function benzersiz() {
        return String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);
    }

    /* ---------- kalp atisi ---------- */

    /*
     * payloadUret: her turda cagrilan islev; dondurdugu alanlar dosyaya
     * eklenir (panel sekans adini, Library kok sayisini boyle bildirir).
     * Islev hata firlatirsa kalp atisi yine yazilir, yalniz ek alanlar olmaz.
     */
    function heartbeat(ad, payloadUret, secenek) {
        ad = gecerliAd(ad);
        secenek = secenek || {};
        var aralik = secenek.aralik || KALP_ARALIK;
        var yol = path.join(presenceDir(), ad + '.json');
        var durdu = false;

        function yaz() {
            if (durdu) return;
            var govde = { app: ad, pid: process.pid, ts: Date.now(), v: SURUM };
            if (typeof payloadUret === 'function') {
                try {
                    var ek = payloadUret();
                    if (ek && typeof ek === 'object') {
                        for (var k in ek) if (ek.hasOwnProperty(k)) govde[k] = ek[k];
                    }
                } catch (e) {}
            }
            try { atomikYaz(yol, JSON.stringify(govde)); } catch (e) {}
        }

        yaz();
        var zamanlayici = setInterval(yaz, aralik);
        if (zamanlayici && typeof zamanlayici.unref === 'function') zamanlayici.unref();
        return {
            yol: yol,
            simdiYaz: yaz,
            stop: function () {
                if (durdu) return;
                durdu = true;
                clearInterval(zamanlayici);
                try { fs.unlinkSync(yol); } catch (e) {}
            }
        };
    }

    /* Kalp atisi dosyasini oku; yoksa ya da bozuksa null */
    function presence(ad) {
        ad = gecerliAd(ad);
        try {
            var ham = fs.readFileSync(path.join(presenceDir(), ad + '.json'), 'utf8');
            var g = JSON.parse(ham);
            return (g && g.app === ad) ? g : null;
        } catch (e) { return null; }
    }

    /*
     * Uygulama acik mi? Iki olcut: kalp atisi taze mi, ve surec gercekten
     * yasiyor mu. Ikincisi cokme sonrasi kalan dosyayi yakalar (kill -9 ile
     * kapanan Premiere kalp atisini silemez).
     */
    function alive(ad, secenek) {
        secenek = secenek || {};
        var g = presence(ad);
        if (!g) return false;
        var tolerans = secenek.tolerans || KALP_TOLERANS;
        if (!(typeof g.ts === 'number') || Date.now() - g.ts > tolerans) return false;
        if (typeof g.pid === 'number' && g.pid > 0) {
            try { process.kill(g.pid, 0); }
            catch (e) { if (e && e.code === 'ESRCH') return false; }
        }
        return true;
    }

    /* ---------- komut gonderme ---------- */

    function send(hedef, mesaj, secenek) {
        hedef = gecerliAd(hedef);
        secenek = secenek || {};
        if (!mesaj || typeof mesaj !== 'object' || !mesaj.cmd) throw new Error('Komut adi (cmd) gerekli.');
        var zarf = { v: SURUM, id: benzersiz(), from: secenek.from || null, ts: Date.now() };
        for (var k in mesaj) if (mesaj.hasOwnProperty(k)) zarf[k] = mesaj[k];
        if (!zarf.from) throw new Error('Gonderen (from) gerekli.');
        gecerliAd(zarf.from);
        atomikYaz(path.join(busDir(hedef), zarf.id + '.json'), JSON.stringify(zarf));
        return zarf.id;
    }

    /* Gelen mesaja yanit: gonderenin kutusuna replyTo ile geri yazilir */
    function reply(mesaj, yanit, secenek) {
        if (!mesaj || !mesaj.from) return null;
        var g = {};
        for (var k in yanit) if (yanit.hasOwnProperty(k)) g[k] = yanit[k];
        g.cmd = g.cmd || (String(mesaj.cmd) + '-yanit');
        g.replyTo = mesaj.id;
        return send(mesaj.from, g, secenek);
    }

    /* ---------- komut alma ---------- */

    function bayatMi(dosyaYol, omur) {
        try { return Date.now() - fs.statSync(dosyaYol).mtimeMs > omur; }
        catch (e) { return false; }
    }

    /*
     * Kutudaki dosyalari sirayla isler.
     *
     * Sahiplenme: dosya once ".busy" olarak yeniden adlandirilir. rename
     * atomiktir, yani ayni anda iki izleyici (fs.watch olayi + yedek tarama,
     * ya da Windows'un cift olayi) ayni komutu iki kez isleyemez; ikincisi
     * ENOENT alir ve gecer.
     */
    function kutuyuIsle(self, handler, secenek) {
        var dizin = busDir(self);
        var dosyalar;
        try { dosyalar = fs.readdirSync(dizin); } catch (e) { return; }
        dosyalar.sort();
        for (var i = 0; i < dosyalar.length; i++) {
            var ad = dosyalar[i];
            var tam = path.join(dizin, ad);
            /* yarim kalmis sahiplenmeleri ve bayat komutlari temizle */
            if (ad.slice(-5) === '.busy' || ad.slice(-4) === '.tmp') {
                if (bayatMi(tam, KOMUT_OMRU)) { try { fs.unlinkSync(tam); } catch (e) {} }
                continue;
            }
            if (ad.slice(-5) !== '.json') continue;
            if (bayatMi(tam, secenek.omur || KOMUT_OMRU)) { try { fs.unlinkSync(tam); } catch (e) {} continue; }

            var benim = tam + '.busy';
            try { fs.renameSync(tam, benim); }
            catch (e) { continue; }   /* baskasi aldi */

            /* yalniz duz dosya ve makul boyut: sembolik bag, klasor, dev dosya atilir */
            var mesaj = null;
            try {
                var st = fs.lstatSync(benim);
                if (st.isFile() && st.size <= EN_BUYUK_KOMUT) mesaj = JSON.parse(fs.readFileSync(benim, 'utf8'));
            } catch (e) { mesaj = null; }
            try { fs.unlinkSync(benim); } catch (e) {}
            /* bozuk ya da bicimsiz dosya: at, cokme */
            if (!mesaj || typeof mesaj !== 'object' || typeof mesaj.cmd !== 'string' || !mesaj.cmd || mesaj.cmd.length > 64) continue;

            try {
                handler(mesaj, function (yanit) { try { return reply(mesaj, yanit, { from: self }); } catch (e) { return null; } });
            } catch (e) {
                if (secenek.hata) { try { secenek.hata(e, mesaj); } catch (e2) {} }
            }
        }
    }

    /*
     * Kutuyu izle.
     *
     * fs.watch her zaman guvenilir degil (CEP'in Node'unda olay kacabiliyor,
     * Windows'ta ayni degisiklik iki kez gelebiliyor). Bu yuzden watch bir
     * HIZLANDIRICI olarak kullanilir; dogruluk her zaman calisan yedek
     * taramadan gelir.
     */
    function watch(self, handler, secenek) {
        self = gecerliAd(self);
        secenek = secenek || {};
        var dizin = busDir(self);
        var durdu = false, mesgul = false, bekleyen = false;
        var ertelenen = null, izleyici = null, sonHata = 0;
        var yenidenAralik = secenek.yenidenKur || YENIDEN_KUR;
        /* testler sahte izleyici verebilsin diye enjekte edilebilir */
        var izleyiciUret = (typeof secenek.izleyiciUret === 'function')
            ? secenek.izleyiciUret
            : function (d, dinle) { return fs.watch(d, dinle); };

        function tur() {
            if (durdu) return;
            if (mesgul) { bekleyen = true; return; }
            mesgul = true;
            try { kutuyuIsle(self, handler, secenek); }
            finally {
                mesgul = false;
                if (bekleyen && !durdu) {
                    bekleyen = false;
                    if (!ertelenen) ertelenen = setTimeout(function () { ertelenen = null; tur(); }, 0);
                }
            }
        }

        /*
         * fs.watch baslatildiktan SONRA da 'error' yayabilir (klasor silindi,
         * disk cikarildi, Windows'ta EPERM...). Dinleyicisiz 'error' EventEmitter
         * kurali geregi sureci cokertir. Bozulan izleyici kapatilir, teslim yedek
         * taramayla surer; izleyici yenidenAralik sonra tekrar kurulmaya calisilir.
         * Hata dinleyicisi kapatilan izleyicide de kalir: gec gelen ikinci bir
         * 'error' da sureci dusuremez.
         */
        function izleyiciAc() {
            if (durdu || izleyici) return;
            var iz = null;
            try { busDir(self); iz = izleyiciUret(dizin, function () { tur(); }); } catch (e) { iz = null; }
            if (!iz) { sonHata = Date.now(); return; }
            if (typeof iz.on === 'function') {
                iz.on('error', function (hata) {
                    if (izleyici === iz) { izleyici = null; sonHata = Date.now(); }
                    try { iz.close(); } catch (e) {}
                    if (secenek.izleyiciHata) { try { secenek.izleyiciHata(hata); } catch (e2) {} }
                });
            }
            izleyici = iz;
        }

        function izleyiciKapat() {
            var iz = izleyici;
            izleyici = null;
            if (iz) { try { iz.close(); } catch (e) {} }
        }

        function tik() {
            if (durdu) return;
            if (!izleyici && Date.now() - sonHata >= yenidenAralik) izleyiciAc();
            tur();
        }

        izleyiciAc();
        var zamanlayici = setInterval(tik, secenek.tarama || TARAMA_ARALIK);
        if (zamanlayici && typeof zamanlayici.unref === 'function') zamanlayici.unref();
        tur();   /* acilista bekleyenleri al */

        var kutu = {
            dizin: dizin,
            simdiTara: tur,
            stop: function () {
                if (durdu) return;
                durdu = true;
                clearInterval(zamanlayici);
                if (ertelenen) { clearTimeout(ertelenen); ertelenen = null; }
                izleyiciKapat();
            }
        };
        /* anlik durum: izleyici sonradan bozulup yeniden kurulabilir */
        Object.defineProperty(kutu, 'izleyiciVar', { enumerable: true, get: function () { return !!izleyici; } });
        return kutu;
    }

    var api = {
        SURUM: SURUM,
        KALP_ARALIK: KALP_ARALIK,
        KALP_TOLERANS: KALP_TOLERANS,
        KOMUT_OMRU: KOMUT_OMRU,
        TARAMA_ARALIK: TARAMA_ARALIK,
        YENIDEN_KUR: YENIDEN_KUR,
        EN_BUYUK_KOMUT: EN_BUYUK_KOMUT,
        sharedDir: sharedDir,
        presenceDir: presenceDir,
        busDir: busDir,
        heartbeat: heartbeat,
        presence: presence,
        alive: alive,
        send: send,
        reply: reply,
        watch: watch
    };
    root.cherrytakeBus = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
