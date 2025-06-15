export const rawPrimaryLang = process.env.CLICKUP_PRIMARY_LANGUAGE || process.env.LANG;
let detectedLanguageHint: string | undefined = undefined;

if (rawPrimaryLang) {
  // Extract the primary language part (e.g., 'en' from 'en_US.UTF-8' or 'en-GB')
  // and convert to lowercase.
  const langPart = rawPrimaryLang.match(/^[a-zA-Z]{2,3}/);
  if (langPart) {
    detectedLanguageHint = langPart[0].toLowerCase();
  }
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

export const CONFIG = {
  apiKey: process.env.CLICKUP_API_KEY!,
  teamId: process.env.CLICKUP_TEAM_ID!,
  maxImages: process.env.MAX_IMAGES ? parseInt(process.env.MAX_IMAGES) : 4,
  primaryLanguageHint: detectedLanguageHint, // Store the cleaned code directly
  mode: mcpMode,
};

if (!CONFIG.apiKey || !CONFIG.teamId) {
  throw new Error("Missing Clickup API key or team ID");
}