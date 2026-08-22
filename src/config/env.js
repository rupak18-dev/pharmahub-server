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

const emailConfig = {
  apiKey: process.env.RESEND_API_KEY ?? null,

  from:
    process.env.EMAIL_FROM ??
    "PharmaHub <onboarding@resend.dev>",
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

  // Demo account passwords (development/demo flows). Defaults preserve the
  // previous hardcoded values; set these in any shared or production
  // environment so demo credentials are never taken from source control.
  demoAccountPassword:
    process.env.DEMO_ACCOUNT_PASSWORD ??
    "password123",

  devDemoPassword:
    process.env.DEV_DEMO_PASSWORD ??
    "PharmaHub@123",

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
    host: process.env.SMTP_HOST ?? "",

    port: parseInt(
      process.env.SMTP_PORT ?? "587",
      10,
    ),

    secure: process.env.SMTP_SECURE
      ? process.env.SMTP_SECURE === "true"
      : parseInt(
          process.env.SMTP_PORT ?? "587",
          10,
        ) === 465,

    user: process.env.SMTP_USER ?? "",

    pass:
      process.env.SMTP_PASSWORD ??
      process.env.SMTP_PASS ??
      "",

    from: process.env.MAIL_FROM ?? "",

    fromName:
      process.env.MAIL_FROM_NAME ??
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