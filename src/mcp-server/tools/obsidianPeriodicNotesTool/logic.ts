/**
 * @fileoverview Logic for managing Obsidian periodic notes operations.
 */

import { RequestContext } from "../../../utils/index.js";
import { ObsidianRestApiService } from "../../../services/obsidianRestAPI/index.js";
import {
  Period,
  PeriodicNoteDate,
  NoteJson,
} from "../../../services/obsidianRestAPI/types.js";
import { BaseErrorCode, McpError } from "../../../types-global/errors.js";

export interface PeriodicNotesOperation {
  operation: "get" | "create" | "append" | "update" | "list_periods" | "exists";
  period?: Period;
  content?: string;
  date?: string;
  format?: "markdown" | "json";
  template?: string;
  createIfNotExists?: boolean;
}

export interface PeriodicNotesResult {
  success: boolean;
  operation: string;
  period?: string;
  date?: string;
  exists?: boolean;
  content?: string | NoteJson;
  created?: boolean;
  appended?: boolean;
  availablePeriods?: string[];
  message?: string;
}

/**
 * Parses a strict YYYY-MM-DD date string into route segments.
 * Throws VALIDATION_ERROR on anything unparseable or not a real calendar
 * date — the tool must never fall back to the current period when the
 * caller named a date.
 */
function parsePeriodicDate(date: string): PeriodicNoteDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      `Invalid date "${date}". Expected ISO format YYYY-MM-DD (e.g. 2026-09-16). No operation was performed.`,
    );
  }
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  // Round-trip through a local Date to reject impossible dates like 2026-02-30.
  const check = new Date(year, month - 1, day);
  if (
    check.getFullYear() !== year ||
    check.getMonth() !== month - 1 ||
    check.getDate() !== day
  ) {
    throw new McpError(
      BaseErrorCode.VALIDATION_ERROR,
      `Invalid date "${date}": not a real calendar date. No operation was performed.`,
    );
  }
  return { year, month, day };
}

/** Human-readable target for messages: "daily note for 2026-09-16" or "current daily note". */
function describeTarget(period: Period, dateStr?: string): string {
  return dateStr ? `${period} note for ${dateStr}` : `current ${period} note`;
}

type PeriodicFailureKind = "note-missing" | "route-missing" | "other";

/**
 * Classifies a failed periodic-note API call using the HTTP status and
 * response body preserved in McpError details.
 *
 * The Local REST API answers 404 in two distinct ways:
 * - Route present, note absent: JSON body with a specific errorCode
 *   (e.g. 40461 "Periodic note does not exist for the specified period.").
 * - Route absent (plugin >= 5.0.2 without the periodic-notes companion
 *   plugin, or an outdated plugin): generic errorCode 40400 "Not Found",
 *   or a non-JSON body.
 * Only the first means "the note does not exist"; the second is a
 * configuration problem and must never be reported as a missing note.
 */
function classifyPeriodicFailure(error: unknown): PeriodicFailureKind {
  if (!(error instanceof McpError)) {
    return "other";
  }
  const status = error.details?.responseStatus;
  if (status !== 404) {
    return "other";
  }
  const body = error.details?.responseData;
  if (body && typeof body === "object" && "errorCode" in body) {
    const errorCode = (body as { errorCode: unknown }).errorCode;
    return errorCode === 40400 ? "route-missing" : "note-missing";
  }
  // 404 without the API's JSON error envelope: the request never reached a
  // periodic-notes handler, so treat it as a missing route.
  return "route-missing";
}

/** Builds the configuration error for an absent /periodic/ route. */
function routeMissingError(period: Period): McpError {
  return new McpError(
    BaseErrorCode.CONFIGURATION_ERROR,
    `The Obsidian REST API has no /periodic/${period}/ route. Local REST API 5.0.2 removed core periodic-note support; install and enable the "obsidian-local-rest-api-periodic-notes" companion plugin (or run a pre-5.0.2 plugin version), then retry.`,
  );
}

/**
 * Executes periodic notes operations.
 */
