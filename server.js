const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
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
  res.json({
    status: 'ok',
    features: {
      app: fs.existsSync(path.join(publicDir, 'bibliothek.html')),
      kindle: !!(process.env.SENDGRID_API_KEY && process.env.FROM_EMAIL),
      ai: !!process.env.ANTHROPIC_API_KEY,
      r2: !!r2,
      sync: true
    }
  });
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
  await r2.send(new PutObjectCommand({
    Bucket: BUCKET, Key: `${key}/library.json`,
    Body: JSON.stringify({ books, updatedAt }), ContentType: 'application/json',
  })).catch(e => console.warn('R2 library save failed:', e.message));
}

app.get('/library/:pin', async (req, res) => {
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

app.put('/library/:pin', async (req, res) => {
  const key = req.params.pin;
  const { books } = req.body;
  if (!Array.isArray(books)) return res.status(400).json({ ok: false, error: 'books must be array' });
  const updatedAt = new Date().toISOString();
  pinStore.set(key, { books, updatedAt });
  await saveLibrary(key, books, updatedAt);
  res.json({ ok: true, updatedAt });
});

// R2 File upload - lagre epub permanent
app.post('/files/upload', upload.single('file'), async (req, res) => {
  if (!r2) return res.status(503).json({ ok: false, error: 'R2 not configured' });
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file' });
  const { pin, bookId } = req.body;
  if (!pin || !bookId) return res.status(400).json({ ok: false, error: 'Missing pin or bookId' });

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
app.get('/files/url/:pin/:bookId/:fileName', async (req, res) => {
  if (!r2) return res.status(503).json({ ok: false, error: 'R2 not configured' });
  const { pin, bookId, fileName } = req.params;
  const key = hashPin(pin) + '/' + bookId + '/' + fileName;
  try {
    const url = await getSignedUrl(r2, new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: 3600 });
    res.json({ ok: true, url });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// R2 Stream file directly (for Kindle sending)
app.get('/files/download/:pin/:bookId/:fileName', async (req, res) => {
  if (!r2) return res.status(503).json({ ok: false, error: 'R2 not configured' });
  const { pin, bookId, fileName } = req.params;
  const key = hashPin(pin) + '/' + bookId + '/' + fileName;
  try {
    const data = await r2.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    res.setHeader('Content-Type', data.ContentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '"');
    data.Body.pipe(res);
  } catch (err) {
    res.status(404).json({ ok: false, error: 'File not found' });
  }
});

// Send to Kindle - hent fra R2 og send via SendGrid
app.post('/send-to-kindle', upload.single('file'), async (req, res) => {
  try {
    const { toEmail, bookTitle, pin, bookId, fileName } = req.body;
    if (!toEmail) return res.status(400).json({ ok: false, error: 'No target email' });
    if (!process.env.SENDGRID_API_KEY) return res.status(503).json({ ok: false, error: 'SendGrid not configured' });

    let fileBuffer, fileOriginalName, fileMime;

    if (req.file) {
      // Direkte opplastet fil
      fileBuffer = req.file.buffer;
      fileOriginalName = req.file.originalname;
      fileMime = req.file.mimetype;
    } else if (r2 && pin && bookId && fileName) {
      // Hent fra R2
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

    // Build attachment filename from bookTitle so Kindle shows title, not ISBN
    let attachmentName = fileOriginalName;
    if (bookTitle && bookTitle.trim()) {
      const ext = (fileOriginalName.match(/\.[a-z0-9]+$/i) || ['.epub'])[0];
      const safe = bookTitle.trim().replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').slice(0, 100);
      if (safe) attachmentName = safe + ext;
    }

    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    await sgMail.send({
      to: toEmail,
      from: process.env.FROM_EMAIL,
      subject: 'Convert',
      text: 'Bok sendt fra Bibliothek: ' + (bookTitle || fileOriginalName),
      attachments: [{
        content: fileBuffer.toString('base64'),
        filename: attachmentName,
        type: fileMime,
        disposition: 'attachment'
      }]
    });
    res.json({ ok: true, message: 'Sent to ' + toEmail });
  } catch (err) {
    const msg = err.response?.body?.errors?.[0]?.message || err.message;
    res.status(500).json({ ok: false, error: msg });
  }
});

// AI chat proxy
app.post('/ai-chat', async (req, res) => {
  try {
    const { systemPrompt, messages } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ ok: false, error: 'No API key' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 1024, system: systemPrompt, messages })
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

// ebok.no series proxy (CORS workaround)
app.get('/series-proxy', async (req, res) => {
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
