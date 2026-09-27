# Bibliothek — Komplett prosjektkontekst

> **Til en ny chat:** Les hele denne filen først. Den inneholder alt du trenger for å
> jobbe videre uten å gjette. Selve frontend er én ~35 000-linjers HTML-fil — bruk
> `grep -n` for å finne funksjoner før du redigerer, ikke les hele. Store `@font-face`-blokker
> (Source Sans Pro) ligger rundt linje 1115–1870; hopp over dem.

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
**Git-identitet i dette repoet:** `handegaard92-alt@users.noreply.github.com`
(GitHub blokkerer den private e-posten `handegaard92@gmail.com` ved push — bruk noreply-adressen).

---

## 3. Filstruktur
```
bibliothek-server/
├── server.js               ← Express API (~1000 linjer)
├── CONTEXT.md              ← denne fila
├── render.yaml             ← Render-konfig (env-vars deklarert, verdier settes i dashboard)
├── package.json            ← deps: express, multer, @aws-sdk/client-s3, nodemailer,
│                              express-rate-limit, helmet
├── .claude/launch.json     ← lokal dev-server (node server.js, port 3000)
├── scripts/
│   └── generate-icons.js   ← Sharp-basert ikongenerering fra icon.svg
└── public/
    ├── bibliothek.html     ← HELE frontend (~35 000 linjer, alt inline: CSS+JS+HTML)
    ├── sw.js               ← Service worker (stale-while-revalidate for HTML)
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
ALLOWED_ORIGIN           — CORS-origin, "https://xn--minebker-94a.no"
                           (faller tilbake til https://<PRIMARY_HOST> hvis ikke satt)
PORT                     — default 3000
```
Uten R2-vars kjører serveren, men lagring/auth er deaktivert (`r2 === null`).
`app.set('trust proxy', 1)` er satt fordi rate limiting kjører bak Render sin proxy.

---

## 5. R2-nøkkelstruktur
```
users/<usernameLower>.json          — { username, passwordHash, salt, libraryKey, readOnlyForLibraryKey?, ownerUsername?, label?, ... }
sessions/<sha256(token)>.json       — { username, libraryKey, readOnly?, expiresAt }  (overlever restart)
<libraryKey>/library.json           — { books:[...], updatedAt }
<libraryKey>/devices.json           — { devices:[...] }  (Kindle-enheter)
<libraryKey>/snapshots/library-YYYY-MM-DD.json  — daglige auto-backups (én pr. dag)
<libraryKey>/_guests.json           — gjesteliste for eier
<hashPin(libraryKey)>/<bookId>/<fileName>  — opplastede EPUB-filer + cover
```
`libraryKey` = R2-prefiks per bruker. Gjester har egen `libraryKey` men leser eierens
bibliotek via `readOnlyForLibraryKey`.

---

## 6. Auth-system (scrypt, ingen tredjepartslib)
- **Passord:** `crypto.scryptSync(password, salt, 64)` → hex. Konstant-tids sammenligning.
  **Min 8 tegn** (håndheves server-side i register/create-user/create-guest/change-password).
- **Registrering STENGT** etter første bruker (`anyUserExists()`). Eier legger til nye
  via `/auth/create-user` eller gjester via `/auth/create-guest`.
- **Sessions:** token (base64url, 32 bytes) → lagret i minne + R2. 30-dagers TTL.
  `getSession(token)` faller tilbake til R2 hvis ikke i minnet (etter kald start).
- **Gjester:** `readOnly=true`, ser eierens bøker, men har egne lesestatuser lagret
  LOKALT i nettleseren (`_guestReads`, synker ikke til server).
- **Token KREVES på alle beskyttede API-kall** via `X-Auth-Token`-header. Brukere logges
  ikke ut ved kald start fordi sessions ligger i R2.

### Auth-middleware (server.js)
- `requireAuth` — krever gyldig `X-Auth-Token`, setter `req.session`
- `requireLibraryAccess` — `requireAuth` + at `session.libraryKey === req.params.pin`
- `authLimiter` — `express-rate-limit`, 10 req/min på auth-endepunkter
- `helmet` er på (CSP deaktivert fordi HTML bruker inline scripts)

