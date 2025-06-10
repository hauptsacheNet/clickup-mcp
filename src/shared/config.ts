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

export const CONFIG = {
  apiKey: process.env.CLICKUP_API_KEY!,
  teamId: process.env.CLICKUP_TEAM_ID!,
  maxImages: process.env.MAX_IMAGES ? parseInt(process.env.MAX_IMAGES) : 4,
  primaryLanguageHint: detectedLanguageHint, // Store the cleaned code directly
};

if (!CONFIG.apiKey || !CONFIG.teamId) {
  throw new Error("Missing Clickup API key or team ID");
}