import { CONFIG } from "../../shared/config";
import { ClickUpApiError, readClickUpError } from "./errors";
import { CLICKUP_V2_BASE, CLICKUP_V3_BASE } from "./settings";

export type ClickUpHttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export type ClickUpQueryValue = string | number | boolean | readonly (string | number)[] | undefined;
export type ClickUpQuery = Record<string, ClickUpQueryValue>;

function appendQuery(target: URL, query: ClickUpQuery | undefined): void {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      // ClickUp reads list filters in the bracket form, e.g. statuses[]=a&statuses[]=b.
      for (const item of value) target.searchParams.append(`${key}[]`, String(item));
    } else {
      target.searchParams.append(key, String(value));
    }
  }
}

function causeMessage(error: unknown): string {
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const source = cause instanceof Error ? cause : error;
  return source instanceof Error ? source.message : String(source);
}

export async function clickupJson<T = unknown>(
  method: ClickUpHttpMethod,
  url: string,
  body?: unknown,
  query?: ClickUpQuery,
): Promise<T> {
  const target = new URL(url);
  appendQuery(target, query);
  const headers: Record<string, string> = { Authorization: CONFIG.apiKey };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let response: Response;
  let text: string;
  try {
    response = await fetch(target, init);
    // A body cut off mid-read leaves nothing usable, so it counts as no response.
    text = await response.text();
  } catch (error) {
    throw new ClickUpApiError({
      kind: "network",
      status: 0,
      detail: causeMessage(error),
      method,
      path: target.pathname,
    });
  }

  if (!response.ok) throw readClickUpError(method, target.toString(), response, text);
  if (text.trim() === "") return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw readClickUpError(method, target.toString(), response, text);
  }
}

export function clickupGet<T = unknown>(url: string, query?: ClickUpQuery): Promise<T> {
  return clickupJson<T>("GET", url, undefined, query);
}

export function clickupPost<T = unknown>(url: string, body?: unknown, query?: ClickUpQuery): Promise<T> {
  return clickupJson<T>("POST", url, body, query);
}

export function clickupPut<T = unknown>(url: string, body?: unknown, query?: ClickUpQuery): Promise<T> {
  return clickupJson<T>("PUT", url, body, query);
}

export function clickupDelete<T = unknown>(url: string, query?: ClickUpQuery): Promise<T> {
  return clickupJson<T>("DELETE", url, undefined, query);
}

export function teamUrl(path: string): string {
  return `${CLICKUP_V2_BASE}/team/${CONFIG.teamId}${path}`;
}

export function workspaceUrl(path: string): string {
  return `${CLICKUP_V3_BASE}/workspaces/${CONFIG.teamId}${path}`;
}
