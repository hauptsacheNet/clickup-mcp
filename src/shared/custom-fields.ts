import { CONFIG } from "./config";

/**
 * Custom field support for ClickUp lists and tasks.
 *
 * ClickUp exposes custom fields in three shapes that do not line up with each
 * other:
 *   - a LIST definition (`GET /list/{id}/field`) carries the writable field and
 *     its options,
 *   - a TASK read (`custom_fields` on the task object) carries the current value
 *     encoded per type (drop_down as an `orderindex`, users as objects, ...),
 *   - a WRITE takes the API-ready value (drop_down as an OPTION ID, labels as an
 *     array of option ids, dates as epoch ms, ...).
 *
 * This module is the single translation layer: callers pass a field reference
 * (id or human name) plus a friendly value, and get back the exact payload
 * ClickUp expects - with actionable errors when a name or an option is unknown.
 *
 * Field references are resolved by NAME first (robust against UUID drift),
 * falling back to the field id: emoji, case, accents and extra spaces are
 * ignored, and a unique partial name also matches (so "domain" finds
 * "🧩 Domain"). Option values are accepted as either the option id or the
 * option name/label.
 */

/** Cache lifetime for list fields and the team member directory. */
const CACHE_TTL_MS = 60_000;

export interface ClickUpCustomFieldOption {
  id: string;
  name?: string | null;
  label?: string | null;
  orderindex?: number;
  color?: string | null;
}

export interface ClickUpCustomField {
  id: string;
  name: string;
  type: string;
  type_config?: {
    options?: ClickUpCustomFieldOption[];
    [key: string]: unknown;
  } | null;
  required?: boolean;
  hide_from_guests?: boolean;
}

/** Input shape accepted from the tools: {name} or {id}, plus the value. */
export interface CustomFieldInput {
  name?: string;
  id?: string;
  value: unknown;
}

export interface ResolvedCustomField {
  fieldId: string;
  fieldName: string;
  fieldType: string;
  /** API-ready value (option id(s), user id(s), epoch ms, boolean, scalar...). */
  value: unknown;
  /** Human-readable rendering of the resolved value, for the tool response. */
  display: string;
}

/** Field types this MCP can write. */
const WRITABLE_TYPES = new Set([
  "text",
  "short_text",
  "email",
  "phone",
  "url",
  "number",
  "currency",
  "rating",
  "manual_progress",
  "drop_down",
  "labels",
  "checkbox",
  "date",
  "users",
  "tasks",
]);

/** Field types ClickUp computes itself and refuses as a write target. */
const READ_ONLY_TYPES = new Set(["automatic_progress", "formula", "rollup", "progress"]);

interface TeamMember {
  id: string;
  username: string;
  email: string;
  initials?: string;
}

const fieldCache = new Map<string, Promise<ClickUpCustomField[]>>();
let memberDirectoryPromise: Promise<TeamMember[]> | null = null;

/** Test hook: drop every cached list-field/team-member lookup. */
export function clearCustomFieldCaches(): void {
  fieldCache.clear();
  memberDirectoryPromise = null;
}

/**
 * Fold a display name into a comparison key that is insensitive to the emoji
 * prefixes ClickUp users put in front of field names ("🤝 Customer"),
 * punctuation, and accents.
 *
 * Letters and digits from every script are kept: stripping to ASCII would turn
 * a CJK/Cyrillic/Greek/Arabic name into an empty key, and an empty key matches
 * every other non-Latin option in `resolveOption` (silently writing the wrong
 * one). Emoji and punctuation still collapse to a single space.
 */
