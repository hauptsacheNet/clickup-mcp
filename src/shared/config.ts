export const rawPrimaryLang = process.env.CLICKUP_PRIMARY_LANGUAGE || process.env.LANG;
let detectedLanguageHint: string | undefined = undefined;

/**
 * Enhanced language detection that handles various formats and common language names
 */
function detectLanguage(rawLang: string): string | undefined {
  if (!rawLang) return undefined;
  
  const normalizedLang = rawLang.toLowerCase().trim();
  
  // German language detection
  if (normalizedLang === 'de' || normalizedLang === 'german' || normalizedLang === 'deutsch' || normalizedLang.startsWith('de_') || normalizedLang.startsWith('de-')) {
    return 'de';
  }
  
  // English language detection
  if (normalizedLang === 'en' || normalizedLang === 'english' || normalizedLang.startsWith('en_') || normalizedLang.startsWith('en-')) {
    return 'en';
  }
  
  // French language detection
  if (normalizedLang === 'fr' || normalizedLang === 'french' || normalizedLang === 'français' || normalizedLang.startsWith('fr_') || normalizedLang.startsWith('fr-')) {
    return 'fr';
  }
  
  // Spanish language detection
  if (normalizedLang === 'es' || normalizedLang === 'spanish' || normalizedLang === 'español' || normalizedLang.startsWith('es_') || normalizedLang.startsWith('es-')) {
    return 'es';
  }
  
  // Italian language detection
  if (normalizedLang === 'it' || normalizedLang === 'italian' || normalizedLang === 'italiano' || normalizedLang.startsWith('it_') || normalizedLang.startsWith('it-')) {
    return 'it';
  }
  
  // Fallback: extract the primary language part (e.g., 'en' from 'en_US.UTF-8' or 'en-GB')
  const langPart = normalizedLang.match(/^[a-zA-Z]{2,3}/);
  if (langPart) {
    return langPart[0].toLowerCase();
  }
  
  return undefined;
}

if (rawPrimaryLang) {
  detectedLanguageHint = detectLanguage(rawPrimaryLang);
}

// MCP Mode configuration
export type McpMode = 'read-minimal' | 'read' | 'write';
const rawMode = process.env.CLICKUP_MCP_MODE?.toLowerCase();
let mcpMode: McpMode = 'write'; // Default to write (full functionality)

if (rawMode === 'read-minimal' || rawMode === 'read') {
  mcpMode = rawMode;
} else if (rawMode && rawMode !== 'write') {
  console.error(`Invalid CLICKUP_MCP_MODE "${rawMode}". Using default "write". Valid options: read-minimal, read, write`);
}

/**
 * The edit window is a safety limit, so a typo must not silently widen it:
 * `parseFloat("Infinity")` would disable the age check altogether, and
 * `parseFloat("abc")` would quietly turn editing off.
 */
function parseCommentEditWindowHours(raw: string | undefined): number {
  if (!raw?.trim()) {
    return 24;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `Invalid CLICKUP_COMMENT_EDIT_WINDOW_HOURS "${raw}". Expected a non-negative number of hours (0 disables editComment).`
    );
  }
  return value;
}

export const CONFIG = {
  apiKey: process.env.CLICKUP_API_KEY!,
  teamId: process.env.CLICKUP_TEAM_ID!,
  maxImages: process.env.MAX_IMAGES ? parseInt(process.env.MAX_IMAGES) : 4,
  maxResponseSizeMB: process.env.MAX_RESPONSE_SIZE_MB ? parseFloat(process.env.MAX_RESPONSE_SIZE_MB) : 1,
  // Upper bound for a single image uploaded to ClickUp. Unlike maxResponseSizeMB this is
  // not about context window budget - it only guards against accidentally pushing huge
  // files into a ticket.
  maxUploadSizeMB: process.env.MAX_UPLOAD_SIZE_MB ? parseFloat(process.env.MAX_UPLOAD_SIZE_MB) : 10,
  // How long after creation a comment may still be edited. ClickUp has no way to tell
  // "written by this MCP" apart from "written by the token owner in the UI", so this
  // window is the actual guard against rewriting history. 0 disables editing entirely.
  commentEditWindowHours: parseCommentEditWindowHours(process.env.CLICKUP_COMMENT_EDIT_WINDOW_HOURS),
  primaryLanguageHint: detectedLanguageHint, // Store the cleaned code directly
  mode: mcpMode,
};

if (!CONFIG.apiKey || !CONFIG.teamId) {
  throw new Error("Missing Clickup API key or team ID");
}