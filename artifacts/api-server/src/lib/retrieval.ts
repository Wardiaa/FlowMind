import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, documentChunksTable, documentsTable } from "@workspace/db";
import { chunkText } from "./chunking";
import { EMBEDDING_MODEL, embedTexts } from "./gemini";
import { recordAiUsage } from "./aiUsage";

export type ChunkSearchResult = {
  documentId: string;
  documentName: string;
  chunkIndex: number;
  content: string;
  score: number;
};

export type ChunkSearch = {
  mode: "vector" | "keyword";
  results: ChunkSearchResult[];
};

// Indexing is skipped for the rest of the process after an embedding failure so
// every request does not retry a broken Gemini configuration.
let indexingDisabled = false;

export async function indexDocument(ownerId: string, documentId: string, text: string): Promise<number> {
  if (indexingDisabled || !process.env.GEMINI_API_KEY) return 0;
  const chunks = chunkText(text);
  if (chunks.length === 0) return 0;
  const { embeddings, totalTokens } = await embedTexts(chunks);
  await db.delete(documentChunksTable).where(
    and(eq(documentChunksTable.ownerId, ownerId), eq(documentChunksTable.documentId, documentId)),
  );
  const rows = chunks.map((content, index) => ({
    id: randomUUID(),
    ownerId,
    documentId,
    chunkIndex: index,
    content,
    embedding: embeddings[index],
  }));
  for (let start = 0; start < rows.length; start += 50) {
    await db.insert(documentChunksTable).values(rows.slice(start, start + 50));
  }
  await recordAiUsage(ownerId, {
    feature: "embedding",
    model: EMBEDDING_MODEL,
    inputTokens: totalTokens,
    outputTokens: 0,
    refId: documentId,
  });
  return chunks.length;
}

export function disableIndexing(reason: unknown): void {
  if (indexingDisabled) return;
  indexingDisabled = true;
  console.error("Disabling document indexing for this process after an embedding failure.", reason);
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

async function keywordSearch(ownerId: string, query: string, k: number): Promise<ChunkSearch> {
  const terms = query.toLowerCase().split(/\s+/).filter((term) => term.length > 2).slice(0, 6);
  if (terms.length === 0) return { mode: "keyword", results: [] };
  const docs = await db
    .select({ id: documentsTable.id, name: documentsTable.name, text: documentsTable.extractedText })
    .from(documentsTable)
    .where(and(eq(documentsTable.ownerId, ownerId), eq(documentsTable.status, "Processed")));
  const results: ChunkSearchResult[] = [];
  for (const doc of docs) {
    const lower = (doc.text ?? "").toLowerCase();
    const matched = terms.filter((term) => lower.includes(term));
    if (matched.length === 0) continue;
    const firstHit = lower.indexOf(escapeLike(matched[0]));
    const start = Math.max(0, firstHit - 200);
    results.push({
      documentId: doc.id,
      documentName: doc.name,
      chunkIndex: 0,
      content: (doc.text ?? "").slice(start, start + 600).trim(),
      score: matched.length / terms.length,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return { mode: "keyword", results: results.slice(0, k) };
}

export async function searchChunks(ownerId: string, query: string, k = 6): Promise<ChunkSearch> {
  if (process.env.GEMINI_API_KEY && !indexingDisabled) {
    try {
      const { embeddings, totalTokens } = await embedTexts([query.slice(0, 8_000)]);
      await recordAiUsage(ownerId, {
        feature: "embedding",
        model: EMBEDDING_MODEL,
        inputTokens: totalTokens,
        outputTokens: 0,
      });
      const literal = `[${embeddings[0].join(",")}]`;
      const result = await db.execute(sql`
        select c.document_id, c.chunk_index, c.content, d.name as document_name,
               1 - (c.embedding <=> ${literal}::vector) as score
        from flowmind_document_chunks c
        join flowmind_documents d on d.id = c.document_id
        where c.owner_id = ${ownerId}
        order by c.embedding <=> ${literal}::vector
        limit ${k}
      `);
      const rows = result.rows as Array<{
        document_id: string;
        document_name: string;
        chunk_index: number;
        content: string;
        score: string;
      }>;
      if (rows.length > 0) {
        return {
          mode: "vector",
          results: rows.map((row) => ({
            documentId: row.document_id,
            documentName: row.document_name,
            chunkIndex: row.chunk_index,
            content: row.content,
            score: Number(row.score),
          })),
        };
      }
    } catch (error) {
      console.error("Vector search failed; falling back to keyword search.", error);
    }
  }
  return keywordSearch(ownerId, query, k);
}
