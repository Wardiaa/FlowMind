import { createHash, randomUUID } from "node:crypto";
import { createReadStream, type ReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  canAccessObject,
  getObjectAclPolicy,
  ObjectPermission,
  setObjectAclPolicy,
  type ObjectAclFile,
  type ObjectAclPolicy,
} from "./objectAcl";

const MAX_UPLOAD_SIZE = 25 * 1024 * 1024;
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const OWNER_HASH_PATTERN = /^[a-f0-9]{64}$/;
const UPLOAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACL_POLICY_METADATA_KEY = "custom:aclPolicy";
// S3 user metadata is sent as x-amz-meta-* headers, whose names cannot contain ":",
// so the S3 adapter stores the ACL under this key and maps it back on read.
const S3_ACL_METADATA_KEY = "acl-policy";
const PENDING_UPLOADS_PREFIX = "pending-uploads";
const UPLOADS_PREFIX = "uploads";

interface UploadDescriptor {
  ownerId: string;
  ownerHash: string;
  contentType: string;
  size: number;
  expiresAt: number;
}

interface LocalFileMetadata {
  contentType: string;
  metadata: Record<string, string>;
}

export class ObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectNotFoundError";
  }
}

export class InvalidLocalUploadError extends Error {
  constructor() {
    super("The upload does not match its upload request.");
    this.name = "InvalidLocalUploadError";
  }
}

class LocalObjectFile implements ObjectAclFile {
  constructor(
    readonly name: string,
    readonly filePath: string,
    readonly metadataPath: string,
  ) {}

  async exists(): Promise<[boolean]> {
    try {
      await fs.access(this.filePath);
      return [true];
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [false];
      throw error;
    }
  }

  async getMetadata(): Promise<[{
    size: number;
    contentType: string;
    metadata: Record<string, unknown>;
  }]> {
    try {
      const [stat, stored] = await Promise.all([
        fs.stat(this.filePath),
        this.readMetadata(),
      ]);
      return [{
        size: stat.size,
        contentType: stored.contentType,
        metadata: stored.metadata,
      }];
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new ObjectNotFoundError();
      }
      throw error;
    }
  }

  async setMetadata(options: {
    metadata: Record<string, string>;
  }): Promise<void> {
    const [exists] = await this.exists();
    if (!exists) throw new ObjectNotFoundError();
    const current = await this.readMetadata();
    await writeJsonAtomically(this.metadataPath, {
      contentType: current.contentType,
      metadata: { ...current.metadata, ...options.metadata },
    } satisfies LocalFileMetadata);
  }

  async download(): Promise<[Buffer]> {
    try {
      return [await fs.readFile(this.filePath)];
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new ObjectNotFoundError();
      }
      throw error;
    }
  }

  createReadStream(): ReadStream {
    return createReadStream(this.filePath);
  }

  async delete(options: { ignoreNotFound?: boolean } = {}): Promise<void> {
    try {
      await Promise.all([
        fs.rm(this.filePath),
        fs.rm(this.metadataPath, { force: true }),
      ]);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT" && options.ignoreNotFound) {
        return;
      }
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new ObjectNotFoundError();
      }
      throw error;
    }
  }

  private async readMetadata(): Promise<LocalFileMetadata> {
    try {
      const value = JSON.parse(await fs.readFile(this.metadataPath, "utf8")) as Partial<LocalFileMetadata>;
      return {
        contentType:
          typeof value.contentType === "string"
            ? value.contentType
            : "application/octet-stream",
        metadata:
          value.metadata && typeof value.metadata === "object"
            ? Object.fromEntries(
                Object.entries(value.metadata).filter(
                  ([, entry]) => typeof entry === "string",
                ),
              ) as Record<string, string>
            : {},
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { contentType: "application/octet-stream", metadata: {} };
      }
      throw error;
    }
  }
}

class S3ObjectFile implements ObjectAclFile {
  constructor(
    private readonly s3: S3Client,
    private readonly bucket: string,
    readonly name: string,
    private readonly key: string,
  ) {}

