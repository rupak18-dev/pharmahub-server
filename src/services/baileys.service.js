import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode";
import pino from "pino";
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { Boom } from "@hapi/boom";

import { logger } from "../core/logger.js";
import { Integration } from "../models/Integration.js";
import { normalizePhone } from "../utils/phone.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SESSIONS_DIR = path.resolve(__dirname, "../../storage/whatsapp_sessions");

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// In-memory active sockets and state per tenant
// Key: tenantId (string) -> { sock, qrCode, status, phone, reconnectAttempts }
const activeSessions = new Map();

function safeTenantKey(tenantId) {
  return String(tenantId || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
}

function getSessionPath(tenantId) {
  return path.join(SESSIONS_DIR, safeTenantKey(tenantId));
}

export function hasSavedSession(tenantId) {
  const sessionPath = getSessionPath(tenantId);
  return fs.existsSync(sessionPath) && fs.existsSync(path.join(sessionPath, "creds.json"));
}

export function getSessionStatus(tenantId) {
  const mem = activeSessions.get(tenantId);
  if (mem?.sock && mem.status === "connected") {
    return {
      status: "connected",
      phone: mem.phone,
      qrCode: null,
      connectedAt: mem.connectedAt,
    };
  }
  if (mem?.status === "connecting" || mem?.status === "qr_ready") {
    return {
      status: mem.status,
      phone: null,
      qrCode: mem.qrCode ?? null,
      connectedAt: null,
    };
  }
  if (hasSavedSession(tenantId)) {
    return {
      status: "disconnected",
      phone: mem?.phone ?? null,
      qrCode: null,
      savedSessionExists: true,
    };
  }
  return {
    status: "disconnected",
    phone: null,
    qrCode: null,
    savedSessionExists: false,
  };
}

export function isSessionConnected(tenantId) {
  const mem = activeSessions.get(tenantId);
  return Boolean(mem?.sock && mem.status === "connected");
}

/**
 * Initializes or reconnects a Baileys WhatsApp Web socket for the given tenant.
 */
export async function initWhatsAppSession(tenantId, { forceNew = false, reconnectAttempts = 0 } = {}) {
  const key = String(tenantId);
  let mem = activeSessions.get(key);

  if (mem?.sock && mem.status === "connected" && !forceNew) {
    return getSessionStatus(key);
  }

  // Clean up any existing socket instance to avoid duplicate listeners or dangling connections
  if (mem?.sock) {
    try {
      mem.sock.ev.removeAllListeners("connection.update");
      mem.sock.ev.removeAllListeners("creds.update");
      mem.sock.end?.();
    } catch {
      // Ignore cleanup error
    }
  }

  const sessionPath = getSessionPath(key);
  if (forceNew && fs.existsSync(sessionPath)) {
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    } catch (err) {
      logger.warn(`[Baileys] Error removing old session files for ${key}: ${err.message}`);
    }
  }

  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
  const { version, isLatest } = await fetchLatestBaileysVersion().catch(() => ({
    version: [2, 3000, 1015901307],
    isLatest: false,
  }));

  logger.info(`[Baileys] Starting WhatsApp socket (tenant: ${key}, v${version.join(".")}, latest: ${isLatest})`);

  const pinoLogger = pino({ level: "silent" });

  const sock = makeWASocket({
    version,
    logger: pinoLogger,
    printQRInTerminal: false,
    auth: state,
    generateHighQualityLinkPreview: true,
    syncFullHistory: false,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  mem = {
    sock,
    qrCode: null,
    status: "connecting",
    phone: null,
    connectedAt: null,
    reconnectAttempts,
  };
  activeSessions.set(key, mem);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        mem.qrCode = await qrcode.toDataURL(qr);
        mem.status = "qr_ready";
        logger.info(`[Baileys] QR generated for tenant: ${key}`);
      } catch (err) {
        logger.error(`[Baileys] Error generating QR data URL: ${err.message}`);
      }
    }

    if (connection === "open") {
      mem.status = "connected";
      mem.qrCode = null;
      mem.connectedAt = new Date();
      mem.reconnectAttempts = 0;

      // sock.user?.id is like "919876543210:1@s.whatsapp.net"
      const rawId = sock.user?.id ?? "";
      const cleaned = rawId.split(":")[0]?.replace(/[^0-9]/g, "");
      mem.phone = cleaned ? `+${cleaned}` : "Connected";

      logger.info(`[Baileys] Connection opened successfully for tenant ${key} (Phone: ${mem.phone})`);

      // Persist in Integration model
      try {
        await Integration.findOneAndUpdate(
          { tenantId: key, key: "whatsapp" },
          {
            $set: {
              name: "WhatsApp Business (Web Session)",
              connected: true,
              configured: true,
              lastSync: new Date(),
              connectedAt: new Date(),
              "config.phone": mem.phone,
              "config.authMethod": "baileys",
              lastError: null,
            },
          },
          { upsert: true, new: true },
        );
      } catch (err) {
        logger.error(`[Baileys] Failed to update Integration model: ${err.message}`);
      }
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect?.error?.output?.statusCode
        : lastDisconnect?.error?.status;

      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isQrTimeout = statusCode === 408 || statusCode === DisconnectReason.timedOut;
      const wasConnected = mem.status === "connected" || Boolean(mem.phone);

      // Only auto-reconnect if session was legitimately connected or not a QR timeout
      const shouldReconnect = !isLoggedOut && (!isQrTimeout || wasConnected);
      logger.warn(
        `[Baileys] Connection closed for tenant ${key} (code: ${statusCode}, shouldReconnect: ${shouldReconnect})`,
      );

      mem.status = "disconnected";
      mem.qrCode = null;

      if (!shouldReconnect) {
        if (isLoggedOut) {
          // Logged out: remove session files and update db
          logger.info(`[Baileys] Logged out from WhatsApp on tenant ${key}`);
          if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
          }
          activeSessions.delete(key);
          await Integration.updateOne(
            { tenantId: key, key: "whatsapp" },
            {
              $set: {
                connected: false,
                disconnectedAt: new Date(),
                lastError: "Session logged out by device",
              },
            },
          ).catch(() => {});
        } else if (isQrTimeout && !wasConnected) {
          logger.info(`[Baileys] QR code expired for tenant ${key} — stopping reconnect loop`);
        }
      } else {
        // Attempt reconnection with exponential backoff (up to 5 attempts)
        const nextAttempt = (mem.reconnectAttempts || 0) + 1;
        mem.reconnectAttempts = nextAttempt;
        if (nextAttempt <= 5) {
          const delay = Math.min(nextAttempt * 3000, 15000);
          logger.info(`[Baileys] Scheduling reconnect #${nextAttempt} in ${delay}ms for tenant ${key}`);
          setTimeout(() => {
            initWhatsAppSession(key, { reconnectAttempts: nextAttempt }).catch((err) => {
              logger.error(`[Baileys] Reconnect failed for tenant ${key}: ${err.message}`);
            });
          }, delay);
        } else {
          logger.warn(`[Baileys] Max reconnect attempts (5) reached for tenant ${key}. Stopped.`);
        }
      }
    }
  });

  return getSessionStatus(key);
}

