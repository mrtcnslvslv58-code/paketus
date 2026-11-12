# 📦 PAKETÜS — Yeni Nesil Akıllı Kurye, POS & Rota Platformu

[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Database](https://img.shields.io/badge/Database-Node%20SQLite%20(Built--in)-003B57?logo=sqlite&logoColor=white)](https://nodejs.org/api/sqlite.html)
[![PWA Ready](https://img.shields.io/badge/PWA-Ready%20(Offline%20Cache)-5A0FC8?logo=pwa&logoColor=white)](public/sw.js)
[![License](https://img.shields.io/badge/License-Proprietary-0f172a)](#)

> **Paketmatik, Pagate, Vigo, Adisyo ve SepetTakip sistemlerinin en güçlü özelliklerini tek çatı altında birleştiren kurumsal, çok kiracılı (multi-tenant) kurye, akıllı rota/paket birleştirme, POS/pazaryeri entegrasyonu, Caller ID, bas-konuş saha telsizi ve süresiz kontör otomasyonu.**

---

## 📑 İçindekiler
- [0. Kırmızı Çizgiler & Mimari Prensip](#0-kırmızı-çizgiler--mimari-prensip)
- [1. Öne Çıkan Güçlü Yetenekler](#1-öne-çıkan-güçlü-yetenekler)
- [2. Demo Giriş Hesapları (Seed Verisi)](#2-demo-giriş-hesapları-seed-verisi)
- [3. Sistem Mimarisi & Klasör Düzeni](#3-sistem-mimarisi--klasör-düzeni)
- [4. Kurulum ve Yerel Çalıştırma](#4-kurulum-ve-yerel-çalıştırma)
- [5. API Referansı](#5-api-referansı)
- [6. Test & Doğrulama Standartları](#6-test--doğrulama-standartları)

---

## 0. Kırmızı Çizgiler & Mimari Prensip

1. **Sıfır Dış Bağımlılık & Maliyet:** Dış ücretli API'lara (Google Maps Matrix, Twilio, ücretli veritabanları) bağımlılık yoktur. Yerleşik `node:sqlite`, `node:crypto`, `node:test`, `express` ve açık kaynak **Leaflet (OpenStreetMap)** kullanılır. Harici yol tarifi için tek tıkla **Google Maps** ve **Yandex Haritalar** doğrudan istemci tarafında açılır.
2. **Kurye Çevrimiçi Kilidi:** Kuryeler GPS sinyaliyle veya sayfa yenilenmesiyle **asla kendiliğinden çevrimiçi olamaz**. Yalnızca kuryenin kendi "Mesaiye Başla" butonu (`POST /api/courier/status`) veya yöneticinin müdahalesi durumu değiştirebilir.
3. **Kurye GPS Gizliliği:** İşletme (`role: merchant`) panellerine ve SSE canlı akışına kuryelerin `lat`/`lng` GPS koordinatları **kesinlikle gönderilmez** (`null` olarak maskelenir). Kurye konumunu sadece operasyon merkezi (`role: admin`) görebilir.
4. **Zorunlu POS Eşleşmesi:** Sipariş içeriğinde kapıda kartla ödeme (`card_on_delivery`) varsa, akıllı dağıtım motoru paketi **yalnızca `has_pos === 1` olan kuryelerle** eşleştirir.
5. **Süresiz Kontör Güvencesi:** Kontörlerin son kullanma tarihi yoktur. Bakiye 0 olduğunda sipariş kaybolmaz; güvenli `pending_credit` modunda bekler. İptal edilen siparişlerde kontör **yalnızca 1 kez** otomatik cüzdana iade edilir.

---

## 1. Öne Çıkan Güçlü Yetenekler

### 🧠 Pagate Tarzı Akıllı Paket Birleştirme (Smart Batching)
- Havuzdaki bekleyen paketleri dükkan mesafesi (`<= 0.8 km`), yön koridoru (açı sapması `<= 38°` veya teslimat arası `<= 1.6 km`) kriterlerine göre en fazla 3'erli gruplar halinde birleştirir.
- Birleştirilen paketleri `nearest-neighbor + 2-opt` algoritmasıyla en kısa kilometreye göre sıralar (`route_sequence: 1, 2, 3`).

### 📞 Caller ID & Otomatik Müşteri Hafızası
- Telefon numarası girildiği anda milisaniyeler içinde müşterinin adı, son teslimat adresi, mahallesi, tercih ettiği ödeme yöntemi ve önceki sipariş sayısı ekrana otomatik dolar.

### 🔌 10 Kanallı POS & Pazaryeri Entegrasyon Hattı
- **Pazaryerleri:** Yemeksepeti, GetirYemek, Trendyol Go, Migros Yemek, TıklaGelsin.
- **Restoran POS Sistemleri:** Adisyo, SambaPOS, SepetTakip.
- **Doğrudan Kanallar:** WhatsApp Sipariş Hattı ve Yerel POS Yazıcı Ajanı (`pos-yazici-ajan.ps1`).
- Tek tık simülasyon ve 80mm termal fiş çıktısı desteği.

### 🎙️ Canlı Bas-Konuş Telsiz (PTT Radio) & Paket Sohbeti
- Kuryeler, işletmeler ve merkez yöneticisi arasında düşük gecikmeli sesli/metin bas-konuş anons hattı.
- Paket bazında teslimat notları ve canlı kurye-işletme mesajlaşması.

### 📱 Çevrimdışı Uyumlu PWA & Modern Web Standartları
- `paketus-v20261112` Service Worker ile ağ öncelikli ve önbellek yedekli çalışma.
- `/api/*` ve `/health` istekleri ASLA önbelleğe alınmaz (canlı veri bütünlüğü).
- Yerel HTML5 `<dialog>` modalları, `@container (width < 600px)` duyarlı tablolar.

---

## 2. Demo Giriş Hesapları (Seed Verisi)

Sistem ilk açılışta `merkez` operasyonu (`tenant_slug: merkez` — *Ege Hızlı Kurye & Lojistik*) altında hazır verilerle gelir:

| Rol | Kullanıcı / Firma Adı | Telefon | Şifre | Yetki & Özellik |
|---|---|---|---|---|
| **Yönetici (Admin)** | Murat Yönetici | `05551001010` | `1234` | Tam operasyon merkezi, harita, kurye atama, kontör & kasa |
| **Grup İşletme (Merchant)** | Lezzet Grup Restoranları | `05552002020` | `1234` | 3 alt şube tek ekranda: *Hatay Dönercisi*, *Burger İstasyonu*, *Gece Kumrucusu* |
| **Tekil İşletme (Merchant)** | Körfez Pide & Lahmacun | `05552002021` | `1234` | Tekil şube sipariş girişi, Caller ID & fiş yazdırma |
| **Kurye 1** | Ahmet Yılmaz | `05553003031` | `1234` | Motosiklet, **POS Cihazı VAR**, Çevrimiçi, Batarya: %92 |
| **Kurye 2** | Burak Demir | `05553003032` | `1234` | Motosiklet, **POS Cihazı YOK**, Çevrimiçi, Batarya: %78 |
| **Kurye 3** | Can Kaya | `05553003033` | `1234` | Hafif Ticari Araç, **POS Cihazı VAR**, Çevrimdışı, Batarya: %100 |

> **30 Saniyede Yeni Şirket:** Farklı bir lojistik şirketi açmak için vitrindeki *"Yeni Şirket Başlat"* formunu doldurabilir veya `POST /api/public/register-tenant` çağırabilirsiniz. Anında 100 hoş geldin kontörüyle izole operasyon açılır!

---

## 3. Sistem Mimarisi & Klasör Düzeni

```text
paketus/
├── ARCHITECTURE.md          # Master Mimari ve Tasarım Sözleşmesi
├── README.md                # Proje ve Kullanım Dokümantasyonu
├── package.json             # Bağımlılıklar (Node.js 22+, Express)
├── server.js                # Express Sunucusu, Auth, SSE ve REST Uç Noktaları
├── src/
│   ├── db.js                # Yerleşik node:sqlite veritabanı ve şema yöneticisi
│   ├── dispatch-engine.js   # Akıllı paket birleştirme (Batching) ve POS eşleme motoru
│   ├── receipt-parser.js    # ESC/POS fiş regex ayrıştırıcı ve 80mm HTML render
│   └── integrations-router.js # 10 platformlu webhook & simülasyon router'ı
├── public/
│   ├── index.html           # Semantik HTML5 PWA arayüzü
│   ├── styles.css           # Modern lacivert-zümrüt kurumsal tasarım sistemi
│   ├── app.js               # İstemci tarafı SPA/PWA kontrolcüsü & Leaflet harita
│   ├── sw.js                # Ağ-öncelikli Service Worker (paketus-v20261112)
│   ├── favicon.svg          # Modern rota & paket sekme ikonu
│   ├── brand/
│   │   ├── logo.svg         # Kesilmeyen Türkçe Ü tipografili yatay vektör logo
│   │   ├── icon-192.svg     # 192x192 PWA ikonu
│   │   └── icon-512.svg     # 512x512 PWA ikonu
│   └── scripts/
│       └── pos-yazici-ajan.ps1 # Yerel termal yazıcı PowerShell arka plan ajanı
└── tests/
    └── paketus.test.js      # Kapsamlı birim ve entegrasyon testleri (node:test)
```

---

## 4. Kurulum ve Yerel Çalıştırma

### Gereksinimler
- **Node.js 22.0.0 veya üzeri** (yerleşik `node:sqlite` desteği için)
- NPM veya PNPM

### Hızlı Başlangıç
```bash
# 1. Proje dizinine gidin
cd C:\Users\murat\.gemini\antigravity\scratch\paketus

# 2. Bağımlılıkları yükleyin
npm install

# 3. Sunucuyu başlatın
node server.js

# 4. Tarayıcıda açın
# http://localhost:3000
```

### Testleri Çalıştırma
```bash
node --test tests/paketus.test.js
```

---

## 5. API Referansı

Tüm korumalı uç noktalar `Authorization: Bearer <token>` başlığı veya SSE için `?token=<token>` parametresi kabul eder.

### Genel & Vitrin
| Metot | Uç Nokta | Açıklama |
|---|---|---|
| `GET` | `/health` | Canlılık ve sistem sağlık durumu |
| `GET` | `/api/config` | Uygulama adı, koordinat ve kontör paketleri |
| `POST` | `/api/auth/login` | Telefon ve şifre ile giriş |
| `GET` | `/api/auth/demo-accounts` | Tek tıkla demo giriş hesapları |
| `POST` | `/api/public/register-tenant` | Yeni çok kiracılı şirket kaydı |
| `GET` | `/api/public/track/:code` | Canlı sipariş ve kurye takip ekranı |

### Canlı Akış & Operasyon
| Metot | Uç Nokta | Açıklama |
|---|---|---|
| `GET` | `/api/stream?token=...` | Server-Sent Events (SSE) anlık canlı veri akışı |
| `GET` | `/api/bootstrap` | Rol bazlı tam başlangıç durumu (Admin/Merchant/Courier) |
| `POST` | `/api/orders` | Yeni sipariş oluşturma (Caller ID hafızasına kaydeder) |
| `GET` | `/api/caller-id?phone=...` | Numara bazlı anlık müşteri bilgisi sorgulama |
| `POST` | `/api/admin/dispatch/preview-batches` | Akıllı paket gruplarını önizleme |
| `POST` | `/api/admin/dispatch/auto-assign` | Paketleri POS & mesafe kuralıyla otomatik atama |
| `PATCH` | `/api/orders/:id/status` | Sipariş durumunu güncelleme (`picked_up`, `delivered`, `cancelled`) |
| `PATCH` | `/api/admin/orders/:id/financials` | Tutar, POS ve kurye hakedişini geriye dönük düzenleme |
| `POST` | `/api/courier/status` | Kurye mesai, mola, batarya ve GPS güncellemesi |
| `POST` | `/api/radio` | Bas-konuş telsiz anonsu gönderme |
| `GET` | `/api/admin/reconciliation` | Gün sonu kurye POS/nakit tahsilat ve işletme cari raporu |

### Entegrasyonlar
| Metot | Uç Nokta | Açıklama |
|---|---|---|
| `GET` | `/api/integrations/platforms` | Desteklenen 10 platform listesi |
| `POST` | `/api/integrations/webhook/:platform` | Dış platformdan gelen siparişi kabul etme |
| `POST` | `/api/integrations/parse-receipt` | Ham fiş metnini nesneye dönüştürme |
| `POST` | `/api/integrations/simulate/:platform` | Canlı sipariş simülasyonu üretme |
| `GET` | `/api/integrations/receipt/:orderId/html` | 80mm termal fiş HTML çıktısı |

---

## 6. Test & Doğrulama Standartları

PAKETÜS, kurumsal kalite kapısı prensiplerine göre doğrulanır:
1. **Sözdizimi Kontrolü:** `node --check` ile tüm sunucu ve Service Worker dosyaları denetlenir.
2. **Birim Testleri:** `node --test` ile `node:sqlite` bellek içi testleri ve rota algoritmaları doğrulanır.
3. **Gerçek Tarayıcı (Chrome Headless CDP):** Arayüz değişikliklerinde `verify-url.mjs` aracıyla gerçek Google Chrome çalıştırılır; sıfır konsol hatası ve sıfır çalışma zamanı istisnası (`Runtime.exceptionThrown === 0`) şartı aranır.

---

<div align="center">
  <sub>PAKETÜS © 2026. Lojistik ve Restoran Otomasyonunda Yeni Standart.</sub>
</div>
