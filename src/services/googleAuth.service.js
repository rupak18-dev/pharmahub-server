import { OAuth2Client } from "google-auth-library";

import { env } from "../config/env.js";
import { ApiError } from "../core/ApiError.js";

let cachedClient = null;

function oauthClient() {
  if (cachedClient) return cachedClient;
  const { clientId, clientSecret, redirectUri } = env.google;
  if (!clientId || !clientSecret || !redirectUri) {
    throw ApiError.badRequest(
      "Google sign-in is not configured. Ask the admin to add GOOGLE_CLIENT_ID, " +
        "GOOGLE_CLIENT_SECRET and GOOGLE_REDIRECT_URI.",
    );
  }
  cachedClient = new OAuth2Client(clientId, clientSecret, redirectUri);
  return cachedClient;
}

/** Builds the Google consent URL with a random CSRF `state` value. */
export function googleAuthUrl(state) {
  return oauthClient().generateAuthUrl({
    access_type: "online",
    scope: ["openid", "email", "profile"],
    state,
    prompt: "select_account",
  });
}

/**
 * Exchanges the OAuth `code` for tokens and returns Google's verified profile.
 * Throws a friendly ApiError on any failure so users land back on /login.
 */
export async function exchangeCodeForProfile(code) {
  const client = oauthClient();
  let tokens;
  try {
    const res = await client.getToken(code);
    tokens = res.tokens;
  } catch {
    throw ApiError.badRequest("Google sign-in failed. Please try again.");
  }

  const idToken = tokens?.id_token;
  if (!idToken) {
    throw ApiError.badRequest("Google sign-in failed. Please try again.");
  }

  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: env.google.clientId });
    payload = ticket.getPayload();
  } catch {
    throw ApiError.badRequest("Google sign-in failed. Please try again.");
  }

  if (!payload?.sub || !payload?.email || payload.email_verified !== true) {
    throw ApiError.badRequest("Your Google account email is not verified.");
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name ?? payload.email.split("@")[0],
    picture: payload.picture ?? null,
  };
}
