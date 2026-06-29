import http, { IncomingMessage, ServerResponse } from "http";
import { URL } from "url";
import { randomUUID } from "crypto";
import path from "path";
import { mkdir, readdir, readFile, stat, writeFile } from "fs/promises";
import { z } from "zod";
import * as chrono from "chrono-node";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config/index.js";
import {
  processObsidianGlobalSearch,
  ObsidianGlobalSearchInputSchema,
} from "../mcp-server/tools/obsidianGlobalSearchTool/logic.js";
import {
  obsidianCreateTaskLogic,
  CreateTaskInputSchema,
} from "../mcp-server/tools/obsidianCreateTaskTool/logic.js";
import {
  obsidianTaskQueryLogic,
  TaskQueryInputSchema,
} from "../mcp-server/tools/obsidianTaskQueryTool/logic.js";
import {
  obsidianUpdateTaskLogic,
  UpdateTaskInputSchema,
} from "../mcp-server/tools/obsidianUpdateTaskTool/logic.js";
import { VaultManager } from "../services/vaultManager/index.js";
import { BaseErrorCode, McpError } from "../types-global/errors.js";
import {
  logger,
  RequestContext,
  requestContextService,
} from "../utils/index.js";
import {
  DEFAULT_CHATGPT_SCOPES,
  JsonOAuthStore,
  OBSIDIAN_DANGEROUS_WRITE_SCOPE,
  OBSIDIAN_READ_SCOPE,
  OBSIDIAN_WRITE_SCOPE,
  normalizeScopes,
  parseScope,
  pkceS256,
  requireScope,
  summarizeInput,
} from "./facadeAuth.js";

const CHATGPT_BROWSER_ORIGINS = ["https://chatgpt.com", "https://chat.openai.com"];
const DEFAULT_DAILY_NOTE_DIRECTORY = "01-Daily-Notes";
const DEFAULT_DAILY_NOTE_TEMPLATE_PATH = "01-Daily-Notes/Daily Note Template.md";

const AppendNoteParametersSchema = z.object({
  filePath: z.string().min(1, "filePath is required"),
  content: z.string().min(1, "content cannot be empty"),
  mode: z.enum(["append", "prepend"]).default("append"),
  createIfMissing: z.boolean().default(true),
});

const CreateNoteParametersSchema = z.object({
  filePath: z.string().min(1, "filePath is required"),
  content: z.string().min(1, "content cannot be empty"),
  ifExists: z.enum(["error", "return", "append"]).default("error"),
  appendSeparator: z.string().default("\n\n"),
});

const CreateDailyNoteParametersSchema = z.object({
  date: z.string().optional(),
  directory: z.string().default(DEFAULT_DAILY_NOTE_DIRECTORY),
  templateFilePath: z.string().default(DEFAULT_DAILY_NOTE_TEMPLATE_PATH),
  useTemplate: z.boolean().default(true),
  content: z.string().optional(),
  ifExists: z.enum(["error", "return", "append"]).default("return"),
  appendSeparator: z.string().default("\n\n"),
});

const ChatGptFacadeActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("search"),
    vault: z.string().optional(),
    parameters: ObsidianGlobalSearchInputSchema.extend({
      pageSize: z.number().int().positive().max(25).optional().default(10),
      maxMatchesPerFile: z.number().int().positive().max(3).optional().default(2),
    }),
  }),
  z.object({
    action: z.literal("fetch"),
    vault: z.string().optional(),
    parameters: z.object({
      filePath: z.string().min(1, "filePath is required"),
      maxChars: z.number().int().positive().max(20000).default(12000),
      format: z.enum(["markdown", "json"]).default("markdown"),
    }),
  }),
  z.object({
    action: z.literal("task_query"),
    vault: z.string().optional(),
    parameters: TaskQueryInputSchema.extend({
      limit: z.number().int().positive().max(100).default(50),
    }),
  }),
  z.object({
    action: z.literal("latest_note"),
    vault: z.string().optional(),
    parameters: z.object({
      searchInPath: z.string().optional(),
      maxChars: z.number().int().positive().max(20000).default(2000),
    }),
  }),
  z.object({
    action: z.literal("create_task"),
    vault: z.string().optional(),
    parameters: CreateTaskInputSchema,
  }),
  z.object({
    action: z.literal("update_task"),
    vault: z.string().optional(),
    parameters: UpdateTaskInputSchema,
  }),
  z.object({
    action: z.literal("append_note"),
    vault: z.string().optional(),
    parameters: AppendNoteParametersSchema,
  }),
  z.object({
    action: z.literal("create_note"),
    vault: z.string().optional(),
    parameters: CreateNoteParametersSchema,
  }),
  z.object({
    action: z.literal("create_daily_note"),
    vault: z.string().optional(),
    parameters: CreateDailyNoteParametersSchema,
  }),
  z.object({
    action: z.literal("overwrite_note"),
    vault: z.string().optional(),
    parameters: z.object({
      filePath: z.string().min(1, "filePath is required"),
      content: z.string().min(1, "content cannot be empty"),
      createIfMissing: z.boolean().default(false),
    }),
  }),
]);

type ChatGptFacadeActionRequest = z.infer<typeof ChatGptFacadeActionSchema>;

interface StartChatGptFacadeOptions {
  vaultManager: VaultManager;
  parentContext: RequestContext;
}

interface AuthenticatedClient {
  clientId: string;
  scopes: string[];
  scopeString: string;
}

const ACTION_SCOPES: Record<ChatGptFacadeActionRequest["action"], string> = {
  search: OBSIDIAN_READ_SCOPE,
  fetch: OBSIDIAN_READ_SCOPE,
  task_query: OBSIDIAN_READ_SCOPE,
  latest_note: OBSIDIAN_READ_SCOPE,
  create_task: OBSIDIAN_WRITE_SCOPE,
  update_task: OBSIDIAN_WRITE_SCOPE,
  append_note: OBSIDIAN_WRITE_SCOPE,
  create_note: OBSIDIAN_WRITE_SCOPE,
  create_daily_note: OBSIDIAN_WRITE_SCOPE,
  overwrite_note: OBSIDIAN_DANGEROUS_WRITE_SCOPE,
};

const ACTION_DESCRIPTORS = [
  {
    action: "search",
    scope: OBSIDIAN_READ_SCOPE,
    summary: "Bounded vault search with snippets.",
  },
  {
    action: "fetch",
    scope: OBSIDIAN_READ_SCOPE,
    summary: "Fetch a bounded note body by vault-relative path.",
  },
  {
    action: "task_query",
    scope: OBSIDIAN_READ_SCOPE,
    summary: "Run the Tasks-plugin aware query engine.",
  },
  {
    action: "latest_note",
    scope: OBSIDIAN_READ_SCOPE,
    summary: "Return the markdown note with the latest filesystem mtime.",
  },
  {
    action: "create_task",
    scope: OBSIDIAN_WRITE_SCOPE,
    summary: "Create a Tasks-plugin compatible task.",
  },
  {
    action: "update_task",
    scope: OBSIDIAN_WRITE_SCOPE,
    summary: "Update an existing task by path and line or text match.",
  },
  {
    action: "append_note",
    scope: OBSIDIAN_WRITE_SCOPE,
    summary: "Append or prepend note content. Overwrite is not allowed here.",
  },
  {
    action: "create_note",
    scope: OBSIDIAN_WRITE_SCOPE,
    summary: "Create a new note without overwriting existing content.",
  },
  {
    action: "create_daily_note",
    scope: OBSIDIAN_WRITE_SCOPE,
    summary: "Create today's or a specified daily note from the vault template.",
  },
  {
    action: "overwrite_note",
    scope: OBSIDIAN_DANGEROUS_WRITE_SCOPE,
    summary: "Overwrite a note. Disabled unless explicitly granted dangerous scope.",
  },
];

