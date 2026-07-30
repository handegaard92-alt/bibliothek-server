# Bibliothek — Komplett prosjektkontekst

> **Til en ny chat:** Les hele denne filen først. Den inneholder alt du trenger for å
> jobbe videre uten å gjette. Selve frontend er én 35 000-linjers HTML-fil — bruk
> `grep -n` for å finne funksjoner før du redigerer, ikke les hele.

---

## 1. Hva er dette?
Norsk e-bokbibliotek som PWA (installerbar web-app). Brukeren organiserer bøkene sine,
sender dem til Kindle, leser EPUB i nettleseren, får AI-anbefalinger og deler biblioteket
med gjestebrukere.

- **Repo:** https://github.com/handegaard92-alt/bibliothek-server
- **Live:** https://minebøker.no  (punycode: `xn--minebker-94a.no`)
- **Eier/bruker:** Håkon (handegaard92@gmail.com)
- **Språk i UI og kode-kommentarer:** norsk (bokmål)

---

## 2. Hosting & infrastruktur
| Del | Tjeneste | Detalj |
|---|---|---|
| Compute | **Render.com** | Gratis tier. Kald start ~30 sek etter 15 min inaktivitet. Auto-deploy på `git push` til `main`. |
| Fillagring | **Cloudflare R2** | S3-kompatibel. All bokdata, EPUB-filer, brukere, sessions, backups. |
| E-post | **Gmail SMTP** | Via Nodemailer. Sender EPUB til Kindle. (Byttet fra SendGrid pga. kredittgrense.) |
| AI | **Anthropic API** | Claude Haiku (`claude-haiku-4-5-20251001`) for anbefalinger, SSE-streaming. |
| Domene | Domeneshop | A-record → 216.24.57.1, CNAME www → bibliothek-server-1.onrender.com |

**Deploy-flyt:** commit → `git push` → Render bygger og deployer automatisk.
GitHub-auth kan utløpe i denne terminalen; hvis `git push` feiler med auth-feil må
brukeren fornye token (evt. via GitHub Desktop).

---

## 3. Filstruktur
```
bibliothek-server/
├── server.js               ← Express API (~1000 linjer)
├── render.yaml             ← Render-konfig (env-vars deklarert, verdier settes i dashboard)
├── package.json            ← deps: express, multer, @aws-sdk/client-s3, nodemailer, cors
├── .claude/launch.json     ← lokal dev-server (node server.js, port 3000)
├── scripts/
│   └── generate-icons.js   ← Sharp-basert ikongenerering fra icon.svg
└── public/
    ├── bibliothek.html     ← HELE frontend (~35 000 linjer, alt inline: CSS+JS+HTML)
    ├── sw.js               ← Service worker v3
    ├── manifest.json       ← PWA manifest ("Mine Bøker")
    ├── pin-sync.js         ← UBRUKT legacy-fil (0 referanser, kan slettes)
    └── icons/              ← icon-192/512, maskable-512, apple-touch, favicon-16/32, icon.svg
```

---

## 4. Miljøvariabler (settes i Render dashboard → Environment)
```
R2_ENDPOINT              — Cloudflare R2 S3-endpoint
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET                — default "bibliothek-files"
GMAIL_USER               — Gmail-adresse (avsender for Kindle)
GMAIL_APP_PASSWORD       — Google App-passord (16 tegn, krever 2FA på)
ANTHROPIC_API_KEY        — for AI-anbefalinger
PRIMARY_HOST             — "xn--minebker-94a.no" (redirect www + onrender → naken domene)
ALLOWED_ORIGIN           — CORS (valgfri, default *)
PORT                     — default 3000
```
Uten R2-vars kjører serveren, men lagring/auth er deaktivert (`r2 === null`).

---

## 5. R2-nøkkelstruktur
```
users/<usernameLower>.json          — { username, passwordHash, salt, libraryKey, readOnlyForLibraryKey?, ownerUsername?, label?, ... }
sessions/<sha256(token)>.json       — { username, libraryKey, readOnly?, expiresAt }  (overlever restart)
<libraryKey>/library.json           — { books:[...], updatedAt }
<libraryKey>/snapshots/library-YYYY-MM-DD.json  — daglige auto-backups (én pr. dag)
<libraryKey>/_guests.json           — gjesteliste for eier
<libraryKey>_devices/library.json   — Kindle-enheter (lagret som {books:[...]} pga. gjenbruk av library-endepunkt)
<hashPin(pin)>/<bookId>/<fileName>  — opplastede EPUB-filer + cover
```
`libraryKey` = R2-prefiks per bruker. Gjester har egen `libraryKey` men leser eierens
bibliotek via `readOnlyForLibraryKey`.

---

## 6. Auth-system (scrypt, ingen tredjepartslib)
- **Passord:** `crypto.scryptSync(password, salt, 64)` → hex. Konstant-tids sammenligning.
- **Registrering STENGT** etter første bruker (`anyUserExists()`). Eier legger til nye
  via `/auth/create-user` eller gjester via `/auth/create-guest`.
