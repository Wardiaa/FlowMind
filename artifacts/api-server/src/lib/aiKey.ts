import { eq } from "drizzle-orm";
import { db, workspaceSettingsTable } from "@workspace/db";
import { decryptSecret, encryptSecret, maskSecret } from "./secrets";

export type WorkspaceAiKeyState = { configured: boolean; hint: string | null };

export type ResolvedAiKey = { apiKey: string | null; source: "workspace" | "server" };

function isConfigured(enc: string | null): boolean {
  return typeof enc === "string" && enc.length > 0;
}

function storedKey(enc: string | null): string | null {
  return isConfigured(enc) ? (enc as string) : null;
}

export async function getWorkspaceAiKeyState(ownerId: string): Promise<WorkspaceAiKeyState> {
  const [row] = await db
    .select({ enc: workspaceSettingsTable.geminiApiKeyEnc })
    .from(workspaceSettingsTable)
    .where(eq(workspaceSettingsTable.ownerId, ownerId));
  const enc = storedKey(row?.enc ?? null);
  if (!enc) return { configured: false, hint: null };
  try {
    return { configured: true, hint: maskSecret(decryptSecret(enc)) };
  } catch {
    // Undecryptable (e.g. FLOWMIND_ENCRYPTION_KEY rotated) — treat as absent.
    return { configured: false, hint: null };
  }
}

// Returns the workspace's personal key when usable, otherwise null so callers
// fall back to the server-level GEMINI_API_KEY.
export async function resolveWorkspaceAiKey(ownerId: string): Promise<string | null> {
  const [row] = await db
    .select({ enc: workspaceSettingsTable.geminiApiKeyEnc })
    .from(workspaceSettingsTable)
    .where(eq(workspaceSettingsTable.ownerId, ownerId));
  const enc = storedKey(row?.enc ?? null);
  if (!enc) return null;
  try {
    return decryptSecret(enc);
  } catch {
    return null;
  }
}

export async function saveWorkspaceAiKey(ownerId: string, key: string): Promise<WorkspaceAiKeyState> {
  const enc = encryptSecret(key.trim());
  await db
    .insert(workspaceSettingsTable)
    .values({ ownerId, geminiApiKeyEnc: enc })
    .onConflictDoUpdate({
      target: workspaceSettingsTable.ownerId,
      set: { geminiApiKeyEnc: enc, updatedAt: new Date() },
    });
  return { configured: true, hint: maskSecret(key.trim()) };
}

export async function deleteWorkspaceAiKey(ownerId: string): Promise<void> {
  await db
    .update(workspaceSettingsTable)
    .set({ geminiApiKeyEnc: null, updatedAt: new Date() })
    .where(eq(workspaceSettingsTable.ownerId, ownerId));
}
