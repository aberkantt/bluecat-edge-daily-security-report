# BlueCat Edge Günlük Güvenlik Raporu

[English documentation](README.md)

BlueCat Edge günlük güvenlik bulgularını alan, ham veriyi arşivleyen, geçmiş
kayıtlarını tutan, yönetici PDF'i oluşturan ve raporu e-posta ile gönderen
Google Apps Script otomasyonudur.

> Bu bağımsız bir topluluk projesidir; BlueCat Networks'ün resmî ürünü değildir.
> BlueCat ve ilgili ürün adları kendi sahiplerinin ticari markalarıdır.

## Neler yapıyor?

- Client credentials ile BlueCat Edge API'ye bağlanır.
- Site bilgilerini ve günlük most-compromised-endpoints raporunu alır.
- API'de gerekli topoloji verisi varsa bulguları siteyle eşleştirir ve DNS
  forwarder kayıtlarını ayırır.
- Ham JSON ve normalize edilmiş CSV dosyasını Google Drive'a arşivler.
- Google Sheets üzerinde günlük özet, detaylı bulgu ve domain inceleme geçmişi
  tutar.
- Google Slides üzerinden üç sayfalık yönetici PDF'i üretir.
- HTML e-posta, PDF eki, opsiyonel CC ve ayrı teknik hata bildirimi gönderir.
- Güvenli test modu, kilit mekanizması, yeniden deneme ve mükerrer production
  mail koruması içerir.

## Klasör yapısı

```text
bluecat-edge-daily-security-report/
├── src/
│   ├── Code.gs
│   └── appsscript.json
├── .clasp.json.example
├── .gitattributes
├── .gitignore
├── LICENSE
├── README.md
├── README.tr.md
└── SECURITY.md
```

## Gereksinimler

- Token alabilen, site ve güvenlik raporu verilerini okuyabilen bir BlueCat
  Edge API client'ı.
- Google Apps Script tarafından erişilebilen BlueCat Edge URL'si.
- Apps Script, Drive, Sheets, Slides ve Mail kullanımına izin verilen bir Google
  hesabı.

## GitHub Desktop ile yayımlama

1. İndirdiğin ZIP'i çıkart; içinde tek üst klasör olarak bu proje bulunur.
2. GitHub Desktop'ta **File → Add Local Repository** seçeneğine gir ve
   `bluecat-edge-daily-security-report` klasörünü seç.
3. GitHub Desktop klasörün henüz Git repository olmadığını söylerse
   **create a repository here** seçeneğine bas.
4. `Initial release` gibi bir mesajla dosyaları commit et.
5. **Publish repository** seçeneğine bas, görünürlüğü belirle ve yayımla.

Hazırlanan kaynakta credential, e-posta adresi, müşteri adı, iç IP adresi,
Drive ID'si veya üretilmiş rapor bulunmaz. Daha sonra ortama özel veri eklersen
repoyu private tut.

## Script Properties

Apps Script projesinde **Proje Ayarları → Komut dosyası özellikleri** bölümüne
gir. Ortama özel değerleri burada tut; `Code.gs` içine yazma.

| Özellik | Zorunlu mu? | Amaç |
|---|---:|---|
| `BLUECAT_BASE_URL` | Evet | Sonda `/` olmadan BlueCat Edge ana URL'si |
| `BLUECAT_CLIENT_ID` | Evet | API client ID |
| `BLUECAT_CLIENT_SECRET` | Evet | API client secret |
| `ALERT_TO` | Evet | Test raporları ve teknik hata bildirimleri |
| `TEST_MODE` | Evet | Güvenli test için `TRUE`, canlı kullanım için `FALSE` |
| `REPORT_TO` | Canlıda | Ana canlı rapor alıcısı |
| `REPORT_CC` | Hayır | Virgülle ayrılmış CC adresleri |
| `REPORT_CUSTOMER_NAME` | Hayır | E-posta ve PDF'de gösterilecek müşteri adı |

`ROOT_FOLDER_ID`, `HISTORY_SPREADSHEET_ID` ve `LAST_SENT_REPORT_KEY` değerlerini
script otomatik üretir ve yönetir. Bunları kaynak koda veya GitHub'a ekleme.

## Apps Script'e manuel kurulum

