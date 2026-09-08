import crypto from "node:crypto";

import { env } from "../config/env.js";
import { ApiError } from "../core/ApiError.js";
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
 * Generates a 6-digit code for `email`/`purpose`, stores a hash, and emails it.
 * `subject`/`html` override the default email copy; `{{code}}` inside them is
 * replaced with the generated code. Returns `devCode` in non-production so the
 * flow can be tested without an email provider.
 */
export async function createAndSendOtp({ email, purpose, subject, html }) {
  const normalizedEmail = email.toLowerCase();
  const existing = await Otp.findOne({ email: normalizedEmail, purpose });
  if (existing && Date.now() - existing.updatedAt.getTime() < RESEND_COOLDOWN_MS) {
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

  const transport = await sendEmail({
    to: normalizedEmail,
    subject: subject ?? "Your PharmaHub verification code",
    html:
      html?.replace(/\{\{code\}\}/g, code) ??
      `<p>Your PharmaHub verification code is:</p>
<p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p>
<p>It expires in 10 minutes. If you didn't request this code, you can ignore this email.</p>`,
  });

  return {
    devCode: env.isProduction || transport === "resend" ? undefined : code,
  };
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