  async exists(): Promise<[boolean]> {
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key }));
      return [true];
    } catch (error) {
      if (isS3NotFound(error)) return [false];
      throw error;
    }
  }

  async getMetadata(): Promise<[{
    size: number;
    contentType: string;
    metadata: Record<string, unknown>;
  }]> {
    try {
      const head = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: this.key }),
      );
      return [{
        size: head.ContentLength ?? 0,
        contentType: head.ContentType ?? "application/octet-stream",
        metadata: canonicalizeS3Metadata(head.Metadata),
      }];
    } catch (error) {
      if (isS3NotFound(error)) throw new ObjectNotFoundError();
      throw error;
    }
  }

  async setMetadata(options: {
    metadata: Record<string, string>;
  }): Promise<void> {
    const [exists] = await this.exists();
    if (!exists) throw new ObjectNotFoundError();
    const head = await this.s3.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: this.key }),
    );
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries(head.Metadata ?? {})) {
      if (typeof value === "string") merged[key] = value;
    }
    Object.assign(merged, toS3Metadata(options.metadata));
    await this.s3.send(new CopyObjectCommand({
      Bucket: this.bucket,
      Key: this.key,
      CopySource: `${this.bucket}/${this.key}`,
      MetadataDirective: "REPLACE",
      Metadata: merged,
      ContentType: head.ContentType,
    }));
  }

  async download(): Promise<[Buffer]> {
    try {
      const output = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.key }),
      );
      if (!output.Body) throw new ObjectNotFoundError();
      return [Buffer.from(await output.Body.transformToByteArray())];
    } catch (error) {
      if (isS3NotFound(error)) throw new ObjectNotFoundError();
      throw error;
    }
  }

  createReadStream(): Readable {
    const passthrough = new PassThrough();
    this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key }))
      .then((output) => {
        if (!output.Body) {
          passthrough.destroy(new ObjectNotFoundError());
          return;
        }
        (output.Body as Readable).pipe(passthrough);
      })
      .catch((error) => {
        passthrough.destroy(isS3NotFound(error) ? new ObjectNotFoundError() : error);
      });
    return passthrough;
  }

  async delete(options: { ignoreNotFound?: boolean } = {}): Promise<void> {
    const [exists] = await this.exists();
    if (!exists) {
      if (options.ignoreNotFound) return;
      throw new ObjectNotFoundError();
    }
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key }));
  }
}

export class ObjectStorageService {
  private readonly mode = process.env.FLOWMIND_STORAGE_MODE === "s3" ? "s3" : "filesystem";
  private readonly dataRoot = path.resolve(
    process.env.FLOWMIND_DATA_DIR || path.resolve(process.cwd(), "data"),
  );
  private readonly privateRoot = path.join(this.dataRoot, "private");
  private readonly publicRoot = path.join(this.dataRoot, "public");
  private readonly pendingRoot = path.join(this.dataRoot, "pending-uploads");
  private readonly bucket = process.env.S3_BUCKET || "";
  private s3Client: S3Client | null = null;

  getPublicObjectSearchPaths(): string[] {
    return this.mode === "s3" ? [] : [this.publicRoot];
  }