1. Bağımsız bir Google Apps Script projesi oluştur.
2. Editördeki varsayılan kodu [`src/Code.gs`](src/Code.gs) ile değiştir.
3. **Proje Ayarları** bölümünden manifest dosyasını editörde göstermeyi aç ve
   içeriğini [`src/appsscript.json`](src/appsscript.json) ile değiştir.
4. Yukarıdaki Script Properties değerlerini `TEST_MODE=TRUE` olacak şekilde gir.
5. `setupBlueCatWorkspace()` fonksiyonunu bir kez çalıştır ve Google izinlerini
   onayla.
6. `testBlueCatConnection()` fonksiyonunu çalıştır; credential veya token
   loglamadan `SUCCESS` döndüğünü doğrula.
7. `runBlueCatDailyReport()` fonksiyonunu çalıştır; test maili, PDF, JSON, CSV ve
   geçmiş tablosunun doğru oluştuğunu kontrol et.
8. `REPORT_TO` ve gerekiyorsa `REPORT_CC` değerlerini gir, `TEST_MODE=FALSE` yap
   ve bir kez `runBlueCatDailyReport()` çalıştırarak canlı smoke test yap.
9. `installDailyTrigger()` fonksiyonunu yalnızca bir kez çalıştır.
   `createProductionDailyTrigger()` uyumluluk fonksiyonu da aynı işlemi yapar.

Zamanlanmış görev `Europe/Istanbul` saat diliminde her gün yaklaşık 10:00'da
çalışır. Günlük tetikleyiciyi kaldırmak için `removeDailyTrigger()` kullanılır.

## Opsiyonel clasp kullanımı

Repo, `clasp` ile yerel Apps Script geliştirmesine hazırdır:

1. `.clasp.json.example` dosyasının `.clasp.json` adlı kopyasını oluştur.
2. Placeholder alanına hedef Apps Script proje ID'sini gir.
3. `clasp` ile oturum aç ve repo kökünde `clasp push` çalıştır.

`.clasp.json`, ortama özel proje ID'si içerdiği için Git tarafından özellikle
yok sayılır.

## Test ve canlı davranışı

| Mod | Alıcılar | Konu ön eki | Mükerrer gönderim koruması |
|---|---|---|---|
| `TEST_MODE=TRUE` | Yalnızca `ALERT_TO` | `[TEST]` | Test tekrarlarında yeniden mail gidebilir |
| `TEST_MODE=FALSE` | `REPORT_TO` ve opsiyonel `REPORT_CC` | Yok | Her rapor anahtarı için tek canlı mail |

Mükerrer gönderim kontrolü `LAST_SENT_REPORT_KEY` içinde tutulur. Aynı rapor
daha önce canlı alıcılara gönderilmiş olsa bile Drive dosyaları güncellenir.

## Üretilen çıktılar

İlk çalışmada Drive üzerinde `BlueCat Security Reports` klasörü ve
`BlueCat Security History` tablosu oluşturulur. Her rapor günü için açılan arşiv
klasöründe şunlar bulunur:

- Ham BlueCat JSON
- Normalize bulgular CSV'si
- Yönetici PDF raporu

Google Sheets dosyası günlük özet, bulgu ve domain inceleme geçmişini tutar.

## Güvenlik ve operasyon notları

- Alıcıları ve PDF ekini doğrulayana kadar `TEST_MODE=TRUE` kullan.
- Script Properties değerlerini, üretilen raporları, müşteri verisini ve ham API
  cevaplarını GitHub'a gönderme.
- BlueCat vendor bulgularını ve skorlarını doğrulanmış olay değil, tespit sinyali
  olarak değerlendir. Rapor vendor severity ile analist inceleme durumunu ayrı
  gösterir.
- Yeni bir ortamda canlıya almadan önce üretilen çıktıyı kontrol et.
- Repoyu yayımlamadan önce [SECURITY.md](SECURITY.md) dosyasını incele.

## Mevcut kapsam

Bu sürüm günlük veri toplama, arşivleme, PDF üretimi, mail gönderimi ve
zamanlamaya odaklanır. Harici tehdit istihbaratı zenginleştirmesi, AI tabanlı
triage ve otomatik false-positive bastırma bu sürüme dahil değildir.

## Lisans

[MIT License](LICENSE) ile yayımlanmıştır.