export async function executePeriodicNotesOperation(
  operation: PeriodicNotesOperation,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<PeriodicNotesResult> {
  const {
    operation: op,
    period,
    content,
    date,
    format = "markdown",
    template,
    createIfNotExists,
  } = operation;

  try {
    // Parse the date up front so an unparseable date fails every operation
    // before any request is made.
    const dateSegments = date !== undefined ? parsePeriodicDate(date) : undefined;
    const dateStr = date?.trim();

    switch (op) {
      case "list_periods":
        return {
          success: true,
          operation: op,
          availablePeriods: ["daily", "weekly", "monthly", "quarterly", "yearly"],
          message: "Available periodic note types",
        };

      case "exists":
        if (!period) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Period is required for exists operation");
        }
        return await checkPeriodicNoteExists(period, dateSegments, dateStr, obsidianService, context);

      case "get":
        if (!period) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Period is required for get operation");
        }
        return await getPeriodicNote(period, format, dateSegments, dateStr, obsidianService, context);

      case "create":
        if (!period) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Period is required for create operation");
        }
        return await createPeriodicNote(period, content, template, dateSegments, dateStr, obsidianService, context);

      case "update":
        if (!period) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Period is required for update operation");
        }
        if (!content) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Content is required for update operation");
        }
        return await updatePeriodicNote(period, content, dateSegments, dateStr, obsidianService, context);

      case "append":
        if (!period) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Period is required for append operation");
        }
        if (!content) {
          throw new McpError(BaseErrorCode.VALIDATION_ERROR, "Content is required for append operation");
        }
        return await appendToPeriodicNote(period, content, createIfNotExists || false, dateSegments, dateStr, obsidianService, context);

      default:
        throw new McpError(BaseErrorCode.VALIDATION_ERROR, `Unknown operation: ${op}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(BaseErrorCode.INTERNAL_ERROR, `Periodic notes operation failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Check if a periodic note exists. Only a note-level "not found" from the
 * API is reported as exists=false; route-level 404s and every other failure
 * (auth, network, server errors) propagate, so an endpoint outage is never
 * mistaken for an absent note.
 */
async function checkPeriodicNoteExists(
  period: Period,
  dateSegments: PeriodicNoteDate | undefined,
  dateStr: string | undefined,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<PeriodicNotesResult> {
  try {
    await obsidianService.getPeriodicNote(period, "markdown", context, dateSegments);
    return {
      success: true,
      operation: "exists",
      period,
      date: dateStr,
      exists: true,
      message: `${describeTarget(period, dateStr)} exists`,
    };
  } catch (error) {
    const kind = classifyPeriodicFailure(error);
    if (kind === "note-missing") {
      return {
        success: true,
        operation: "exists",
        period,
        date: dateStr,
        exists: false,
        message: `${describeTarget(period, dateStr)} does not exist`,
      };
    }
    if (kind === "route-missing") {
      throw routeMissingError(period);
    }
    throw error;
  }
}

/**
 * Get a periodic note.
 */
async function getPeriodicNote(
  period: Period,
  format: "markdown" | "json",
  dateSegments: PeriodicNoteDate | undefined,
  dateStr: string | undefined,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<PeriodicNotesResult> {
  try {
    const content = await obsidianService.getPeriodicNote(period, format, context, dateSegments);
    return {
      success: true,
      operation: "get",
      period,
      date: dateStr,
      content,
      message: `Retrieved ${describeTarget(period, dateStr)}`,
    };
  } catch (error) {
    const kind = classifyPeriodicFailure(error);
    if (kind === "note-missing") {
      throw new McpError(
        BaseErrorCode.NOT_FOUND,
        `${describeTarget(period, dateStr)} not found. Use create operation to create it first.`,
      );
    }
    if (kind === "route-missing") {
      throw routeMissingError(period);
    }
    throw error;
  }
}

/**
 * Create a new periodic note.
 */
async function createPeriodicNote(
  period: Period,
  content: string | undefined,
  template: string | undefined,
  dateSegments: PeriodicNoteDate | undefined,
  dateStr: string | undefined,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<PeriodicNotesResult> {
  const targetDate = toLocalDate(dateSegments);
  let noteContent = content || "";

  // If template is provided, use it as the base content
  if (template) {
    noteContent = await processTemplate(template, period, targetDate, obsidianService, context);
    // If additional content is provided, append it
    if (content) {
      noteContent += "\n\n" + content;
    }
  }

  // If no content or template, create a basic structure
  if (!noteContent) {
    noteContent = createDefaultPeriodicContent(period, targetDate);
  }

  try {
    await obsidianService.updatePeriodicNote(period, noteContent, context, dateSegments);
  } catch (error) {
    if (classifyPeriodicFailure(error) === "route-missing") {
      throw routeMissingError(period);
    }
    throw error;
  }

  return {
    success: true,
    operation: "create",
    period,
    date: dateStr,
    created: true,
    message: `Created ${describeTarget(period, dateStr)}${template ? " from template" : ""}`,
  };
}

/**
 * Update a periodic note (overwrites existing content).
 */
async function updatePeriodicNote(
  period: Period,
  content: string,
  dateSegments: PeriodicNoteDate | undefined,
  dateStr: string | undefined,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<PeriodicNotesResult> {
  try {
    await obsidianService.updatePeriodicNote(period, content, context, dateSegments);
  } catch (error) {
    if (classifyPeriodicFailure(error) === "route-missing") {
      throw routeMissingError(period);
    }
    throw error;
  }

  return {
    success: true,
    operation: "update",
    period,
    date: dateStr,
    message: `Updated ${describeTarget(period, dateStr)}`,
  };
}

/**
 * Append content to a periodic note.
 */
async function appendToPeriodicNote(
  period: Period,
  content: string,
  createIfNotExists: boolean,
  dateSegments: PeriodicNoteDate | undefined,
  dateStr: string | undefined,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<PeriodicNotesResult> {
  try {
    // Try to get existing content
    const existingContent = await obsidianService.getPeriodicNote(period, "markdown", context, dateSegments) as string;
    const newContent = existingContent + "\n\n" + content;
    await obsidianService.updatePeriodicNote(period, newContent, context, dateSegments);

    return {
      success: true,
      operation: "append",
      period,
      date: dateStr,
      appended: true,
      message: `Appended content to ${describeTarget(period, dateStr)}`,
    };
  } catch (error) {
    const kind = classifyPeriodicFailure(error);
    if (kind === "route-missing") {
      throw routeMissingError(period);
    }
    if (kind !== "note-missing") {
      throw error;
    }
    if (createIfNotExists) {
      // Create new note with the content
      await obsidianService.updatePeriodicNote(period, content, context, dateSegments);
      return {
        success: true,
        operation: "append",
        period,
        date: dateStr,
        created: true,
        appended: true,
        message: `Created ${describeTarget(period, dateStr)} and added content`,
      };
    }
    throw new McpError(
      BaseErrorCode.NOT_FOUND,
      `${describeTarget(period, dateStr)} not found. Set createIfNotExists=true to create it.`,
    );
  }
}

/** Converts route segments to a local-time Date; defaults to now. */
function toLocalDate(dateSegments?: PeriodicNoteDate): Date {
  if (!dateSegments) {
    return new Date();
  }
  return new Date(dateSegments.year, dateSegments.month - 1, dateSegments.day);
}

/**
 * Process a template for periodic notes.
 */
async function processTemplate(
  template: string,
  period: Period,
  targetDate: Date,
  obsidianService: ObsidianRestApiService,
  context: RequestContext,
): Promise<string> {
  // If template looks like a file path, try to read it
  if (template.includes("/") || template.endsWith(".md")) {
    try {
      const templateContent = await obsidianService.getFileContent(template, "markdown", context) as string;
      return processTemplateVariables(templateContent, period, targetDate);
    } catch (error) {
      // If file doesn't exist, treat template as literal content
      return processTemplateVariables(template, period, targetDate);
    }
  }

  // Otherwise, treat as literal template content
  return processTemplateVariables(template, period, targetDate);
}

/** Formats a Date as local YYYY-MM-DD (toISOString would shift the day across timezones). */
function formatLocalDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Process template variables in content.
 */
function processTemplateVariables(content: string, period: Period, targetDate: Date): string {
  const dateStr = formatLocalDate(targetDate);
  const timeStr = new Date().toTimeString().split(' ')[0]; // HH:MM:SS
  const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' });
  const monthName = targetDate.toLocaleDateString('en-US', { month: 'long' });
  const year = targetDate.getFullYear();

  return content
    .replace(/\{\{date\}\}/g, dateStr)
    .replace(/\{\{time\}\}/g, timeStr)
    .replace(/\{\{day\}\}/g, dayName)
    .replace(/\{\{month\}\}/g, monthName)
    .replace(/\{\{year\}\}/g, year.toString())
    .replace(/\{\{period\}\}/g, period)
    .replace(/\{\{title\}\}/g, `${period.charAt(0).toUpperCase() + period.slice(1)} Note - ${dateStr}`);
}

/**
 * Create default content for periodic notes.
 */
function createDefaultPeriodicContent(period: Period, targetDate: Date): string {
  const dateStr = formatLocalDate(targetDate);
  const dayName = targetDate.toLocaleDateString('en-US', { weekday: 'long' });

  switch (period) {
    case "daily":
      return `# Daily Note - ${dateStr} (${dayName})

## Today's Goals
-

## Notes


## Reflections


## Tomorrow's Priorities
- `;

    case "weekly":
      const weekStart = getWeekStart(new Date(targetDate));
      const weekEnd = getWeekEnd(new Date(targetDate));
      return `# Weekly Note - Week of ${formatLocalDate(weekStart)}

## Week Overview
${formatLocalDate(weekStart)} to ${formatLocalDate(weekEnd)}

## This Week's Goals
-

## Achievements


## Lessons Learned


## Next Week's Focus
- `;

    case "monthly":
      const monthName = targetDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
      return `# Monthly Note - ${monthName}

## Month Overview

## Goals for This Month
-

## Key Projects


## Monthly Review


## Next Month's Priorities
- `;

    case "quarterly":
      const quarter = Math.floor(targetDate.getMonth() / 3) + 1;
      return `# Quarterly Note - Q${quarter} ${targetDate.getFullYear()}

## Quarter Overview

## Quarterly Goals
-

## Major Projects


## Quarterly Review


## Next Quarter's Focus
- `;

    case "yearly":
      return `# Yearly Note - ${targetDate.getFullYear()}

## Year Overview

## Annual Goals
-

## Major Achievements


## Year in Review


## Next Year's Vision
- `;

    default:
      return `# ${(period as string).charAt(0).toUpperCase() + (period as string).slice(1)} Note - ${dateStr}

## Notes

`;
  }
}

/**
 * Get the start of the week (Monday).
 */
function getWeekStart(date: Date): Date {
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
  return new Date(date.setDate(diff));
}

/**
 * Get the end of the week (Sunday).
 */
function getWeekEnd(date: Date): Date {
  const weekStart = getWeekStart(new Date(date));
  return new Date(weekStart.getTime() + 6 * 24 * 60 * 60 * 1000);
}