### Klient: auth-header-helpers (bibliothek.html ~linje 30148)
**Alle** fetch-kall mot beskyttede endepunkter MÅ sende token:
```js
function authHdr()     { return { 'X-Auth-Token': window._authToken || '' }; }
function authJsonHdr() { return { 'Content-Type': 'application/json', 'X-Auth-Token': window._authToken || '' }; }
```
`window._authToken` settes i `applyAuthSession()` ved innlogging og gjenopprettes fra
localStorage (`bibliothek_authToken`) i `init()`. Legger du til et nytt fetch mot server,
HUSK header — ellers 401.

---

## 7. API-endepunkter (server.js)  — [middleware i parentes]
```
AUTH
  GET    /auth/registration-open           — er åpen registrering tillatt?
  POST   /auth/register        (authLimiter) — {username,password,migratePinHash?} kun førstegang, min 8 tegn
  POST   /auth/create-user     (authLimiter) — eier lager full bruker, min 8 tegn
  POST   /auth/create-guest    (authLimiter) — eier lager gjest
  POST   /auth/login           (authLimiter) — {username,password} → token
  GET    /auth/guests/:ownerUsername       (requireAuth) — list gjester
  DELETE /auth/guest/:username (requireAuth, authLimiter) — slett gjest
  POST   /auth/change-password (authLimiter) — min 8 tegn
  GET    /auth/exists/:username
  GET    /auth/verify                      — valider token (KUN header x-auth-token, aldri URL)
  POST   /auth/logout

BIBLIOTEK
  GET    /library/:pin         (requireLibraryAccess) — hent bøker
  PUT    /library/:pin         (requireLibraryAccess) — lagre (tom/drastisk-shrink-vern, force=true overstyrer)
  GET    /library/:pin/devices (requireLibraryAccess) — Kindle-enheter (devices.json)
  PUT    /library/:pin/devices (requireLibraryAccess)
  GET    /backups/:pin         (requireLibraryAccess) — list snapshots
  POST   /library/:pin/restore (requireLibraryAccess) — gjenopprett snapshot

FILER / KINDLE
  POST   /files/upload                     (requireAuth) — multipart, lagrer EPUB/cover i R2
  GET    /files/url/:pin/:bookId/:fileName (requireAuth) — signert nedlastings-URL
  GET    /files/download/:pin/:bookId/:fileName
         — bilder (jpg/jpeg/png/webp/gif) serveres UTEN auth (brukes som <img src>);
           alt annet (epub) krever gyldig session + matchende libraryKey
  POST   /send-to-kindle                   (requireAuth) — Gmail SMTP, filnavn ÆØÅ→ae/oe/aa

AI
  POST   /ai-chat            (requireAuth) — non-streaming fallback
  POST   /ai-chat-stream     (requireAuth) — SSE streaming (getReader-loop, ikke .on('data'))

DIV
  GET    /series-proxy       (requireAuth) — CORS-workaround mot ebok.no (serie/nummer/sjanger)
  GET    /health                           — { status: 'ok' }  (bevisst minimal)
  GET    /                                  — serverer bibliothek.html

⚠️ LEGACY PIN-endepunkter UTEN auth (gammel PIN-deling — bør fases ut):
  POST   /guest-link
  GET    /guest-links/:ownerPin
  DELETE /guest-links/:ownerPin/:guestPin
  POST   /guest-links/:ownerPin/restore
```

---

## 8. Frontend-arkitektur (bibliothek.html)
Alt inline i én fil. Ingen bygg-steg. Nøkkelmønstre:

- **Datamodell:** `books[]` — objekter med
  `{id, title, author, genre, series, seriesNum, status, progress, finishedDate,
    rating, year, notes, coverUrl, r2Key, fileName, fileType, fileData?, isbn, publisher, added, ...}`
- **Statuser:** `unread` / `reading` / `done` / `wishlist`
- **Lagring:** `localStorage` (`bibliothek_books`) + synk mot server via `pushToPin()`.
  `storageGet/storageSet` abstraherer localStorage vs. minne (sandkasse).
