import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing. Copy .env.example to .env first.");
  process.exit(1);
}

async function withClient(run) {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

try {
  await withClient((client) => client.query("CREATE EXTENSION IF NOT EXISTS vector"));
  console.log("pgvector extension ready.");
} catch (error) {
  console.error(`Could not create the pgvector extension: ${error instanceof Error ? error.message : String(error)}`);
  console.error("Local development needs the pgvector/pgvector:pg16 image (docker compose up -d db).");
  process.exit(1);
}

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(command, ["--filter", "@workspace/db", "run", "push"], {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
if ((result.status ?? 1) !== 0) {
  process.exit(result.status ?? 1);
}

try {
  await withClient((client) =>
    client.query(
      "CREATE INDEX IF NOT EXISTS flowmind_document_chunks_embedding_hnsw ON flowmind_document_chunks USING hnsw (embedding vector_cosine_ops)",
    ),
  );
  console.log("Embedding index ready.");
} catch (error) {
  console.error(`Could not create the embedding index: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
