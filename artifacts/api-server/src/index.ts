import app from "./app";
import { isLocalAuthMode } from "./lib/auth";
import { logger } from "./lib/logger";
import path from "node:path";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);
const localAuth = isLocalAuthMode();
const storageMode = process.env.FLOWMIND_STORAGE_MODE || "filesystem";

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

if (!localAuth && (!process.env.OIDC_ISSUER_URL || !process.env.OIDC_CLIENT_ID)) {
  throw new Error("Set OIDC_ISSUER_URL and OIDC_CLIENT_ID before starting the API.");
}
if (!localAuth && !process.env.PUBLIC_APP_URL) {
  throw new Error("Set PUBLIC_APP_URL before starting the API.");
}
if (!localAuth) {
  const issuerUrl = new URL(process.env.OIDC_ISSUER_URL!);
  const publicAppUrl = new URL(process.env.PUBLIC_APP_URL!);
  if (
    publicAppUrl.pathname !== "/" ||
    publicAppUrl.search ||
    publicAppUrl.hash ||
    publicAppUrl.username ||
    publicAppUrl.password
  ) {
    throw new Error("PUBLIC_APP_URL must be the app origin without a path or credentials.");
  }
  if (
    process.env.NODE_ENV === "production" &&
    (issuerUrl.protocol !== "https:" || publicAppUrl.protocol !== "https:")
  ) {
    throw new Error("Production OIDC issuer and PUBLIC_APP_URL must use HTTPS.");
  }
}
if (storageMode !== "filesystem" && storageMode !== "s3") {
  throw new Error('FLOWMIND_STORAGE_MODE must be "filesystem" or "s3".');
}
if (storageMode === "s3") {
  for (const name of [
    "S3_ENDPOINT",
    "S3_REGION",
    "S3_BUCKET",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
  ]) {
    if (!process.env[name]) {
      throw new Error(`${name} is required when FLOWMIND_STORAGE_MODE=s3.`);
    }
  }
}
if (process.env.NODE_ENV === "production" && storageMode === "filesystem") {
  if (process.env.FLOWMIND_ALLOW_FILESYSTEM_STORAGE_IN_PRODUCTION !== "true") {
    throw new Error(
      "Production filesystem storage requires an explicitly configured persistent volume.",
    );
  }
  if (!process.env.FLOWMIND_DATA_DIR || !path.isAbsolute(process.env.FLOWMIND_DATA_DIR)) {
    throw new Error("Set FLOWMIND_DATA_DIR to an absolute persistent directory in production.");
  }
}

app.listen(port, localAuth ? "127.0.0.1" : "0.0.0.0", (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
