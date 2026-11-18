import { CONFIG } from "../../shared/config";
import type { ClickUpHttpMethod } from "./request";
import { CLICKUP_ERROR_BODY_MAX_CHARS, CLICKUP_RATE_RESET_HEADER } from "./settings";

export type ClickUpErrorKind =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "server"
  | "request"
  | "network"
  | "response";

export const CLICKUP_ERROR_HINTS: Record<ClickUpErrorKind, string> = {
  unauthorized: "ClickUp rejected the token in CLICKUP_API_KEY.",
  forbidden: "The token's user has no access to this item.",
  not_found: "ClickUp has no item with this id, or the token's user cannot see it.",
  rate_limited: "The per-minute ClickUp request limit is spent.",
  server: "ClickUp failed on its side; the same call may work later.",
  request: "ClickUp refused the request as sent.",
  network: "ClickUp could not be reached.",
  response: "ClickUp answered with a body that is not JSON.",
};

interface ClickUpApiErrorInit {
  kind: ClickUpErrorKind;
  status: number;
  ecode?: string;
  detail: string;
  method: ClickUpHttpMethod;
  path: string;
  rateLimitResetAt?: number;
}

// A body or a low-level cause can echo request headers, so the token never reaches a message.
export function withoutToken(text: string): string {
  return CONFIG.apiKey ? text.split(CONFIG.apiKey).join("[redacted]") : text;
}

function buildMessage(init: ClickUpApiErrorInit, detail: string): string {
  const outcome =
    init.status === 0
      ? "failed with no response"
      : `failed with HTTP ${init.status}${init.ecode ? ` (${init.ecode})` : ""}`;
  const resetAt = init.rateLimitResetAt === undefined ? NaN : new Date(init.rateLimitResetAt).getTime();
  const retry =
    init.kind === "rate_limited" && Number.isFinite(resetAt)
      ? ` Retry after ${new Date(resetAt).toISOString()}.`
      : "";
  return `ClickUp ${init.method} ${init.path} ${outcome}: ${detail}. ${CLICKUP_ERROR_HINTS[init.kind]}${retry}`;
}

export class ClickUpApiError extends Error {
  readonly name = "ClickUpApiError" as const;
  readonly kind: ClickUpErrorKind;
  readonly status: number;
  readonly ecode: string | undefined;
  readonly detail: string;
  readonly method: ClickUpHttpMethod;
  readonly path: string;
  readonly rateLimitResetAt: number | undefined;

  constructor(init: ClickUpApiErrorInit) {
    const detail = withoutToken(init.detail);
    super(buildMessage(init, detail));
    this.kind = init.kind;
    this.status = init.status;
    this.ecode = init.ecode;
    this.detail = detail;
    this.method = init.method;
    this.path = init.path;
    this.rateLimitResetAt = init.rateLimitResetAt;
  }
}

export function clickupErrorKind(status: number): ClickUpErrorKind {
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "server";
  return "request";
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function readResetAt(response: Response): number | undefined {
  const raw = response.headers.get(CLICKUP_RATE_RESET_HEADER)?.trim();
  const seconds = raw ? Number(raw) : NaN;
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

// An ok response only gets here when its body is not JSON, hence kind "response".
export function readClickUpError(
  method: ClickUpHttpMethod,
  url: string,
  response: Response,
  text: string,
): ClickUpApiError {
  const body = response.ok ? undefined : parseJsonObject(text);
  const cut = body ? undefined : nonEmptyString(text.trim().slice(0, CLICKUP_ERROR_BODY_MAX_CHARS));
  return new ClickUpApiError({
    kind: response.ok ? "response" : clickupErrorKind(response.status),
    status: response.status,
    ecode: nonEmptyString(body?.ECODE),
    detail: nonEmptyString(body?.err) ?? nonEmptyString(body?.message) ?? cut ?? response.statusText,
    method,
    path: new URL(url).pathname,
    rateLimitResetAt: response.status === 429 ? readResetAt(response) : undefined,
  });
}
