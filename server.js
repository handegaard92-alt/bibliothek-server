const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
app.set('trust proxy', 1); // nødvendig for rate limiting bak Render sin proxy

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));

// Sikkerhetsheaders (CSP deaktivert — bibliothek.html bruker inline scripts)
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// Automatisk redirect til primær-domene (hvis satt)
// PRIMARY_HOST kan være "minebøker.no" eller punycode-formen "xn--minebker-94a.no"
const PRIMARY_HOST = process.env.PRIMARY_HOST || '';
app.use((req, res, next) => {
  if (PRIMARY_HOST) {
    const host = (req.headers.host || '').toLowerCase();
    const primaryLower = PRIMARY_HOST.toLowerCase();
    if (host && host !== primaryLower) {
      // Redirect:
      //  - fra Render-default URL (*.onrender.com)
      //  - fra www.<primær> til naken primær
      const isRenderHost = host.endsWith('.onrender.com');
      const isWwwOfPrimary = host === 'www.' + primaryLower;
      if (isRenderHost || isWwwOfPrimary) {
        return res.redirect(301, 'https://' + PRIMARY_HOST + req.originalUrl);
      }
    }
  }
  next();
});

app.use((req, res, next) => {
  const allowed = process.env.ALLOWED_ORIGIN || (PRIMARY_HOST ? 'https://' + PRIMARY_HOST : '');
  if (allowed) res.header('Access-Control-Allow-Origin', allowed);
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,X-Auth-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// R2 S3 client
const r2 = process.env.R2_ENDPOINT ? new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
}) : null;
const BUCKET = process.env.R2_BUCKET || 'bibliothek-files';

// In-memory PIN store for library metadata
const pinStore = new Map();
function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex').slice(0, 16);
}

// ── BRUKER-AUTENTISERING ──
// Lagring: R2 under users/<usernameLower>.json
//   { username, passwordHash, salt, libraryKey, createdAt, updatedAt }
// passwordHash = scrypt(password, salt, 64) i hex
// libraryKey = identifikator brukt som R2-prefix for biblioteket (bevarer eksisterende PIN-data ved migrering)
const sessionStore = new Map(); // token -> { username, libraryKey, expiresAt }
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dager

function sessionR2Key(token) {
  // Bruk hash av token som nøkkel (ikke rå token) for sikkerhet
  return 'sessions/' + crypto.createHash('sha256').update(token).digest('hex') + '.json';
}

async function persistSession(token, data) {
  if (!r2) return;
  try {
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET, Key: sessionR2Key(token),
      Body: JSON.stringify(data), ContentType: 'application/json',
    }));
  } catch(e) { console.warn('Session persist failed:', e.message); }
}

async function loadSessionR2(token) {
  if (!r2) return null;
  try {
    const data = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: sessionR2Key(token) }));
    const chunks = [];
    for await (const chunk of data.Body) chunks.push(chunk);
    const session = JSON.parse(Buffer.concat(chunks).toString());
    if (!session?.expiresAt) return null;
    if (Date.now() > session.expiresAt) {
      r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: sessionR2Key(token) })).catch(() => {});
      return null;
    }
    sessionStore.set(token, session); // cache i minnet
    return session;
  } catch(_) { return null; }
}

async function deleteSessionR2(token) {
  if (!r2) return;
  try { await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: sessionR2Key(token) })); } catch(_) {}
}

async function getSession(token) {
  if (!token) return null;
  const mem = sessionStore.get(token);
  if (mem) {
    if (Date.now() > mem.expiresAt) {
      sessionStore.delete(token);
      deleteSessionR2(token).catch(() => {});
      return null;
    }
    return mem;
  }
  return await loadSessionR2(token); // fall back til R2 etter restart
}

// Rate limiter for autentiseringsendepunkter
const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { ok: false, error: 'For mange forsøk. Prøv igjen om ett minutt.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Middleware: krev gyldig innlogget sesjon
async function requireAuth(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ ok: false, error: 'Innlogging påkrevd' });
  const session = await getSession(token);
  if (!session) return res.status(401).json({ ok: false, error: 'Ugyldig eller utløpt sesjon' });
  req.session = session;
  next();
}

// Middleware: krev auth + at session.libraryKey matcher :pin-parameteret
async function requireLibraryAccess(req, res, next) {
  const token = req.headers['x-auth-token'];
  if (!token) return res.status(401).json({ ok: false, error: 'Innlogging påkrevd' });
  const session = await getSession(token);
  if (!session) return res.status(401).json({ ok: false, error: 'Ugyldig eller utløpt sesjon' });
  if (session.libraryKey !== req.params.pin) {
    return res.status(403).json({ ok: false, error: 'Ingen tilgang til dette biblioteket' });
  }
  req.session = session;
  next();
}

