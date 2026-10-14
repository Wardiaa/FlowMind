import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Without this handler an idle-client connection error crashes the whole process.
pool.on("error", (error) => {
  console.error("[db] idle client error", error);
});
export const db = drizzle(pool, { schema });

export * from "./schema";
