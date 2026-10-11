import crypto from "crypto";
import type { AuthUser } from "@workspace/api-zod";
import { db, sessionsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { type Request, type Response } from "express";
import * as client from "openid-client";

export const SESSION_COOKIE = "sid";
export const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;

export interface SessionData {
  user: AuthUser;
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
}

let oidcConfig: client.Configuration | null = null;

export function isLocalAuthMode(): boolean {
  const localMode = process.env.FLOWMIND_AUTH_MODE === "local";
  if (localMode && process.env.NODE_ENV === "production") {
    throw new Error("Local development authentication cannot run in production.");
  }
  return localMode;
}

export function getOidcClientId(): string {
  const clientId = process.env.OIDC_CLIENT_ID;
  if (!clientId) throw new Error("OIDC_CLIENT_ID is required for OIDC sign-in.");
  return clientId;
}

export async function getOidcConfig(): Promise<client.Configuration> {
  if (!oidcConfig) {
    const issuer = process.env.OIDC_ISSUER_URL;
    if (!issuer) throw new Error("OIDC_ISSUER_URL is required for OIDC sign-in.");
    oidcConfig = await client.discovery(
      new URL(issuer),
      getOidcClientId(),
      process.env.OIDC_CLIENT_SECRET || undefined,
    );
  }
  return oidcConfig;
}

export async function createSession(data: SessionData): Promise<string> {
  const sid = crypto.randomBytes(32).toString("hex");
  await db.insert(sessionsTable).values({
    sid,
    sess: data as unknown as Record<string, unknown>,
    expire: new Date(Date.now() + SESSION_TTL),
  });
  return sid;
}

export async function getSession(sid: string): Promise<SessionData | null> {
  const [row] = await db.select().from(sessionsTable).where(eq(sessionsTable.sid, sid));
  if (!row || row.expire < new Date()) {
    if (row) await deleteSession(sid);
    return null;
  }
  return row.sess as unknown as SessionData;
}

export async function updateSession(sid: string, data: SessionData): Promise<void> {
  await db.update(sessionsTable)
    .set({ sess: data as unknown as Record<string, unknown>, expire: new Date(Date.now() + SESSION_TTL) })
    .where(eq(sessionsTable.sid, sid));
}

export async function deleteSession(sid: string): Promise<void> {
  await db.delete(sessionsTable).where(eq(sessionsTable.sid, sid));
}

export async function clearSession(res: Response, sid?: string): Promise<void> {
  if (sid) await deleteSession(sid);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function getSessionId(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return req.cookies?.[SESSION_COOKIE];
}