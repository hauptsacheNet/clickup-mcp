export interface ParsedDataUri {
  mimeType: string;
  base64Data: string;
}

/**
 * Parse data URI strings of the form data:mime/type;base64,....
 * Returns null if the value is not a base64 data URI.
 */
export function parseDataUri(dataUri: string): ParsedDataUri | null {
  if (!dataUri.startsWith("data:")) {
    return null;
  }

  const match = dataUri.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) {
    return null;
  }

  const [, mimeType, base64Part] = match;
  const sanitizedBase64 = base64Part.replace(/\s+/g, "");
  if (!sanitizedBase64) {
    return null;
  }

  return {
    mimeType,
    base64Data: sanitizedBase64,
  };
}

/**
 * Estimate the decoded byte-size of base64 data without allocating buffers
 */
export function estimateBase64Size(base64Data: string): number {
  const sanitized = base64Data.replace(/\s+/g, "");
  const padding = sanitized.endsWith("==") ? 2 : sanitized.endsWith("=") ? 1 : 0;
  return Math.max(0, (sanitized.length * 3) / 4 - padding);
}
