import crypto from "node:crypto";

import { ApiError } from "../core/ApiError.js";
import { logger } from "../core/logger.js";
import { env, googleConfig, isGoogleConfigured } from "../config/env.js";
import { Integration } from "../models/Integration.js";
import { resolveTenant } from "./integration.service.js";

const GMAIL_KEY = "gmail";
const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const GMAIL_API_PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
const GMAIL_API_SEND = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const STATE_TTL_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;

/**
 * Organization-level Gmail integration. A pharmacy connects its OWN Gmail
 * account (send-only scope) via Google OAuth 2.0. This is completely separate
 * from the system SMTP mailer (pharmahub.team@gmail.com) that handles staff
 * invitations, password resets and scheduled reports — the two never touch.
 *
 * Tenant isolation: every record is looked up by the tenant derived from the
 * authenticated session (resolveTenant), and the OAuth callback re-identifies
 * the tenant from the signed `state` value. Tokens stay backend-only.
 */

function b64url(input) {
  return Buffer.from(JSON.stringify(input)).toString("base64url");
}

function signState(payload) {
  const encoded = b64url(payload);
  const sig = crypto.createHmac("sha256", env.jwtSecret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

/**
 * Build the opaque OAuth state token for a connect attempt. It carries the
 * tenant derived from the authenticated user and is HMAC-signed so the public
 * callback can never be replayed to write into another organization.
 */
export function createOAuthState(user) {
  return signState({
    tenantId: resolveTenant(user),
    orgName: String(user?.orgName ?? "").trim(),
    userId: String(user._id),
    ts: Date.now(),
  });
}

export function verifyOAuthState(state) {
  if (typeof state !== "string" || !state.includes(".")) {
    throw ApiError.badRequest("Invalid connection request");
  }
  const [encoded, sig] = state.split(".");
  if (!encoded || !sig) throw ApiError.badRequest("Invalid connection request");
  const expected = crypto.createHmac("sha256", env.jwtSecret).update(encoded).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw ApiError.badRequest("Invalid or tampered connection request");
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw ApiError.badRequest("Invalid connection request");
  }
  if (!payload?.tenantId || !Number.isFinite(payload?.ts)) {
    throw ApiError.badRequest("Invalid connection request");
  }
  if (Date.now() - payload.ts > STATE_TTL_MS) {
    throw ApiError.badRequest("This connection request has expired. Please try again.");
  }
  return payload;
}

/**
 * The URL a user is sent to authorize PharmaHub to send mail from their
 * Gmail account. Scope is send-only (gmail.send) — never read/modify.
 */
export function buildAuthorizationUrl(user) {
  const google = googleConfig();
  if (!isGoogleConfigured()) {
    logger.warn(
      "Gmail connection attempted but Google OAuth is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI are missing or empty).",
    );
    throw new ApiError(
      503,
      "Google OAuth is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI).",
    );
  }
  const params = new URLSearchParams({
    client_id: google.clientId,
    redirect_uri: google.redirectUri,
    response_type: "code",
    scope: GMAIL_SEND_SCOPE,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: createOAuthState(user),
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

async function googleFetch(url, options, fetchImpl) {
  const f = fetchImpl ?? globalThis.fetch;
  const res = await f(url, options);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON response — json stays null
  }
  if (!res.ok) {
    const detail = json?.error_description ?? json?.error ?? `HTTP ${res.status}`;
    throw new Error(`Google API error: ${detail}`);
  }
  return json;
}

export async function exchangeCodeForTokens(code, fetchImpl) {
  const google = googleConfig();
  if (!isGoogleConfigured()) {
    logger.warn(
      "Gmail OAuth callback received but Google OAuth is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI are missing or empty).",
    );
    throw new ApiError(503, "Google OAuth is not configured on this server.");
  }
  const body = new URLSearchParams({
    code,
    client_id: google.clientId,
    client_secret: google.clientSecret,
    redirect_uri: google.redirectUri,
    grant_type: "authorization_code",
  });
  const json = await googleFetch(
    GOOGLE_TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    fetchImpl,
  );
  if (!json.access_token) {
    throw new Error("Google did not return an access token");
  }
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresIn: Number(json.expires_in) || 3600,
    scope: json.scope ?? null,
  };
}

export async function refreshAccessToken(refreshToken, fetchImpl) {
  const google = googleConfig();
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: google.clientId,
    client_secret: google.clientSecret,
    grant_type: "refresh_token",
  });
  const json = await googleFetch(
    GOOGLE_TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
    fetchImpl,
  );
  if (!json.access_token) throw new Error("Google token refresh failed");
  return {
    accessToken: json.access_token,
    expiresIn: Number(json.expires_in) || 3600,
    scope: json.scope ?? null,
  };
}

/**
 * Authoritative identification of the connected account. Also verifies the
 * access token actually works, so the backend never marks a Gmail account as
 * connected until Google has validated it.
 */
export async function getGmailProfile(accessToken, fetchImpl) {
  const json = await googleFetch(
    GMAIL_API_PROFILE,
    { headers: { Authorization: `Bearer ${accessToken}` } },
    fetchImpl,
  );
  if (!json?.emailAddress) {
    throw new Error("Unable to identify the connected Gmail account");
  }
  return { emailAddress: json.emailAddress, providerAccountId: json.id ?? null };
}

export async function revokeGoogleToken(token, fetchImpl) {
  if (!token) return;
  const f = fetchImpl ?? globalThis.fetch;
  try {
    await f(`${GOOGLE_REVOKE_ENDPOINT}?token=${encodeURIComponent(token)}`, { method: "POST" });
  } catch (err) {
    logger.debug(`[gmail] token revoke failed: ${err?.message ?? err}`);
  }
}

