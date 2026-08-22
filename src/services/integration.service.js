import mongoose from "mongoose";

import { ApiError } from "../core/ApiError.js";
import { Integration } from "../models/Integration.js";
import { findIntegrationMeta } from "../config/integrationCatalog.js";
import { isValidIndianPhone, normalizeIndianPhone } from "../utils/phone.js";
import { isWhatsAppConfigured } from "../config/env.js";

// Config keys that carry credentials are never persisted. The integration
// build only stores safe, non-secret settings (phone numbers, org ids, etc.);
// anything that looks like a secret is dropped at write time.
const SECRET_FIELD_PATTERN =
  /(secret|password|passwd|api[-_]?key|key[-_]?id|client[-_]?secret|access[-_]?token|refresh[-_]?token)/i;

// Gmail has a dedicated OAuth flow (src/services/gmail.service.js). The
// generic connect/configure/disconnect paths reject the gmail key so it can
// never be marked "configured" without a real Google authentication.
const GMAIL_KEY = "gmail";

function isObjectId(value) {
  return mongoose.Types.ObjectId.isValid(String(value));
}

// Tenant scope mirrors the existing app model: a user belongs to one org
// (denormalized orgName). Users without an org never share records, so the
// fallback is the user's own id. Always derived from the authenticated
// session — never from anything the client sends.
export function resolveTenant(user) {
  const orgName = String(user?.orgName ?? "").trim();
  return orgName || String(user._id);
}

export function sanitizeConfig(config = {}) {
  const clean = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (SECRET_FIELD_PATTERN.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

function waLink(phone) {
  return `https://wa.me/${String(phone).replace(/^\+/, "")}`;
}

function formatIntegration(item) {
  const connected = Boolean(item.connected);
  const configured = Boolean(item.configured);
  const config = item.config ?? {};
  const phone = connected && item.key === "whatsapp" ? config.phone : null;
  // For WhatsApp, expose whether the server-level Meta Cloud API credentials
  // (WHATSAPP_ACCESS_TOKEN + WHATSAPP_PHONE_NUMBER_ID) are set. This allows
  // the frontend to show a proactive warning when the integration is connected
  // but delivery is impossible because the server env vars are missing.
  const serverConfigured = item.key === "whatsapp" ? isWhatsAppConfigured() : undefined;
  return {
    id: String(item._id),
    key: item.key,
    name: item.name ?? item.key,
    description: item.description ?? "",
    status: connected ? "connected" : configured ? "configured" : "disconnected",
    connected,
    configured,
    // Only ever contains safe, non-secret values (secrets are stripped on write).
    config,
    connectedAt: item.connectedAt ?? null,
    disconnectedAt: item.disconnectedAt ?? null,
    lastSync: item.lastSync ?? null,
    lastError: item.lastError ?? null,
    // Connected provider account identity (Gmail). Non-secret — safe to display.
    accountEmail: item.accountEmail ?? null,
    destinationUrl: phone ? waLink(phone) : null,
    // Only present for whatsapp: whether the server has the Meta Cloud API
    // credentials configured. Never exposes the actual credential values.
    ...(serverConfigured !== undefined ? { serverConfigured } : {}),
  };
}

async function findByIdentifier(identifier, tenantId) {
  if (!identifier) return null;
  if (isObjectId(identifier)) {
    const byId = await Integration.findOne({ tenantId, _id: identifier });
    if (byId) return byId;
  }
  return Integration.findOne({ tenantId, key: String(identifier) });
}

// WhatsApp Business is the only integration with a real, verifiable connect
// flow in this build: a validated + normalized phone number stored on the
// tenant's record. Everything else is saved as "configured" only (never
// marked connected) because the project has no OAuth/API credentials to
// actually verify those providers.
function whatsAppPhoneFrom(config = {}) {
  const phone = String(config.phone ?? "").trim();
  if (!phone) {
    throw ApiError.badRequest("WhatsApp Business phone number is required");
  }
  if (!isValidIndianPhone(phone)) {
    throw ApiError.badRequest(
      "Enter a valid Indian mobile number (10 digits starting with 6-9, e.g. +91 98765 43210)",
    );
  }
  return normalizeIndianPhone(phone);
}

function baseRecord(user, key) {
  const meta = findIntegrationMeta(key);
  return new Integration({
    key,
    name: meta?.name ?? key,
    description: meta?.description ?? "",
    tenantId: resolveTenant(user),
    orgName: String(user?.orgName ?? "").trim(),
    createdBy: user._id,
  });
}

export async function listIntegrations(user) {
  const tenantId = resolveTenant(user);
  const items = await Integration.find({ tenantId }).sort({ createdAt: 1 }).lean();
  return items.map(formatIntegration);
}

export async function getIntegration(user, identifier) {
  const record = await findByIdentifier(identifier, resolveTenant(user));
  if (!record) throw ApiError.notFound("Integration not found");
  return formatIntegration(record);
}

export async function connectIntegration(user, identifier, payload = {}) {
  const tenantId = resolveTenant(user);
  if (String(identifier) === GMAIL_KEY) {
    throw ApiError.badRequest(
      "Gmail connects through Google OAuth — use GET /integrations/gmail/connect instead.",
    );
  }
  let record = await Integration.findOne({ tenantId, key: String(identifier) });
  if (!record) record = baseRecord(user, String(identifier));

  if (String(identifier) === "whatsapp") {
    record.config = { phone: whatsAppPhoneFrom(payload.config) };
    record.connected = true;
    record.configured = true;
    record.connectedAt = record.connectedAt ?? new Date();
    record.disconnectedAt = null;
    record.lastSync = new Date();
    record.lastError = null;
  } else {
    record.config = { ...(record.config ?? {}), ...sanitizeConfig(payload.config) };
    record.configured = true;
    record.connected = false;
    record.lastSync = new Date();
    record.lastError = null;
  }

  try {
    await record.save();
  } catch (err) {
    if (err?.code === 11000) {
      throw ApiError.conflict("This integration is already set up for your organization");
    }
    throw err;
  }
  return formatIntegration(record);
}

export async function configureIntegration(user, identifier, payload = {}) {
  const tenantId = resolveTenant(user);
  if (String(identifier) === GMAIL_KEY) {
    throw ApiError.badRequest(
      "Gmail configuration is managed through Google OAuth — see GET /integrations/gmail/connect.",
    );
  }
  let record = await Integration.findOne({ tenantId, key: String(identifier) });
  if (!record) record = baseRecord(user, String(identifier));

  if (String(identifier) === "whatsapp" && payload.config?.phone !== undefined) {
    record.config = { ...(record.config ?? {}), phone: whatsAppPhoneFrom(payload.config) };
  } else {
    record.config = { ...(record.config ?? {}), ...sanitizeConfig(payload.config) };
  }
  record.configured = true;
  record.lastSync = new Date();

  try {
    await record.save();
  } catch (err) {
    if (err?.code === 11000) {
      throw ApiError.conflict("This integration is already set up for your organization");
    }
    throw err;
  }
  return formatIntegration(record);
}

export async function disconnectIntegration(user, identifier) {
  if (String(identifier) === GMAIL_KEY) {
    throw ApiError.badRequest("Disconnect Gmail through DELETE /integrations/gmail instead.");
  }
  const record = await findByIdentifier(identifier, resolveTenant(user));
  if (!record) throw ApiError.notFound("Integration not found");

  record.connected = false;
  record.connectedAt = null;
  record.lastSync = null;
  record.disconnectedAt = new Date();
  await record.save();
  return formatIntegration(record);
}
