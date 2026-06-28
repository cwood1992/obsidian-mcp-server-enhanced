import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { createHash, randomBytes, randomUUID } from "crypto";

export const OBSIDIAN_READ_SCOPE = "obsidian:read";
export const OBSIDIAN_WRITE_SCOPE = "obsidian:write";
export const OBSIDIAN_DANGEROUS_WRITE_SCOPE = "obsidian:dangerous-write";

export const DEFAULT_CHATGPT_SCOPES = [
  OBSIDIAN_READ_SCOPE,
  OBSIDIAN_WRITE_SCOPE,
  OBSIDIAN_DANGEROUS_WRITE_SCOPE,
];

export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

export interface AuthorizationCodeRecord {
  codeHash: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scope: string;
  codeChallenge: string;
  expiresAt: string;
  usedAt?: string;
  createdAt: string;
}

export interface AccessTokenRecord {
  tokenHash: string;
  clientId: string;
  resource: string;
  scope: string;
  expiresAt: string;
  createdAt: string;
}

export interface RefreshTokenRecord {
  tokenHash: string;
  clientId: string;
  resource: string;
  scope: string;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
}

export interface AuditEntry {
  id: string;
  timestamp: string;
  action: string;
  clientId: string;
  scopes: string[];
  vaultId?: string;
  targetPath?: string;
  taskLineNumber?: number;
  mode?: string;
  status: "success" | "rejected" | "error";
  resultPath?: string;
  inputSummary: string;
  correlationId: string;
}

interface StoreState {
  authorizationCodes: AuthorizationCodeRecord[];
  accessTokens: AccessTokenRecord[];
  refreshTokens: RefreshTokenRecord[];
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function parseScope(scope: string | undefined): Set<string> {
  return new Set((scope || "").split(/\s+/).filter(Boolean));
}

export function normalizeScopes(
  requestedScope: string | undefined,
  allowedScopes: string[],
): string {
  const requested = parseScope(requestedScope || allowedScopes.join(" "));
  const allowed = new Set(allowedScopes);
  for (const scope of requested) {
    if (!allowed.has(scope)) {
      throw new Error(`Invalid scope: ${scope}`);
    }
  }
  if (
    requested.has(OBSIDIAN_WRITE_SCOPE) ||
    requested.has(OBSIDIAN_DANGEROUS_WRITE_SCOPE)
  ) {
    requested.add(OBSIDIAN_READ_SCOPE);
  }
  if (requested.has(OBSIDIAN_DANGEROUS_WRITE_SCOPE)) {
    requested.add(OBSIDIAN_WRITE_SCOPE);
  }
  return allowedScopes.filter((scope) => requested.has(scope)).join(" ");
}

export function requireScope(grantedScope: string, requiredScope: string): void {
  const scopes = parseScope(grantedScope);
  if (!scopes.has(requiredScope)) {
    throw new Error(`Required scope missing: ${requiredScope}`);
  }
}

export function summarizeInput(
  payload: Record<string, unknown>,
  keys: string[],
  maxLength = 500,
): string {
  const summary = keys
    .filter((key) => payload[key] !== undefined)
    .map((key) => `${key}=${JSON.stringify(payload[key])}`)
    .join(" ");
  return (summary || "(no summary fields)").slice(0, maxLength);
}

export class JsonOAuthStore {
  constructor(
    private readonly storePath: string,
    private readonly auditPath: string,
  ) {
    ensureParentDir(storePath);
    ensureParentDir(auditPath);
    if (!existsSync(this.storePath)) {
      this.writeState({
        authorizationCodes: [],
        accessTokens: [],
        refreshTokens: [],
      });
    }
    if (!existsSync(this.auditPath)) {
      writeFileSync(this.auditPath, "", "utf8");
    }
  }

  createAuthorizationCode(input: {
    clientId: string;
    redirectUri: string;
    resource: string;
    scope: string;
    codeChallenge: string;
    now?: Date;
  }): string {
    const code = randomSecret(32);
    const now = input.now || new Date();
    const state = this.readState();
    state.authorizationCodes.push({
      codeHash: sha256(code),
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      resource: input.resource,
      scope: input.scope,
      codeChallenge: input.codeChallenge,
      expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_MS).toISOString(),
      createdAt: now.toISOString(),
    });
    this.writeState(state);
    return code;
  }

  consumeAuthorizationCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    resource: string;
    codeVerifier: string;
    now?: Date;
  }): AuthorizationCodeRecord | undefined {
    const now = input.now || new Date();
    const state = this.readState();
    const codeHash = sha256(input.code);
    const record = state.authorizationCodes.find(
      (item) => item.codeHash === codeHash,
    );
    if (!record || record.usedAt || new Date(record.expiresAt) < now) {
      return undefined;
    }
    record.usedAt = now.toISOString();
    this.writeState(state);
    if (
      record.clientId !== input.clientId ||
      record.redirectUri !== input.redirectUri ||
      record.resource !== input.resource ||
      record.codeChallenge !== pkceS256(input.codeVerifier)
    ) {
      return undefined;
    }
    return record;
  }

  createAccessToken(input: {
    clientId: string;
    resource: string;
    scope: string;
    ttlMs: number;
    now?: Date;
  }): { token: string; expiresAt: Date } {
    const token = randomSecret(48);
    const now = input.now || new Date();
    const expiresAt = new Date(now.getTime() + input.ttlMs);
    const state = this.readState();
    state.accessTokens.push({
      tokenHash: sha256(token),
      clientId: input.clientId,
      resource: input.resource,
      scope: input.scope,
      expiresAt: expiresAt.toISOString(),
      createdAt: now.toISOString(),
    });
    this.writeState(state);
    return { token, expiresAt };
  }

  createRefreshToken(input: {
    clientId: string;
    resource: string;
    scope: string;
    ttlMs: number;
    now?: Date;
  }): { token: string; expiresAt: Date } {
    const token = randomSecret(48);
    const now = input.now || new Date();
    const expiresAt = new Date(now.getTime() + input.ttlMs);
    const state = this.readState();
    state.refreshTokens.push({
      tokenHash: sha256(token),
      clientId: input.clientId,
      resource: input.resource,
      scope: input.scope,
      expiresAt: expiresAt.toISOString(),
      createdAt: now.toISOString(),
    });
    this.writeState(state);
    return { token, expiresAt };
  }

  consumeRefreshToken(input: {
    token: string;
    clientId?: string;
    resource: string;
    now?: Date;
  }): RefreshTokenRecord | undefined {
    const now = input.now || new Date();
    const tokenHash = sha256(input.token);
    const state = this.readState();
    const record = state.refreshTokens.find(
      (item) => item.tokenHash === tokenHash,
    );
    if (
      !record ||
      record.revokedAt ||
      new Date(record.expiresAt) < now ||
      (input.clientId && record.clientId !== input.clientId) ||
      record.resource !== input.resource
    ) {
      return undefined;
    }
    record.revokedAt = now.toISOString();
    this.writeState(state);
    return record;
  }

  verifyAccessToken(input: {
    token: string;
    resource: string;
    requiredScope: string;
    now?: Date;
  }): AccessTokenRecord | undefined {
    const now = input.now || new Date();
    const tokenHash = sha256(input.token);
    const record = this.readState().accessTokens.find(
      (item) => item.tokenHash === tokenHash,
    );
    if (!record || new Date(record.expiresAt) < now) {
      return undefined;
    }
    if (record.resource !== input.resource) {
      return undefined;
    }
    if (!parseScope(record.scope).has(input.requiredScope)) {
      return undefined;
    }
    return record;
  }

  appendAudit(entry: Omit<AuditEntry, "id" | "timestamp">): AuditEntry {
    const fullEntry: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
      inputSummary: entry.inputSummary.slice(0, 500),
    };
    writeFileSync(
      this.auditPath,
      `${JSON.stringify(fullEntry)}\n`,
      { encoding: "utf8", flag: "a" },
    );
    return fullEntry;
  }

  listAuditEntries(limit = 20): AuditEntry[] {
    if (!existsSync(this.auditPath)) {
      return [];
    }
    const lines = readFileSync(this.auditPath, "utf8")
      .split("\n")
      .filter(Boolean);
    return lines
      .slice(Math.max(0, lines.length - limit))
      .map((line) => JSON.parse(line) as AuditEntry)
      .reverse();
  }

  private readState(): StoreState {
    const state = JSON.parse(readFileSync(this.storePath, "utf8")) as Partial<StoreState>;
    return {
      authorizationCodes: state.authorizationCodes || [],
      accessTokens: state.accessTokens || [],
      refreshTokens: state.refreshTokens || [],
    };
  }

  private writeState(state: StoreState): void {
    writeFileSync(this.storePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}