- **`init()`** (nederst i fila): laster localStorage → `render()` UMIDDELBART →
  bakgrunnssynk mot server → re-render hvis server har nyere `updatedAt`.
  Henter bibliotek + Kindle-enheter i parallell (`Promise.all`), begge med `authHdr()`.
- **`render()`** — én stor funksjon som tegner alt: stats-rad, "Fortsett å lese"-hero,
  filterpills (Status/Sjanger/Serie/Forfatter), og bokgrid/liste. Kalles etter hver endring.
- **`effectiveStatus/Progress/FinishedDate(b)`** — returnerer gjesters egne verdier fra
  `_guestReads` når `window._readOnly`.
- **Filtervariabler:** `genreFilter`, `seriesFilter`, `authorFilter`, `readFilter`
  (done/reading/unread), `view` (all/reading/done/wishlist/unread). `getFiltered()` kombinerer.
- **`coverHtml(b)` / `genreColor(b.genre)`** — bygger typografisk fallback-cover (se §10 Design).

### Viktige globale variabler
```
window._pinKey      — libraryKey (R2-prefiks) for aktiv bruker
window._readOnly    — true for gjester
window._authToken   — session-token (sendes i X-Auth-Token)
window._username
_guestReads         — {bookId: {status,progress,finishedDate}} lokalt for gjest
kindleDevices       — [{name, email, assignedTo?:[username...]}]
books               — hovedarray
```

---

## 9. Design (redesign gjennomført)
- **Fonter:** Hanken Grotesk (sans — brødtekst/UI) + Newsreader (serif — titler/tall).
  `.serif`-klasse. Google Fonts importeres i `<head>`.
- **Palett (CSS-variabler i `:root`):** krem bakgrunn `--bg #F2EBDC`, skogsgrønn brand
  `--brand #2C4034`, rust aksent `--accent #B6552F`, stjerne-gull `--star-gold #B68A3E`.
  **`:root.light` er det MØRKE temaet** (invertert navngiving — ikke bytt om på det).
- **theme-color meta:** `#F2EBDC` (oppdateres dynamisk ved temabytte).
- **Header:** sticky `.site-header` med brand «mine**bøker**.», nav (Biblioteket/Leseåret),
  søk, temaveksler, brukerikon. Erstatter gammel sidebar (`.sidebar { display:none }`).
- **Mobil:** bunnmeny `.tabbar` (≤680px): Bibliotek / Leseåret / Legg til / Profil.
  Header-søk/nav skjules. Grid 3 kol (≤900px) → 2 kol (≤680px).
- **Bokomslag:** CSS-typografiske fallback-covers med bok-rygg-form
  (`border-radius:4px 8px 8px 4px`), spine-skygge, papir-sheen. LEST = grønn pille nederst.
- **Stats/Leseåret:** `renderStatsView()` med lesemål-ring (conic-gradient) + grønt målkort.
- **Modaler:** 22px avrunding, blur-backdrop, pill-knapper (brand=grønn save, ghost=cancel).
  Bruk `askConfirm()` (stylet modal) for bekreftelser — ikke `confirm()`/`alert()`.

---

## 10. Funksjonsoversikt
- Grid/liste-visning, søk (tittel/forfatter/sjanger), sortering
- Status unread/reading/done/wishlist + fremgang-% med rask-klikk-popup
- Grønn "✓ LEST"-pille på cover for ferdiglest (grid + liste)
- Serier: auto-nummerering (ebok.no series-proxy), sortering, AI-leseguide,
  "legg manglende bok #N på ønskeliste"
- Sjanger-deteksjon (NB.no + Open Library + ebok.no)
- Ønskeliste isolert i egen visning
- AI-anbefalinger med streaming + lenker + "legg til ønskeliste"-knapp
- Legg til bok: ISBN-oppslag, auto-cover (Google Books/OL), EPUB-metadata-parsing, batch-opplasting
- Send til Kindle (Gmail, filnavn = boktittel med ÆØÅ normalisert)
- Innebygd EPUB-leser (epub.js + JSZip fra CDN): paginert, mørk/lys/sepia, font-størrelse, posisjon-synk
- Statistikk: leseheatmap, årsoppsummering
- Multivalg-sletting, cover-forstørring, duplikatdeteksjon ved opplasting
- Gjestebrukere: egne lesestatuser, tildelbare Kindle-enheter (`assignedTo`)
- Daglige server-snapshots + last ned/gjenopprett JSON-backup

