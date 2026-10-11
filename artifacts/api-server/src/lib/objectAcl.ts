export enum ObjectPermission {
  READ = "read",
  WRITE = "write",
}

export interface ObjectAclPolicy {
  owner: string;
  visibility: "public" | "private";
}

export interface ObjectAclFile {
  name: string;
  exists(): Promise<[boolean]>;
  getMetadata(): Promise<[{
    size?: number;
    contentType?: string;
    metadata?: Record<string, unknown>;
  }]>;
  setMetadata(options: {
    metadata: Record<string, string>;
  }): Promise<void>;
}

const ACL_POLICY_METADATA_KEY = "custom:aclPolicy";

export async function setObjectAclPolicy(
  file: ObjectAclFile,
  policy: ObjectAclPolicy,
): Promise<void> {
  const [exists] = await file.exists();
  if (!exists) throw new Error(`Object not found: ${file.name}`);
  await file.setMetadata({
    metadata: {
      [ACL_POLICY_METADATA_KEY]: JSON.stringify(policy),
    },
  });
}

export async function getObjectAclPolicy(
  file: ObjectAclFile,
): Promise<ObjectAclPolicy | null> {
  const [metadata] = await file.getMetadata();
  const value = metadata.metadata?.[ACL_POLICY_METADATA_KEY];
  if (typeof value !== "string") return null;

  try {
    const policy = JSON.parse(value) as Partial<ObjectAclPolicy>;
    if (
      typeof policy.owner === "string" &&
      (policy.visibility === "public" || policy.visibility === "private")
    ) {
      return { owner: policy.owner, visibility: policy.visibility };
    }
  } catch {
    return null;
  }
  return null;
}

export async function canAccessObject({
  userId,
  objectFile,
  requestedPermission,
}: {
  userId?: string;
  objectFile: ObjectAclFile;
  requestedPermission: ObjectPermission;
}): Promise<boolean> {
  const policy = await getObjectAclPolicy(objectFile);
  if (!policy) return false;
  if (policy.visibility === "public" && requestedPermission === ObjectPermission.READ) {
    return true;
  }
  return Boolean(userId && policy.owner === userId);
}