export function getGmailRecord(user, { withCredentials = false } = {}) {
  const query = Integration.findOne({ tenantId: resolveTenant(user), key: GMAIL_KEY });
  if (withCredentials) query.select("+credentials");
  return query.exec();
}

export async function connectGmail({ code, state }, fetchImpl) {
  if (typeof code !== "string" || !code) {
    throw ApiError.badRequest("Missing authorization code from Google");
  }
  const payload = verifyOAuthState(state);
  const tokens = await exchangeCodeForTokens(code, fetchImpl);
  const profile = await getGmailProfile(tokens.accessToken, fetchImpl);

  const record = await Integration.findOneAndUpdate(
    { tenantId: payload.tenantId, key: GMAIL_KEY },
    {
      $set: {
        name: "Gmail",
        description: "Send invoices, reports, and notifications from your pharmacy email.",
        connected: true,
        configured: true,
        connectedAt: new Date(),
        disconnectedAt: null,
        lastSync: new Date(),
        lastError: null,
        credentials: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenExpiresAt: Date.now() + tokens.expiresIn * 1000,
          scope: tokens.scope,
        },
        accountEmail: profile.emailAddress,
        providerAccountId: profile.providerAccountId,
        orgName: payload.orgName,
      },
      $setOnInsert: { createdBy: payload.userId },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).select("+credentials");

  logger.info(`[gmail] connected account ${profile.emailAddress} for tenant ${payload.tenantId}`);
  return record;
}

/**
 * Return a valid access token for the connected account, refreshing it when
 * it is expired or close to expiry. Persists the refreshed token immediately.
 */
export async function getValidAccessToken(record, fetchImpl) {
  const credentials = record?.credentials;
  if (!credentials?.accessToken) {
    throw new ApiError(400, "This Gmail connection has no credentials. Please reconnect.");
  }
  const expiresAt = Number(credentials.tokenExpiresAt ?? 0);
  if (expiresAt && Date.now() < expiresAt - TOKEN_REFRESH_SKEW_MS) {
    return credentials.accessToken;
  }
  if (!credentials.refreshToken) {
    throw new ApiError(
      400,
      "This Gmail connection cannot refresh its access token. Please disconnect and reconnect.",
    );
  }
  const refreshed = await refreshAccessToken(credentials.refreshToken, fetchImpl);
  credentials.accessToken = refreshed.accessToken;
  credentials.tokenExpiresAt = Date.now() + refreshed.expiresIn * 1000;
  if (refreshed.scope) credentials.scope = refreshed.scope;
  record.markModified("credentials");
  await record.save();
  return refreshed.accessToken;
}

function buildRawMessage({ to, subject, text }) {
  const headers = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
  ];
  const body = Buffer.from(text).toString("base64");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

export async function sendGmailMessage(accessToken, { to, subject, text }, fetchImpl) {
  const raw = Buffer.from(buildRawMessage({ to, subject, text })).toString("base64url");
  const json = await googleFetch(
    GMAIL_API_SEND,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
    },
    fetchImpl,
  );
  if (!json?.id) throw new Error("Gmail did not confirm the message was sent");
  return json;
}

export async function sendTestEmail(user, fetchImpl) {
  const record = await getGmailRecord(user, { withCredentials: true });
  if (!record || !record.connected) {
    throw ApiError.badRequest("Connect a Gmail account before sending a test email.");
  }
  const accessToken = await getValidAccessToken(record, fetchImpl);
  const to = record.accountEmail || user.email;
  const subject = "PharmaHub — Gmail integration test";
  const text =
    `This is a test email from PharmaHub.\n\n` +
    `It was sent through your organization's connected Gmail account (${to}) using the ` +
    `Gmail API. If you received this, invoices, reports and notifications can be sent from ` +
    `this account.\n\n` +
    `Sent at: ${new Date().toISOString()}`;
  try {
    await sendGmailMessage(accessToken, { to, subject, text }, fetchImpl);
  } catch (err) {
    record.lastError = `Gmail send failed: ${err?.message ?? "unknown error"}`;
    record.lastSync = new Date();
    await record.save();
    logger.error(`[gmail] send failed for tenant ${resolveTenant(user)}`, err);
    throw new ApiError(502, `Failed to send test email: ${err?.message ?? "unknown error"}`);
  }
  record.lastError = null;
  record.lastSync = new Date();
  await record.save();
  return { to, message: "Test email sent successfully" };
}

export async function disconnectGmail(user, fetchImpl) {
  const record = await getGmailRecord(user, { withCredentials: true });
  if (!record) throw ApiError.notFound("Gmail integration not found");

  // Best-effort server-side revoke of the refresh token (ignores failures).
  await revokeGoogleToken(record.credentials?.refreshToken, fetchImpl);

  record.credentials = null;
  record.accountEmail = null;
  record.providerAccountId = null;
  record.connected = false;
  record.configured = false;
  record.connectedAt = null;
  record.lastSync = null;
  record.lastError = null;
  record.disconnectedAt = new Date();
  await record.save();
  logger.info(`[gmail] disconnected for tenant ${resolveTenant(user)}`);
  return record;
}

/** Safe API shape for a gmail record — never includes credentials. */
export function toSafeIntegration(item) {
  return {
    id: String(item._id),
    key: item.key,
    name: item.name ?? item.key,
    description: item.description ?? "",
    status: item.connected ? "connected" : item.configured ? "configured" : "disconnected",
    connected: Boolean(item.connected),
    configured: Boolean(item.configured),
    config: item.config ?? {},
    accountEmail: item.accountEmail ?? null,
    connectedAt: item.connectedAt ?? null,
    disconnectedAt: item.disconnectedAt ?? null,
    lastSync: item.lastSync ?? null,
    lastError: item.lastError ?? null,
  };
}
