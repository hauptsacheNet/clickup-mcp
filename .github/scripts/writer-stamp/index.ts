const MACHINE_LINE = /^<!-- writer-stamp v1 ([^\r\n]*?) -->$/m;
const UNKNOWN = "unknown";
export const REQUIRED_FIELDS = ["provider", "model", "effort", "executor", "profile"] as const;
const HANDOVER_GROUPS = ["handed", "fixed"] as const;
const HANDOVER_FIELDS = ["provider", "model", "effort", "executor"] as const;

// Reads the machine line of a writer stamp; null when the body has none or it does not decode.
export function parseStamp(body: string): Map<string, string> | null {
  const match = MACHINE_LINE.exec(body);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const pair of match[1]!.split(" ")) {
    const equal = pair.indexOf("=");
    if (equal < 1) continue;
    try { fields.set(pair.slice(0, equal), decodeURIComponent(pair.slice(equal + 1)).trim()); }
    catch { return null; }
  }
  return fields;
}

// Null when the stamp names its writer in full, else the reason the check fails.
export function stampProblem(body: string): string | null {
  const fields = parseStamp(body);
  if (!fields) return "missing writer stamp; a plain \"written by\" line is not a stamp";
  const known = (key: string) => !!fields.get(key) && fields.get(key) !== UNKNOWN;
  const missing: string[] = REQUIRED_FIELDS.filter((key) => !known(key));
  for (const group of HANDOVER_GROUPS) {
    if (HANDOVER_FIELDS.some((key) => fields.has(`${group}_${key}`))) missing.push(...HANDOVER_FIELDS.map((key) => `${group}_${key}`).filter((key) => !known(key)));
  }
  return missing.length ? `incomplete writer stamp; missing ${missing.join(", ")}` : null;
}

export function stampSummary(body: string): string {
  const fields = parseStamp(body);
  return fields ? `${fields.get("model")} / ${fields.get("effort")} / ${fields.get("executor")}` : "";
}