- **Sessions:** token (base64url, 32 bytes) → lagret i minne + R2. 30-dagers TTL.
  `getSession(token)` faller tilbake til R2 hvis ikke i minnet (etter kald start).
- **Gjester:** `readOnly=true`, ser eierens bøker, men har egne lesestatuser lagret
  LOKALT i nettleseren (`_guestReads`, synker ikke til server).
- Frontend bruker `libraryKey` fra localStorage for API-kall — token brukes kun til
  logout/verify. Så brukere logges IKKE ut ved kald start.

---

## 7. API-endepunkter (server.js)
```
AUTH
  GET    /auth/registration-open           — er åpen registrering tillatt?
  POST   /auth/register                    — {username,password,migratePinHash?} (kun førstegang)
  POST   /auth/create-user                 — eier lager full bruker
  POST   /auth/create-guest                — eier lager gjest {ownerUsername,ownerPassword,guestUsername,guestPassword,label?}
  POST   /auth/login                       — {username,password} → token
  GET    /auth/guests/:ownerUsername       — list gjester
  DELETE /auth/guest/:username             — slett gjest
  POST   /auth/change-password
  GET    /auth/exists/:username
  GET    /auth/verify                      — valider token (header x-auth-token el. ?token=)
  POST   /auth/logout

BIBLIOTEK
  GET    /library/:pin                     — hent bøker (pin = libraryKey el. gjeste-pin)
  PUT    /library/:pin                     — lagre bøker (beskyttelse mot tom/drastisk shrink, force=true overstyrer)
  GET    /library/:pin/devices             — Kindle-enheter
  PUT    /library/:pin/devices
  GET    /backups/:pin                     — list snapshots
  POST   /library/:pin/restore             — gjenopprett snapshot

FILER / KINDLE
  POST   /files/upload                     — multipart, lagrer EPUB i R2
  GET    /files/url/:pin/:bookId/:fileName — signert nedlastings-URL
  GET    /files/download/:pin/:bookId/:fileName — stream fil
  POST   /send-to-kindle                   — Gmail SMTP, filnavn normaliserer ÆØÅ→ae/oe/aa

AI
  POST   /ai-chat                          — non-streaming fallback
  POST   /ai-chat-stream                   — SSE streaming (getReader-loop, ikke .on('data'))

DIV
  GET    /series-proxy                     — CORS-workaround mot ebok.no, henter serie/nummer/sjanger
  GET    /health                           — { status, features:{app,kindle,ai,r2,sync} }
  GET    /                                 — serverer bibliothek.html

Legacy PIN-endepunkter (/guest-link, /guest-links/*) finnes fortsatt for bakoverkomp.
```

---

## 8. Frontend-arkitektur (bibliothek.html)
Alt inline i én fil. Ingen bygg-steg. Nøkkelmønstre:

- **Datamodell:** `books[]` — objekter med
  `{id, title, author, genre, series, seriesNum, status, progress, finishedDate,
    rating, year, coverUrl, r2Key, fileName, fileData?, isbn, publisher, ...}`
- **Statuser:** `unread` / `reading` / `done` / `wishlist`
- **Lagring:** `localStorage` (`bibliothek_books`) + synk mot server via `pushToPin()`.
  `storageGet/storageSet` abstraherer localStorage vs. minne (sandkasse).
- **`init()`** (nederst i fila): laster localStorage → `render()` UMIDDELBART →
  bakgrunnssynk mot server → re-render hvis server har nyere `updatedAt`.
  Henter bibliotek + Kindle-enheter i parallell (`Promise.all`).
- **`render()`** — én stor funksjon som tegner alt: stats-rad, "Fortsett å lese"-hero,
  filterpills, og bokgrid/liste. Kalles etter hver endring.
- **`effectiveStatus(b)` / `effectiveProgress(b)` / `effectiveFinishedDate(b)`** —
  returnerer gjesters egne verdier fra `_guestReads` når `window._readOnly`.
- **Filtervariabler:** `genreFilter`, `seriesFilter`, `authorFilter`, `readFilter`
  (done/reading/unread), `view` (all/reading/done/wishlist/unread). `getFiltered()`
  kombinerer alle. `clearFilters()` og `setView()` nullstiller.
- **`window._pinKey`** = aktiv libraryKey. `window._readOnly` = gjest. `window._authToken`.

### Viktige globale variabler
```
window._pinKey      — libraryKey (R2-prefiks) for aktiv bruker
window._readOnly    — true for gjester
window._authToken   — session-token
window._username
_guestReads         — {bookId: {status,progress,finishedDate}} lokalt for gjest
kindleDevices       — [{name, email, allowedGuests?}]
books               — hovedarray
```

---

