#!/usr/bin/env node

import http from "http";
import { config, environment } from "../config/index.js";
import { VaultManager } from "../services/vaultManager/index.js";
import { logger, McpLogLevel } from "../utils/internal/logger.js";
import { requestContextService, retryWithDelay } from "../utils/index.js";
import { startChatGptFacade } from "./facade.js";

let httpServerInstance: http.Server | undefined;
let vaultManager: VaultManager | undefined;

async function shutdown(signal: string): Promise<void> {
  const context = requestContextService.createRequestContext({
    operation: "ChatGPTFacadeShutdown",
    signal,
  });
  logger.info(`Received ${signal}. Shutting down ChatGPT facade...`, context);
  if (httpServerInstance) {
    await new Promise<void>((resolve, reject) => {
      httpServerInstance!.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
  if (config.obsidianEnableCache && vaultManager) {
    for (const vaultId of vaultManager.getAvailableVaults()) {
      vaultManager.getVaultCacheService(vaultId)?.stopPeriodicRefresh();
    }
  }
  process.exit(0);
}

async function start(): Promise<void> {
  const validMcpLogLevels: McpLogLevel[] = [
    "debug",
    "info",
    "notice",
    "warning",
    "error",
    "crit",
    "alert",
    "emerg",
  ];
  const logLevel = validMcpLogLevels.includes(config.logLevel as McpLogLevel)
    ? (config.logLevel as McpLogLevel)
    : "info";
  await logger.initialize(logLevel);

  const startupContext = requestContextService.createRequestContext({
    operation: "ChatGPTFacadeStartup",
    appName: "obsidian-chatgpt",
    appVersion: config.mcpServerVersion,
    environment,
  });

  vaultManager = new VaultManager();
  if (config.chatgptFacadeSkipObsidianCheck) {
    logger.warning(
      "Skipping initial Obsidian API status check for ChatGPT facade startup.",
      startupContext,
    );
  } else {
    const defaultVaultService = vaultManager.getVaultService();
    await retryWithDelay(
      async () => {
        const status = await defaultVaultService.checkStatus(startupContext);
        if (
          status?.service !== "Obsidian Local REST API" ||
          !status?.authenticated
        ) {
          throw new Error(
            `Obsidian API status check failed: ${JSON.stringify(status)}`,
          );
        }
        return status;
      },
      {
        operationName: "chatgptFacadeObsidianApiCheck",
        context: startupContext,
        maxRetries: 5,
        delayMs: 3000,
      },
    );
  }

  httpServerInstance = await startChatGptFacade({
    vaultManager,
    parentContext: startupContext,
  });

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

start().catch((error) => {
  logger.error("Critical error during ChatGPT facade startup", error instanceof Error ? error : undefined);
  process.exit(1);
});