  async searchPublicObject(
    filePath: string,
  ): Promise<(ObjectAclFile & { createReadStream(): Readable }) | null> {
    if (this.mode === "s3") return null;
    const segments = filePath.replace(/\\/g, "/").split("/");
    if (
      !filePath ||
      filePath.startsWith("/") ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      return null;
    }

    await fs.mkdir(this.publicRoot, { recursive: true, mode: 0o755 });
    const candidate = path.resolve(this.publicRoot, ...segments);
    if (!candidate.startsWith(`${this.publicRoot}${path.sep}`)) return null;
    try {
      const [realRoot, realFile] = await Promise.all([
        fs.realpath(this.publicRoot),
        fs.realpath(candidate),
      ]);
      if (!realFile.startsWith(`${realRoot}${path.sep}`)) return null;
      const stat = await fs.stat(realFile);
      if (!stat.isFile()) return null;
      return new LocalObjectFile(
        `public/${segments.join("/")}`,
        realFile,
        `${realFile}.json`,
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  async downloadObject(
    file: ObjectAclFile & { createReadStream(): Readable },
    cacheTtlSec = 3600,
  ): Promise<Response> {
    const [metadata] = await file.getMetadata();
    const policy = await getObjectAclPolicy(file);
    const headers: Record<string, string> = {
      "Content-Type": metadata.contentType || "application/octet-stream",
      "Cache-Control": `${policy?.visibility === "public" ? "public" : "private"}, max-age=${cacheTtlSec}`,
      "X-Content-Type-Options": "nosniff",
    };
    if (metadata.size) headers["Content-Length"] = String(metadata.size);
    const webStream = Readable.toWeb(file.createReadStream()) as ReadableStream;
    return new Response(webStream, { headers });
  }

  async getObjectEntityUploadURL(
    ownerId: string,
    descriptor: { contentType: string; size: number },
  ): Promise<string> {
    if (
      !ownerId ||
      !ALLOWED_CONTENT_TYPES.has(descriptor.contentType) ||
      !Number.isInteger(descriptor.size) ||
      descriptor.size < 1 ||
      descriptor.size > MAX_UPLOAD_SIZE
    ) {
      throw new InvalidLocalUploadError();
    }

    const ownerHash = hashOwner(ownerId);
    const id = randomUUID();
    const pending: UploadDescriptor = {
      ownerId,
      ownerHash,
      contentType: descriptor.contentType,
      size: descriptor.size,
      expiresAt: Date.now() + UPLOAD_TTL_MS,
    };
    if (this.mode === "s3") {
      await this.getS3().send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${PENDING_UPLOADS_PREFIX}/${id}.json`,
        Body: JSON.stringify(pending),
        ContentType: "application/json",
      }));
    } else {
      await fs.mkdir(this.pendingRoot, { recursive: true, mode: 0o700 });
      await writeJsonAtomically(this.pendingPath(id), pending);
    }
    const baseUrl = process.env.PUBLIC_APP_URL || "http://127.0.0.1:22473";
    return `${baseUrl}/api/storage/local-uploads/${ownerHash}/${id}`;
  }

  async saveUpload(
    ownerId: string,
    ownerHash: string,
    id: string,
    contentType: string,
    bytes: Buffer,
  ): Promise<void> {
    if (
      !UPLOAD_ID_PATTERN.test(id) ||
      !OWNER_HASH_PATTERN.test(ownerHash) ||
      hashOwner(ownerId) !== ownerHash ||
      !ALLOWED_CONTENT_TYPES.has(contentType) ||
      bytes.length < 1 ||
      bytes.length > MAX_UPLOAD_SIZE
    ) {
      throw new InvalidLocalUploadError();
    }

    const descriptor = await this.readPendingUpload(id);
    if (
      !descriptor ||
      descriptor.expiresAt < Date.now() ||
      descriptor.ownerId !== ownerId ||
      descriptor.ownerHash !== ownerHash ||
      descriptor.contentType !== contentType ||
      descriptor.size !== bytes.length
    ) {
      throw new InvalidLocalUploadError();
    }

    if (this.mode === "s3") {
      await this.getS3().send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.objectKey(ownerHash, id),
        Body: bytes,
        ContentType: contentType,
        Metadata: {
          [S3_ACL_METADATA_KEY]: JSON.stringify({
            owner: ownerId,
            visibility: "private",
          } satisfies ObjectAclPolicy),
        },
      }));
      await this.getS3().send(new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: `${PENDING_UPLOADS_PREFIX}/${id}.json`,
      }));
      return;
    }

    const file = this.privateFile(ownerHash, id);
    await fs.mkdir(path.dirname(file.filePath), { recursive: true, mode: 0o700 });
    try {
      await fs.writeFile(file.filePath, bytes, { flag: "wx", mode: 0o600 });
      await writeJsonAtomically(file.metadataPath, {
        contentType,
        metadata: {
          [ACL_POLICY_METADATA_KEY]: JSON.stringify({
            owner: ownerId,
            visibility: "private",
          } satisfies ObjectAclPolicy),
        },
      } satisfies LocalFileMetadata);
      await fs.rm(this.pendingPath(id), { force: true });
    } catch (error) {
      await fs.rm(file.filePath, { force: true });
      await fs.rm(file.metadataPath, { force: true });
      throw error;
    }
  }

  async getObjectEntityFile(objectPath: string): Promise<ObjectAclFile & {
    createReadStream(): Readable;
    download(): Promise<[Buffer]>;
    delete(options?: { ignoreNotFound?: boolean }): Promise<void>;
  }> {
    const match = /^\/objects\/uploads\/([a-f0-9]{64})\/([0-9a-f-]{36})$/i.exec(objectPath);
    if (!match || !UPLOAD_ID_PATTERN.test(match[2])) {
      throw new ObjectNotFoundError();
    }
    if (this.mode === "s3") {
      const name = this.objectKey(match[1], match[2]);
      return new S3ObjectFile(this.getS3(), this.bucket, name, name);
    }
    const file = this.privateFile(match[1], match[2]);
    const [exists] = await file.exists();
    if (!exists) throw new ObjectNotFoundError();
    return file;
  }

  normalizeObjectEntityPath(rawPath: string): string {
    let pathname = rawPath;
    try {
      // Si c'est une URL absolue, on extrait le chemin
      if (rawPath.startsWith("http://") || rawPath.startsWith("https://")) {
        pathname = new URL(rawPath).pathname;
      }
    } catch {
      // Si ce n'est pas une URL valide, on garde la valeur brute
    }
    const match =
      /^\/api\/storage\/local-uploads\/([a-f0-9]{64})\/([0-9a-f-]{36})$/i.exec(pathname);
    if (!match || !UPLOAD_ID_PATTERN.test(match[2])) return rawPath;
    return `/objects/uploads/${match[1]}/${match[2]}`;
  }

  async trySetObjectEntityAclPolicy(
    rawPath: string,
    policy: ObjectAclPolicy,
  ): Promise<string> {
    const normalized = this.normalizeObjectEntityPath(rawPath);
    if (!normalized.startsWith("/objects/")) return normalized;
    await setObjectAclPolicy(await this.getObjectEntityFile(normalized), policy);
    return normalized;
  }

  async canAccessObjectEntity({
    userId,
    objectFile,
    requestedPermission,
  }: {
    userId?: string;
    objectFile: ObjectAclFile;
    requestedPermission?: ObjectPermission;
  }): Promise<boolean> {
    return canAccessObject({
      userId,
      objectFile,
      requestedPermission: requestedPermission ?? ObjectPermission.READ,
    });
  }

  private getS3(): S3Client {
    if (!this.s3Client) {
      const endpoint = process.env.S3_ENDPOINT;
      const region = process.env.S3_REGION;
      const accessKeyId = process.env.S3_ACCESS_KEY_ID;
      const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
      if (!endpoint || !region || !this.bucket || !accessKeyId || !secretAccessKey) {
        throw new Error(
          "FLOWMIND_STORAGE_MODE=s3 requires S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID, and S3_SECRET_ACCESS_KEY.",
        );
      }
      this.s3Client = new S3Client({
        endpoint,
        region,
        // Neon Object Storage (and most S3-compatible providers) require path-style addressing.
        forcePathStyle: true,
        credentials: { accessKeyId, secretAccessKey },
      });
    }
    return this.s3Client;
  }

  private objectKey(ownerHash: string, id: string): string {
    return `${UPLOADS_PREFIX}/${ownerHash}/${id}`;
  }

  private privateFile(ownerHash: string, id: string): LocalObjectFile {
    const directory = path.join(this.privateRoot, UPLOADS_PREFIX, ownerHash);
    const filePath = path.join(directory, id);
    if (!filePath.startsWith(`${this.privateRoot}${path.sep}`)) {
      throw new ObjectNotFoundError();
    }
    return new LocalObjectFile(
      `uploads/${ownerHash}/${id}`,
      filePath,
      `${filePath}.json`,
    );
  }

  private pendingPath(id: string): string {
    return path.join(this.pendingRoot, `${id}.json`);
  }

  private async readPendingUpload(id: string): Promise<UploadDescriptor | null> {
    if (this.mode === "s3") {
      try {
        const output = await this.getS3().send(new GetObjectCommand({
          Bucket: this.bucket,
          Key: `${PENDING_UPLOADS_PREFIX}/${id}.json`,
        }));
        if (!output.Body) return null;
        return parseUploadDescriptor(
          Buffer.from(await output.Body.transformToByteArray()).toString("utf8"),
        );
      } catch (error) {
        if (isS3NotFound(error)) return null;
        throw error;
      }
    }
    try {
      return parseUploadDescriptor(await fs.readFile(this.pendingPath(id), "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }
}

function parseUploadDescriptor(text: string): UploadDescriptor | null {
  const value = JSON.parse(text) as Partial<UploadDescriptor>;
  if (
    typeof value.ownerId === "string" &&
    typeof value.ownerHash === "string" &&
    typeof value.contentType === "string" &&
    typeof value.size === "number" &&
    typeof value.expiresAt === "number"
  ) {
    return value as UploadDescriptor;
  }
  return null;
}

function toS3Metadata(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key === ACL_POLICY_METADATA_KEY ? S3_ACL_METADATA_KEY : key,
      value,
    ]),
  );
}

function canonicalizeS3Metadata(
  metadata: Record<string, string> | undefined,
): Record<string, unknown> {
  const canonical: Record<string, unknown> = { ...metadata };
  if (typeof metadata?.[S3_ACL_METADATA_KEY] === "string") {
    canonical[ACL_POLICY_METADATA_KEY] = metadata[S3_ACL_METADATA_KEY];
  }
  return canonical;
}

function isS3NotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "NotFound" || error.name === "NoSuchKey") return true;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 404;
}

function hashOwner(ownerId: string): string {
  return createHash("sha256").update(ownerId).digest("hex");
}

async function writeJsonAtomically(
  destination: string,
  value: object,
): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(value), {
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, destination);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
