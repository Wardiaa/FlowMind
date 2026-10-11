import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const webPort = process.env.FLOWMIND_WEB_PORT || "22473";
const apiPort = process.env.API_PORT || "8080";
const publicUrl = process.env.PUBLIC_APP_URL || `http://127.0.0.1:${webPort}`;
const authMode = process.env.FLOWMIND_AUTH_MODE || "local";
const storageMode = process.env.FLOWMIND_STORAGE_MODE || "filesystem";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing. Copy .env.example to .env first.");
  process.exit(1);
}
if (authMode !== "local") {
  console.error("The local dev command requires FLOWMIND_AUTH_MODE=local.");
  process.exit(1);
}
if (storageMode !== "filesystem") {
  console.error("The local dev command uses FLOWMIND_STORAGE_MODE=filesystem.");
  process.exit(1);
}

const commonEnv = {
  ...process.env,
  NODE_ENV: "development",
  FLOWMIND_AUTH_MODE: "local",
  FLOWMIND_STORAGE_MODE: "filesystem",
  FLOWMIND_DATA_DIR: path.resolve(root, process.env.FLOWMIND_DATA_DIR || "data"),
  PUBLIC_APP_URL: publicUrl,
  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS || publicUrl,
};

function pnpmCommand() {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

const typecheck = spawnSync(pnpmCommand(), ["run", "typecheck:libs"], {
  cwd: root,
  env: commonEnv,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if (typecheck.status !== 0) {
  process.exit(typecheck.status ?? 1);
}

const children = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exitCode = code;
}

function start(args, env, label) {
  const child = spawn(pnpmCommand(), args, {
    cwd: root,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(`${label} failed to start: ${error.message}`);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) {
      console.error(`${label} stopped${signal ? ` (${signal})` : ` with code ${code}`}.`);
      stop(code && code > 0 ? code : 1);
    }
  });
}

process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

start(
  ["--filter", "@workspace/api-server", "run", "dev"],
  {
    ...commonEnv,
    PORT: apiPort,
    API_PORT: apiPort,
  },
  "FlowMind API",
);
start(
  ["--filter", "@workspace/flowmind", "run", "dev"],
  {
    ...commonEnv,
    PORT: webPort,
    API_PORT: apiPort,
    BASE_PATH: "/",
  },
  "FlowMind web",
);

console.log(`FlowMind local preview: ${publicUrl}`);
