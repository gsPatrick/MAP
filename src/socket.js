// src/socket.js
// WebSocket (Socket.IO) para atualizações em tempo real do painel de afiliados.
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('./utils/authUtils');

let io = null;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
    path: '/socket.io',
  });

  io.on('connection', (socket) => {
    // Autentica pelo mesmo JWT do REST (passado em auth.token).
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    let decoded = null;
    try { if (token) decoded = jwt.verify(token, JWT_SECRET); } catch { decoded = null; }
    if (!decoded) { socket.disconnect(true); return; }

    const isAdmin = decoded.type === 'user_admin' || !decoded.type;
    const isClient = decoded.type === 'client' || decoded.type === 'client_shared_access';

    // Afiliado entra automaticamente na própria sala.
    if (isClient) {
      const cid = decoded.type === 'client_shared_access' ? decoded.ownerClientId : decoded.id;
      if (cid) socket.join(`affiliate:${cid}`);
    }

    // Admin pode "observar" a sala de qualquer afiliado (ao abrir o detalhe).
    if (isAdmin) {
      socket.on('watch-affiliate', (affiliateId) => {
        const id = parseInt(affiliateId, 10);
        if (id) socket.join(`affiliate:${id}`);
      });
      socket.on('unwatch-affiliate', (affiliateId) => {
        const id = parseInt(affiliateId, 10);
        if (id) socket.leave(`affiliate:${id}`);
      });
    }
  });

  console.log('[SOCKET] Socket.IO inicializado.');
  return io;
}

// Notifica a sala do afiliado que algo mudou (lead, comissão, saque, saldo...).
function emitAffiliateUpdate(affiliateClientId, payload = {}) {
  try {
    if (!io || !affiliateClientId) return;
    io.to(`affiliate:${affiliateClientId}`).emit('affiliate:update', {
      affiliateClientId,
      ...payload,
      at: Date.now(),
    });
  } catch (e) {
    console.error('[SOCKET] Falha ao emitir affiliate:update:', e.message);
  }
}

module.exports = { initSocket, emitAffiliateUpdate, getIo: () => io };