function userKey(usernameLower) { return `users/${usernameLower}.json`; }

async function loadUser(username) {
  if (!r2) return null;
  try {
    const data = await r2.send(new GetObjectCommand({
      Bucket: BUCKET, Key: userKey(String(username).toLowerCase().trim()),
    }));
    const chunks = [];
    for await (const chunk of data.Body) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch(e) { return null; }
}

async function saveUser(user) {
  if (!r2) throw new Error('R2 ikke konfigurert');
  user.updatedAt = new Date().toISOString();
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET, Key: userKey(user.username.toLowerCase()),
    Body: JSON.stringify(user), ContentType: 'application/json',
  }));
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 64).toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  // Konstant-tids sammenligning
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function makeToken() { return crypto.randomBytes(32).toString('base64url'); }

function validateUsername(u) {
  if (!u || typeof u !== 'string') return 'Brukernavn mangler';
  const s = u.trim();
  if (s.length < 2) return 'Brukernavn må være minst 2 tegn';
  if (s.length > 32) return 'Brukernavn maks 32 tegn';
  if (!/^[a-zA-ZæøåÆØÅ0-9_-]+$/.test(s)) return 'Brukernavn kan kun inneholde bokstaver, tall, _ og -';
  return null;
}

// Sjekk om noen bruker finnes (for å avgjøre om registrering er åpen)
async function anyUserExists() {
  if (!r2) return false;
  try {
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const list = await r2.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: 'users/', MaxKeys: 1,
    }));
    return (list.Contents || []).length > 0;
  } catch(_) { return false; }
}

// GET /auth/registration-open — sier om åpen registrering er tillatt
app.get('/auth/registration-open', async (req, res) => {
  const blocked = await anyUserExists();
  res.json({ ok: true, open: !blocked });
});

