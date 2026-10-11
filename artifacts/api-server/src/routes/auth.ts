import { GetCurrentAuthUserResponse } from "@workspace/api-zod";
import { db, usersTable } from "@workspace/db";
import { Router, type IRouter, type Response } from "express";
import * as oidc from "openid-client";
import {
  clearSession,
  createSession,
  getOidcConfig,
  getOidcClientId,
  getSessionId,
  isLocalAuthMode,
  SESSION_COOKIE,
  SESSION_TTL,
  type SessionData,
} from "../lib/auth";

const router: IRouter = Router();
const OIDC_COOKIE_TTL = 10 * 60 * 1000;

function getOrigin(): string {
  const configuredOrigin = process.env.PUBLIC_APP_URL;
  if (!configuredOrigin) throw new Error("PUBLIC_APP_URL is required for OIDC callbacks.");
  const url = new URL(configuredOrigin);
  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    throw new Error("PUBLIC_APP_URL must use HTTPS in production.");
  }
  return url.origin;
}

function isGoogleIssuer(): boolean {
  try {
    return new URL(process.env.OIDC_ISSUER_URL || "").hostname === "accounts.google.com";
  } catch {
    return false;
  }
}

function buildAuthorizationParams(callbackUrl: string, state: string, nonce: string, codeChallenge: string): Record<string, string> {
  if (isGoogleIssuer()) {
    // Google rejects "offline_access" and "login" prompt values; refresh tokens are
    // requested with access_type=offline plus a consent prompt.
    return {
      redirect_uri: callbackUrl,
      scope: "openid email profile",
      access_type: "offline",
      prompt: "consent",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state,
      nonce,
    };
  }
  return {
    redirect_uri: callbackUrl,
    scope: "openid email profile offline_access",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    prompt: "login consent",
    state,
    nonce,
  };
}

function setSessionCookie(res: Response, sid: string): void {
  res.cookie(SESSION_COOKIE, sid, { httpOnly: true, secure: !isLocalAuthMode(), sameSite: "lax", path: "/", maxAge: SESSION_TTL });
}

function setOidcCookie(res: Response, name: string, value: string): void {
  res.cookie(name, value, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: OIDC_COOKIE_TTL });
}

function getSafeReturnTo(_value: unknown): string {
  return "/";
}

async function upsertUser(claims: Record<string, unknown>) {
  const userData = {
    id: claims.sub as string,
    email: (claims.email as string) || null,
    firstName: (claims.first_name || claims.given_name) as string | null,
    lastName: (claims.last_name || claims.family_name) as string | null,
    profileImageUrl: (claims.profile_image_url || claims.picture) as string | null,
  };
  const [user] = await db.insert(usersTable).values(userData).onConflictDoUpdate({
    target: usersTable.id,
    set: { ...userData, updatedAt: new Date() },
  }).returning();
  return user;
}

router.get("/auth/user", (req, res) => {
  res.json(GetCurrentAuthUserResponse.parse({ user: req.isAuthenticated() ? req.user : null }));
});

router.get("/login", async (req, res) => {
  if (isLocalAuthMode()) {
    const user = await upsertUser({
      sub: "local-developer",
      email: process.env.LOCAL_DEV_EMAIL || "developer@flowmind.local",
      given_name: "Local",
      family_name: "Developer",
    });
    const now = Math.floor(Date.now() / 1000);
    const sessionData: SessionData = {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        profileImageUrl: user.profileImageUrl,
      },
      access_token: "local-development-only",
      expires_at: now + Math.floor(SESSION_TTL / 1000),
    };
    setSessionCookie(res, await createSession(sessionData));
    res.redirect("/");
    return;
  }
  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin()}/api/callback`;
  const state = oidc.randomState();
  const nonce = oidc.randomNonce();
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
  const redirectTo = oidc.buildAuthorizationUrl(
    config,
    buildAuthorizationParams(callbackUrl, state, nonce, codeChallenge),
  );
  setOidcCookie(res, "code_verifier", codeVerifier);
  setOidcCookie(res, "nonce", nonce);
  setOidcCookie(res, "state", state);
  setOidcCookie(res, "return_to", getSafeReturnTo(req.query.returnTo));
  res.redirect(redirectTo.href);
});

router.get("/callback", async (req, res) => {
  if (isLocalAuthMode()) {
    res.redirect("/");
    return;
  }
  const config = await getOidcConfig();
  const callbackUrl = `${getOrigin()}/api/callback`;
  const codeVerifier = req.cookies?.code_verifier;
  const nonce = req.cookies?.nonce;
  const expectedState = req.cookies?.state;
  if (!codeVerifier || !expectedState) {
    res.redirect("/api/login");
    return;
  }
  const currentUrl = new URL(callbackUrl);
  currentUrl.search = new URL(req.url, "http://localhost").search;
  let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
  try {
    tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
      pkceCodeVerifier: codeVerifier,
      expectedNonce: nonce,
      expectedState,
      idTokenExpected: true,
    });
  } catch (error) {
    req.log.warn({ err: error }, "OIDC callback rejected");
    res.redirect("/api/login");
    return;
  }
  const returnTo = getSafeReturnTo(req.cookies?.return_to);
  for (const cookie of ["code_verifier", "nonce", "state", "return_to"]) res.clearCookie(cookie, { path: "/" });
  const claims = tokens.claims();
  if (!claims) {
    res.redirect("/api/login");
    return;
  }
  const user = await upsertUser(claims as unknown as Record<string, unknown>);
  const now = Math.floor(Date.now() / 1000);
  const sessionData: SessionData = {
    user: { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName, profileImageUrl: user.profileImageUrl },
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expiresIn() ? now + tokens.expiresIn()! : claims.exp,
  };
  setSessionCookie(res, await createSession(sessionData));
  res.redirect(returnTo);
});

router.get("/logout", async (req, res) => {
  if (isLocalAuthMode()) {
    await clearSession(res, getSessionId(req));
    res.redirect("/");
    return;
  }
  const config = await getOidcConfig();
  const origin = getOrigin();
  const returnTo = getSafeReturnTo(req.query.returnTo);
  await clearSession(res, getSessionId(req));
  // Providers such as Google do not publish an RP-initiated logout endpoint;
  // clearing the local session is the full sign-out in that case.
  if (!config.serverMetadata().end_session_endpoint) {
    res.redirect(returnTo);
    return;
  }
  const endSessionUrl = oidc.buildEndSessionUrl(config, {
    client_id: getOidcClientId(),
    post_logout_redirect_uri: new URL(returnTo, `${origin}/`).href,
  });
  res.redirect(endSessionUrl.href);
});

export default router;