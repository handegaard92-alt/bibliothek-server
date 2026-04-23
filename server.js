const express = require('express');
const multer  = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve bibliothek.html from /public
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
      ai: !!process.env.ANTHROPIC_API_KEY
    }
  });
});

// AI chat proxy
app.post('/ai-chat', async (req, res) => {
  try {
    const { systemPrompt, messages } = req.body;
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ ok: false, error: 'No API key' });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: systemPrompt,
        messages: messages
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ ok: false, error: data.error?.message || 'API error' });

    const text = data.content && data.content[0] && data.content[0].text;
    if (!text) return res.status(500).json({ ok: false, error: 'Empty response from AI' });

    res.json({ ok: true, text });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Send to Kindle via SendGrid
app.post('/send-to-kindle', upload.single('file'), async (req, res) => {
  try {
    const { toEmail, bookTitle, bookAuthor } = req.body;
    if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });
    if (!toEmail) return res.status(400).json({ ok: false, error: 'No target email' });
    if (!process.env.SENDGRID_API_KEY) return res.status(503).json({ ok: false, error: 'SendGrid not configured' });

    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);

    await sgMail.send({
      to: toEmail,
      from: process.env.FROM_EMAIL,
      subject: 'Convert',
      text: 'Bok sendt fra Bibliothek: ' + (bookTitle || req.file.originalname),
      attachments: [{
        content: req.file.buffer.toString('base64'),
        filename: req.file.originalname,
        type: req.file.mimetype,
        disposition: 'attachment'
      }]
    });

    res.json({ ok: true, message: 'Sent to ' + toEmail });
  } catch (err) {
    const msg = err.response?.body?.errors?.[0]?.message || err.message;
    res.status(500).json({ ok: false, error: msg });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Bibliothek server running on port ' + PORT));