// POST /auth/register — body: {username, password, migratePinHash?}
// Tillates KUN hvis det ikke finnes brukere (førstegangsoppsett)
app.post('/auth/register', authLimiter, async (req, res) => {
  try {
    if (await anyUserExists()) {
      return res.status(403).json({
        ok: false,
        error: 'Registrering er stengt. Be eieren legge til kontoen din via brukerpanelet.',
      });
    }
    const { username, password, migratePinHash } = req.body || {};
    const err = validateUsername(username);
    if (err) return res.status(400).json({ ok: false, error: err });
    if (!password || password.length < 8) return res.status(400).json({ ok: false, error: 'Passord må være minst 8 tegn' });
    const lower = username.trim().toLowerCase();
    const existing = await loadUser(lower);
    if (existing) return res.status(409).json({ ok: false, error: 'Brukernavnet er allerede tatt' });
    const { salt, hash } = hashPassword(password);
    let libraryKey = (typeof migratePinHash === 'string' && /^[a-f0-9]{16,64}$/.test(migratePinHash))
      ? migratePinHash
      : crypto.randomBytes(16).toString('hex');
    const user = {
      username: username.trim(),
      passwordHash: hash, salt,
      libraryKey,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveUser(user);
    const token = makeToken();
    const sessionData = { username: user.username, libraryKey, expiresAt: Date.now() + SESSION_TTL_MS };
    sessionStore.set(token, sessionData);
    await persistSession(token, sessionData);
    res.json({ ok: true, token, username: user.username, libraryKey });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /auth/create-user — eier oppretter ny full bruker (ikke gjest)
// Body: {ownerUsername, ownerPassword, newUsername, newPassword}
app.post('/auth/create-user', authLimiter, async (req, res) => {
  try {
    const { ownerUsername, ownerPassword, newUsername, newPassword } = req.body || {};
    if (!ownerUsername || !ownerPassword) return res.status(400).json({ ok: false, error: 'Eier-credentials påkrevd' });
    const owner = await loadUser(ownerUsername);
    if (!owner || !verifyPassword(ownerPassword, owner.salt, owner.passwordHash)) {
      return res.status(401).json({ ok: false, error: 'Feil eier-passord' });
    }
    // Eierroller: ingen gjester kan opprette nye brukere
    if (owner.readOnlyForLibraryKey) {
      return res.status(403).json({ ok: false, error: 'Kun eiere kan opprette nye brukere' });
    }
    const err = validateUsername(newUsername);
    if (err) return res.status(400).json({ ok: false, error: err });
    if (!newPassword || newPassword.length < 8) return res.status(400).json({ ok: false, error: 'Passord må være minst 8 tegn' });
    const lower = newUsername.trim().toLowerCase();
    if (lower === ownerUsername.trim().toLowerCase()) return res.status(400).json({ ok: false, error: 'Brukernavnet må være forskjellig fra ditt eget' });
    const existing = await loadUser(lower);
    if (existing) return res.status(409).json({ ok: false, error: 'Brukernavnet er allerede tatt' });
    const { salt, hash } = hashPassword(newPassword);
    const user = {
      username: newUsername.trim(),
      passwordHash: hash, salt,
      libraryKey: crypto.randomBytes(16).toString('hex'),
      createdBy: owner.username,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveUser(user);
    res.json({ ok: true, username: user.username });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /auth/login — body: {username, password}
app.post('/auth/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok: false, error: 'Brukernavn og passord påkrevd' });
    const user = await loadUser(username);
    if (!user) return res.status(401).json({ ok: false, error: 'Feil brukernavn eller passord' });
    if (!verifyPassword(password, user.salt, user.passwordHash)) {
      return res.status(401).json({ ok: false, error: 'Feil brukernavn eller passord' });
    }
    // Gjester: libraryKey peker på eierens bibliotek + readOnly-flagg
    const isGuest = !!user.readOnlyForLibraryKey;
    const libraryKey = isGuest ? user.readOnlyForLibraryKey : user.libraryKey;
    const token = makeToken();
    const sessionData = { username: user.username, libraryKey, readOnly: isGuest, expiresAt: Date.now() + SESSION_TTL_MS };
    sessionStore.set(token, sessionData);
    await persistSession(token, sessionData);
    res.json({ ok: true, token, username: user.username, libraryKey, readOnly: isGuest });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /auth/create-guest — body: {ownerUsername, ownerPassword, guestUsername, guestPassword, label?}
app.post('/auth/create-guest', authLimiter, async (req, res) => {
  try {
    const { ownerUsername, ownerPassword, guestUsername, guestPassword, label } = req.body || {};
    if (!ownerUsername || !ownerPassword) return res.status(400).json({ ok: false, error: 'Eier-credentials påkrevd' });
    const owner = await loadUser(ownerUsername);
    if (!owner || !verifyPassword(ownerPassword, owner.salt, owner.passwordHash)) {
      return res.status(401).json({ ok: false, error: 'Feil eier-passord' });
    }
    const err = validateUsername(guestUsername);
    if (err) return res.status(400).json({ ok: false, error: err });
    if (!guestPassword || guestPassword.length < 8) return res.status(400).json({ ok: false, error: 'Gjeste-passord må være minst 8 tegn' });
    const lower = guestUsername.trim().toLowerCase();
    if (lower === ownerUsername.trim().toLowerCase()) return res.status(400).json({ ok: false, error: 'Gjeste-brukernavn må være forskjellig fra eier' });
    const existing = await loadUser(lower);
    if (existing) return res.status(409).json({ ok: false, error: 'Brukernavnet er allerede tatt' });
    const { salt, hash } = hashPassword(guestPassword);
    const guest = {
      username: guestUsername.trim(),
      passwordHash: hash, salt,
      libraryKey: crypto.randomBytes(8).toString('hex'),
      readOnlyForLibraryKey: owner.libraryKey,
      ownerUsername: owner.username,
      label: label || guestUsername.trim(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await saveUser(guest);
    // Lagre i eierens gjesteliste i R2
    try {
      const list = await loadGuestList(owner.libraryKey);
      list.push({ guestUsername: guest.username, label: guest.label, created: guest.createdAt });
      await saveGuestList(owner.libraryKey, list);
    } catch(_) {}
    res.json({ ok: true, guest: { username: guest.username, label: guest.label } });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /auth/guests/:ownerUsername — list guests for an owner (krever at innlogget bruker ER eieren)
app.get('/auth/guests/:ownerUsername', requireAuth, async (req, res) => {
  try {
    if (req.session.username.toLowerCase() !== req.params.ownerUsername.toLowerCase()) {
      return res.status(403).json({ ok: false, error: 'Ingen tilgang' });
    }
    const owner = await loadUser(req.params.ownerUsername);
    if (!owner) return res.status(404).json({ ok: false, error: 'Eier ikke funnet' });
    const list = await loadGuestList(owner.libraryKey);
    // Filtrer ut PIN-baserte og behold bare bruker-baserte
    const guestUsers = list.filter(g => g.guestUsername).map(g => ({ username: g.guestUsername, label: g.label, created: g.created }));
    res.json({ ok: true, guests: guestUsers });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// DELETE /auth/guest/:username — body: {ownerUsername, ownerPassword}
app.delete('/auth/guest/:username', requireAuth, authLimiter, async (req, res) => {
  try {
    const { ownerUsername, ownerPassword } = req.body || {};
    const owner = await loadUser(ownerUsername);
    if (!owner || !verifyPassword(ownerPassword, owner.salt, owner.passwordHash)) {
      return res.status(401).json({ ok: false, error: 'Feil eier-passord' });
    }
    const guest = await loadUser(req.params.username);
    if (!guest || guest.readOnlyForLibraryKey !== owner.libraryKey) {
      return res.status(404).json({ ok: false, error: 'Gjest ikke funnet' });
    }
    // Slett bruker
    if (r2) {
      try { await r2.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: userKey(guest.username.toLowerCase()) })); } catch(_) {}
    }
    // Fjern fra liste
    try {
      const list = await loadGuestList(owner.libraryKey);
      await saveGuestList(owner.libraryKey, list.filter(g => g.guestUsername !== guest.username));
    } catch(_) {}
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /auth/change-password — body: {username, oldPassword, newPassword}
app.post('/auth/change-password', authLimiter, async (req, res) => {
  try {
    const { username, oldPassword, newPassword } = req.body || {};
    if (!username || !oldPassword || !newPassword) return res.status(400).json({ ok: false, error: 'Alle felter påkrevd' });
    if (newPassword.length < 8) return res.status(400).json({ ok: false, error: 'Nytt passord må være minst 8 tegn' });
    const user = await loadUser(username);
    if (!user) return res.status(404).json({ ok: false, error: 'Bruker finnes ikke' });
    if (!verifyPassword(oldPassword, user.salt, user.passwordHash)) {
      return res.status(401).json({ ok: false, error: 'Feil gammelt passord' });
    }
    const { salt, hash } = hashPassword(newPassword);
    user.passwordHash = hash; user.salt = salt;
    await saveUser(user);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /auth/exists/:username — sjekk om brukernavn finnes (for register-flow)
app.get('/auth/exists/:username', async (req, res) => {
  const user = await loadUser(req.params.username);
  res.json({ ok: true, exists: !!user });
});

// POST /auth/logout — body: {token}
app.post('/auth/logout', async (req, res) => {
  const { token } = req.body || {};
  if (token) {
    sessionStore.delete(token);
    await deleteSessionR2(token);
  }
  res.json({ ok: true });
});

// GET /auth/verify — verifiser at token fortsatt er gyldig (overlever server-restart via R2)
app.get('/auth/verify', async (req, res) => {
  const token = req.headers['x-auth-token']; // ikke aksepter token i URL (logges i access-logs)
  if (!token) return res.status(401).json({ ok: false, error: 'Token mangler' });
  const session = await getSession(token);
  if (!session) return res.status(401).json({ ok: false, error: 'Ugyldig eller utløpt sesjon' });
  res.json({ ok: true, username: session.username, libraryKey: session.libraryKey, readOnly: session.readOnly || false });
});

// R2-nøkkel for gjeste-PIN-liste per eier
function guestListKey(ownerKey) {
  return `${ownerKey}/_guests.json`;
}

async function loadGuestList(ownerKey) {
  if (!r2) return [];
  try {
    const data = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: guestListKey(ownerKey) }));
    const chunks = [];
    for await (const chunk of data.Body) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch(e) { return []; }
}

async function saveGuestList(ownerKey, list) {
  if (!r2) return;
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET, Key: guestListKey(ownerKey),
    Body: JSON.stringify(list), ContentType: 'application/json',
  }));
}

// Serve app
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (filePath.endsWith('manifest.json')) {
      res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=3600');
    } else if (filePath.endsWith('sw.js')) {
      // Service worker: alltid hent ny versjon så oppdateringer slår igjennom
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    } else if (/\/icons\//.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }
}));
app.get('/', (req, res) => {
  const f = path.join(publicDir, 'bibliothek.html');
  if (fs.existsSync(f)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(f);
  } else res.json({ status: 'ok', note: 'Place bibliothek.html in /public/' });
});

app.get('/health', (req, res) => {
  // Returner kun det absolutt nødvendige — ingen feature-flagg som avslører konfigurasjon
  res.json({ status: 'ok' });
});

// PIN-based library sync
// Gjeste-PIN store: guestKey -> ownerKey
const guestStore = new Map();

app.post('/guest-link', async (req, res) => {
  const { ownerPin, guestPin, label } = req.body;
  if (!ownerPin || !guestPin) return res.status(400).json({ ok: false, error: 'ownerPin og guestPin er påkrevd' });
  const ownerKey = ownerPin;
  const guestKey = guestPin;
  guestStore.set(guestKey, ownerKey);
  // Lagre persistent i R2
  try {
    const list = await loadGuestList(ownerKey);
    const existing = list.findIndex(g => g.guestKey === guestKey);
    const entry = { guestKey, label: label || guestPin, created: new Date().toISOString() };
    if (existing >= 0) list[existing] = entry; else list.push(entry);
    await saveGuestList(ownerKey, list);
  } catch(e) { console.warn('guest list R2 save failed:', e.message); }
  res.json({ ok: true, message: 'Gjeste-PIN opprettet' });
});

// List guest links for owner
app.get('/guest-links/:ownerPin', async (req, res) => {
  const ownerKey = req.params.ownerPin;
  const list = await loadGuestList(ownerKey);
  // Marker hvilke som er aktive i guestStore
  const enriched = list.map(g => ({ ...g, active: guestStore.has(g.guestKey) }));
  res.json({ ok: true, guests: enriched });
});

// Delete a guest link
app.delete('/guest-links/:ownerPin/:guestPin', async (req, res) => {
  const ownerKey = req.params.ownerPin;
  const guestKey = req.params.guestPin;
  guestStore.delete(guestKey);
  try {
    const list = await loadGuestList(ownerKey);
    await saveGuestList(ownerKey, list.filter(g => g.guestKey !== guestKey));
  } catch(e) { console.warn('guest list R2 delete failed:', e.message); }
  res.json({ ok: true });
});

// Restore guest links from R2 into guestStore on startup / owner sync
app.post('/guest-links/:ownerPin/restore', async (req, res) => {
  const ownerKey = req.params.ownerPin;
  const list = await loadGuestList(ownerKey);
  list.forEach(g => guestStore.set(g.guestKey, ownerKey));
  res.json({ ok: true, restored: list.length });
});

async function loadLibrary(key) {
  if (!r2) return null;
  try {
    const data = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${key}/library.json` }));
    const chunks = [];
    for await (const chunk of data.Body) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch(e) { return null; }
}

async function saveLibrary(key, books, updatedAt) {
  if (!r2) return;
  const body = JSON.stringify({ books, updatedAt });
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET, Key: `${key}/library.json`,
    Body: body, ContentType: 'application/json',
  })).catch(e => console.warn('R2 library save failed:', e.message));
  // Daglig snapshot (skriver bare hvis dagens ikke finnes — én pr. dag)
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const snapKey = `${key}/snapshots/library-${today}.json`;
    let exists = false;
    try {
      await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: snapKey }));
      exists = true;
    } catch(_) {}
    if (!exists) {
      await r2.send(new PutObjectCommand({
        Bucket: BUCKET, Key: snapKey,
        Body: body, ContentType: 'application/json',
      }));
    }
  } catch(e) { console.warn('snapshot failed:', e.message); }
}

app.get('/library/:pin', requireLibraryAccess, async (req, res) => {
  const key = req.params.pin;
  // Check if guest PIN
  let ownerKey = guestStore.get(key);
  if (!ownerKey && r2) {
    // Guest store may be empty after redeploy — not easily recoverable without owner context
  }
  if (ownerKey) {
    let data = pinStore.get(ownerKey);
    if (!data) data = await loadLibrary(ownerKey);
    if (!data) return res.json({ ok: true, books: [], updatedAt: null, readOnly: true });
    if (!pinStore.has(ownerKey)) pinStore.set(ownerKey, data);
    return res.json({ ok: true, books: data.books, updatedAt: data.updatedAt, readOnly: true });
  }
  let data = pinStore.get(key);
  if (!data) data = await loadLibrary(key);
  if (!data) return res.json({ ok: true, books: [], updatedAt: null });
  if (!pinStore.has(key)) pinStore.set(key, data);
  res.json({ ok: true, books: data.books, updatedAt: data.updatedAt });
});

app.put('/library/:pin', requireLibraryAccess, async (req, res) => {
  const key = req.params.pin;
  if (req.session.readOnly) return res.status(403).json({ ok: false, error: 'Gjestebrukere kan ikke endre biblioteket' });
  const { books, force } = req.body;
  if (!Array.isArray(books)) return res.status(400).json({ ok: false, error: 'books must be array' });
  // Beskyttelse: avvis tom oppdatering hvis det allerede ligger bøker lagret
  if (books.length === 0 && !force) {
    let existing = pinStore.get(key);
    if (!existing) existing = await loadLibrary(key);
    const existingCount = existing?.books?.length || 0;
    if (existingCount > 0) {
      return res.status(409).json({
        ok: false, error: 'refusing_empty_overwrite',
        message: `Avviser tom lagring — eksisterende bibliotek har ${existingCount} bøker. Send force=true for å overskrive.`,
        existingCount,
      });
    }
  }
  // Beskyttelse: advar hvis bok-antall faller drastisk (50%+)
  if (!force && books.length > 0) {
    let existing = pinStore.get(key);
    if (!existing) existing = await loadLibrary(key);
    const existingCount = existing?.books?.length || 0;
    if (existingCount >= 5 && books.length < existingCount / 2) {
      return res.status(409).json({
        ok: false, error: 'refusing_drastic_shrink',
        message: `Avviser stor reduksjon (${existingCount} → ${books.length}). Send force=true for å overskrive.`,
        existingCount, newCount: books.length,
      });
    }
  }
  const updatedAt = new Date().toISOString();
  pinStore.set(key, { books, updatedAt });
  await saveLibrary(key, books, updatedAt);
  res.json({ ok: true, updatedAt });
});

// List backups for a PIN
app.get('/backups/:pin', requireLibraryAccess, async (req, res) => {
  if (!r2) return res.status(503).json({ ok: false, error: 'R2 not configured' });
  const key = req.params.pin;
  const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
  try {
    const list = await r2.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: `${key}/snapshots/`, MaxKeys: 100,
    }));
    const items = (list.Contents || []).map(o => ({
      key: o.Key,
      date: o.Key.match(/library-(\d{4}-\d{2}-\d{2})\.json$/)?.[1] || null,
      size: o.Size,
      updatedAt: o.LastModified,
    })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    res.json({ ok: true, backups: items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Restore a backup as the active library
app.post('/library/:pin/restore', requireLibraryAccess, async (req, res) => {
  if (!r2) return res.status(503).json({ ok: false, error: 'R2 not configured' });
  const key = req.params.pin;
  const { snapshotKey } = req.body;
  if (!snapshotKey || !snapshotKey.startsWith(`${key}/snapshots/`)) {
    return res.status(400).json({ ok: false, error: 'invalid snapshotKey' });
  }
  if (req.session.readOnly) return res.status(403).json({ ok: false, error: 'Gjestebrukere kan ikke gjenopprette backup' });
  try {
    const data = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: snapshotKey }));
    const chunks = [];
    for await (const chunk of data.Body) chunks.push(chunk);
    const snap = JSON.parse(Buffer.concat(chunks).toString());
    const updatedAt = new Date().toISOString();
    pinStore.set(key, { books: snap.books || [], updatedAt });
    await saveLibrary(key, snap.books || [], updatedAt);
    res.json({ ok: true, restored: (snap.books || []).length, updatedAt });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /library/:pin/devices — hent Kindle-enheter
app.get('/library/:pin/devices', requireLibraryAccess, async (req, res) => {
  if (!r2) return res.json({ ok: true, devices: [] });
  const key = req.params.pin;
  try {
    const data = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: `${key}/devices.json` }));
    const chunks = [];
    for await (const chunk of data.Body) chunks.push(chunk);
    const json = JSON.parse(Buffer.concat(chunks).toString());
    res.json({ ok: true, devices: json.devices || [] });
  } catch(_) { res.json({ ok: true, devices: [] }); }
});

// PUT /library/:pin/devices — lagre Kindle-enheter
app.put('/library/:pin/devices', requireLibraryAccess, async (req, res) => {
  if (!r2) return res.status(503).json({ ok: false, error: 'R2 not configured' });
  if (req.session.readOnly) return res.status(403).json({ ok: false, error: 'Gjestebrukere kan ikke endre enheter' });
  const key = req.params.pin;
  const { devices } = req.body;
  if (!Array.isArray(devices)) return res.status(400).json({ ok: false, error: 'devices must be array' });
  try {
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET, Key: `${key}/devices.json`,
      Body: JSON.stringify({ devices }), ContentType: 'application/json',
    }));
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// R2 File upload - lagre epub permanent
app.post('/files/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!r2) return res.status(503).json({ ok: false, error: 'R2 not configured' });
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file' });
  const { pin, bookId } = req.body;
  if (!pin || !bookId) return res.status(400).json({ ok: false, error: 'Missing pin or bookId' });
  if (pin !== req.session.libraryKey) return res.status(403).json({ ok: false, error: 'Ingen tilgang' });

  const key = hashPin(pin) + '/' + bookId + '/' + req.file.originalname;
  try {
    await r2.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));
    res.json({ ok: true, key, fileName: req.file.originalname, size: req.file.size });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// R2 Get signed download URL
app.get('/files/url/:pin/:bookId/:fileName', requireAuth, async (req, res) => {
  if (!r2) return res.status(503).json({ ok: false, error: 'R2 not configured' });
  const { pin, bookId, fileName } = req.params;
  if (pin !== req.session.libraryKey) return res.status(403).json({ ok: false, error: 'Ingen tilgang' });
  const key = hashPin(pin) + '/' + bookId + '/' + fileName;
  try {
    const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });
    res.json({ ok: true, url });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// R2 Stream file directly (for Kindle sending and cover images)
// Cover images (.jpg/.png/.webp) are served without session auth — the pin hash in the URL
// provides path-level security; these are not sensitive files.
// All other files (epub, pdf, etc.) require a valid session.
app.get('/files/download/:pin/:bookId/:fileName', async (req, res) => {
  if (!r2) return res.status(503).json({ ok: false, error: 'R2 not configured' });
  const { pin, bookId, fileName } = req.params;
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const isImage = ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext);
  if (!isImage) {
    const token = req.headers['x-auth-token'];
    if (!token) return res.status(401).json({ ok: false, error: 'Innlogging påkrevd' });
    const session = await getSession(token);
    if (!session) return res.status(401).json({ ok: false, error: 'Ugyldig eller utløpt sesjon' });
    if (session.libraryKey !== pin) return res.status(403).json({ ok: false, error: 'Ingen tilgang' });
  }
  const key = hashPin(pin) + '/' + bookId + '/' + fileName;
  try {
    const data = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    res.setHeader('Content-Type', data.ContentType || 'application/octet-stream');
    if (!isImage) res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
    data.Body.pipe(res);
  } catch (err) {
    res.status(404).json({ ok: false, error: 'File not found' });
  }
});

// Send to Kindle - hent fra R2 og send via Nodemailer (Gmail)
app.post('/send-to-kindle', requireAuth, upload.single('file'), async (req, res) => {
  try {
    const { toEmail, bookTitle, pin, bookId, fileName } = req.body;
    if (!toEmail) return res.status(400).json({ ok: false, error: 'No target email' });
    if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
      return res.status(503).json({ ok: false, error: 'E-post ikke konfigurert (GMAIL_USER / GMAIL_APP_PASSWORD mangler)' });
    }

    let fileBuffer, fileOriginalName, fileMime;

    if (req.file) {
      fileBuffer = req.file.buffer;
      fileOriginalName = req.file.originalname;
      fileMime = req.file.mimetype;
    } else if (r2 && pin && bookId && fileName) {
      const key = hashPin(pin) + '/' + bookId + '/' + fileName;
      const data = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      const chunks = [];
      for await (const chunk of data.Body) chunks.push(chunk);
      fileBuffer = Buffer.concat(chunks);
      fileOriginalName = fileName;
      fileMime = data.ContentType || 'application/epub+zip';
    } else {
      return res.status(400).json({ ok: false, error: 'No file provided' });
    }

    // Bygg filnavn fra boktittel — normaliser ÆØÅ så Kindle viser riktig tittel
    let attachmentName = fileOriginalName;
    if (bookTitle && bookTitle.trim()) {
      const ext = (fileOriginalName.match(/\.[a-z0-9]+$/i) || ['.epub'])[0];
      const safe = bookTitle.trim()
        .replace(/[æ]/g,'ae').replace(/[Æ]/g,'Ae')
        .replace(/[ø]/g,'oe').replace(/[Ø]/g,'Oe')
        .replace(/[å]/g,'aa').replace(/[Å]/g,'Aa')
        .replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').slice(0, 100);
      if (safe) attachmentName = safe + ext;
    }

    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: toEmail,
      subject: 'Convert',
      text: 'Bok sendt fra Bibliothek: ' + (bookTitle || fileOriginalName),
      attachments: [{
        filename: attachmentName,
        content: fileBuffer,
        contentType: fileMime,
      }],
    });

    res.json({ ok: true, message: 'Sent to ' + toEmail });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// AI chat proxy (non-streaming fallback)
app.post('/ai-chat', requireAuth, async (req, res) => {
  try {
    const { systemPrompt, messages } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ ok: false, error: 'No API key' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system: systemPrompt, messages })
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ ok: false, error: data.error?.message || 'API error' });
    const text = data.content && data.content[0] && data.content[0].text;
    if (!text) return res.status(500).json({ ok: false, error: 'Empty response' });
    res.json({ ok: true, text });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// AI chat — streaming versjon (Server-Sent Events) for raskere oppfattet hastighet
app.post('/ai-chat-stream', requireAuth, async (req, res) => {
  try {
    const { systemPrompt, messages } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ ok: false, error: 'No API key' });
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        system: systemPrompt,
        messages,
        stream: true
      })
    });

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      res.write('event: error\ndata: ' + JSON.stringify({ status: upstream.status, body: errBody.slice(0, 500) }) + '\n\n');
      res.end();
      return;
    }

    // upstream.body er Web ReadableStream i Node 18+ — bruk getReader-loop
    const reader = upstream.body.getReader();
    let aborted = false;
    req.on('close', () => { aborted = true; try { reader.cancel(); } catch(_) {} });

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (aborted) break;
        res.write(Buffer.from(value));
        if (typeof res.flush === 'function') res.flush();
      }
    } catch (e) {
      try { res.write('event: error\ndata: ' + JSON.stringify({ error: e.message }) + '\n\n'); } catch(_) {}
    } finally {
      res.end();
    }
  } catch (err) {
    try {
      res.write('event: error\ndata: ' + JSON.stringify({ error: err.message }) + '\n\n');
    } catch(_) {}
    res.end();
  }
});

// ebok.no series proxy (CORS workaround)
app.get('/series-proxy', requireAuth, async (req, res) => {
  const { title, author } = req.query;
  if (!title) return res.json({ ok: false });
  try {
    const q = encodeURIComponent((title + (author ? ' ' + author : '')).slice(0, 80));
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'nb-NO,nb;q=0.9,no;q=0.8',
    };

    // ebok.no book pages: /eboker/<category>/<slug>/ or /lydboker/<category>/<slug>/
    // Use ebok.no without www to skip an HTTP redirect hop
    const searchUrl = `https://ebok.no/search/?q=${q}`;
    const searchHtml = await fetch(searchUrl, { headers, redirect: 'follow' }).then(r => r.text());

    // Map ebok.no URL category slugs → app-genre buckets
    const slugToGenre = (slug) => {
      const s = (slug || '').toLowerCase();
      if (/krim|detektiv|mystikk|whodunit/.test(s)) return 'Krim';
      if (/thriller|spenning|suspense/.test(s))     return 'Thriller';
      if (/science[- ]?fiction|sci[- ]?fi|dystopi/.test(s)) return 'Sci-Fi';
      if (/fantasy|eventyr/.test(s))                return 'Fantasy';
      if (/biografi|memoar|selvbiografi/.test(s))   return 'Biografi';
      if (/humor|satir|komedi/.test(s))             return 'Humor';
      if (/sakprosa|historie|filosofi|samfunn|politikk|religion|psykologi|selvhjelp|kokebok|mat|reise|dokumentar|natur|helse|vitenskap|okonomi|business/.test(s)) return 'Sakprosa';
      if (/roman|skjonn|skjønn|novelle|fortelling|barn|ungdom|kjaerlighet|kjærlighet|romantikk|romanse/.test(s)) return 'Roman';
      return null;
    };

    const linkMatches = [...searchHtml.matchAll(/href="(\/(?:eboker|lydboker)\/([a-z0-9\-]+)\/[a-z0-9\-]+\/)"/gi)];
    const seenPaths = new Set();
    let firstGenre = null;
    for (const lm of linkMatches) {
      const path = lm[1];
      const categorySlug = lm[2];
      if (seenPaths.has(path)) continue;
      seenPaths.add(path);
      if (!firstGenre) firstGenre = slugToGenre(categorySlug);
      if (seenPaths.size > 4) break;

      try {
        const pageHtml = await fetch('https://ebok.no' + path, { headers, redirect: 'follow' }).then(r => r.text());

        // Primary: dataLayer JS object embedded in page (most reliable)
        // Example: dataLayer = [{"author": "...", "series": "Torsdagsmordklubben", ...}];
        let series = null;
        const dlMatch = pageHtml.match(/dataLayer\s*=\s*\[\s*(\{[\s\S]*?\})\s*\]\s*;/);
        if (dlMatch) {
          try {
            const obj = JSON.parse(dlMatch[1]);
            if (obj.series && typeof obj.series === 'string') series = obj.series.trim();
          } catch(e) {}
        }

        // Fallback: parse "Serie" row in book_info table
        if (!series) {
          const seriesMatch =
            pageHtml.match(/<span[^>]*class="[^"]*coltable__th[^"]*"[^>]*>[Ss]erie<\/span>\s*<span[^>]*class="[^"]*coltable__td[^"]*"[^>]*>(?:<a[^>]*>)?([^<]{2,80})/i) ||
            pageHtml.match(/<th[^>]*>[Ss]erie<\/th>\s*<td[^>]*>(?:<a[^>]*>)?([^<]{2,80})/i);
          if (seriesMatch) series = seriesMatch[1].trim();
        }

        if (!series) continue;

        // Series number — only present in some book_info tables
        let seriesNum = null;
        const numMatch =
          pageHtml.match(/<span[^>]*class="[^"]*coltable__th[^"]*"[^>]*>Nummer i serie<\/span>\s*<span[^>]*class="[^"]*coltable__td[^"]*"[^>]*>\s*(\d+)/i) ||
          pageHtml.match(/<th[^>]*>Nummer i serie<\/th>\s*<td[^>]*>\s*(\d+)/i);
        if (numMatch) seriesNum = parseInt(numMatch[1]);

        const pageGenre = slugToGenre(path.split('/')[2]);
        return res.json({ ok: true, series, seriesNum, genre: pageGenre || firstGenre || null });
      } catch(e) { continue; }
    }
    res.json({ ok: true, series: null, genre: firstGenre || null });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bibliothek server on port ' + PORT));
