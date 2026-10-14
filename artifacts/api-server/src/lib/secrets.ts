import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

// Personal AI keys are stored encrypted (AES-256-GCM) in the database. The
// key-encryption key comes from FLOWMIND_ENCRYPTION_KEY; without it the BYOK
// feature is disabled and stored keys cannot be recovered.
const CIPHER_PREFIX = "v1:";

function encryptionKey(): Buffer | null {
  const secret = process.env.FLOWMIND_ENCRYPTION_KEY?.trim();
  if (!secret) return null;
  return createHash("sha256").update(secret).digest();
}

export function encryptionConfigured(): boolean {
  return encryptionKey() !== null;
}

export function encryptSecret(plain: string): string {
  const key = encryptionKey();
  if (!key) throw new Error("FLOWMIND_ENCRYPTION_KEY is not set; cannot store secrets.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${CIPHER_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(stored: string): string {
  const key = encryptionKey();
  if (!key) throw new Error("FLOWMIND_ENCRYPTION_KEY is not set; cannot read stored secrets.");
  if (!stored.startsWith(CIPHER_PREFIX)) throw new Error("Stored secret has an unknown format.");
  const [ivB64, tagB64, dataB64] = stored.slice(CIPHER_PREFIX.length).split(":");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export function maskSecret(plain: string): string {
  if (plain.length <= 8) return "••••";
  return `${plain.slice(0, 6)}…${plain.slice(-4)}`;
}