---

## 11. Kjente fallgruver (lært denne veien)
- **Auth-header:** hvert nytt fetch mot beskyttet endepunkt MÅ ha `authHdr()`/`authJsonHdr()`,
  ellers 401 og "ingenting synker" (dette var rot-årsaken til en hel bugfiks-runde).
- **series-proxy:** ebok.no bruker `/eboker/<sjanger>/<slug>/`. Parse `dataLayer`-objektet
  først, deretter `Serie`-rad i book_info-tabell.
- **SSE-streaming:** `upstream.body` er Web ReadableStream i Node 18+ → bruk
  `getReader()`-loop, IKKE `.on('data')`.
- **Kindle-enheter:** bruk `/library/:pin/devices` (devices.json). Det gamle
  `_devices`-suffikset på library-endepunktet gir 403 (matcher ikke libraryKey).
- **`!important` i mobil-CSS** kan stille overstyre desktop-fikser — sjekk media-queries.
  `body` har `flex-direction:column !important` pga. font-face-blokk som ellers overstyrer.
- **Tom lagring:** PUT /library avviser tom/drastisk-mindre bok-array uten `force=true`.
- **Liste vs. grid:** `.bk.lv-item` må ha eksplisitt `flex-direction:row` (arver ellers
  `column` fra `.bk`). Media-query bruker `.grid:not(.lv)` for ikke å bryte listevisning.

---

## 12. Utestående / kjente problemer
- ⚠️ **Legacy PIN-innlogging** (`loginConnect`/`connectPin` i bibliothek.html) kaller fortsatt
  `/library/:pin` UTEN `X-Auth-Token` og refererer det gamle `_devices`-suffikset → gir 401.
  Enten fjern flyten helt (brukernavn-auth har erstattet den) eller gi den auth-header.
- `.filter-mobile-btn` bruker fortsatt `font-family:'Outfit'` (fjernet font) → faller til system-sans.
- To hardkodede cover-URL-er (`bibliothek-server-1.onrender.com`) ligger som eksempel-markup
  i den statiske grid'en i HTML-en.
- `logoutUser()` nullstiller ikke `window._readOnly` (mindre; ryddes ved reload).
- XSS: bok-felt (`title`/`author`/`series`) interpoleres rått i `innerHTML` (self-XSS-risiko, lav).
- `fetchJSON` faller tilbake via `corsproxy.io` for eksterne API-er (tredjepart ser forespørslene).

## 13. Ikke gjort ennå / fremtidige ideer
- Fysiske bøker (egen mappe, kun statistikk — ingen filer). Nevnt, ikke bygget.
- Goodreads-import — utsatt av bruker.
- Lydbøker — utsatt av bruker.
- `pin-sync.js` er ubrukt og kan ryddes bort.

---

## 14. Kronologi — siste sesjoners endringer (nyeste øverst)
```
ca07b99  Fiks alle audit-bugs: auth-headers (authHdr/authJsonHdr), sikkerhet, CSS-dubletter
e4d3ddf  Design-polish: badges, stjerner, seksjonstitler, brukerpanel
cbdf310  Fiks listevisning: horisontal layout, kompakte rader
e6e6f7f  Redesign fase 3-5: stats, modaler, polish
c85f619  Grid som standardvisning, strammere listevisning
0d9d350  Sikkerhetsherding + visuelt redesign fase 1-2
7c1cbb7  Fiks mobil topbar safe-area (!important overstyrte forrige fiks)
7618f51  iPhone safe-area-inset for topbar
```

## 15. Kom i gang lokalt
```bash
cd "/Users/hakon/Claude Code/bibliothek-server"
npm install
# krever R2-env-vars for full funksjon; ellers kjører den uten sky-lagring
node server.js          # http://localhost:3000  (eller preview_start "bibliothek")
```
Redigering: `grep -n "funksjonsnavn" public/bibliothek.html` for å finne linje.
Commit + `git push` deployer til Render automatisk.
