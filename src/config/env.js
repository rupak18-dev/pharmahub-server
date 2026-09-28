import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config();

const secretEnvPath = "/etc/secrets/.env";

if (fs.existsSync(secretEnvPath)) {
  dotenv.config({ path: secretEnvPath });
}

function envVar(...names) {
  for (const name of names) {
    const value = process.env[name];

    if (value && value.trim() !== "") {
      return value;
    }
  }

  return undefined;
}

/**
 * Returns a trimmed env value, or undefined when the variable is unset *or*
 * blank. `envVar` is not enough on its own for provider credentials: a var that
 * is defined but empty (`RESEND_API_KEY=`) reads as "configured" in most
 * dashboards while being falsy in code, so the provider silently switches off.
 */
function trimmedEnv(...names) {
  for (const name of names) {
    const raw = process.env[name];

    if (typeof raw === "string" && raw.trim() !== "") {
      return raw.trim();
    }
  }

  return undefined;
}

/**
 * Splits a `Display Name <user@domain.com>` sender string into its parts.
 * Mail providers reject a malformed sender for the WHOLE message, so the
 * address/domain must be extractable and valid before it is handed over.
 */
function parseSender(raw) {
  if (!raw) return { name: null, address: null, domain: null };

  const value = raw.replace(/^['"]|['"]$/g, "").trim();
  const angle = value.match(/^(.*?)<([^>]+)>\s*$/);

  const name = angle
    ? angle[1].replace(/^['"]|['"]$/g, "").trim() || null
    : null;
  const address = (angle ? angle[2] : value).trim();

  const at = address.lastIndexOf("@");
  const domain = at === -1 ? null : address.slice(at + 1).toLowerCase();

  // Not `local@domain.tld` shaped — providers will reject it.
  const valid = domain !== null && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);

  return { name, address: valid ? address : null, domain: valid ? domain : null };
}

const nodeEnv = envVar("NODE_ENV", "node_env") ?? "development";
const isProduction = nodeEnv === "production";

const mongoUri = envVar(
  "MONGO_URI",
  "mongo_URI",
  "MONGODB_URI",
  "MONGO_URL",
);

if (isProduction && !mongoUri) {
  throw new Error("MONGO_URI is required in production.");
}

if (isProduction) {
  if (
    !process.env.JWT_SECRET ||
    process.env.JWT_SECRET === "dev-only-change-me"
  ) {
    throw new Error(
      "JWT_SECRET is not set or still uses the development default.",
    );
  }

  if (
    !process.env.CORS_ORIGIN ||
    process.env.CORS_ORIGIN === "*"
  ) {
    throw new Error("CORS_ORIGIN must be configured in production.");
  }
}

const googleConfig = {
  clientId: process.env.GOOGLE_CLIENT_ID ?? null,

  clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? null,

  redirectUri:
    process.env.GOOGLE_REDIRECT_URI ??
    (isProduction
      ? "https://pharmahub-server.onrender.com/api/v1/auth/google/callback"
      : `http://localhost:${parseInt(
          process.env.PORT ?? "5050",
          10,
        )}/api/v1/auth/google/callback`),

  frontendUrl:
    process.env.FRONTEND_URL ??
    (isProduction
      ? "https://pharmahub-co.vercel.app"
      : "http://localhost:8080"),

  stateCookieName: "google_oauth_state",
};

// Named `whatsAppConfig` (capital "A") to exactly match the import in
// src/services/whatsapp.service.js — ES module imports are case-sensitive.
export const whatsAppConfig = {
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN ?? "",

  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? "",

  templateName:
    process.env.WHATSAPP_BILL_TEMPLATE_NAME ?? "",

  templateLang:
    process.env.WHATSAPP_BILL_TEMPLATE_LANG ?? "en",

  graphVersion:
    process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0",

  publicUrl:
    process.env.API_PUBLIC_URL ??
    `http://localhost:${parseInt(
      process.env.PORT ?? "5050",
      10,
    )}`,

  currencySymbol:
    process.env.CURRENCY_SYMBOL ?? "₹",
};

// Resend's shared onboarding domain. It only delivers to the account owner's own
// address, so it is a dev convenience and a production footgun — it is reported
// as a misconfiguration by validateEmailConfig().
const RESEND_TEST_FROM = "PharmaHub <onboarding@resend.dev>";

const resendSender = parseSender(trimmedEnv("EMAIL_FROM") ?? RESEND_TEST_FROM);
const mailFromSender = parseSender(trimmedEnv("MAIL_FROM"));

const emailConfig = {
  apiKey: trimmedEnv("RESEND_API_KEY") ?? null,

  // The variable is defined but blank. Resend is OFF in this case (apiKey is
  // null) even though the dashboard shows the key, so it is surfaced at startup
  // instead of silently falling back to SMTP.
  apiKeyBlank:
    process.env.RESEND_API_KEY !== undefined &&
    process.env.RESEND_API_KEY.trim() === "",

  from: trimmedEnv("EMAIL_FROM") ?? RESEND_TEST_FROM,

  fromName: resendSender.name,

  fromAddress: resendSender.address,

  fromDomain: resendSender.domain,

  // True for the Resend test sender, which cannot reach arbitrary recipients.
  usesTestSender: resendSender.domain === "resend.dev",

  // EMAIL_FROM is set but is not a usable `local@domain.tld` sender.
  fromInvalid: trimmedEnv("EMAIL_FROM") !== undefined && !resendSender.address,
};

export const env = {
  nodeEnv,
  isProduction,
  isTest: nodeEnv === "test",

  port: parseInt(
    envVar("PORT", "port") ?? "5050",
    10,
  ),

  frontendUrl:
    process.env.FRONTEND_URL ??
    "http://localhost:8080",

  mongoUri:
    mongoUri ??
    "mongodb://127.0.0.1:27017/pharmahub",

  mongoUriConfigured: Boolean(mongoUri),

  resetTokenTtlMs: parseInt(
    process.env.PASSWORD_RESET_TTL_MS ??
      "3600000",
    10,
  ),

  jwtSecret:
    envVar("JWT_SECRET", "jwt_secret") ??
    "dev-only-change-me",

  jwtExpiresIn:
    envVar("JWT_EXPIRES_IN", "jwt_expires_in") ??
    "7d",

  corsOrigin:
    envVar("CORS_ORIGIN", "cors_origin") ??
    "*",

  // Demo-account passwords (development/demo flows ONLY). There are no code
  // defaults — they must come from environment configuration. Demo auto-login
  // degrades gracefully (401 + warn) when unset, and production ignores demos
  // regardless.
  demoAccountPassword: process.env.DEMO_ACCOUNT_PASSWORD ?? "",

  devDemoPassword: process.env.DEV_DEMO_PASSWORD ?? "",

  // Explicit opt-in for demo-account auto-creation flows (@pharmahub.demo
  // logins, magic-link demo signup, seeded dev user). Off unless explicitly
  // enabled in the environment; production always ignores them.
  enableDemoAccounts: process.env.ENABLE_DEMO_ACCOUNTS === "true",

  // When email delivery is NOT configured (no SMTP/Resend), the OTP would
  // otherwise be unretrievable. This opt-in surfaces the generated code as
  // `devCode` in the register/resend response so local/demo UIs (which already
  // render it) keep working. Off by default; ignored in production unless the
  // separate `echoDevCodeInProduction` opt-in is also set (for TEST deployments
  // that must stay usable while e.g. Gmail SMTP is unreachable from the host).
  echoDevCode: process.env.EMAIL_DEV_CODE === "true",

  // Explicit second key that lets a NON-production-grade TEST service (Render
  // free tier, no working SMTP egress) echo the dev code in production mode.
  // Real production must never set EMAIL_DEV_CODE_PROD=true.
  echoDevCodeInProduction: process.env.EMAIL_DEV_CODE_PROD === "true",

  cookie: {
    name: "pharmahub_session",

    httpOnly: true,

    secure:
      process.env.COOKIE_SECURE === "true" ||
      isProduction,

    sameSite:
      process.env.COOKIE_SAME_SITE ??
      (isProduction ? "none" : "lax"),

    maxAgeDays: parseInt(
      process.env.COOKIE_MAX_AGE_DAYS ??
        "7",
      10,
    ),
  },

  rateLimitWindowMs: parseInt(
    process.env.RATE_LIMIT_WINDOW_MS ??
      "900000",
    10,
  ),

  rateLimitMax: parseInt(
    process.env.RATE_LIMIT_MAX ?? "300",
    10,
  ),

  // Email / invitation configuration
  smtp: {
    host: trimmedEnv("SMTP_HOST") ?? "",

    port: parseInt(
      trimmedEnv("SMTP_PORT") ?? "587",
      10,
    ),

    secure: trimmedEnv("SMTP_SECURE")
      ? trimmedEnv("SMTP_SECURE") === "true"
      : parseInt(
          trimmedEnv("SMTP_PORT") ?? "587",
          10,
        ) === 465,

    user: trimmedEnv("SMTP_USER") ?? "",

    pass:
      trimmedEnv("SMTP_PASSWORD") ??
      trimmedEnv("SMTP_PASS") ??
      "",

    from: trimmedEnv("MAIL_FROM") ?? "",

    // `PharmaHub <a@b.com>` and `a@b.com` are both accepted; splitting them
    // here keeps mailer.js from re-wrapping an already-wrapped address into
    // `PharmaHub <PharmaHub <a@b.com>>`.
    fromAddress: mailFromSender.address,

    // An explicit MAIL_FROM_NAME wins, then any display name embedded in
    // MAIL_FROM, then the product default.
    fromName:
      trimmedEnv("MAIL_FROM_NAME") ??
      mailFromSender.name ??
      "PharmaHub",
  },

  // Google integration
  google: googleConfig,

  // WhatsApp integration
  whatsapp: whatsAppConfig,

  // Resend email configuration
  email: emailConfig,
};

// Named exports required by existing services
export { googleConfig };

// SMTP email configuration check
export const isEmailConfigured = () =>
  Boolean(
    env.smtp.host &&
      env.smtp.user &&
      env.smtp.pass &&
      (env.smtp.from || env.smtp.user),
  );

// Resend configuration check. Requires a NON-BLANK key: a variable that exists
// but holds an empty string leaves Resend disabled, so it must not count here.
export const isResendConfigured = () => Boolean(env.email.apiKey);

// Google configuration check
export const isGoogleConfigured = () =>
  Boolean(
    googleConfig.clientId &&
      googleConfig.clientSecret &&
      googleConfig.redirectUri,
  );

// WhatsApp configuration check — uses the same whatsAppConfig object.
export const isWhatsAppConfigured = () =>
  Boolean(
    whatsAppConfig.phoneNumberId &&
      whatsAppConfig.accessToken,
  );