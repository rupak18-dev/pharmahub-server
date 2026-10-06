import crypto from "node:crypto";

import { ApiError } from "../core/ApiError.js";
import { logger } from "../core/logger.js";
import { env } from "../config/env.js";
import { Otp } from "../models/Otp.js";
import { sendEmail } from "./email.service.js";

const CODE_LENGTH = 6;
const EXPIRES_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_MS = 60 * 1000;

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function hashMatches(actual, expected) {
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function generateCode() {
  return crypto.randomInt(0, 10 ** CODE_LENGTH).toString().padStart(CODE_LENGTH, "0");
}

/**
 * Decides whether a generated code may be echoed back to the caller as
 * `devCode`. Ordered most-specific first:
 *
 * 1. Delivered successfully — the code provably reached a real inbox, so this
 *    is the only case that is a genuine leak. Opt-in only (`EMAIL_SHOW_CODE`),
 *    default off, for local dev convenience.
 * 2. `email_unconfigured` — no provider exists at all, so the code is provably
 *    unreadable by anyone. Echo it automatically; this self-kills as soon as
 *    SMTP/Resend is configured, because the reason no longer matches.
 * 3. `delivery_failed` — never echoes, even with the opt-ins set. A provider IS
 *    configured, so the code may have reached a real inbox despite the error.
 * 4. Any other future skip reason keeps the original opt-in gate, so nothing
 *    starts echoing by accident.
 */
export function shouldEchoDevCode(sendResult) {
  // Every `sendEmail` path returns an object. A missing one is an anomaly, not
  // a delivery success — never echo on it, or a future early-return would leak
  // a code that nobody can prove was sent.
  if (!sendResult) return false;
  if (!sendResult.skipped) return env.echoCodeAlways;
  if (sendResult.reason === "email_unconfigured") return env.autoEchoUnconfigured;
  if (sendResult.reason === "delivery_failed") return false;
  return env.echoDevCode && (!env.isProduction || env.echoDevCodeInProduction);
}

/**
 * Generates a 6-digit code for `email`/`purpose`, stores a hash, and emails it.
 * `subject`/`html` override the default email copy; `{{code}}` inside them is
 * replaced with the generated code.
 */
export async function createAndSendOtp({ email, purpose, subject, html }) {
  const normalizedEmail = email.toLowerCase();
  const existing = await Otp.findOne({ email: normalizedEmail, purpose });

  // Cooldown is throttling against real inbox spam, so it is measured from the
  // last SUCCESSFUL delivery. Gating it on `updatedAt` meant a failed send also
  // started the clock, and the user's immediate "Resend code" retry came back
  // 429 — indistinguishable from the endpoint being broken.
  const lastSentAt = existing?.lastSentAt ? new Date(existing.lastSentAt) : null;
  if (lastSentAt && Date.now() - lastSentAt.getTime() < RESEND_COOLDOWN_MS) {
    throw ApiError.tooMany("Please wait a minute before requesting another code");
  }

  const code = generateCode();
  await Otp.findOneAndUpdate(
    { email: normalizedEmail, purpose },
    {
      $set: {
        codeHash: hashCode(code),
        expiresAt: new Date(Date.now() + EXPIRES_MS),
        attempts: 0,
      },
    },
    { upsert: true },
  );

  const sendResult = await sendEmail({
    to: normalizedEmail,
    subject: subject ?? "Your PharmaHub verification code",
    html:
      html
        ?.replace(/\{\{otp_code\}\}/g, code)
        .replace(/\{\{code\}\}/g, code) ??
      `<p>Your PharmaHub verification code is:</p>
<p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p>
<p>It expires in 10 minutes. If you didn't request this code, you can ignore this email.</p>`,
  });

  // Never let a skipped/failed delivery masquerade as a sent code: surface it
  // loudly so the API response / logs reflect that no email actually went out.
  if (sendResult?.skipped) {
    logger.error(
      `[otp] Code stored for ${normalizedEmail} (${purpose}) but the email was NOT delivered ` +
        `(reason=${sendResult.reason})` +
        (sendResult.error ? ` providerError="${sendResult.error}"` : "") +
        (sendResult.hint ? ` — ${sendResult.hint}` : "") +
        ". The recipient cannot verify their account until this is fixed.",
    );
  } else {
    // Only a delivered email starts the resend cooldown.
    await Otp.updateOne(
      { email: normalizedEmail, purpose },
      { $set: { lastSentAt: new Date() } },
    );
  }

  // Frontend dev contract: surface the code as `devCode` so UIs keep working
  // when no email ever goes out. See `shouldEchoDevCode` for the rules.
  const skipped = Boolean(sendResult?.skipped);
  const devCode = skipped && shouldEchoDevCode(sendResult) ? code : undefined;
  return { skipped, devCode, reason: sendResult?.reason ?? null };
}

/** Verifies a code for `email`/`purpose` and consumes it once successful. */
export async function verifyOtp({ email, purpose, code }) {
  const normalizedEmail = email.toLowerCase();
  const record = await Otp.findOne({ email: normalizedEmail, purpose });
  if (!record) {
    throw ApiError.badRequest("No verification code found for this email");
  }
  if (record.expiresAt.getTime() < Date.now()) {
    await Otp.deleteOne({ _id: record._id });
    throw ApiError.badRequest("This code has expired. Request a new one.");
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    await Otp.deleteOne({ _id: record._id });
    throw ApiError.tooMany("Too many incorrect attempts. Request a new code.");
  }

  const trimmed = code.trim();
  if (!hashMatches(record.codeHash, hashCode(trimmed))) {
    record.attempts += 1;
    await record.save();
    throw ApiError.badRequest("Incorrect code. Please try again.");
  }

  await Otp.deleteOne({ _id: record._id });
  return true;
}
