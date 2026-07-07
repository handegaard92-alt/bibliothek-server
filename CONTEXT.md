# Bibliothek — Prosjektkontekst

## Hva er dette?
Norsk e-bokbibliotek PWA. Single-page app (Express.js backend + én stor HTML-fil).
- **Repo:** https://github.com/handegaard92-alt/bibliothek-server
- **Live:** https://minebøker.no (punycode: xn--minebker-94a.no)
- **Hosting:** Render.com (gratis tier — kald start etter 15 min inaktivitet)
- **Lagring:** Cloudflare R2 (S3-kompatibel) — all bokdata og filer

## Filstruktur
```
server.js               — Express API
public/
  bibliothek.html       — Hele frontend (~35 000 linjer, alt inline)
  sw.js                 — Service worker v3 (stale-while-revalidate for HTML)
  manifest.json         — PWA manifest
  icons/                — PWA-ikoner (icon-192, icon-512, maskable, apple-touch, favicons)
```

## Stack
- Node.js 18+ / Express
- Cloudflare R2 via @aws-sdk/client-s3
- Nodemailer + Gmail SMTP (send til Kindle)
- Anthropic API (Claude Haiku) — AI-anbefalinger via SSE-streaming
- epub.js + JSZip — innebygd EPUB-leser
- scrypt-passord (Node crypto) — ingen tredjeparts auth-lib
- PWA: manifest + service worker, installerbar på mobil

## Autentisering
- Brukere lagret i R2: `users/<usernameLower>.json`
  - `{ username, passwordHash, salt, libraryKey, createdAt, updatedAt }`
- Sessions lagres i R2: `sessions/<sha256(token)>.json` (overlever server-restart)
- Registrering stengt etter første bruker — eier legger til via brukerpanel
- Gjestebrukere: `readOnlyForLibraryKey` peker på eierens bibliotek
- 30-dagers token-TTL

## Miljøvariabler (Render)
```
R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
GMAIL_USER, GMAIL_APP_PASSWORD   ← Kindle-sending (byttet fra SendGrid)
ANTHROPIC_API_KEY
PRIMARY_HOST=xn--minebker-94a.no
PORT=3000
```

## Viktige R2-nøkler
```
users/<username>.json            — brukerdata
<libraryKey>/library.json        — bokbibliotek
<libraryKey>/snapshots/          — daglige backups
<libraryKey>/_guests.json        — gjesteliste
<libraryKey>/_devices            — Kindle-enheter (lagres som {books:[...]})
sessions/<hash>.json             — auth sessions
```

## Frontend-arkitektur (bibliothek.html)
- Alle bøker i `localStorage` + synk mot server
- `init()` viser localStorage umiddelbart, deretter bakgrunnssynk mot server
- `books[]` array med objekter: `{id, title, author, genre, series, seriesNum, status, progress, finishedDate, coverUrl, r2Key, fileName, ...}`
- `effectiveStatus(b)` — returnerer gjesters egne statuser fra `_guestReads`
- `render()` — én funksjon tegner alt (stats, hero, pills, bokgrid/liste)
- `readFilter` — status-filter (done/reading/unread), kombineres med genre/series/author

## Funksjoner
- Biblioteksvisning (grid/liste), søk, sortering
- Statuser: unread / reading / done / wishlist
- Fremgang (%) med rask-klikk-popup
- Serier med nummerering og AI-leseguide
- AI-anbefalinger (streaming SSE)
- Send til Kindle (Gmail SMTP, filnavn normaliserer ÆØÅ→ae/oe/aa)
- Innebygd EPUB-leser (epub.js, mørk/lys/sepia, font-størrelse, pos-sync)
- Statistikk: leseheatmap, årsoppsummering
- Multivalg-sletting
- Gjestebrukere med egne lesestatuser og Kindle-enhetstilgang
- Filterpills: Status (Lest/Ikke lest/Leser nå) + Sjanger + Serie + Forfatter

## PWA / Mobil
- Service worker v3: stale-while-revalidate for HTML, cache-first for ikoner/covers
- theme-color oppdateres dynamisk ved lys/mørk-bytte
- Safe area inset: topbar har `padding-top: max(..., env(safe-area-inset-top))` — mobil override bruker `!important`
- Bottom nav: Bibliotek / Leser nå / Legg til / Statistikk / Tips

## Kjente begrensninger / fremtidige ideer
- Fysiske bøker (kun statistikk, ingen filer) — ikke implementert ennå
- Goodreads-import — utsatt
- Lydbøker — utsatt
- Render gratis tier: kald start (~30 sek) etter 15 min inaktivitet

## Siste endringer (denne sesjonen)
1. Nedgradert Render til gratis tier
2. Sessions lagres i R2 (overlever restart)
3. Byttet SendGrid → Nodemailer/Gmail
4. Fikset grønn LEST-badge manglende i listevisning
5. Lagt til Status-filter (Lest/Ikke lest/Leser nå) i pills + filtermodal
6. ÆØÅ normaliseres i Kindle-filnavn
7. Fjernet staggered animasjon (bøker dukket opp 2 om gangen)
8. Fikset theme-color meta for lys modus
9. Fikset topbar-farge i lys modus (var hardkodet mørk)
10. Performance: render fra localStorage umiddelbart, server-synk i bakgrunn
11. SW v3: stale-while-revalidate for HTML
12. iPhone safe area: topbar padding-top med env(safe-area-inset-top)
