import dotenv from "dotenv";

dotenv.config();

const isProduction = process.env.NODE_ENV === "production";

if (isProduction) {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "dev-only-change-me") {
    throw new Error(
      "JWT_SECRET is not set or still uses the development default. Add a strong, unique value " +
        "to the environment (Render dashboard > your service > Environment > add JWT_SECRET).",
    );
  }
  if (!process.env.CORS_ORIGIN || process.env.CORS_ORIGIN === "*") {
    throw new Error(
      "CORS_ORIGIN is not set or uses the development wildcard. Set it to the exact frontend " +
        "origin (e.g. https://pharmahub-co.vercel.app) so cross-site cookies work securely.",
    );
  }
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProduction,
  isTest: process.env.NODE_ENV === "test",

  port: parseInt(process.env.PORT ?? "5000", 10),

  mongoUri: process.env.MONGO_URI ?? "mongodb://127.0.0.1:27017/pharmahub",
  mongoUriConfigured: Boolean(process.env.MONGO_URI),

  jwtSecret: process.env.JWT_SECRET ?? "dev-only-change-me",
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "7d",

  corsOrigin: process.env.CORS_ORIGIN ?? "*",

  cookie: {
    name: "pharmahub_session",
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "true" || isProduction,
    sameSite: process.env.COOKIE_SAME_SITE ?? (isProduction ? "none" : "lax"),
    maxAgeDays: parseInt(process.env.COOKIE_MAX_AGE_DAYS ?? "7", 10),
  },

  rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "900000", 10),
  rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX ?? "300", 10),

  // Google sign-in (OAuth 2.0 authorization-code flow). Missing values are
  // tolerated at boot so a partially configured deployment still starts; the
  // /auth/google routes fail with a clear message until they are provided.
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? null,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? null,
    redirectUri:
      process.env.GOOGLE_REDIRECT_URI ??
      (isProduction
        ? "https://pharmahub-server.onrender.com/api/v1/auth/google/callback"
        : "http://localhost:5000/api/v1/auth/google/callback"),
    frontendUrl:
      process.env.FRONTEND_URL ??
      (isProduction ? "https://pharmahub-co.vercel.app" : "http://localhost:5100"),
    stateCookieName: "google_oauth_state",
  },

  // Email (OTP delivery). When RESEND_API_KEY is absent the service falls back
  // to logging the code to the server console — but only outside production.
  email: {
    apiKey: process.env.RESEND_API_KEY ?? null,
    from: process.env.EMAIL_FROM ?? "PharmaHub <onboarding@resend.dev>",
  },
};
