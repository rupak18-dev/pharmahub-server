import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { env } from "../config/env.js";
import { ApiError } from "../core/ApiError.js";
import { User } from "../models/User.js";
import { DemoLoginToken } from "../models/DemoLoginToken.js";
import { sendMail } from "./email.service.js";
import { toPublicUser } from "./auth.service.js";

const TOKEN_TTL_MS = parseInt(process.env.DEMO_LOGIN_TOKEN_TTL_MS ?? "900000", 10); // 15 min default

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashToken(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function buildDemoLoginHtml({ name, loginUrl, expiresAt }) {
  const expiryMinutes = Math.round((expiresAt - Date.now()) / 60000);
  return `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f4f6f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f9;padding:40px 20px;">
    <tr><td align="center">
      <table width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:linear-gradient(135deg,#0d9488,#14b8a6);padding:32px 40px;text-align:center;">
            <h1 style="margin:0;color:#ffffff;font-size:24px;font-weight:700;">PharmaHub</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:40px;">
            <h2 style="margin:0 0 16px;color:#1e293b;font-size:20px;font-weight:600;">Your Demo Login Link</h2>
            <p style="margin:0 0 8px;color:#475569;font-size:15px;line-height:1.6;">
              Hi${name ? ` ${name}` : ""},
            </p>
            <p style="margin:0 0 24px;color:#475569;font-size:15px;line-height:1.6;">
              Click the button below to access the PharmaHub demo. This link will grant you immediate access without a password.
            </p>
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding:8px 0 32px;">
                  <a href="${loginUrl}" style="display:inline-block;background:#0d9488;color:#ffffff;text-decoration:none;font-size:16px;font-weight:600;padding:14px 40px;border-radius:10px;transition:background 0.2s;">
                    Login to PharmaHub Demo
                  </a>
                </td>
              </tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border-radius:10px;padding:16px 20px;">
              <tr>
                <td>
                  <p style="margin:0;color:#64748b;font-size:13px;line-height:1.6;">
                    This link expires in <strong>${expiryMinutes} minutes</strong> and can only be used once.
                    If you did not request this, you can safely ignore this email.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 40px;background:#f8fafc;border-top:1px solid #e2e8f0;">
            <p style="margin:0;color:#94a3b8;font-size:12px;text-align:center;">
              This is a security-sensitive email. Do not share this link. PharmaHub will never ask for your password via email.
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export async function requestDemoLogin(email) {
  const normalizedEmail = email.toLowerCase();

  // Check if user exists (optional — create a temporary user if not, or require registration)
  let user = await User.findOne({ email: normalizedEmail }).collation({
    locale: "en",
    strength: 2,
  });

  // For demo purposes, create a temporary user if they don't exist
  if (!user) {
    user = await User.create({
      name: normalizedEmail.split("@")[0],
      email: normalizedEmail,
      passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10),
      role: "Pharmacist",
      active: true,
    });
  }

  // Invalidate any previous unused tokens for this email
  await DemoLoginToken.updateMany(
    { email: normalizedEmail, used: false },
    { $set: { used: true } },
  );

  // Generate and store token
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

  await DemoLoginToken.create({
    email: normalizedEmail,
    tokenHash,
    used: false,
    expiresAt,
  });

  // Build login URL
  const frontendUrl = env.frontendUrl || "http://localhost:5100";
  const loginUrl = `${frontendUrl}/auth/demo-login?token=${rawToken}`;

  // Send email
  const html = buildDemoLoginHtml({ name: user.name, loginUrl: loginUrl, expiresAt });
  try {
    await sendMail({
      to: normalizedEmail,
      subject: "Your PharmaHub Demo Login",
      html,
    });
  } catch (err) {
    // Log but don't fail the request — the token was created successfully
    console.error("Failed to send demo login email:", err.message);
  }

  return { email: normalizedEmail, expiresAt };
}

export async function verifyDemoLogin(rawToken) {
  const tokenHash = hashToken(rawToken);

  const record = await DemoLoginToken.findOne({ tokenHash });

  if (!record) {
    throw ApiError.unauthorized("Invalid or expired demo login link");
  }

  if (record.used) {
    throw ApiError.unauthorized("This demo login link has already been used");
  }

  if (record.expiresAt < new Date()) {
    throw ApiError.unauthorized("This demo login link has expired");
  }

  // Mark as used
  record.used = true;
  await record.save();

  // Find or create user
  const normalizedEmail = record.email.toLowerCase();
  let user = await User.findOne({ email: normalizedEmail }).collation({
    locale: "en",
    strength: 2,
  });

  if (!user) {
    user = await User.create({
      name: normalizedEmail.split("@")[0],
      email: normalizedEmail,
      passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10),
      role: "Pharmacist",
      active: true,
    });
  }

  // Sign JWT
  const token = jwt.sign({ sub: String(user._id) }, env.jwtSecret, {
    expiresIn: env.jwtExpiresIn,
  });

  return { token, user: toPublicUser(user) };
}
