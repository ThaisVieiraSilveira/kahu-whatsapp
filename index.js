const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let currentQR = null;
let isConnected = false;

async function connectWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = await qrcode.toDataURL(qr);
      isConnected = false;
      console.log('QR Code gerado');
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('Conexão fechada. Reconectando:', shouldReconnect);
      if (shouldReconnect) {
        setTimeout(connectWhatsApp, 3000);
      }
    }

    if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('WhatsApp conectado!');
    }
  });
}

// ── Rotas ────────────────────────────────────────────────────

// Status + QR Code
app.get('/status', (req, res) => {
  res.json({
    connected: isConnected,
    qr: currentQR,
  });
});

// Página HTML para escanear QR
app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="pt-BR">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Kahu Care — WhatsApp</title>
      <style>
        body { font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; background: #f0fdf4; margin: 0; }
        h1 { color: #065f46; }
        img { width: 280px; border-radius: 16px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
        .connected { font-size: 2rem; color: #059669; font-weight: bold; }
        .waiting { color: #6b7280; }
        button { margin-top: 20px; padding: 12px 24px; background: #059669; color: white; border: none; border-radius: 8px; cursor: pointer; font-size: 1rem; }
      </style>
      <script>
        async function check() {
          const res = await fetch('/status');
          const data = await res.json();
          if (data.connected) {
            document.getElementById('content').innerHTML = '<div class="connected">✅ WhatsApp Conectado!</div>';
          } else if (data.qr) {
            document.getElementById('content').innerHTML = '<p class="waiting">Escaneie o QR Code com o WhatsApp:</p><img src="' + data.qr + '" />';
          } else {
            document.getElementById('content').innerHTML = '<p class="waiting">Aguardando QR Code...</p>';
          }
        }
        check();
        setInterval(check, 3000);
      </script>
    </head>
    <body>
      <h1>🐾 Kahu Care — WhatsApp</h1>
      <div id="content"><p class="waiting">Carregando...</p></div>
    </body>
    </html>
  `);
});

// Enviar mensagem para um número
app.post('/send', async (req, res) => {
  const { phone, message } = req.body;

  if (!isConnected) {
    return res.status(503).json({ error: 'WhatsApp não conectado' });
  }
  if (!phone || !message) {
    return res.status(400).json({ error: 'phone e message são obrigatórios' });
  }

  try {
    const jid = `55${phone.replace(/\D/g, '')}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ status: 'ok', phone });
  } catch (e) {
    console.error('Erro ao enviar:', e);
    res.status(500).json({ error: e.message });
  }
});

// Enviar para vários números de uma vez
app.post('/send-bulk', async (req, res) => {
  const { messages } = req.body;
  // messages = [{ phone: '11999999999', message: 'texto' }, ...]

  if (!isConnected) {
    return res.status(503).json({ error: 'WhatsApp não conectado' });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages deve ser um array' });
  }

  const results = [];
  for (const item of messages) {
    try {
      const jid = `55${item.phone.replace(/\D/g, '')}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text: item.message });
      results.push({ phone: item.phone, status: 'ok' });
      // Delay de 1.5s entre mensagens para não ser bloqueado
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      results.push({ phone: item.phone, status: 'erro', error: e.message });
    }
  }

  res.json({ results });
});

// ── Iniciar ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  connectWhatsApp();
});
