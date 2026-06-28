const VALID_TAG_PATTERN = /^[a-z0-9_/-]+$/;

function splitTagString(raw: string): string[] {
  const value = String(raw || "").trim();
  if (!value) return [];

  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => part.trim()).filter(Boolean);
  }

  if (value.includes("\n")) {
    const tokens: string[] = [];
    for (const line of value.split(/\r?\n/)) {
      const listMatch = line.match(/^\s*-\s*(.+)$/);
      if (listMatch) {
        tokens.push(listMatch[1]);
        continue;
      }
      const trimmed = line.trim();
      if (trimmed) {
        tokens.push(trimmed);
      }
    }
    return tokens;
  }

  if (value.includes(",")) {
    return value.split(",").map((part) => part.trim()).filter(Boolean);
  }

  const hashMatches = Array.from(value.matchAll(/#([a-zA-Z0-9_/-]+)/g))
    .map((match) => match[1])
    .filter(Boolean);
  if (hashMatches.length > 0) {
    return hashMatches;
  }

  return value.split(/\s+/).filter(Boolean);
}

function splitRawTagInput(raw: any): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.flatMap((value) => splitRawTagInput(value)).filter(Boolean);
  }
  if (typeof raw === "string") {
    return splitTagString(raw);
  }
  return splitTagString(String(raw));
}

function normalizeTagToken(raw: string): string {
  let value = String(raw || "").trim();
  if (!value) return "";

  value = value.replace(/^#+/, "");
  value = value.replace(/^[\[\]`"'(){}]+|[\[\]`"'(){}]+$/g, "");
  value = value.replace(/[.,;:!?]+$/g, "");
  value = value.replace(/\\/g, "/");
  value = value.replace(/\s+/g, "");
  value = value.replace(/\/{2,}/g, "/");
  value = value.replace(/^\/+|\/+$/g, "");
  value = value.trim().toLowerCase();
  if (!value) return "";
  if (!VALID_TAG_PATTERN.test(value)) return "";
  return value;
}

function stripIncrementalTagFragments(tags: string[]): string[] {
  if (tags.length < 4) return tags;
  const unique = Array.from(new Set(tags));
  const tagSet = new Set(unique);
  const toDrop = new Set<string>();

  const longestFirst = [...unique].sort((a, b) => b.length - a.length || a.localeCompare(b));
  for (const longest of longestFirst) {
    if (longest.length < 4) continue;

    const chain: string[] = [];
    for (let length = 1; length <= longest.length; length += 1) {
      const prefix = longest.slice(0, length);
      if (tagSet.has(prefix)) {
        chain.push(prefix);
      }
    }

    if (chain.length < 4) continue;
    const isConsecutive = chain.every((token, index) => token.length === index + 1);
    if (!isConsecutive) continue;
    if (chain[0].length !== 1) continue;

    if (longest.length <= 6) {
      chain.forEach((token) => toDrop.add(token));
    } else {
      chain.slice(0, -1).forEach((token) => toDrop.add(token));
    }
  }

  if (!toDrop.size) return unique;
  return unique.filter((token) => !toDrop.has(token));
}

export function normalizeTagValue(value: string | null | undefined): string {
  if (typeof value !== "string") return "";
  return normalizeTagToken(value);
}

export function parseTagInput(raw: any): string[] {
  const normalizedTokens = splitRawTagInput(raw)
    .map((token) => normalizeTagToken(String(token)))
    .filter(Boolean);
  const uniqueTokens = Array.from(new Set(normalizedTokens));
  return stripIncrementalTagFragments(uniqueTokens);
}

export function mergeTagInputs(existing: any, incoming: any): string[] {
  return Array.from(new Set([...parseTagInput(existing), ...parseTagInput(incoming)]));
}