## 9. PWA / mobil
- **sw.js v3:** stale-while-revalidate for HTML (viser cache umiddelbart, oppdaterer i bg),
  cache-first for ikoner/covers (7 dagers utløp på covers), API-kall aldri cachet.
  **Bump `VERSION` ved SW-endringer** så den reinstalleres.
- **theme-color** meta oppdateres dynamisk (`setThemeColor`) ved lys/mørk-bytte:
  `#f4f1ec` lys / `#0a0a0c` mørk.
- **Safe area (iPhone notch):** `.topbar` har
  `padding-top: max(15px, calc(12px + env(safe-area-inset-top)))`.
  MERK: mobil-media-query (< 700px) overstyrer med `!important`, så safe-area-padding
  må også settes der med `!important`. `viewport-fit=cover` er satt i viewport-meta.
- **Bottom-nav (mobil):** Bibliotek / Leser nå / Legg til / Statistikk / Tips.
- Lys/mørk-modus: `:root.light` CSS-variabler. Hardkodede mørke farger må ha
  `:root.light`-override (f.eks. `.topbar`).

---

## 10. Funksjonsoversikt
- Grid/liste-visning, søk (tittel/forfatter/sjanger), sortering (popup)
- Status: unread/reading/done/wishlist + fremgang-% med rask-klikk-popup
- Grønn "✓ LEST"-badge på cover for ferdiglest (både grid og liste)
- Serier: auto-nummerering (via ebok.no series-proxy), sortering, AI-leseguide,
  "legg manglende bok på ønskeliste"
- Sjanger-deteksjon (mange havner i "Annet" hvis ukjent)
- Ønskeliste isolert — vises kun i egen "mappe"
- AI-anbefalinger med streaming + lenker + "legg til ønskeliste"-knapp
- Send til Kindle (Gmail, filnavn = boktittel med ÆØÅ normalisert)
- Innebygd EPUB-leser (epub.js + JSZip): paginert, mørk/lys/sepia, font-størrelse,
  fremgang + posisjon-synk
- Statistikk: leseheatmap, årsoppsummering (year-in-review)
- ISBN-skanner ved opplasting
- Multivalg-sletting
- Cover-forstørring ved klikk
- Gjestebrukere: egne lesestatuser, tildelbare Kindle-enheter
- Duplikatdeteksjon ved opplasting (normalisert tittel + sortert-ord forfatter + filnavn)

---

## 11. Kjente fallgruver (lært denne veien)
- **Hero-cover størrelse:** ikke la `genreBg()` injisere `width/height:100%` — bruk kun gradient.
- **series-proxy:** ebok.no bruker `/eboker/<sjanger>/<slug>/`. Parse `dataLayer`-objektet
  først, deretter `Serie`-rad i book_info-tabell.
- **SSE-streaming:** `upstream.body` er Web ReadableStream i Node 18+ → bruk
  `getReader()`-loop, IKKE `.on('data')`.
- **Kindle-sync:** både auth-login og auto-login-sti må hente `_devices`-endepunktet.
- **`!important` i mobil-CSS** kan stille overstyre desktop-fikser — sjekk media-queries.
- **Tom lagring:** PUT /library avviser tom/drastisk-mindre bok-array uten `force=true`
  (beskyttelse mot datatap).

---

## 12. Ikke gjort ennå / fremtidige ideer
- Fysiske bøker (egen mappe, kun statistikk — ingen filer). Nevnt, ikke bygget.
- Goodreads-import — utsatt av bruker.
- Lydbøker — utsatt av bruker.
- `pin-sync.js` er ubrukt og kan ryddes bort.

---

## 13. Kronologi — siste sesjons endringer (nyeste øverst)
```
7c1cbb7  Fiks mobil topbar safe-area (!important overstyrte forrige fiks)
7618f51  iPhone safe-area-inset for topbar
6764307  Lest/Ikke lest/Leser nå filter-pills i hovedfilterlinje
80475c5  Fiks topbar mørk i lys modus
3ff79c4  Perf: umiddelbar render fra localStorage + parallell server-synk
9fec4b3  Fiks theme-color meta ved lys-modus-bytte
4992a44  Fjern staggered animasjon (bøker dukket opp 2 om gangen)
23aea7f  Bytt Kindle-e-post SendGrid → Nodemailer/Gmail
7175253  Fiks: read-filter, liste-checkmark, Kindle-filnavn-encoding (ÆØÅ)
9a0a62a  Lagre auth-sessions i R2 (overlever restart)
4405226  Innebygd EPUB-leser (epub.js)
322640a  PWA: app-ikoner, manifest, service worker
```

## 14. Kom i gang lokalt
```bash
cd "/Users/hakon/Claude Code/bibliothek-server"
npm install
# krever R2-env-vars i .env for full funksjon; ellers kjører den read-only
node server.js          # http://localhost:3000
```
Redigering: `grep -n "funksjonsnavn" public/bibliothek.html` for å finne linje.
Commit + `git push` deployer til Render automatisk.
