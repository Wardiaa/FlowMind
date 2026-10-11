import { Readable } from "stream";
import { RequestUploadUrlBody, RequestUploadUrlResponse } from "@workspace/api-zod";
import express, { Router, type IRouter, type Request, type Response } from "express";
import {
  InvalidLocalUploadError,
  ObjectNotFoundError,
  ObjectStorageService,
} from "../lib/objectStorage";
import { ObjectPermission } from "../lib/objectAcl";

const router: IRouter = Router();
const storage = new ObjectStorageService();
const acceptedTypes = new Set([
  "application/pdf", "text/plain", "text/markdown", "text/csv", "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;

router.post("/storage/uploads/request-url", async (req: Request, res: Response): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Sign in before uploading files." });
    return;
  }
  const parsed = RequestUploadUrlBody.safeParse(req.body);
  if (!parsed.success || parsed.data.size > MAX_UPLOAD_SIZE || !acceptedTypes.has(parsed.data.contentType)) {
    res.status(400).json({ error: "Upload a supported document up to 25 MB." });
    return;
  }
  try {
    const { name, size, contentType } = parsed.data;
    const uploadURL = await storage.getObjectEntityUploadURL(req.user.id, { size, contentType });
    const objectPath = storage.normalizeObjectEntityPath(uploadURL);
    res.json(RequestUploadUrlResponse.parse({ uploadURL, objectPath, metadata: { name, size, contentType } }));
  } catch (error) {
    req.log.error({ err: error }, "Unable to generate document upload URL");
    res.status(500).json({ error: "Unable to prepare document upload." });
  }
});

router.put(
  "/storage/local-uploads/:ownerHash/:id",
  express.raw({ type: "*/*", limit: MAX_UPLOAD_SIZE }),
  async (req: Request, res: Response): Promise<void> => {
    if (!req.isAuthenticated()) {
      res.status(401).json({ error: "Sign in before uploading files." });
      return;
    }
    const body = req.body;
    const contentType = (req.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (
      !Buffer.isBuffer(body) ||
      body.length > MAX_UPLOAD_SIZE ||
      !acceptedTypes.has(contentType)
    ) {
      res.status(400).json({ error: "Upload a supported document up to 25 MB." });
      return;
    }
    try {
      const ownerHash = Array.isArray(req.params.ownerHash)
        ? req.params.ownerHash[0]
        : req.params.ownerHash;
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      await storage.saveUpload(req.user.id, ownerHash, id, contentType, body);
      res.status(201).json({ uploaded: true });
    } catch (error) {
      if (error instanceof InvalidLocalUploadError) {
        res.status(400).json({ error: "The upload does not match its request." });
        return;
      }
      if (error instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "Upload request not found." });
        return;
      }
      req.log.error({ err: error }, "Unable to save document upload");
      res.status(500).json({ error: "Unable to save document upload." });
    }
  },
);

router.get("/storage/public-objects/*filePath", async (req: Request, res: Response): Promise<void> => {
  try {
    const raw = req.params.filePath;
    const filePath = Array.isArray(raw) ? raw.join("/") : raw;
    const file = await storage.searchPublicObject(filePath);
    if (!file) {
      res.status(404).json({ error: "File not found." });
      return;
    }
    const response = await storage.downloadObject(file);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
    else res.end();
  } catch (error) {
    req.log.error({ err: error }, "Unable to serve public asset");
    res.status(500).json({ error: "Unable to serve public asset." });
  }
});

router.get("/storage/objects/*path", async (req: Request, res: Response): Promise<void> => {
  if (!req.isAuthenticated()) {
    res.status(401).json({ error: "Sign in to access this document." });
    return;
  }
  try {
    const raw = req.params.path;
    const wildcard = Array.isArray(raw) ? raw.join("/") : raw;
    const objectFile = await storage.getObjectEntityFile(`/objects/${wildcard}`);
    const allowed = await storage.canAccessObjectEntity({
      userId: req.user.id,
      objectFile,
      requestedPermission: ObjectPermission.READ,
    });
    if (!allowed) {
      res.status(403).json({ error: "You do not have access to this document." });
      return;
    }
    const response = await storage.downloadObject(objectFile);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    if (response.body) Readable.fromWeb(response.body as ReadableStream<Uint8Array>).pipe(res);
    else res.end();
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Document not found." });
      return;
    }
    req.log.error({ err: error }, "Unable to serve private document");
    res.status(500).json({ error: "Unable to serve document." });
  }
});

export default router;