export async function startChatGptFacade(
  options: StartChatGptFacadeOptions,
): Promise<http.Server> {
  const publicUrl = getPublicUrl();
  const scopes = getConfiguredScopes();
  const wellKnownPaths = pathScopedWellKnownPaths(publicUrl);
  const store = new JsonOAuthStore(
    config.chatgptFacadeStorePath,
    config.chatgptFacadeAuditPath,
  );
  const mcpTransports: Record<string, StreamableHTTPServerTransport> = {};
  const mcpSessionAuth: Record<string, AuthenticatedClient> = {};

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const correlationId = randomUUID();
    const context = requestContextService.createRequestContext({
      ...options.parentContext,
      operation: "ChatGPTFacadeHTTPRequest",
      method: req.method,
      path: url.pathname,
      correlationId,
    });
    logger.debug("ChatGPT facade HTTP request", {
      ...context,
      hasAuthorization: Boolean(req.headers.authorization),
      hasMcpSessionId: Boolean(req.headers["mcp-session-id"]),
    });

    try {
      setCorsHeaders(req, res, publicUrl);
      if (req.method === "OPTIONS") {
        sendJson(res, 200, { success: true });
        return;
      }

      if (url.pathname === "/mcp") {
        await handleMcpRequest({
          req,
          res,
          bodyParser: () => parseJsonBody(req),
          transports: mcpTransports,
          sessionAuth: mcpSessionAuth,
          store,
          vaultManager: options.vaultManager,
          context,
          scopes,
          publicUrl,
        });
        return;
      }

      if (url.pathname === "/health" && req.method === "HEAD") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (url.pathname === "/health" && req.method === "GET") {
        sendJson(res, 200, {
          status: "ok",
          service: "obsidian-chatgpt",
          resource: publicUrl,
          auth: {
            type: "oauth2-pkce",
            adminSecretConfigured: Boolean(config.chatgptFacadeAdminSecret),
          },
          scopes,
          endpoints: {
            mcp: `${publicUrl}/mcp`,
            actions: `${publicUrl}/chatgpt/actions`,
          },
          actions: actionDescriptorsForScopes(scopes),
        });
        return;
      }

      if (
        wellKnownPaths.protectedResource.has(url.pathname) &&
        req.method === "GET"
      ) {
        sendJson(res, 200, {
          resource: publicUrl,
          authorization_servers: [publicUrl],
          scopes_supported: scopes,
          resource_documentation: `${publicUrl}/health`,
        });
        return;
      }

      if (
        wellKnownPaths.authorizationServer.has(url.pathname) &&
        req.method === "GET"
      ) {
        sendJson(res, 200, {
          issuer: publicUrl,
          authorization_endpoint: `${publicUrl}/authorize`,
          token_endpoint: `${publicUrl}/token`,
          registration_endpoint: `${publicUrl}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: scopes,
        });
        return;
      }

      if (url.pathname === "/register" && req.method === "HEAD") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (url.pathname === "/register" && req.method === "POST") {
        const payload = await parseJsonBody(req);
        const clientId =
          stringOrUndefined(payload.client_id) ||
          `obsidian-chatgpt-${randomUUID()}`;
        sendJson(res, 201, {
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          redirect_uris: Array.isArray(payload.redirect_uris)
            ? payload.redirect_uris
            : [],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          scope: scopes.join(" "),
        });
        return;
      }

      if (url.pathname === "/authorize" && req.method === "HEAD") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (url.pathname === "/authorize" && req.method === "GET") {
        const payload = Object.fromEntries(url.searchParams.entries());
        const normalized = validateAuthorizePayload(payload, publicUrl, scopes);
        if (!config.chatgptFacadeAdminSecret) {
          sendText(res, 503, "ChatGPT facade admin secret is not configured.");
          return;
        }
        sendText(res, 200, renderAuthorizeForm(normalized, publicUrl));
        return;
      }

      if (url.pathname === "/authorize" && req.method === "POST") {
        const payload = await parseFormBody(req);
        const adminSecret = payload.admin_secret || "";
        delete payload.admin_secret;
        const normalized = validateAuthorizePayload(payload, publicUrl, scopes);
        if (!config.chatgptFacadeAdminSecret) {
          sendText(res, 503, "ChatGPT facade admin secret is not configured.");
          return;
        }
        if (!adminSecret) {
          sendText(
            res,
            200,
            renderAuthorizeForm(
              normalized,
              publicUrl,
              "Enter the admin secret to approve access.",
            ),
          );
          return;
        }
        if (adminSecret !== config.chatgptFacadeAdminSecret) {
          sendText(res, 401, "Invalid admin secret.");
          return;
        }
        const code = store.createAuthorizationCode({
          clientId: normalized.client_id,
          redirectUri: normalized.redirect_uri,
          resource: normalized.resource,
          scope: normalized.scope,
          codeChallenge: normalized.code_challenge,
        });
        const redirect = new URL(normalized.redirect_uri);
        redirect.searchParams.set("code", code);
        if (normalized.state) {
          redirect.searchParams.set("state", normalized.state);
        }
        res.writeHead(302, { Location: redirect.toString() });
        res.end();
        return;
      }

      if (url.pathname === "/token" && req.method === "HEAD") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (url.pathname === "/token" && req.method === "POST") {
        const payload = await parseFormBody(req);
        if (payload.grant_type === "refresh_token") {
          const refreshToken = payload.refresh_token || "";
          const resource = (payload.resource || publicUrl).replace(/\/$/, "");
          if (!refreshToken) {
            sendJson(res, 400, oauthError("invalid_request", "Missing refresh_token."));
            return;
          }
          const record = store.consumeRefreshToken({
            token: refreshToken,
            clientId: stringOrUndefined(payload.client_id),
            resource,
          });
          if (!record) {
            sendJson(res, 400, oauthError("invalid_grant", "Refresh token is invalid, expired, already used, or scoped to another client/resource."));
            return;
          }
          const token = store.createAccessToken({
            clientId: record.clientId,
            resource: record.resource,
            scope: record.scope,
            ttlMs: config.chatgptFacadeTokenTtlSeconds * 1000,
          });
          const nextRefreshToken = store.createRefreshToken({
            clientId: record.clientId,
            resource: record.resource,
            scope: record.scope,
            ttlMs: config.chatgptFacadeRefreshTokenTtlSeconds * 1000,
          });
          sendJson(res, 200, {
            access_token: token.token,
            refresh_token: nextRefreshToken.token,
            token_type: "Bearer",
            expires_in: Math.max(0, Math.floor((token.expiresAt.getTime() - Date.now()) / 1000)),
            refresh_token_expires_in: Math.max(0, Math.floor((nextRefreshToken.expiresAt.getTime() - Date.now()) / 1000)),
            scope: record.scope,
          });
          return;
        }
        if (payload.grant_type !== "authorization_code") {
          sendJson(res, 400, oauthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported."));
          return;
        }
        const resource = (payload.resource || publicUrl).replace(/\/$/, "");
        const record = store.consumeAuthorizationCode({
          code: payload.code || "",
          clientId: payload.client_id || "",
          redirectUri: payload.redirect_uri || "",
          resource,
          codeVerifier: payload.code_verifier || "",
        });
        if (!record) {
          sendJson(res, 400, oauthError("invalid_grant", "Authorization code is invalid, expired, already used, or failed PKCE verification."));
          return;
        }
        const token = store.createAccessToken({
          clientId: record.clientId,
          resource: record.resource,
          scope: record.scope,
          ttlMs: config.chatgptFacadeTokenTtlSeconds * 1000,
        });
        const refreshToken = store.createRefreshToken({
          clientId: record.clientId,
          resource: record.resource,
          scope: record.scope,
          ttlMs: config.chatgptFacadeRefreshTokenTtlSeconds * 1000,
        });
        sendJson(res, 200, {
          access_token: token.token,
          refresh_token: refreshToken.token,
          token_type: "Bearer",
          expires_in: Math.max(0, Math.floor((token.expiresAt.getTime() - Date.now()) / 1000)),
          refresh_token_expires_in: Math.max(0, Math.floor((refreshToken.expiresAt.getTime() - Date.now()) / 1000)),
          scope: record.scope,
        });
        return;
      }

      if (url.pathname === "/chatgpt/actions" && req.method === "POST") {
        const auth = authenticate(req, store, publicUrl, OBSIDIAN_READ_SCOPE);
        if (!auth) {
          sendOAuthUnauthorized(
            res,
            publicUrl,
            "Missing, expired, or invalid bearer token.",
          );
          return;
        }
        const rawBody = await parseJsonBody(req);
        const parsed = ChatGptFacadeActionSchema.safeParse(rawBody);
        if (!parsed.success) {
          sendJson(res, 400, {
            success: false,
            error: "ValidationError",
            details: parsed.error.flatten(),
          });
          return;
        }
        const requiredScope = ACTION_SCOPES[parsed.data.action];
        try {
          requireScope(auth.scopeString, requiredScope);
        } catch {
          const rejectedSummary = summarizeActionInput(parsed.data);
          store.appendAudit({
            action: parsed.data.action,
            clientId: auth.clientId,
            scopes: auth.scopes,
            vaultId: parsed.data.vault,
            targetPath: targetPathFor(parsed.data),
            mode: modeFor(parsed.data),
            status: "rejected",
            inputSummary: rejectedSummary,
            correlationId,
          });
          sendJson(res, 403, oauthError("insufficient_scope", `Action requires ${requiredScope}.`));
          return;
        }

        const result = await executeFacadeAction(
          parsed.data,
          options.vaultManager,
          context,
        );
        if (requiredScope !== OBSIDIAN_READ_SCOPE) {
          store.appendAudit({
            action: parsed.data.action,
            clientId: auth.clientId,
            scopes: auth.scopes,
            vaultId: result.vaultId,
            targetPath: targetPathFor(parsed.data),
            taskLineNumber: result.taskLineNumber,
            mode: modeFor(parsed.data),
            status: "success",
            resultPath: result.resultPath,
            inputSummary: summarizeActionInput(parsed.data),
            correlationId,
          });
        }
        sendJson(res, 200, {
          success: true,
          action: parsed.data.action,
          vault: result.vaultId,
          data: result.payload,
          correlationId,
        });
        return;
      }

      if (url.pathname === "/audit/recent" && req.method === "GET") {
        if (!isAdminRequest(url)) {
          sendJson(res, 401, { success: false, error: "Unauthorized" });
          return;
        }
        const limit = Number(url.searchParams.get("limit") || "20");
        sendJson(res, 200, {
          success: true,
          entries: store.listAuditEntries(Number.isFinite(limit) ? limit : 20),
        });
        return;
      }

      sendJson(res, 404, { success: false, error: "Not Found" });
    } catch (error) {
      logger.error("ChatGPT facade request failed", error instanceof Error ? error : undefined, {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      });
      sendJson(res, mapErrorToStatus(error), {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        correlationId,
      });
    }
  });

  return new Promise((resolve) => {
    server.listen(config.chatgptFacadePort, config.chatgptFacadeHost, () => {
      logger.info("ChatGPT facade listening", {
        ...options.parentContext,
        host: config.chatgptFacadeHost,
        port: config.chatgptFacadePort,
        publicUrl,
      });
      resolve(server);
    });
  });
}

async function handleMcpRequest(options: {
  req: IncomingMessage;
  res: ServerResponse;
  bodyParser: () => Promise<any>;
  transports: Record<string, StreamableHTTPServerTransport>;
  sessionAuth: Record<string, AuthenticatedClient>;
  store: JsonOAuthStore;
  vaultManager: VaultManager;
  context: RequestContext;
  scopes: string[];
  publicUrl: string;
}): Promise<void> {
  const sessionId = options.req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? options.transports[sessionId] : undefined;
  const sessionAuth = sessionId ? options.sessionAuth[sessionId] : undefined;
  let body: unknown = undefined;

  if (options.req.method === "POST") {
    body = await options.bodyParser();
    const auth = sessionAuth || authenticate(options.req, options.store, options.publicUrl, OBSIDIAN_READ_SCOPE);
    if (!auth) {
      sendOAuthUnauthorized(
        options.res,
        options.publicUrl,
        "Missing, expired, or invalid bearer token.",
      );
      return;
    }
    logger.debug("ChatGPT facade MCP request", {
      ...options.context,
      rpcMethod:
        body && typeof body === "object" && "method" in body
          ? String((body as { method?: unknown }).method)
          : "(batch-or-unknown)",
      hasSessionId: Boolean(sessionId),
    });
    if (!transport) {
      if (!isInitializeRequest(body)) {
        sendJsonRpcError(options.res, -32000, "Bad Request: No valid session ID provided");
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          options.transports[newSessionId] = transport!;
          options.sessionAuth[newSessionId] = auth;
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) {
          delete options.transports[transport.sessionId];
          delete options.sessionAuth[transport.sessionId];
        }
      };
      const mcpServer = createFacadeMcpServer(
        options.vaultManager,
        options.context,
        scopesForClient(options.scopes, auth.scopes),
        options.store,
        auth,
      );
      await mcpServer.connect(transport);
    }
    await transport.handleRequest(options.req, options.res, body);
    return;
  }

  if (options.req.method === "GET" || options.req.method === "DELETE") {
    if (!transport) {
      options.res.writeHead(400);
      options.res.end("Invalid or missing MCP session ID");
      return;
    }
    await transport.handleRequest(options.req, options.res);
    return;
  }

  sendJson(options.res, 405, {
    success: false,
    error: "Method Not Allowed",
    allowed: ["GET", "POST", "DELETE"],
  });
}

function createFacadeMcpServer(
  vaultManager: VaultManager,
  parentContext: RequestContext,
  scopes: string[],
  store: JsonOAuthStore,
  auth: AuthenticatedClient,
): McpServer {
  const server = new McpServer(
    {
      name: "obsidian-chatgpt",
      version: config.mcpServerVersion,
    },
    {
      capabilities: {
        tools: { listChanged: true },
      },
      instructions:
        "Use these tools for bounded Obsidian vault search, note fetch, and explicitly enabled task or note writes. Prefer search before fetch and avoid broad vault changes.",
    },
  );
  const enabledScopes = new Set(scopes);
  const readOnlyToolAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    securitySchemes: [{ type: "noauth" }],
  };

  if (enabledScopes.has(OBSIDIAN_READ_SCOPE)) {
    server.tool(
      "search",
      "Bounded Obsidian vault search with snippets.",
      ObsidianGlobalSearchInputSchema.extend({
        vault: z.string().optional(),
        pageSize: z.number().int().positive().max(25).optional().default(10),
        maxMatchesPerFile: z.number().int().positive().max(3).optional().default(2),
      }).shape,
      readOnlyToolAnnotations,
      async (params) => callAuditedFacadeTool({
        action: "search",
        vault: params.vault,
        parameters: params,
      }, vaultManager, parentContext, store, auth),
    );

    server.tool(
      "fetch",
      "Fetch bounded Obsidian note content by vault-relative path.",
      {
        vault: z.string().optional(),
        filePath: z.string().min(1),
        maxChars: z.number().int().positive().max(20000).default(12000),
        format: z.enum(["markdown", "json"]).default("markdown"),
      },
      readOnlyToolAnnotations,
      async (params) => callAuditedFacadeTool({
        action: "fetch",
        vault: params.vault,
        parameters: params,
      }, vaultManager, parentContext, store, auth),
    );

    server.tool(
      "task_query",
      "Query Obsidian Tasks-plugin compatible tasks.",
      TaskQueryInputSchema.extend({
        limit: z.number().int().positive().max(100).default(50),
      }).shape,
      readOnlyToolAnnotations,
      async (params) => callAuditedFacadeTool({
        action: "task_query",
        vault: params.vault,
        parameters: params,
      }, vaultManager, parentContext, store, auth),
    );

    server.tool(
      "latest_note",
      "Return the markdown note with the latest filesystem modification time.",
      {
        vault: z.string().optional(),
        searchInPath: z.string().optional(),
        maxChars: z.number().int().positive().max(20000).default(2000),
      },
      readOnlyToolAnnotations,
      async (params) => callAuditedFacadeTool({
        action: "latest_note",
        vault: params.vault,
        parameters: params,
      }, vaultManager, parentContext, store, auth),
    );
  }

  if (enabledScopes.has(OBSIDIAN_WRITE_SCOPE)) {
    server.tool(
      "create_task",
      "Create a Tasks-plugin compatible task.",
      CreateTaskInputSchema.extend({ vault: z.string().optional() }).shape,
      async (params) => callAuditedFacadeTool({
        action: "create_task",
        vault: params.vault,
        parameters: params,
      }, vaultManager, parentContext, store, auth),
    );

    server.tool(
      "update_task",
      "Update an existing task by path and line or text match.",
      UpdateTaskInputSchema.extend({ vault: z.string().optional() }).shape,
      async (params) => callAuditedFacadeTool({
        action: "update_task",
        vault: params.vault,
        parameters: params,
      }, vaultManager, parentContext, store, auth),
    );

    server.tool(
      "append_note",
      "Append or prepend note content. Whole-note overwrite is not available here.",
      AppendNoteParametersSchema.extend({ vault: z.string().optional() }).shape,
      async (params) => callAuditedFacadeTool({
        action: "append_note",
        vault: params.vault,
        parameters: params,
      }, vaultManager, parentContext, store, auth),
    );

    server.tool(
      "create_note",
      "Create a new note by vault-relative path. Existing notes are not overwritten.",
      CreateNoteParametersSchema.extend({ vault: z.string().optional() }).shape,
      async (params) => callAuditedFacadeTool({
        action: "create_note",
        vault: params.vault,
        parameters: params,
      }, vaultManager, parentContext, store, auth),
    );

    server.tool(
      "create_daily_note",
      "Create today's or a specified daily note from the configured daily-note template.",
      CreateDailyNoteParametersSchema.extend({ vault: z.string().optional() }).shape,
      async (params) => callAuditedFacadeTool({
        action: "create_daily_note",
        vault: params.vault,
        parameters: params,
      }, vaultManager, parentContext, store, auth),
    );
  }

  if (enabledScopes.has(OBSIDIAN_DANGEROUS_WRITE_SCOPE)) {
    server.tool(
      "overwrite_note",
      "Overwrite a note. Enable only for explicitly trusted connector clients.",
      {
        vault: z.string().optional(),
        filePath: z.string().min(1),
        content: z.string().min(1),
        createIfMissing: z.boolean().default(false),
      },
      async (params) => callAuditedFacadeTool({
        action: "overwrite_note",
        vault: params.vault,
        parameters: params,
      }, vaultManager, parentContext, store, auth),
    );
  }

  return server;
}

async function callAuditedFacadeTool(
  request: ChatGptFacadeActionRequest,
  vaultManager: VaultManager,
  parentContext: RequestContext,
  store: JsonOAuthStore,
  auth: AuthenticatedClient,
) {
  const context = requestContextService.createRequestContext({
    ...parentContext,
    operation: `MCP_${request.action}`,
  });
  const requiredScope = ACTION_SCOPES[request.action];
  const result = await executeFacadeAction(request, vaultManager, context);
  if (requiredScope !== OBSIDIAN_READ_SCOPE) {
    store.appendAudit({
      action: request.action,
      clientId: auth.clientId,
      scopes: auth.scopes,
      vaultId: result.vaultId,
      targetPath: targetPathFor(request),
      taskLineNumber: result.taskLineNumber,
      mode: modeFor(request),
      status: "success",
      resultPath: result.resultPath,
      inputSummary: summarizeActionInput(request),
      correlationId: typeof context.correlationId === "string" ? context.correlationId : randomUUID(),
    });
  }
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(result.payload, null, 2),
      },
    ],
    isError: false,
  };
}

async function executeFacadeAction(
  request: ChatGptFacadeActionRequest,
  vaultManager: VaultManager,
  context: RequestContext,
): Promise<{
  vaultId: string;
  payload: unknown;
  resultPath?: string;
  taskLineNumber?: number;
}> {
  const vaultId = request.vault || vaultManager.getDefaultVaultId();
  const obsidianService = vaultManager.getVaultService(vaultId, context);
  const vaultCacheService = vaultManager.getVaultCacheService(vaultId, context);

  switch (request.action) {
    case "search": {
      let payload: unknown;
      try {
        payload = await processObsidianGlobalSearch(
          request.parameters,
          context,
          obsidianService,
          vaultCacheService,
        );
      } catch (error) {
        payload = await filesystemSearch(vaultId, request.parameters, context, error);
      }
      return { vaultId, payload };
    }
    case "fetch": {
      let content: unknown;
      try {
        content = await obsidianService.getFileContent(
          request.parameters.filePath,
          request.parameters.format,
          context,
        );
      } catch (error) {
        content = await filesystemFetch(vaultId, request.parameters.filePath, context, error);
      }
      const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
      const truncated = text.length > request.parameters.maxChars;
      return {
        vaultId,
        resultPath: request.parameters.filePath,
        payload: {
          filePath: request.parameters.filePath,
          format: request.parameters.format,
          content: text.slice(0, request.parameters.maxChars),
          truncated,
        },
      };
    }
    case "task_query": {
      let payload: unknown;
      try {
        payload = await obsidianTaskQueryLogic(
          { ...request.parameters, vault: vaultId },
          context,
          obsidianService,
        );
      } catch (error) {
        payload = await filesystemTaskQuery(vaultId, request.parameters, context, error);
      }
      return { vaultId, payload };
    }
    case "latest_note": {
      const payload = await filesystemLatestNote(vaultId, request.parameters, context);
      return { vaultId, payload };
    }
    case "create_task": {
      let payload: Awaited<ReturnType<typeof obsidianCreateTaskLogic>>;
      try {
        payload = await obsidianCreateTaskLogic(
          request.parameters,
          context,
          obsidianService,
        );
      } catch (error) {
        payload = await filesystemCreateTask(vaultId, request.parameters, context, error);
      }
      return {
        vaultId,
        payload,
        resultPath: payload.filePath,
        taskLineNumber: payload.lineNumber,
      };
    }
    case "update_task": {
      let payload: Awaited<ReturnType<typeof obsidianUpdateTaskLogic>>;
      try {
        payload = await obsidianUpdateTaskLogic(
          request.parameters,
          context,
          obsidianService,
        );
      } catch (error) {
        payload = await filesystemUpdateTask(vaultId, request.parameters, context, error);
      }
      return {
        vaultId,
        payload,
        resultPath: payload.filePath,
        taskLineNumber: payload.lineNumber,
      };
    }
    case "append_note": {
      let payload: Record<string, unknown>;
      try {
        payload = await appendOrPrependNote(
          request.parameters,
          obsidianService,
          context,
        );
      } catch (error) {
        payload = await filesystemAppendOrPrependNote(vaultId, request.parameters, context, error);
      }
      return { vaultId, payload, resultPath: request.parameters.filePath };
    }
    case "create_note": {
      let payload: Record<string, unknown>;
      try {
        payload = await createNote(
          request.parameters,
          obsidianService,
          context,
        );
      } catch (error) {
        payload = await filesystemCreateNote(vaultId, request.parameters, context, error);
      }
      return {
        vaultId,
        payload,
        resultPath: String(payload.filePath || request.parameters.filePath),
      };
    }
    case "create_daily_note": {
      let payload: Record<string, unknown>;
      try {
        payload = await createDailyNote(
          request.parameters,
          obsidianService,
          context,
        );
      } catch (error) {
        payload = await filesystemCreateDailyNote(vaultId, request.parameters, context, error);
      }
      return {
        vaultId,
        payload,
        resultPath: String(payload.filePath || dailyNotePath(request.parameters)),
      };
    }
    case "overwrite_note": {
      try {
        if (!request.parameters.createIfMissing) {
          await obsidianService.getFileContent(
            request.parameters.filePath,
            "markdown",
            context,
          );
        }
        await obsidianService.updateFileContent(
          request.parameters.filePath,
          request.parameters.content,
          context,
        );
      } catch (error) {
        await filesystemOverwriteNote(vaultId, request.parameters, context, error);
      }
      return {
        vaultId,
        resultPath: request.parameters.filePath,
        payload: {
          filePath: request.parameters.filePath,
          mode: "overwrite",
          contentLength: request.parameters.content.length,
        },
      };
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof McpError &&
    error.code === BaseErrorCode.NOT_FOUND
  );
}

async function appendOrPrependNote(
  params: z.infer<typeof AppendNoteParametersSchema>,
  obsidianService: any,
  context: RequestContext,
): Promise<Record<string, unknown>> {
  if (params.mode === "append") {
    try {
      await obsidianService.appendFileContent(params.filePath, params.content, context);
      return {
        filePath: params.filePath,
        mode: params.mode,
        created: false,
        contentLength: params.content.length,
      };
    } catch (error) {
      if (
        params.createIfMissing &&
        error instanceof McpError &&
        error.code === BaseErrorCode.NOT_FOUND
      ) {
        await obsidianService.updateFileContent(params.filePath, params.content, context);
        return {
          filePath: params.filePath,
          mode: params.mode,
          created: true,
          contentLength: params.content.length,
        };
      }
      throw error;
    }
  }

  let existing = "";
  let created = false;
  try {
    const current = await obsidianService.getFileContent(params.filePath, "markdown", context);
    existing = typeof current === "string" ? current : "";
  } catch (error) {
    if (
      params.createIfMissing &&
      error instanceof McpError &&
      error.code === BaseErrorCode.NOT_FOUND
    ) {
      created = true;
    } else {
      throw error;
    }
  }
  await obsidianService.updateFileContent(
    params.filePath,
    existing ? `${params.content}\n${existing}` : `${params.content}\n`,
    context,
  );
  return {
    filePath: params.filePath,
    mode: params.mode,
    created,
    contentLength: params.content.length,
  };
}

async function createNote(
  params: z.infer<typeof CreateNoteParametersSchema>,
  obsidianService: any,
  context: RequestContext,
): Promise<Record<string, unknown>> {
  const filePath = safeVaultRelativePath(params.filePath);
  try {
    await obsidianService.getFileContent(filePath, "markdown", context);
    if (params.ifExists === "return") {
      return {
        filePath,
        mode: "return",
        created: false,
        existing: true,
        contentLength: 0,
      };
    }
    if (params.ifExists === "append") {
      await obsidianService.appendFileContent(
        filePath,
        `${params.appendSeparator}${params.content}`,
        context,
      );
      return {
        filePath,
        mode: "append",
        created: false,
        existing: true,
        appended: true,
        contentLength: params.content.length,
      };
    }
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Note already exists: ${filePath}`);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  await obsidianService.updateFileContent(filePath, ensureTrailingNewline(params.content), context);
  return {
    filePath,
    mode: "create",
    created: true,
    existing: false,
    contentLength: params.content.length,
  };
}

async function createDailyNote(
  params: z.infer<typeof CreateDailyNoteParametersSchema>,
  obsidianService: any,
  context: RequestContext,
): Promise<Record<string, unknown>> {
  const note = await buildDailyNoteCreateParams(params, async (templatePath) => {
    try {
      const template = await obsidianService.getFileContent(templatePath, "markdown", context);
      return typeof template === "string" ? template : JSON.stringify(template, null, 2);
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  });

  try {
    await obsidianService.getFileContent(note.filePath, "markdown", context);
    if (note.ifExists === "return" || !note.existsAppendContent) {
      return {
        filePath: note.filePath,
        mode: "return",
        created: false,
        existing: true,
        date: note.date,
        templateFilePath: note.templateFilePath,
        contentLength: 0,
      };
    }
    if (note.ifExists === "append") {
      await obsidianService.appendFileContent(
        note.filePath,
        `${note.appendSeparator}${note.existsAppendContent}`,
        context,
      );
      return {
        filePath: note.filePath,
        mode: "append",
        created: false,
        existing: true,
        appended: true,
        date: note.date,
        templateFilePath: note.templateFilePath,
        contentLength: note.existsAppendContent.length,
      };
    }
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Daily note already exists: ${note.filePath}`);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  await obsidianService.updateFileContent(note.filePath, note.content, context);
  return {
    filePath: note.filePath,
    mode: "create",
    created: true,
    existing: false,
    date: note.date,
    templateFilePath: note.templateFilePath,
    contentLength: note.content.length,
  };
}

interface MarkdownFileEntry {
  filePath: string;
  fullPath: string;
  mtimeMs: number;
  mtime: string;
  size: number;
}

function fallbackCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getFilesystemVaultRoot(vaultId: string): string {
  const root = config.chatgptFacadeVaultPaths[vaultId];
  if (!root) {
    throw new McpError(
      BaseErrorCode.NOT_FOUND,
      `No filesystem fallback path configured for vault '${vaultId}'.`,
      { vaultId },
    );
  }
  return root;
}

function safeVaultRelativePath(relativePath: string): string {
  const rawPath = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const normalized = path.posix.normalize(rawPath);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.isAbsolute(normalized)
  ) {
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Invalid vault-relative path.");
  }
  return normalized;
}

function resolveFilesystemVaultPath(vaultId: string, relativePath: string): {
  root: string;
  relativePath: string;
  fullPath: string;
} {
  const root = getFilesystemVaultRoot(vaultId);
  const safePath = safeVaultRelativePath(relativePath);
  const fullPath = path.resolve(root, safePath);
  const rootResolved = path.resolve(root);
  if (fullPath === rootResolved || !fullPath.startsWith(`${rootResolved}${path.sep}`)) {
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Invalid vault-relative path.");
  }
  return { root, relativePath: safePath, fullPath };
}

async function listMarkdownFiles(
  vaultId: string,
  context: RequestContext,
  searchInPath?: string,
): Promise<MarkdownFileEntry[]> {
  const root = getFilesystemVaultRoot(vaultId);
  const startRelative = searchInPath ? safeVaultRelativePath(searchInPath) : "";
  const start = path.join(root, startRelative);
  const rootResolved = path.resolve(root);
  const entries: MarkdownFileEntry[] = [];

  async function walk(dir: string): Promise<void> {
    const dirents = await readdir(dir, { withFileTypes: true });
    for (const dirent of dirents) {
      if (
        dirent.name === ".obsidian" ||
        dirent.name === ".git" ||
        dirent.name === "node_modules" ||
        dirent.name.startsWith(".trash")
      ) {
        continue;
      }
      const fullPath = path.join(dir, dirent.name);
      const resolved = path.resolve(fullPath);
      if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
        continue;
      }
      if (dirent.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!dirent.isFile() || !dirent.name.toLowerCase().endsWith(".md")) {
        continue;
      }
      const fileStat = await stat(fullPath);
      entries.push({
        filePath: path.relative(root, fullPath).split(path.sep).join("/"),
        fullPath,
        mtimeMs: fileStat.mtimeMs,
        mtime: fileStat.mtime.toISOString(),
        size: fileStat.size,
      });
    }
  }

  try {
    await walk(start);
  } catch (error) {
    logger.warning("Filesystem vault fallback failed to list markdown files", {
      ...context,
      vaultId,
      root,
      searchInPath: startRelative,
      error: fallbackCause(error),
    });
    throw error;
  }

  return entries;
}

async function filesystemFetch(
  vaultId: string,
  filePath: string,
  context: RequestContext,
  originalError?: unknown,
): Promise<string> {
  const { relativePath, fullPath } = resolveFilesystemVaultPath(vaultId, filePath);
  logger.warning("Using filesystem fetch fallback for ChatGPT facade", {
    ...context,
    vaultId,
    filePath: relativePath,
    originalError: originalError ? fallbackCause(originalError) : undefined,
  });
  return readFile(fullPath, "utf8");
}

async function readFilesystemNote(
  vaultId: string,
  filePath: string,
): Promise<{ relativePath: string; fullPath: string; content: string }> {
  const { relativePath, fullPath } = resolveFilesystemVaultPath(vaultId, filePath);
  try {
    return {
      relativePath,
      fullPath,
      content: await readFile(fullPath, "utf8"),
    };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new McpError(BaseErrorCode.NOT_FOUND, `File not found: ${relativePath}`);
    }
    throw error;
  }
}

async function writeFilesystemNote(
  vaultId: string,
  filePath: string,
  content: string,
): Promise<{ relativePath: string; fullPath: string }> {
  const { relativePath, fullPath } = resolveFilesystemVaultPath(vaultId, filePath);
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf8");
  return { relativePath, fullPath };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function filesystemAppendOrPrependNote(
  vaultId: string,
  params: z.infer<typeof AppendNoteParametersSchema>,
  context: RequestContext,
  originalError?: unknown,
): Promise<Record<string, unknown>> {
  logger.warning("Using filesystem append/prepend fallback for ChatGPT facade", {
    ...context,
    vaultId,
    filePath: params.filePath,
    mode: params.mode,
    originalError: originalError ? fallbackCause(originalError) : undefined,
  });

  let current = "";
  let created = false;
  try {
    current = (await readFilesystemNote(vaultId, params.filePath)).content;
  } catch (error) {
    if (
      params.createIfMissing &&
      error instanceof McpError &&
      error.code === BaseErrorCode.NOT_FOUND
    ) {
      created = true;
    } else {
      throw error;
    }
  }

  const nextContent = params.mode === "prepend"
    ? `${params.content}${current ? `\n${current}` : "\n"}`
    : `${current}${current.endsWith("\n") || !current ? "" : "\n"}${params.content}\n`;
  const { relativePath } = await writeFilesystemNote(vaultId, params.filePath, nextContent);
  return {
    source: "filesystem-fallback",
    filePath: relativePath,
    mode: params.mode,
    created,
    contentLength: params.content.length,
  };
}

async function filesystemCreateNote(
  vaultId: string,
  params: z.infer<typeof CreateNoteParametersSchema>,
  context: RequestContext,
  originalError?: unknown,
): Promise<Record<string, unknown>> {
  const filePath = safeVaultRelativePath(params.filePath);
  logger.warning("Using filesystem create note fallback for ChatGPT facade", {
    ...context,
    vaultId,
    filePath,
    ifExists: params.ifExists,
    originalError: originalError ? fallbackCause(originalError) : undefined,
  });

  try {
    const current = await readFilesystemNote(vaultId, filePath);
    if (params.ifExists === "return") {
      return {
        source: "filesystem-fallback",
        filePath: current.relativePath,
        mode: "return",
        created: false,
        existing: true,
        contentLength: 0,
      };
    }
    if (params.ifExists === "append") {
      const nextContent = `${current.content.replace(/\n*$/, "")}${params.appendSeparator}${params.content}\n`;
      const { relativePath } = await writeFilesystemNote(vaultId, filePath, nextContent);
      return {
        source: "filesystem-fallback",
        filePath: relativePath,
        mode: "append",
        created: false,
        existing: true,
        appended: true,
        contentLength: params.content.length,
      };
    }
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Note already exists: ${filePath}`);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const { relativePath } = await writeFilesystemNote(vaultId, filePath, ensureTrailingNewline(params.content));
  return {
    source: "filesystem-fallback",
    filePath: relativePath,
    mode: "create",
    created: true,
    existing: false,
    contentLength: params.content.length,
  };
}

async function filesystemCreateDailyNote(
  vaultId: string,
  params: z.infer<typeof CreateDailyNoteParametersSchema>,
  context: RequestContext,
  originalError?: unknown,
): Promise<Record<string, unknown>> {
  logger.warning("Using filesystem create daily note fallback for ChatGPT facade", {
    ...context,
    vaultId,
    date: params.date,
    directory: params.directory,
    originalError: originalError ? fallbackCause(originalError) : undefined,
  });
  const note = await buildDailyNoteCreateParams(params, async (templatePath) => {
    try {
      return (await readFilesystemNote(vaultId, templatePath)).content;
    } catch (error) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  });
  try {
    const current = await readFilesystemNote(vaultId, note.filePath);
    if (note.ifExists === "return" || !note.existsAppendContent) {
      return {
        source: "filesystem-fallback",
        filePath: current.relativePath,
        mode: "return",
        created: false,
        existing: true,
        date: note.date,
        templateFilePath: note.templateFilePath,
        contentLength: 0,
      };
    }
    if (note.ifExists === "append") {
      const nextContent = `${current.content.replace(/\n*$/, "")}${note.appendSeparator}${note.existsAppendContent}`;
      const { relativePath } = await writeFilesystemNote(vaultId, note.filePath, ensureTrailingNewline(nextContent));
      return {
        source: "filesystem-fallback",
        filePath: relativePath,
        mode: "append",
        created: false,
        existing: true,
        appended: true,
        date: note.date,
        templateFilePath: note.templateFilePath,
        contentLength: note.existsAppendContent.length,
      };
    }
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Daily note already exists: ${note.filePath}`);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error;
    }
  }

  const { relativePath } = await writeFilesystemNote(vaultId, note.filePath, note.content);
  return {
    source: "filesystem-fallback",
    filePath: relativePath,
    mode: "create",
    created: true,
    existing: false,
    date: note.date,
    templateFilePath: note.templateFilePath,
    contentLength: note.content.length,
  };
}

interface DailyNoteCreateParams {
  date: string;
  filePath: string;
  templateFilePath: string;
  content: string;
  existsAppendContent?: string;
  ifExists: "error" | "return" | "append";
  appendSeparator: string;
}

async function buildDailyNoteCreateParams(
  params: z.infer<typeof CreateDailyNoteParametersSchema>,
  loadTemplate: (templatePath: string) => Promise<string | undefined>,
): Promise<DailyNoteCreateParams> {
  const date = normalizeDailyNoteDate(params.date);
  const filePath = dailyNotePath({ ...params, date });
  const templateFilePath = safeVaultRelativePath(params.templateFilePath);
  const template = params.useTemplate ? await loadTemplate(templateFilePath) : undefined;
  return {
    date,
    filePath,
    templateFilePath,
    content: renderDailyNoteContent({
      date,
      template,
      content: params.content,
    }),
    existsAppendContent: params.content ? ensureTrailingNewline(params.content) : undefined,
    ifExists: params.ifExists,
    appendSeparator: params.appendSeparator,
  };
}

function normalizeDailyNoteDate(input?: string): string {
  if (!input) {
    return localDateString(new Date());
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return input;
  }
  return formatFacadeDate(input);
}

function localDateString(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function dailyNotePath(params: Pick<z.infer<typeof CreateDailyNoteParametersSchema>, "directory" | "date">): string {
  const directory = safeVaultRelativePath(params.directory).replace(/\/+$/, "");
  const date = normalizeDailyNoteDate(params.date);
  return `${directory}/${date}.md`;
}

function renderDailyNoteContent(input: {
  date: string;
  template?: string;
  content?: string;
}): string {
  const renderedTemplate = input.template
    ? renderDailyTemplateVariables(input.template, input.date)
    : defaultDailyNoteContent(input.date);
  const parts = [renderedTemplate, input.content]
    .filter((part): part is string => Boolean(part?.trim()))
    .map((part) => part.replace(/\n*$/, ""));
  return ensureTrailingNewline(parts.join("\n\n"));
}

function renderDailyTemplateVariables(template: string, date: string): string {
  const parsed = dateParts(date);
  return template
    .replace(/\{\{date(?::YYYY-MM-DD)?\}\}/g, date)
    .replace(/\{\{title\}\}/g, date)
    .replace(/\{\{year\}\}/g, String(parsed.year))
    .replace(/\{\{month\}\}/g, String(parsed.month).padStart(2, "0"))
    .replace(/\{\{day\}\}/g, String(parsed.day).padStart(2, "0"));
}

function dateParts(date: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Invalid date format: ${date}`);
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function defaultDailyNoteContent(date: string): string {
  return `# ${date}

## Today's Focus
**Primary Context**:
**Top 3 priorities**:
1.
2.
3.

## Notes

## Tasks

## Reflection
`;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

async function filesystemOverwriteNote(
  vaultId: string,
  params: { filePath: string; content: string; createIfMissing: boolean },
  context: RequestContext,
  originalError?: unknown,
): Promise<void> {
  logger.warning("Using filesystem overwrite fallback for ChatGPT facade", {
    ...context,
    vaultId,
    filePath: params.filePath,
    createIfMissing: params.createIfMissing,
    originalError: originalError ? fallbackCause(originalError) : undefined,
  });
  if (!params.createIfMissing) {
    await readFilesystemNote(vaultId, params.filePath);
  }
  await writeFilesystemNote(vaultId, params.filePath, params.content);
}

const FACADE_STATUS_CHARS: Record<string, string> = {
  incomplete: " ",
  completed: "x",
  "in-progress": "/",
  cancelled: "-",
  deferred: ">",
  scheduled: "<",
};

const FACADE_PRIORITY_MARKERS: Record<string, string> = {
  highest: "\u{1F53A}",
  high: "\u{1F534}",
  medium: "\u{1F7E1}",
  low: "\u{1F7E2}",
  lowest: "\u{1F53B}",
};

function formatFacadeDate(dateInput: string): string {
  const parsed = chrono.parseDate(dateInput);
  if (!parsed) {
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Invalid date format: ${dateInput}`);
  }
  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, "0"),
    String(parsed.getDate()).padStart(2, "0"),
  ].join("-");
}

function buildFacadeTaskText(input: z.infer<typeof CreateTaskInputSchema>): string {
  let taskText = input.text;
  if (input.priority) {
    taskText = `${FACADE_PRIORITY_MARKERS[input.priority]} ${taskText}`;
  }
  if (input.dueDate) {
    taskText += ` \u{1F4C5} ${formatFacadeDate(input.dueDate)}`;
  }
  if (input.scheduledDate) {
    taskText += ` \u{23F3} ${formatFacadeDate(input.scheduledDate)}`;
  }
  if (input.startDate) {
    taskText += ` \u{1F6EB} ${formatFacadeDate(input.startDate)}`;
  }
  if (input.recurrence) {
    taskText += ` \u{1F501} ${input.recurrence}`;
  }
  if (input.project) {
    taskText += ` #project/${input.project}`;
  }
  if (input.tags?.length) {
    taskText += ` ${input.tags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")}`;
  }
  return taskText;
}

function buildFacadeTaskLine(input: z.infer<typeof CreateTaskInputSchema>): string {
  const statusChar = FACADE_STATUS_CHARS[input.status];
  const indent = "  ".repeat(input.indentLevel);
  const marker = input.listStyle === "1." ? "1." : input.listStyle;
  return `${indent}${marker} [${statusChar}] ${buildFacadeTaskText(input)}`;
}

function periodicTaskPath(periodType: "daily" | "weekly" | "monthly"): string {
  const today = new Date();
  const date = [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0"),
  ].join("-");
  if (periodType === "weekly") {
    return `Weekly Notes/Week of ${date}.md`;
  }
  if (periodType === "monthly") {
    return `Monthly Notes/${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}.md`;
  }
  return `Daily Notes/${date}.md`;
}

function findTaskInsertionIndex(
  content: string,
  input: z.infer<typeof CreateTaskInputSchema>,
): number {
  const lines = content ? content.split("\n") : [];
  if (!input.section) {
    return input.insertAt === "top" ? 0 : lines.length;
  }
  const escapedSection = input.section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingPattern = new RegExp(`^#+\\s+${escapedSection}\\s*$`, "i");
  const headingIndex = lines.findIndex((line) => headingPattern.test(line));
  if (headingIndex < 0) {
    return input.insertAt === "top" ? 0 : lines.length;
  }
  if (input.insertAt === "after-heading") {
    return headingIndex + 1;
  }
  const headingLevel = lines[headingIndex].match(/^#+/)?.[0].length || 1;
  const nextHeadingIndex = lines.findIndex((line, index) =>
    index > headingIndex &&
    Boolean(line.match(/^#+/)) &&
    (line.match(/^#+/)?.[0].length || 0) <= headingLevel,
  );
  return nextHeadingIndex < 0 ? lines.length : nextHeadingIndex;
}

async function filesystemCreateTask(
  vaultId: string,
  input: z.infer<typeof CreateTaskInputSchema>,
  context: RequestContext,
  originalError?: unknown,
): Promise<Awaited<ReturnType<typeof obsidianCreateTaskLogic>>> {
  const startTime = Date.now();
  logger.warning("Using filesystem create task fallback for ChatGPT facade", {
    ...context,
    vaultId,
    filePath: input.filePath,
    usePeriodicNote: input.usePeriodicNote,
    originalError: originalError ? fallbackCause(originalError) : undefined,
  });
  if (input.useActiveFile && !input.filePath) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      "Filesystem task creation requires filePath or usePeriodicNote; useActiveFile needs Obsidian REST.",
    );
  }
  const targetPath = input.filePath || (input.usePeriodicNote ? periodicTaskPath(input.usePeriodicNote) : undefined);
  if (!targetPath) {
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, "No target file specified.");
  }
  let content = "";
  try {
    content = (await readFilesystemNote(vaultId, targetPath)).content;
  } catch (error) {
    if (!(error instanceof McpError && error.code === BaseErrorCode.NOT_FOUND)) {
      throw error;
    }
  }
  const taskLine = buildFacadeTaskLine(input);
  const lines = content ? content.split("\n") : [];
  const lineIndex = findTaskInsertionIndex(content, input);
  lines.splice(lineIndex, 0, taskLine);
  const updatedContent = `${lines.join("\n").replace(/\n*$/, "")}\n`;
  const { relativePath } = await writeFilesystemNote(vaultId, targetPath, updatedContent);
  return {
    success: true,
    taskText: input.text,
    filePath: relativePath,
    lineNumber: lineIndex + 1,
    formattedTask: taskLine,
    metadata: {
      status: input.status,
      priority: input.priority,
      dueDate: input.dueDate ? formatFacadeDate(input.dueDate) : undefined,
      scheduledDate: input.scheduledDate ? formatFacadeDate(input.scheduledDate) : undefined,
      startDate: input.startDate ? formatFacadeDate(input.startDate) : undefined,
      tags: input.tags || [],
      project: input.project,
      recurrence: input.recurrence,
    },
    executionTime: `${Date.now() - startTime}ms`,
  };
}

interface ParsedFacadeTask {
  indent: string;
  marker: string;
  statusChar: string;
  text: string;
}

function parseFacadeTaskLine(line: string): ParsedFacadeTask | undefined {
  const match = line.match(/^(\s*)([-*]|\d+\.)\s+\[([^\]])\]\s+(.*)$/);
  if (!match) {
    return undefined;
  }
  return {
    indent: match[1],
    marker: match[2],
    statusChar: match[3],
    text: match[4],
  };
}

function statusNameForChar(statusChar: string): string {
  return Object.entries(FACADE_STATUS_CHARS).find(([, char]) => char === statusChar)?.[0] || "unknown";
}

function stripTaskMetadata(taskText: string): string {
  return taskText
    .replace(/[\u{1F53A}\u{1F534}\u{1F7E1}\u{1F7E2}\u{1F53B}]/gu, "")
    .replace(/\u{1F4C5}\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/\u{23F3}\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/\u{1F6EB}\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/\u{2705}\s*\d{4}-\d{2}-\d{2}/gu, "")
    .replace(/\u{1F501}\s*[^#\u{1F4C5}\u{23F3}\u{1F6EB}\u{2705}]+/gu, "")
    .replace(/#[\w/-]+/g, "")
    .trim();
}

function replaceOrAppendMarker(taskText: string, markerPattern: RegExp, marker: string, value: string): string {
  if (markerPattern.test(taskText)) {
    return taskText.replace(markerPattern, `${marker} ${value}`);
  }
  return `${taskText} ${marker} ${value}`;
}

function removePriorityMarkers(taskText: string): string {
  return taskText.replace(/[\u{1F53A}\u{1F534}\u{1F7E1}\u{1F7E2}\u{1F53B}]\s*/gu, "").trim();
}

function findFacadeTaskLine(
  lines: string[],
  input: z.infer<typeof UpdateTaskInputSchema>,
): { lineIndex: number; taskLine: string; parsed: ParsedFacadeTask } {
  if (input.lineNumber) {
    const lineIndex = input.lineNumber - 1;
    const taskLine = lines[lineIndex];
    const parsed = taskLine ? parseFacadeTaskLine(taskLine) : undefined;
    if (parsed) {
      return { lineIndex, taskLine, parsed };
    }
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, `No task found at line ${input.lineNumber}`);
  }

  if (input.taskText) {
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const taskLine = lines[lineIndex];
      const parsed = parseFacadeTaskLine(taskLine);
      if (!parsed) {
        continue;
      }
      const candidate = input.exactMatch ? parsed.text : stripTaskMetadata(parsed.text);
      const matches = input.exactMatch
        ? candidate === input.taskText
        : candidate.includes(input.taskText) || parsed.text.includes(input.taskText);
      if (matches) {
        return { lineIndex, taskLine, parsed };
      }
    }
    throw new McpError(BaseErrorCode.VALIDATION_ERROR, `No task found matching text: "${input.taskText}"`);
  }

  throw new McpError(
    BaseErrorCode.VALIDATION_ERROR,
    "Either lineNumber or taskText must be provided to identify the task.",
  );
}

function updateFacadeTaskText(
  input: z.infer<typeof UpdateTaskInputSchema>,
  currentText: string,
): { text: string; changes: Awaited<ReturnType<typeof obsidianUpdateTaskLogic>>["changes"] } {
  const changes: Awaited<ReturnType<typeof obsidianUpdateTaskLogic>>["changes"] = {};
  let text = currentText;

  if (input.operation === "update-text") {
    if (!input.newText) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "newText required for update-text operation.");
    }
    changes.text = { from: stripTaskMetadata(currentText), to: input.newText };
    text = currentText.replace(stripTaskMetadata(currentText), input.newText);
  }

  if (input.operation === "set-priority") {
    if (!input.priority) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "priority required for set-priority operation.");
    }
    text = `${FACADE_PRIORITY_MARKERS[input.priority]} ${removePriorityMarkers(text)}`;
    changes.priority = { to: input.priority };
  }

  if (input.operation === "set-due-date") {
    if (!input.dueDate) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "dueDate required for set-due-date operation.");
    }
    const formatted = formatFacadeDate(input.dueDate);
    text = replaceOrAppendMarker(text, /\u{1F4C5}\s*\d{4}-\d{2}-\d{2}/u, "\u{1F4C5}", formatted);
    changes.dueDate = { to: formatted };
  }

  if (input.operation === "set-scheduled-date") {
    if (!input.scheduledDate) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "scheduledDate required for set-scheduled-date operation.");
    }
    const formatted = formatFacadeDate(input.scheduledDate);
    text = replaceOrAppendMarker(text, /\u{23F3}\s*\d{4}-\d{2}-\d{2}/u, "\u{23F3}", formatted);
    changes.scheduledDate = { to: formatted };
  }

  if (input.operation === "set-start-date") {
    if (!input.startDate) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "startDate required for set-start-date operation.");
    }
    const formatted = formatFacadeDate(input.startDate);
    text = replaceOrAppendMarker(text, /\u{1F6EB}\s*\d{4}-\d{2}-\d{2}/u, "\u{1F6EB}", formatted);
    changes.startDate = { to: formatted };
  }

  if (input.operation === "add-tags") {
    const tags = input.tags || [];
    const existingTags = new Set((text.match(/#[\w/-]+/g) || []).map((tag) => tag.slice(1)));
    const added = tags.filter((tag) => !existingTags.has(tag.replace(/^#/, "")));
    if (added.length) {
      text += ` ${added.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ")}`;
    }
    changes.tags = { added, removed: [] };
  }

  if (input.operation === "remove-tags") {
    const tags = new Set((input.tags || []).map((tag) => tag.replace(/^#/, "")));
    const removed: string[] = [];
    text = text.replace(/#[\w/-]+/g, (tag) => {
      const clean = tag.slice(1);
      if (tags.has(clean)) {
        removed.push(clean);
        return "";
      }
      return tag;
    }).replace(/\s+/g, " ").trim();
    changes.tags = { added: [], removed };
  }

  if (input.operation === "set-project") {
    if (!input.project) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "project required for set-project operation.");
    }
    text = text.replace(/#project\/[\w-]+/g, "").trim();
    text += ` #project/${input.project}`;
    changes.project = { to: input.project };
  }

  if (input.operation === "set-recurrence") {
    if (!input.recurrence) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "recurrence required for set-recurrence operation.");
    }
    text = replaceOrAppendMarker(
      text,
      /\u{1F501}\s*[^#\u{1F4C5}\u{23F3}\u{1F6EB}\u{2705}]+/u,
      "\u{1F501}",
      input.recurrence,
    );
    changes.recurrence = { to: input.recurrence };
  }

  if (input.operation === "complete-task" && !/\u{2705}\s*\d{4}-\d{2}-\d{2}/u.test(text)) {
    const today = formatFacadeDate(new Date().toISOString());
    text += ` \u{2705} ${today}`;
  }

  return { text: text.replace(/\s+/g, " ").trim(), changes };
}

async function filesystemUpdateTask(
  vaultId: string,
  input: z.infer<typeof UpdateTaskInputSchema>,
  context: RequestContext,
  originalError?: unknown,
): Promise<Awaited<ReturnType<typeof obsidianUpdateTaskLogic>>> {
  const startTime = Date.now();
  logger.warning("Using filesystem update task fallback for ChatGPT facade", {
    ...context,
    vaultId,
    filePath: input.filePath,
    operation: input.operation,
    originalError: originalError ? fallbackCause(originalError) : undefined,
  });
  const note = await readFilesystemNote(vaultId, input.filePath);
  const lines = note.content.split("\n");
  const { lineIndex, taskLine, parsed } = findFacadeTaskLine(lines, input);
  let statusChar = parsed.statusChar;
  let taskText = parsed.text;
  let changes: Awaited<ReturnType<typeof obsidianUpdateTaskLogic>>["changes"] = {};

  if (input.operation === "toggle-status") {
    const from = statusNameForChar(statusChar);
    const to = from === "completed" ? "incomplete" : "completed";
    statusChar = FACADE_STATUS_CHARS[to];
    changes.status = { from, to };
  } else if (input.operation === "set-status") {
    if (!input.newStatus) {
      throw new McpError(BaseErrorCode.VALIDATION_ERROR, "newStatus required for set-status operation.");
    }
    changes.status = { from: statusNameForChar(statusChar), to: input.newStatus };
    statusChar = FACADE_STATUS_CHARS[input.newStatus];
  } else if (input.operation === "complete-task") {
    changes.status = { from: statusNameForChar(statusChar), to: "completed" };
    statusChar = FACADE_STATUS_CHARS.completed;
    taskText = updateFacadeTaskText(input, taskText).text;
  } else if (input.operation === "move-task") {
    if (!input.targetLineNumber && !input.targetSection) {
      throw new McpError(
        BaseErrorCode.VALIDATION_ERROR,
        "targetLineNumber or targetSection required for move-task operation.",
      );
    }
  } else {
    const updated = updateFacadeTaskText(input, taskText);
    taskText = updated.text;
    changes = updated.changes;
  }

  const updatedTask = `${parsed.indent}${parsed.marker} [${statusChar}] ${taskText}`;
  lines[lineIndex] = updatedTask;

  let finalLineIndex = lineIndex;
  if (input.operation === "move-task") {
    const [movedLine] = lines.splice(lineIndex, 1);
    if (input.targetLineNumber) {
      finalLineIndex = Math.min(Math.max(input.targetLineNumber - 1, 0), lines.length);
    } else {
      finalLineIndex = findTaskInsertionIndex(lines.join("\n"), {
        text: taskText,
        section: input.targetSection,
        insertAt: "after-heading",
        status: "incomplete",
        indentLevel: 0,
        listStyle: "-",
      } as z.infer<typeof CreateTaskInputSchema>);
    }
    lines.splice(finalLineIndex, 0, movedLine);
  }

  await writeFilesystemNote(vaultId, input.filePath, `${lines.join("\n").replace(/\n*$/, "")}\n`);
  return {
    success: true,
    operation: input.operation,
    filePath: note.relativePath,
    lineNumber: finalLineIndex + 1,
    originalTask: taskLine,
    updatedTask,
    changes,
    executionTime: `${Date.now() - startTime}ms`,
  };
}

async function filesystemSearch(
  vaultId: string,
  params: Record<string, any>,
  context: RequestContext,
  originalError?: unknown,
): Promise<Record<string, unknown>> {
  logger.warning("Using filesystem search fallback for ChatGPT facade", {
    ...context,
    vaultId,
    originalError: originalError ? fallbackCause(originalError) : undefined,
  });
  const files = await listMarkdownFiles(vaultId, context, params.searchInPath);
  const pageSize = Math.min(Math.max(Number(params.pageSize || 10), 1), 25);
  const page = Math.max(Number(params.page || 1), 1);
  const maxMatchesPerFile = Math.min(Math.max(Number(params.maxMatchesPerFile || 2), 1), 3);
  const matcher = params.useRegex
    ? new RegExp(String(params.query), params.caseSensitive ? "g" : "gi")
    : undefined;
  const needle = String(params.query || "");
  const lowerNeedle = needle.toLowerCase();
  const results: Array<Record<string, unknown>> = [];

  for (const file of files) {
    const text = await readFile(file.fullPath, "utf8");
    const matches: Array<Record<string, unknown>> = [];
    if (matcher) {
      matcher.lastIndex = 0;
      for (const match of text.matchAll(matcher)) {
        const index = match.index ?? 0;
        matches.push(matchSnippet(text, index, match[0].length, Number(params.contextLength || 100)));
        if (matches.length >= maxMatchesPerFile) break;
      }
    } else {
      const haystack = params.caseSensitive ? text : text.toLowerCase();
      const searchNeedle = params.caseSensitive ? needle : lowerNeedle;
      let index = haystack.indexOf(searchNeedle);
      while (index >= 0 && matches.length < maxMatchesPerFile) {
        matches.push(matchSnippet(text, index, needle.length, Number(params.contextLength || 100)));
        index = haystack.indexOf(searchNeedle, index + Math.max(needle.length, 1));
      }
    }
    if (matches.length > 0) {
      results.push({
        filePath: file.filePath,
        mtime: file.mtime,
        size: file.size,
        matches,
      });
    }
  }

  const offset = (page - 1) * pageSize;
  return {
    source: "filesystem-fallback",
    vault: vaultId,
    query: params.query,
    totalResults: results.length,
    page,
    pageSize,
    results: results.slice(offset, offset + pageSize),
  };
}

function matchSnippet(text: string, index: number, length: number, contextLength: number): Record<string, unknown> {
  const start = Math.max(0, index - contextLength);
  const end = Math.min(text.length, index + length + contextLength);
  const lineNumber = text.slice(0, index).split(/\r?\n/).length;
  return {
    lineNumber,
    context: text.slice(start, end),
  };
}

async function filesystemTaskQuery(
  vaultId: string,
  params: Record<string, any>,
  context: RequestContext,
  originalError?: unknown,
): Promise<Record<string, unknown>> {
  logger.warning("Using filesystem task query fallback for ChatGPT facade", {
    ...context,
    vaultId,
    originalError: originalError ? fallbackCause(originalError) : undefined,
  });
  const files = await listMarkdownFiles(vaultId, context, params.folder);
  const limit = Math.min(Math.max(Number(params.limit || 50), 1), 100);
  const status = params.status || "all";
  const tasks: Array<Record<string, unknown>> = [];
  const taskPattern = /^(\s*[-*]\s+\[([^\]]*)\]\s+.*)$/gm;

  for (const file of files) {
    const text = await readFile(file.fullPath, "utf8");
    for (const match of text.matchAll(taskPattern)) {
      const mark = match[2];
      const completed = mark && mark.toLowerCase() !== " ";
      if (status === "completed" && !completed) continue;
      if (status === "incomplete" && completed) continue;
      const index = match.index ?? 0;
      tasks.push({
        filePath: file.filePath,
        lineNumber: text.slice(0, index).split(/\r?\n/).length,
        status: completed ? "completed" : "incomplete",
        text: match[1],
        mtime: file.mtime,
      });
      if (tasks.length >= limit) {
        break;
      }
    }
    if (tasks.length >= limit) {
      break;
    }
  }

  return {
    source: "filesystem-fallback",
    vault: vaultId,
    count: tasks.length,
    tasks,
  };
}

async function filesystemLatestNote(
  vaultId: string,
  params: { searchInPath?: string; maxChars: number },
  context: RequestContext,
): Promise<Record<string, unknown>> {
  const files = await listMarkdownFiles(vaultId, context, params.searchInPath);
  const latest = files.sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!latest) {
    return {
      source: "filesystem-fallback",
      vault: vaultId,
      found: false,
      message: "No markdown files found in the configured vault path.",
    };
  }
  const content = await readFile(latest.fullPath, "utf8");
  const truncated = content.length > params.maxChars;
  return {
    source: "filesystem-fallback",
    vault: vaultId,
    found: true,
    filePath: latest.filePath,
    mtime: latest.mtime,
    size: latest.size,
    content: content.slice(0, params.maxChars),
    truncated,
  };
}

function authenticate(
  req: IncomingMessage,
  store: JsonOAuthStore,
  resource: string,
  requiredScope: string,
): AuthenticatedClient | undefined {
  const authorization = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(Array.isArray(authorization) ? authorization[0] : authorization);
  if (!match) {
    return undefined;
  }
  const record = store.verifyAccessToken({
    token: match[1],
    resource,
    requiredScope,
  });
  if (!record) {
    return undefined;
  }
  return {
    clientId: record.clientId,
    scopeString: record.scope,
    scopes: Array.from(parseScope(record.scope)),
  };
}

function validateAuthorizePayload(
  payload: Record<string, string>,
  publicUrl: string,
  allowedScopes: string[],
): Record<string, string> {
  const required = [
    "response_type",
    "client_id",
    "redirect_uri",
    "code_challenge",
    "code_challenge_method",
  ];
  const missing = required.filter((key) => !payload[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required authorize parameter: ${missing.join(", ")}`);
  }
  if (payload.response_type !== "code") {
    throw new Error("Unsupported response_type");
  }
  if (payload.code_challenge_method !== "S256") {
    throw new Error("Unsupported code_challenge_method");
  }
  const resource = (payload.resource || publicUrl).replace(/\/$/, "");
  if (resource !== publicUrl) {
    throw new Error("Invalid resource");
  }
  const redirect = new URL(payload.redirect_uri);
  if (!["https:", "http:"].includes(redirect.protocol)) {
    throw new Error("Invalid redirect_uri");
  }
  return {
    ...payload,
    resource,
    scope: normalizeScopes(payload.scope, allowedScopes),
  };
}

function renderAuthorizeForm(
  payload: Record<string, string>,
  publicUrl: string,
  message?: string,
): string {
  const hidden = Object.entries(payload)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join("\n");
  const messageHtml = message ? `<p>${escapeHtml(message)}</p>` : "";
  return `<!doctype html>
<html>
  <head><title>Obsidian ChatGPT Authorization</title></head>
  <body>
    <h1>Obsidian ChatGPT Authorization</h1>
    <p>Approve scoped access to the Obsidian ChatGPT facade.</p>
    ${messageHtml}
    <form method="post" action="${escapeHtml(publicUrl)}/authorize">
      ${hidden}
      <label>Admin secret <input name="admin_secret" type="password" autofocus></label>
      <button type="submit">Approve</button>
    </form>
  </body>
</html>`;
}

function summarizeActionInput(request: ChatGptFacadeActionRequest): string {
  return summarizeInput(request.parameters as Record<string, unknown>, [
    "query",
    "filePath",
    "date",
    "directory",
    "templateFilePath",
    "text",
    "mode",
    "ifExists",
    "operation",
    "lineNumber",
    "taskText",
  ]);
}

function targetPathFor(request: ChatGptFacadeActionRequest): string | undefined {
  if ("filePath" in request.parameters) {
    return request.parameters.filePath;
  }
  if (request.action === "create_daily_note") {
    return dailyNotePath(request.parameters);
  }
  return undefined;
}

function modeFor(request: ChatGptFacadeActionRequest): string | undefined {
  if (request.action === "append_note") {
    return request.parameters.mode;
  }
  if (request.action === "create_note" || request.action === "create_daily_note") {
    return request.parameters.ifExists === "append" ? "append-or-create" : "create";
  }
  if (request.action === "overwrite_note") {
    return "overwrite";
  }
  if (request.action === "update_task") {
    return request.parameters.operation;
  }
  return request.action;
}

function getPublicUrl(): string {
  return (
    config.chatgptFacadePublicUrl ||
    `http://${config.chatgptFacadeHost}:${config.chatgptFacadePort}`
  ).replace(/\/$/, "");
}

function pathScopedWellKnownPaths(publicUrl: string): {
  protectedResource: Set<string>;
  authorizationServer: Set<string>;
} {
  const paths = {
    protectedResource: new Set([
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/obsidian-chatgpt",
    ]),
    authorizationServer: new Set([
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
    ]),
  };
  const prefix = new URL(publicUrl).pathname.replace(/^\/+|\/+$/g, "");
  if (prefix) {
    paths.protectedResource.add(`/.well-known/oauth-protected-resource/${prefix}`);
    paths.authorizationServer.add(`/.well-known/oauth-authorization-server/${prefix}`);
    paths.authorizationServer.add(`/.well-known/openid-configuration/${prefix}`);
  }
  return paths;
}

function getConfiguredScopes(): string[] {
  const configured = config.chatgptFacadeScopes.length
    ? config.chatgptFacadeScopes
    : DEFAULT_CHATGPT_SCOPES;
  return configured.includes(OBSIDIAN_READ_SCOPE)
    ? configured
    : [OBSIDIAN_READ_SCOPE, ...configured];
}

function scopesForClient(configuredScopes: string[], clientScopes: string[]): string[] {
  const configured = new Set(configuredScopes);
  return clientScopes.filter((scope) => configured.has(scope));
}

function actionDescriptorsForScopes(scopes: string[]): typeof ACTION_DESCRIPTORS {
  const enabledScopes = new Set(scopes);
  return ACTION_DESCRIPTORS.filter((descriptor) =>
    enabledScopes.has(descriptor.scope),
  );
}

function isAdminRequest(url: URL): boolean {
  const secret = config.chatgptFacadeAdminSecret;
  return Boolean(secret && url.searchParams.get("admin_secret") === secret);
}

function setCorsHeaders(
  req: IncomingMessage,
  res: ServerResponse,
  publicUrl: string,
): void {
  const allowedOrigins = Array.from(new Set([
    ...(config.chatgptFacadeAllowedOrigins?.length
      ? config.chatgptFacadeAllowedOrigins
      : [publicUrl]),
    ...CHATGPT_BROWSER_ORIGINS,
  ]));
  const requestOrigin = req.headers.origin;
  const origin = requestOrigin && allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : allowedOrigins[0];
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version, mcp-session-id, Accept");
  res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Session-ID");
}

function parseJsonBody(req: IncomingMessage): Promise<any> {
  return readBody(req).then((body) => body ? JSON.parse(body) : {});
}

function parseFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  return readBody(req).then((body) =>
    Object.fromEntries(new URLSearchParams(body).entries()),
  );
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function sendOAuthUnauthorized(
  res: ServerResponse,
  publicUrl: string,
  description: string,
): void {
  res.setHeader(
    "WWW-Authenticate",
    [
      'Bearer realm="obsidian-chatgpt"',
      `resource_metadata="${headerQuoted(`${publicUrl}/.well-known/oauth-protected-resource`)}"`,
      'error="invalid_token"',
      `error_description="${headerQuoted(description)}"`,
    ].join(", "),
  );
  sendJson(res, 401, oauthError("invalid_token", description));
}

function headerQuoted(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sendJsonRpcError(
  res: ServerResponse,
  code: number,
  message: string,
): void {
  sendJson(res, 400, {
    jsonrpc: "2.0",
    error: { code, message },
    id: null,
  });
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function oauthError(error: string, description: string): Record<string, string> {
  return { error, error_description: description };
}

function mapErrorToStatus(error: unknown): number {
  if (error instanceof McpError) {
    switch (error.code) {
      case BaseErrorCode.UNAUTHORIZED:
        return 401;
      case BaseErrorCode.FORBIDDEN:
        return 403;
      case BaseErrorCode.NOT_FOUND:
        return 404;
      case BaseErrorCode.VALIDATION_ERROR:
      case BaseErrorCode.PARSING_ERROR:
        return 400;
      default:
        return 500;
    }
  }
  return 500;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const __test = {
  pkceS256,
  validateAuthorizePayload,
};