/**
 * Cleanly logs out and clears stored session credentials for a tenant.
 */
export async function logoutWhatsAppSession(tenantId) {
  const key = String(tenantId);
  const mem = activeSessions.get(key);

  if (mem?.sock) {
    try {
      await mem.sock.logout().catch(() => {});
    } catch {
      // Ignore
    }
  }

  activeSessions.delete(key);

  const sessionPath = getSessionPath(key);
  if (fs.existsSync(sessionPath)) {
    try {
      fs.rmSync(sessionPath, { recursive: true, force: true });
    } catch (err) {
      logger.warn(`[Baileys] Could not delete session folder: ${err.message}`);
    }
  }

  await Integration.updateOne(
    { tenantId: key, key: "whatsapp" },
    {
      $set: {
        connected: false,
        disconnectedAt: new Date(),
        "config.phone": null,
        lastError: null,
      },
    },
  ).catch(() => {});

  return { ok: true, status: "disconnected" };
}

/**
 * Normalize phone number to Baileys WhatsApp JID format (e.g. 919876543210@s.whatsapp.net)
 */
export function formatWhatsAppJid(phone) {
  if (!phone) return null;
  const normalized = normalizePhone(phone);
  const digits = String(normalized).replace(/[^0-9]/g, "");
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

/**
 * Sends a WhatsApp message and optional PDF document via active Baileys socket.
 */
export async function sendBaileysMessage(tenantId, { to, text, documentPath, documentFilename, caption }) {
  const key = String(tenantId);
  const mem = activeSessions.get(key);

  if (!mem?.sock || mem.status !== "connected") {
    return {
      ok: false,
      errorCode: "not_connected",
      errorMessage: "WhatsApp Web session is not connected",
    };
  }

  const jid = formatWhatsAppJid(to);
  if (!jid) {
    return {
      ok: false,
      errorCode: "invalid_number",
      errorMessage: "Invalid recipient phone number",
    };
  }

  try {
    let result;

    if (documentPath && fs.existsSync(documentPath)) {
      const buffer = fs.readFileSync(documentPath);
      result = await mem.sock.sendMessage(jid, {
        document: buffer,
        mimetype: "application/pdf",
        fileName: documentFilename || "Invoice.pdf",
        caption: caption || text || undefined,
      });
    } else if (text) {
      result = await mem.sock.sendMessage(jid, { text });
    } else {
      return {
        ok: false,
        errorCode: "empty_message",
        errorMessage: "No text or document provided to send",
      };
    }

    const messageId = result?.key?.id ?? `baileys_${Date.now()}`;
    logger.info(`[Baileys] Message sent successfully to ${jid} (ID: ${messageId})`);

    return {
      ok: true,
      messageId,
    };
  } catch (err) {
    logger.error(`[Baileys] Error sending message to ${jid}: ${err.message}`);
    return {
      ok: false,
      errorCode: "send_error",
      errorMessage: err.message || "Failed to send WhatsApp message",
    };
  }
}

/**
 * On server startup: automatically restore any previously saved sessions.
 */
export async function autoRestoreSessions() {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const credsFile = path.join(SESSIONS_DIR, entry.name, "creds.json");
        if (fs.existsSync(credsFile)) {
          logger.info(`[Baileys] Auto-restoring session for tenant: ${entry.name}`);
          initWhatsAppSession(entry.name).catch((err) => {
            logger.warn(`[Baileys] Failed to auto-restore session ${entry.name}: ${err.message}`);
          });
        }
      }
    }
  } catch (err) {
    logger.error(`[Baileys] Error during auto-restore: ${err.message}`);
  }
}
