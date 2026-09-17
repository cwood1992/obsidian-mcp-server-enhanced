/**
 * @module PeriodicNoteMethods
 * @description
 * Methods for interacting with periodic notes (daily, weekly, etc.) via the Obsidian REST API.
 */

import { RequestContext } from "../../../utils/index.js";
import { NoteJson, Period, PeriodicNoteDate, RequestFunction } from "../types.js";

/**
 * Builds the periodic note route. Without a date this is the current-period
 * route `/periodic/{period}/`; with a date it is the dated route
 * `/periodic/{period}/{year}/{month}/{day}/`, which resolves the period
 * containing that date (Local REST API >= 5.x requires the
 * obsidian-local-rest-api-periodic-notes companion plugin for both).
 */
function buildPeriodicUrl(period: Period, date?: PeriodicNoteDate): string {
  if (!date) {
    return `/periodic/${period}/`;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `/periodic/${period}/${date.year}/${pad(date.month)}/${pad(date.day)}/`;
}

/**
 * Gets the content of a periodic note (daily, weekly, etc.).
 * @param _request - The internal request function from the service instance.
 * @param period - The period type ('daily', 'weekly', 'monthly', 'quarterly', 'yearly').
 * @param format - 'markdown' or 'json'.
 * @param context - Request context.
 * @param date - Optional specific date; omitted means the current period.
 * @returns The note content or NoteJson.
 */
export async function getPeriodicNote(
  _request: RequestFunction,
  period: Period,
  format: "markdown" | "json" = "markdown",
  context: RequestContext,
  date?: PeriodicNoteDate,
): Promise<string | NoteJson> {
  const acceptHeader =
    format === "json" ? "application/vnd.olrapi.note+json" : "text/markdown";
  return _request<string | NoteJson>(
    {
      method: "GET",
      url: buildPeriodicUrl(period, date),
      headers: { Accept: acceptHeader },
    },
    context,
    "getPeriodicNote",
  );
}

/**
 * Updates (overwrites) the content of a periodic note. Creates if needed.
 * @param _request - The internal request function from the service instance.
 * @param period - The period type.
 * @param content - The new content.
 * @param context - Request context.
 * @param date - Optional specific date; omitted means the current period.
 * @returns {Promise<void>} Resolves on success (204 No Content).
 */
export async function updatePeriodicNote(
  _request: RequestFunction,
  period: Period,
  content: string,
  context: RequestContext,
  date?: PeriodicNoteDate,
): Promise<void> {
  await _request<void>(
    {
      method: "PUT",
      url: buildPeriodicUrl(period, date),
      headers: { "Content-Type": "text/markdown" },
      data: content,
    },
    context,
    "updatePeriodicNote",
  );
}

/**
 * Appends content to a periodic note. Creates if needed.
 * @param _request - The internal request function from the service instance.
 * @param period - The period type.
 * @param content - The content to append.
 * @param context - Request context.
 * @param date - Optional specific date; omitted means the current period.
 * @returns {Promise<void>} Resolves on success (204 No Content).
 */
export async function appendPeriodicNote(
  _request: RequestFunction,
  period: Period,
  content: string,
  context: RequestContext,
  date?: PeriodicNoteDate,
): Promise<void> {
  await _request<void>(
    {
      method: "POST",
      url: buildPeriodicUrl(period, date),
      headers: { "Content-Type": "text/markdown" },
      data: content,
    },
    context,
    "appendPeriodicNote",
  );
}

/**
 * Deletes a periodic note.
 * @param _request - The internal request function from the service instance.
 * @param period - The period type.
 * @param context - Request context.
 * @param date - Optional specific date; omitted means the current period.
 * @returns {Promise<void>} Resolves on success (204 No Content).
 */
export async function deletePeriodicNote(
  _request: RequestFunction,
  period: Period,
  context: RequestContext,
  date?: PeriodicNoteDate,
): Promise<void> {
  await _request<void>(
    {
      method: "DELETE",
      url: buildPeriodicUrl(period, date),
    },
    context,
    "deletePeriodicNote",
  );
}
