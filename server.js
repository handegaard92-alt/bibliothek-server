const express    = require('express');
const cors       = require('cors');
const sgMail     = require('@sendgrid/mail');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

const SENDGRID_API_KEY  = process.env.SENDGRID_API_KEY;
const FROM_EMAIL        = process.env.FROM_EMAIL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ALLOWED_ORIGIN    = process.env.ALLOWED_ORIGIN || '*';

if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY);

app.use(cors({ origin: ALLOWED_ORIGIN, methods: ['GET','POST','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '200kb' }));

// Serve bibliothek.html from /public at root
app.get('/', (req, res) => {
  const p = path.join(__dirname, 'public', 'bibliothek.html');
  fs.existsSync(p) ? res.sendFile(p) : res.json({ status: 'ok', note: 'Place bibliothek.html in /public/' });
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({
  status: 'ok',
  features: { app: fs.existsSync(path.join(__dirname,'public','bibliothek.html')), kindle: !!SENDGRID_API_KEY, ai: !!ANTHROPIC_API_KEY }
}));

app.post('/ai-chat', async (req, res) => {
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ ok: false, error: 'Mangler ANTHROPIC_API_KEY' });
  const { systemPrompt, messages } = req.body;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ ok: false, error: 'Mangler messages' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 1024, system: systemPrompt || '', messages }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ ok: false, error: data?.error?.message || 'Feil fra Anthropic' });
    res.json({ ok: true, text: data?.content?.find(b => b.type === 'text')?.text || '' });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.post('/send-to-kindle', upload.single('file'), async (req, res) => {
  if (!SENDGRID_API_KEY || !FROM_EMAIL) return res.status(503).json({ ok: false, error: 'E-post ikke konfigurert' });
  try {
    const { toEmail, bookTitle, bookAuthor } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ ok: false, error: 'Ingen fil' });
    if (!toEmail?.includes('@')) return res.status(400).json({ ok: false, error: 'Ugyldig Kindle-adresse' });
    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.epub','.mobi','.azw3','.azw','.pdf'].includes(ext)) return res.status(400).json({ ok: false, error: 'Filtype ikke støttet' });
    const title = bookTitle || path.basename(file.originalname, ext);
    await sgMail.send({
      to: toEmail, from: FROM_EMAIL, subject: `Convert: ${title}`,
      text: `Vedlagt: ${title}${bookAuthor ? ' av ' + bookAuthor : ''}\n\nSendt fra Bibliothek.`,
      attachments: [{ content: file.buffer.toString('base64'), filename: file.originalname, type: file.mimetype || 'application/octet-stream', disposition: 'attachment' }],
    });
    res.json({ ok: true, message: `Sendt til ${toEmail}` });
  } catch (err) { res.status(500).json({ ok: false, error: err?.response?.body?.errors?.[0]?.message || err.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bibliothek pa port ${PORT} | App: ${fs.existsSync(path.join(__dirname,'public','bibliothek.html'))?'OK':'MANGLER'} | Kindle: ${SENDGRID_API_KEY?'OK':'MANGLER'} | AI: ${ANTHROPIC_API_KEY?'OK':'MANGLER'}`);
});
