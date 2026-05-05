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

// Serve app
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
app.get('/', (req, res) => {
  const f = path.join(publicDir, 'bibliothek.html');
  if (fs.existsSync(f)) res.sendFile(f);
  else res.json({ status: 'ok', note: 'Place bibliothek.html in /public/' });
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

app.post('/guest-link', (req, res) => {
  const { ownerPin, guestPin } = req.body;
  if (!ownerPin || !guestPin) return res.status(400).json({ ok: false, error: 'ownerPin og guestPin er påkrevd' });
  // App sender allerede hashede nøkler (window._pinKey / pinHash(rawPin))
  const ownerKey = ownerPin;
  const guestKey = guestPin;
  if (!pinStore.has(ownerKey)) return res.status(404).json({ ok: false, error: 'Eier-bibliotek ikke funnet' });
  guestStore.set(guestKey, ownerKey);
  res.json({ ok: true, message: 'Gjeste-PIN opprettet' });
});

app.get('/library/:pin', (req, res) => {
  const key = req.params.pin; // App sender allerede hashet PIN
  // Sjekk om dette er en gjeste-PIN
  const ownerKey = guestStore.get(key);
  if (ownerKey) {
    const data = pinStore.get(ownerKey);
    if (!data) return res.json({ ok: true, books: [], updatedAt: null, readOnly: true });
    return res.json({ ok: true, books: data.books, updatedAt: data.updatedAt, readOnly: true });
  }
  const data = pinStore.get(key);
  if (!data) return res.json({ ok: true, books: [], updatedAt: null });
  res.json({ ok: true, books: data.books, updatedAt: data.updatedAt });
});

app.put('/library/:pin', (req, res) => {
  const key = req.params.pin; // App sender allerede hashet PIN
  const { books } = req.body;
  if (!Array.isArray(books)) return res.status(400).json({ ok: false, error: 'books must be array' });
  pinStore.set(key, { books, updatedAt: new Date().toISOString() });
  res.json({ ok: true, updatedAt: pinStore.get(key).updatedAt });
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

    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);
    await sgMail.send({
      to: toEmail,
      from: process.env.FROM_EMAIL,
      subject: 'Convert',
      text: 'Bok sendt fra Bibliothek: ' + (bookTitle || fileOriginalName),
      attachments: [{
        content: fileBuffer.toString('base64'),
        filename: fileOriginalName,
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
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: systemPrompt, messages })
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bibliothek server on port ' + PORT));