export function normalizeFieldKey(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function optionLabel(option: ClickUpCustomFieldOption): string {
  return (option.name ?? option.label ?? "").toString().trim();
}

/** Load (and cache) the custom field definitions of a list. */
export async function getListCustomFields(listId: string): Promise<ClickUpCustomField[]> {
  if (!listId) {
    throw new Error("A list ID is required to resolve custom fields.");
  }
  const cached = fieldCache.get(listId);
  if (cached) {
    return cached;
  }
  const promise = (async () => {
    const response = await fetch(`https://api.clickup.com/api/v2/list/${listId}/field`, {
      headers: { Authorization: CONFIG.apiKey },
    });
    if (!response.ok) {
      throw new Error(`Error fetching custom fields for list ${listId}: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return (data.fields || []) as ClickUpCustomField[];
  })();
  fieldCache.set(listId, promise);
  // Never keep a rejected promise cached: a transient API error would otherwise
  // make every field lookup fail for the whole TTL, even after the API recovers.
  promise.catch(() => {
    if (fieldCache.get(listId) === promise) {
      fieldCache.delete(listId);
    }
  });
  setTimeout(() => {
    if (fieldCache.get(listId) === promise) {
      fieldCache.delete(listId);
    }
  }, CACHE_TTL_MS).unref?.();
  return promise;
}

/** Load (and cache) the workspace member directory used to resolve `users` fields. */
async function getTeamMemberDirectory(): Promise<TeamMember[]> {
  if (memberDirectoryPromise) {
    return memberDirectoryPromise;
  }
  const request = (async () => {
    const response = await fetch(`https://api.clickup.com/api/v2/team`, {
      headers: { Authorization: CONFIG.apiKey },
    });
    if (!response.ok) {
      console.error(`Could not fetch team members: ${response.status} ${response.statusText}`);
      return [];
    }
    const data = await response.json();
    // Only ever resolve users within the configured team. Falling back to the
    // first returned team would silently resolve a user reference (or leak its
    // members in an error) from another workspace the token can see.
    const team = (data.teams || []).find((t: any) => t.id === CONFIG.teamId);
    if (!team || !Array.isArray(team.members)) {
      console.error(`Team ${CONFIG.teamId} was not found in the teams response`);
      return [];
    }
    const members: TeamMember[] = team.members
      .map((member: any) => member.user)
      .filter(Boolean)
      .map((user: any) => ({
        id: String(user.id),
        username: String(user.username ?? ""),
        email: String(user.email ?? ""),
        initials: user.initials,
      }));
    return members;
  })();
  memberDirectoryPromise = request;
  // A failed or empty directory must not be cached either, otherwise a single
  // transient error turns every user lookup into "Unknown user" for the TTL.
  const evict = () => {
    if (memberDirectoryPromise === request) {
      memberDirectoryPromise = null;
    }
  };
  request.then(
    (members) => {
      if (members.length === 0) {
        evict();
      }
    },
    evict
  );
  setTimeout(evict, CACHE_TTL_MS).unref?.();
  return request;
}

/**
 * Find a field by id (exact) or by human name (normalized). A unique partial
 * name also matches, so "domain" resolves "🧩 Domain" without the emoji.
 */
function resolveField(fields: ClickUpCustomField[], input: CustomFieldInput): ClickUpCustomField {
  const reference = (input.name ?? input.id ?? "").toString();
  if (!reference) {
    throw new Error("Each custom field needs a `name` or an `id`.");
  }
  if (input.id) {
    const byId = fields.find((field) => String(field.id) === String(input.id));
    if (byId) {
      return byId;
    }
    // `id` is documented as taking precedence over `name`: an unknown id must
    // fail loudly rather than silently target whatever `name` happens to match.
    throw new Error(`Unknown custom field id "${input.id}". Available fields: ${describeFieldNames(fields)}`);
  }
  const key = normalizeFieldKey(reference);
  if (!key) {
    throw new Error(`Custom field reference "${reference}" has no usable name.`);
  }
  const exact = fields.filter((field) => normalizeFieldKey(field.name) === key);
  if (exact.length === 1) {
    return exact[0];
  }
  if (exact.length > 1) {
    throw new Error(`Custom field name "${reference}" is ambiguous: ${exact.map((f) => `"${f.name}"`).join(", ")}. Use the field id.`);
  }
  const partial = fields.filter((field) => normalizeFieldKey(field.name).includes(key));
  if (partial.length === 1) {
    return partial[0];
  }
  throw new Error(`Unknown custom field "${reference}". Available fields: ${describeFieldNames(fields)}`);
}

function describeFieldNames(fields: ClickUpCustomField[]): string {
  return fields.length > 0 ? fields.map((field) => `"${field.name}"`).join(", ") : "(none defined on this list)";
}

function describeOptions(field: ClickUpCustomField): string {
  const options = field.type_config?.options || [];
  return options.length > 0 ? options.map((option) => `"${optionLabel(option)}"`).join(", ") : "(no options)";
}

/** Resolve a drop_down option from its id or its (case-insensitive) name/label. */
function resolveOption(field: ClickUpCustomField, raw: unknown): ClickUpCustomFieldOption {
  const options = field.type_config?.options || [];
  const reference = String(raw);
  const byId = options.find((option) => String(option.id) === reference);
  if (byId) {
    return byId;
  }
  const key = normalizeFieldKey(reference);
  // A reference with no letters/digits (e.g. an emoji-only value) normalizes to
  // "", which would match every option that also normalizes to "". Refuse it
  // rather than silently picking whichever non-Latin option happens to match.
  if (!key) {
    throw new Error(`Unknown option "${reference}" for field "${field.name}". Valid options: ${describeOptions(field)}`);
  }
  const byName = options.filter((option) => normalizeFieldKey(optionLabel(option)) === key);
  if (byName.length === 1) {
    return byName[0];
  }
  if (byName.length > 1) {
    throw new Error(`Option "${reference}" is ambiguous on field "${field.name}". Valid options: ${describeOptions(field)}`);
  }
  throw new Error(`Unknown option "${reference}" for field "${field.name}". Valid options: ${describeOptions(field)}`);
}

function toArray(value: unknown): unknown[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/** Resolve one `users` value (id, email or username) to a ClickUp user id. */
async function resolveUser(member: unknown, directory: TeamMember[]): Promise<string> {
  const reference = String(member).trim();
  const byId = directory.find((entry) => entry.id === reference);
  if (byId) {
    return byId.id;
  }
  const lower = reference.toLowerCase();
  const byEmail = directory.find((entry) => entry.email.toLowerCase() === lower);
  if (byEmail) {
    return byEmail.id;
  }
  const byName = directory.filter((entry) => entry.username.toLowerCase() === lower);
  if (byName.length === 1) {
    return byName[0].id;
  }
  if (byName.length > 1) {
    throw new Error(`User "${reference}" is ambiguous (${byName.map((entry) => `${entry.username} (${entry.id})`).join(", ")}). Use the user id.`);
  }
  throw new Error(`Unknown user "${reference}". Use a workspace user id, email or exact username.`);
}

/** Convert a friendly value into the API-ready value for a field type. */
async function coerceValue(field: ClickUpCustomField, raw: unknown): Promise<{ value: unknown; display: string }> {
  const type = field.type;

  if (READ_ONLY_TYPES.has(type)) {
    throw new Error(`Field "${field.name}" is of type ${type} and is computed by ClickUp - it cannot be written.`);
  }
  if (type === "attachment") {
    throw new Error(`Field "${field.name}" is an attachment field - upload files through a task attachment instead of a custom field value.`);
  }
  if (!WRITABLE_TYPES.has(type)) {
    // Unknown/new type: pass the raw value through rather than blocking the user.
    return { value: raw, display: renderValue(raw) };
  }

  switch (type) {
    case "drop_down": {
      if (isBlank(raw)) {
        return { value: null, display: "(cleared)" };
      }
      const option = resolveOption(field, raw);
      return { value: option.id, display: optionLabel(option) || option.id };
    }
    case "labels": {
      if (isBlank(raw)) {
        return { value: [], display: "(none)" };
      }
      const options = toArray(raw).map((entry) => resolveOption(field, entry));
      return { value: options.map((option) => option.id), display: options.map((option) => optionLabel(option) || option.id).join(", ") };
    }
    case "users": {
      if (isBlank(raw)) {
        // Clearing a `users` field needs the current members to build the `rem`
        // half, which this resolver does not read. A silent no-op would report a
        // clear that never happened, so ask for the explicit diff instead. Checked
        // before the directory fetch so a clear request costs no API call.
        throw new Error(`Field "${field.name}" is a users field - pass { add: [...], rem: [...] } (null cannot clear it because the current members are unknown).`);
      }
      const directory = await getTeamMemberDirectory();
      const resolveIds = (list: unknown[]): Promise<string[]> =>
        Promise.all(list.map((entry) => resolveUser(entry, directory)));
      const describe = (ids: string[]): string =>
        ids
          .map((id) => {
            const found = directory.find((member) => member.id === id);
            return found ? `${found.username} (${found.id})` : id;
          })
          .join(", ");

      // ClickUp writes a `users` field through an assignees-style diff
      // ({add, rem}), not a plain array - passing an array is rejected with
      // FIELD_341. Accept an explicit diff, or treat any other value as `add`.
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && ("add" in raw || "rem" in raw)) {
        const diff = raw as { add?: unknown; rem?: unknown };
        const add = await resolveIds(toArray(diff.add));
        const rem = await resolveIds(toArray(diff.rem));
        const parts = [
          add.length > 0 ? `+ ${describe(add)}` : null,
          rem.length > 0 ? `- ${describe(rem)}` : null,
        ].filter(Boolean);
        return { value: { add, rem }, display: parts.join(" ") || "(no change)" };
      }
      const ids = await resolveIds(toArray(raw));
      return { value: { add: ids, rem: [] }, display: describe(ids) };
    }
    case "checkbox": {
      if (isBlank(raw)) {
        return { value: false, display: "false" };
      }
      const truthy = raw === true || raw === 1 || String(raw).toLowerCase() === "true" || String(raw).toLowerCase() === "yes" || String(raw) === "1";
      const falsy = raw === false || raw === 0 || String(raw).toLowerCase() === "false" || String(raw).toLowerCase() === "no" || String(raw) === "0";
      if (!truthy && !falsy) {
        throw new Error(`Field "${field.name}" is a checkbox - expected true/false, got "${String(raw)}".`);
      }
      return { value: truthy, display: String(truthy) };
    }
    case "date": {
      if (isBlank(raw)) {
        return { value: null, display: "(cleared)" };
      }
      const ms = typeof raw === "number" ? raw : new Date(String(raw)).getTime();
      if (!Number.isFinite(ms)) {
        throw new Error(`Field "${field.name}" needs a date as ISO string or epoch ms, got "${String(raw)}".`);
      }
      return { value: ms, display: new Date(ms).toISOString() };
    }
    case "number":
    case "currency":
    case "rating":
    case "manual_progress": {
      if (isBlank(raw)) {
        return { value: null, display: "(cleared)" };
      }
      if (typeof raw === "object") {
        return { value: raw, display: JSON.stringify(raw) };
      }
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Field "${field.name}" expects a number, got "${String(raw)}".`);
      }
      return { value: parsed, display: String(parsed) };
    }
    case "tasks": {
      // ClickUp writes a `tasks` (relationship) field through the same
      // assignees-style diff as `users` - a plain array is rejected.
      if (isBlank(raw)) {
        throw new Error(`Field "${field.name}" is a tasks field - pass { add: [...], rem: [...] } (null cannot clear it because the current links are unknown).`);
      }
      if (raw !== null && typeof raw === "object" && !Array.isArray(raw) && ("add" in raw || "rem" in raw)) {
        const diff = raw as { add?: unknown; rem?: unknown };
        const add = toArray(diff.add).map((entry) => String(entry));
        const rem = toArray(diff.rem).map((entry) => String(entry));
        const parts = [
          add.length > 0 ? `+ ${add.join(", ")}` : null,
          rem.length > 0 ? `- ${rem.join(", ")}` : null,
        ].filter(Boolean);
        return { value: { add, rem }, display: parts.join(" ") || "(no change)" };
      }
      const ids = toArray(raw).map((entry) => String(entry));
      return { value: { add: ids, rem: [] }, display: ids.join(", ") || "(no change)" };
    }
    default: {
      // text / short_text / email / phone / url
      if (isBlank(raw)) {
        return { value: null, display: "(cleared)" };
      }
      const text = String(raw);
      return { value: text, display: text };
    }
  }
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "(empty)";
  }
  if (Array.isArray(value)) {
    return value.join(", ") || "(none)";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/**
 * Resolve the caller's `custom_fields` payload against a list definition.
 *
 * Duplicate targets are rejected rather than silently letting the last write
 * win - two entries pointing at the same field are almost always a mistake.
 */
export async function resolveCustomFields(
  listId: string,
  inputs: CustomFieldInput[] | undefined
): Promise<ResolvedCustomField[]> {
  if (!inputs || inputs.length === 0) {
    return [];
  }
  const fields = await getListCustomFields(listId);
  const resolved: ResolvedCustomField[] = [];
  const seen = new Map<string, string>();
  for (const input of inputs) {
    const field = resolveField(fields, input);
    const previous = seen.get(field.id);
    if (previous) {
      throw new Error(`Custom field "${field.name}" is set twice ("${previous}" and "${input.name ?? input.id}") - keep a single entry.`);
    }
    seen.set(field.id, input.name ?? input.id ?? field.name);
    const { value, display } = await coerceValue(field, input.value);
    resolved.push({ fieldId: field.id, fieldName: field.name, fieldType: field.type, value, display });
  }
  return resolved;
}

/** Build the `custom_fields` array for the create-task request body. */
export function buildCreateCustomFieldsBody(resolved: ResolvedCustomField[]): Array<{ id: string; value: unknown }> {
  return resolved.map((field) => ({ id: field.fieldId, value: field.value }));
}

export interface CustomFieldWriteResult {
  written: ResolvedCustomField[];
  warnings: string[];
}

/**
 * Write resolved fields onto an existing task, one API call per field.
 *
 * A failure on one field must not abort the others, so errors are collected as
 * warnings - the same pattern the tag/dependency updates already follow.
 */
export async function writeCustomFieldsToTask(
  taskId: string,
  resolved: ResolvedCustomField[]
): Promise<CustomFieldWriteResult> {
  const written: ResolvedCustomField[] = [];
  const warnings: string[] = [];
  for (const field of resolved) {
    try {
      const response = await fetch(`https://api.clickup.com/api/v2/task/${taskId}/field/${field.fieldId}`, {
        method: "POST",
        headers: {
          Authorization: CONFIG.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ value: field.value }),
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        warnings.push(`Failed to set "${field.fieldName}": ${response.status} ${response.statusText} ${JSON.stringify(errorData)}`);
        continue;
      }
      written.push(field);
    } catch (error) {
      warnings.push(`Error setting "${field.fieldName}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { written, warnings };
}

/** One-line confirmation of what was written, used in tool responses. */
export function formatResolvedCustomFields(resolved: ResolvedCustomField[]): string[] {
  return resolved.map((field) => `  - ${field.fieldName}: ${field.display}`);
}

/**
 * Render a task's current custom field value for the read tools.
 *
 * Task reads encode values differently from writes: drop_down comes back as an
 * `orderindex`, labels as option ids, users as objects. Resolve all of those
 * back to names using the field's `type_config`.
 */
export function formatCustomFieldReadValue(field: any): string | null {
  const value = field?.value;
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const options: ClickUpCustomFieldOption[] = field.type_config?.options || [];
  const optionName = (id: unknown): string => {
    const match = options.find((option) => String(option.id) === String(id));
    return match ? optionLabel(match) || String(id) : String(id);
  };

  if (field.type === "date") {
    const ms = Number(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : String(value);
  }

  if (field.type === "drop_down") {
    const match = options.find((option) => option.orderindex === value);
    return match ? optionLabel(match) || String(value) : String(value);
  }
  if (field.type === "labels") {
    const list = Array.isArray(value) ? value : [value];
    return list.map((entry) => (typeof entry === "object" && entry !== null ? (entry.name ?? entry.label ?? optionName(entry.id)) : optionName(entry))).join(", ");
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (entry && typeof entry === "object") {
          return entry.username || entry.name || entry.label || entry.email || JSON.stringify(entry);
        }
        return optionName(entry);
      })
      .join(", ");
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return String(object.username || object.name || object.label || JSON.stringify(value));
  }
  return String(value);
}

/** Human-readable catalog of a list's custom fields, used by getListCustomFields. */
export function describeCustomFields(listId: string, fields: ClickUpCustomField[]): string {
  const lines = [`Custom fields for list ${listId} (${fields.length} total):`];
  if (fields.length === 0) {
    lines.push("  (no custom fields defined on this list)");
    return lines.join("\n");
  }
  for (const field of fields) {
    const flags = [
      WRITABLE_TYPES.has(field.type) ? "writable" : READ_ONLY_TYPES.has(field.type) ? "read-only" : "unsupported",
      field.required ? "required" : null,
      field.hide_from_guests ? "hidden-from-guests" : null,
    ].filter(Boolean);
    lines.push(`  - ${field.name} [${field.type}] (id: ${field.id})${flags.length ? ` - ${flags.join(", ")}` : ""}`);
    const options = field.type_config?.options || [];
    if (options.length > 0) {
      lines.push(`      options: ${options.map((option) => `${optionLabel(option) || "(unnamed)"} [${option.id}]`).join(" | ")}`);
    }
  }
  lines.push("");
  lines.push("Pass `custom_fields: [{name, value}]` to createTask/updateTask. Values accept the option/user NAME or id; dates accept ISO strings; checkboxes accept true/false.");
  return lines.join("\n");
}
