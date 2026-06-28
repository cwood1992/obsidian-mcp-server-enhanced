#!/usr/bin/env node

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import assert from "assert";
import {
  JsonOAuthStore,
  OBSIDIAN_READ_SCOPE,
  OBSIDIAN_WRITE_SCOPE,
  normalizeScopes,
  pkceS256,
  requireScope,
} from "./facadeAuth.js";

const tempDir = mkdtempSync(join(tmpdir(), "obsidian-chatgpt-facade-"));

try {
  assert.equal(
    normalizeScopes(OBSIDIAN_WRITE_SCOPE, [
      OBSIDIAN_READ_SCOPE,
      OBSIDIAN_WRITE_SCOPE,
    ]),
    `${OBSIDIAN_READ_SCOPE} ${OBSIDIAN_WRITE_SCOPE}`,
  );

  assert.throws(() => requireScope(OBSIDIAN_READ_SCOPE, OBSIDIAN_WRITE_SCOPE));

  const store = new JsonOAuthStore(
    join(tempDir, "oauth.json"),
    join(tempDir, "audit.jsonl"),
  );
  const verifier = "correct horse battery staple";
  const code = store.createAuthorizationCode({
    clientId: "client-1",
    redirectUri: "https://chat.openai.com/aip/plugin/callback",
    resource: "https://example.test",
    scope: OBSIDIAN_READ_SCOPE,
    codeChallenge: pkceS256(verifier),
  });

  assert.equal(
    store.consumeAuthorizationCode({
      code,
      clientId: "client-1",
      redirectUri: "https://chat.openai.com/aip/plugin/callback",
      resource: "https://example.test",
      codeVerifier: "wrong verifier",
    }),
    undefined,
  );

  const code2 = store.createAuthorizationCode({
    clientId: "client-1",
    redirectUri: "https://chat.openai.com/aip/plugin/callback",
    resource: "https://example.test",
    scope: OBSIDIAN_READ_SCOPE,
    codeChallenge: pkceS256(verifier),
  });
  const consumed = store.consumeAuthorizationCode({
    code: code2,
    clientId: "client-1",
    redirectUri: "https://chat.openai.com/aip/plugin/callback",
    resource: "https://example.test",
    codeVerifier: verifier,
  });
  assert.equal(consumed?.clientId, "client-1");

  const token = store.createAccessToken({
    clientId: "client-1",
    resource: "https://example.test",
    scope: OBSIDIAN_READ_SCOPE,
    ttlMs: 60_000,
  });
  assert.equal(
    store.verifyAccessToken({
      token: token.token,
      resource: "https://example.test",
      requiredScope: OBSIDIAN_READ_SCOPE,
    })?.clientId,
    "client-1",
  );
  assert.equal(
    store.verifyAccessToken({
      token: token.token,
      resource: "https://wrong.example.test",
      requiredScope: OBSIDIAN_READ_SCOPE,
    }),
    undefined,
  );

  const refresh = store.createRefreshToken({
    clientId: "client-1",
    resource: "https://example.test",
    scope: OBSIDIAN_READ_SCOPE,
    ttlMs: 60_000,
  });
  assert.equal(
    store.consumeRefreshToken({
      token: refresh.token,
      clientId: "client-1",
      resource: "https://wrong.example.test",
    }),
    undefined,
  );
  const consumedRefresh = store.consumeRefreshToken({
    token: refresh.token,
    clientId: "client-1",
    resource: "https://example.test",
  });
  assert.equal(consumedRefresh?.clientId, "client-1");
  assert.equal(
    store.consumeRefreshToken({
      token: refresh.token,
      clientId: "client-1",
      resource: "https://example.test",
    }),
    undefined,
  );

  store.appendAudit({
    action: "append_note",
    clientId: "client-1",
    scopes: [OBSIDIAN_WRITE_SCOPE],
    status: "success",
    inputSummary: "content=\"short summary only\"",
    correlationId: "test-correlation",
  });
  assert.equal(store.listAuditEntries(1)[0].action, "append_note");

  console.log("ChatGPT facade auth selftest passed.");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
