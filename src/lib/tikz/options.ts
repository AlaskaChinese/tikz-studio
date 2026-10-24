import type { ParsedOption } from "./types";

export const PX_PER_CM = 48;
export const DEFAULT_FONT_PX = 15;
export const DEFAULT_INNER_SEP_CM = 0.11;

export interface RawOptionToken extends ParsedOption {
  start: number;
  end: number;
  keyStart: number;
  keyEnd: number;
  valueStart?: number;
  valueEnd?: number;
}

export interface StyleDefinition {
  tokens: ParsedOption[];
  mode: "set" | "append" | "prefix";
}

export type StyleMap = Map<string, StyleDefinition>;

export function maskComments(source: string): string {
  const result = source.split("");
  let inComment = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "\n") {
      inComment = false;
      continue;
    }
    if (inComment) {
      result[index] = " ";
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "%") {
      inComment = true;
      result[index] = " ";
    }
  }
  return result.join("");
}

export function skipWhitespace(source: string, start: number, end = source.length): number {
  let index = start;
  while (index < end && /\s/.test(source[index])) index += 1;
  return index;
}

export function findBalanced(
  source: string,
  start: number,
  open: string,
  close: string,
  end = source.length,
): number {
  if (source[start] !== open) return -1;
  let depth = 0;
  for (let index = start; index < end; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

export function splitTopLevel(
  source: string,
  start: number,
  end: number,
  separator: string,
): Array<{ text: string; start: number; end: number }> {
  const parts: Array<{ text: string; start: number; end: number }> = [];
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let partStart = start;

  for (let index = start; index < end; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (
      char === separator &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenDepth === 0
    ) {
      parts.push({ text: source.slice(partStart, index), start: partStart, end: index });
      partStart = index + 1;
    }
  }
  parts.push({ text: source.slice(partStart, end), start: partStart, end });

  return parts.filter((part) => part.text.trim().length > 0);
}

function findTopLevelEquals(text: string): number {
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth -= 1;
    else if (char === "=" && braceDepth === 0 && bracketDepth === 0) return index;
  }
  return -1;
}

export function parseOptionTokens(source: string, start: number, end: number): RawOptionToken[] {
  const chunks = splitTopLevel(source, start, end, ",");
  const result: RawOptionToken[] = [];

  for (const chunk of chunks) {
    const leading = chunk.text.length - chunk.text.trimStart().length;
    const trailing = chunk.text.length - chunk.text.trimEnd().length;
    const tokenStart = chunk.start + leading;
    const tokenEnd = chunk.end - trailing;
    const raw = source.slice(tokenStart, tokenEnd);
    if (!raw) continue;

    const equals = findTopLevelEquals(raw);
    if (equals < 0) {
      result.push({
        key: raw.trim(),
        raw,
        start: tokenStart,
        end: tokenEnd,
        keyStart: tokenStart,
        keyEnd: tokenEnd,
      });
      continue;
    }

    const keyRaw = raw.slice(0, equals);
    const valueRaw = raw.slice(equals + 1);
    const keyLeading = keyRaw.length - keyRaw.trimStart().length;
    const valueLeading = valueRaw.length - valueRaw.trimStart().length;
    const valueTrailing = valueRaw.length - valueRaw.trimEnd().length;
    const keyStart = tokenStart + keyLeading;
    const keyEnd = tokenStart + equals;
    const valueStart = tokenStart + equals + 1 + valueLeading;
    const valueEnd = tokenEnd - valueTrailing;

    result.push({
      key: source.slice(keyStart, keyEnd).trim(),
      value: source.slice(valueStart, valueEnd),
      raw,
      start: tokenStart,
      end: tokenEnd,
      keyStart,
      keyEnd,
      valueStart,
      valueEnd,
    });
  }

  return result;
}

export function tokensFromOptionString(raw: string): ParsedOption[] {
  return parseOptionTokens(raw, 0, raw.length).map((token) => ({
    key: token.key,
    value: token.value,
    raw: token.raw,
  }));
}

export function readBalancedContent(
  source: string,
  openIndex: number,
  open = "{",
  close = "}",
): { start: number; end: number; innerStart: number; innerEnd: number } | null {
  const closeIndex = findBalanced(source, openIndex, open, close);
  if (closeIndex < 0) return null;
  return {
    start: openIndex,
    end: closeIndex + 1,
    innerStart: openIndex + 1,
    innerEnd: closeIndex,
  };
}

export function evaluateExpression(input: string): number | null {
  const text = input.trim();
  if (!text) return null;

  let index = 0;

  function skipSpace() {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  }

  function parseUnit(raw: string): number {
    const match = raw.match(/^(-?\d*\.?\d+)([a-zA-Z]+)?$/);
    if (!match) return Number.NaN;
    const value = Number.parseFloat(match[1]);
    const unit = (match[2] ?? "cm").toLowerCase();
    switch (unit) {
      case "cm":
        return value;
      case "mm":
        return value / 10;
      case "in":
        return value * 2.54;
      case "pt":
        return value / 28.3464567;
      case "bp":
        return value / 28.4527559;
      case "pc":
        return (value * 12) / 28.3464567;
      case "em":
        return (value * DEFAULT_FONT_PX) / PX_PER_CM;
      case "ex":
        return (value * DEFAULT_FONT_PX * 0.5) / PX_PER_CM;
      case "px":
        return value / PX_PER_CM;
      default:
        return Number.NaN;
    }
  }

  function parsePrimary(): number {
    skipSpace();
    if (text[index] === "(") {
      index += 1;
      const value = parseAdditive();
      skipSpace();
      if (text[index] === ")") index += 1;
      return value;
    }
    if (text[index] === "-") {
      index += 1;
      return -parsePrimary();
    }
    if (text[index] === "+") {
      index += 1;
      return parsePrimary();
    }
    const match = text.slice(index).match(/^(\d*\.?\d+)([a-zA-Z]+)?/);
    if (!match) return Number.NaN;
    index += match[0].length;
    return parseUnit(match[0]);
  }

  function parseMultiplicative(): number {
    let value = parsePrimary();
    while (Number.isFinite(value)) {
      skipSpace();
      const op = text[index];
      if (op !== "*" && op !== "/") break;
      index += 1;
      const right = parsePrimary();
      if (!Number.isFinite(right)) return Number.NaN;
      value = op === "*" ? value * right : value / right;
    }
    return value;
  }

  function parseAdditive(): number {
    let value = parseMultiplicative();
    while (Number.isFinite(value)) {
      skipSpace();
      const op = text[index];
      if (op !== "+" && op !== "-") break;
      index += 1;
      const right = parseMultiplicative();
      if (!Number.isFinite(right)) return Number.NaN;
      value = op === "+" ? value + right : value - right;
    }
    return value;
  }

  const result = parseAdditive();
  skipSpace();
  return Number.isFinite(result) && index === text.length ? result : null;
}

export function parseDimension(value: string | undefined, fallback?: number): number | undefined {
  if (value == null) return fallback;
  const cleaned = value.replace(/^\{|\}$/g, "").trim();
  const result = evaluateExpression(cleaned);
  return result == null ? fallback : result;
}

export function parseFontSize(tokens: ParsedOption[], fallback = DEFAULT_FONT_PX): number {
  const sizes: Record<string, number> = {
    tiny: 9,
    scriptsize: 11,
    footnotesize: 12,
    small: 13,
    normalsize: 15,
    large: 17.5,
    Large: 20.5,
    LARGE: 23.5,
    huge: 27,
    Huge: 31,
  };

  const fontToken = tokens.find((token) => token.key === "font");
  const raw = fontToken?.value ?? "";
  const sizeMatch = raw.match(/\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b/);
  if (sizeMatch) return sizes[sizeMatch[1]] ?? fallback;

  const explicit = raw.match(/\\fontsize\s*\{([\d.]+)\s*(?:pt)?\}/);
  if (explicit) {
    const points = Number.parseFloat(explicit[1]);
    if (Number.isFinite(points)) return (points * 96) / 72;
  }

  const scale = parseFloatOption(tokens, "font size", NaN);
  if (Number.isFinite(scale)) return scale;

  return fallback;
}

export function parseFloatOption(
  tokens: ParsedOption[],
  key: string,
  fallback: number,
): number {
  const token = [...tokens].reverse().find((item) => item.key === key);
  if (!token?.value) return fallback;
  const value = Number.parseFloat(token.value);
  return Number.isFinite(value) ? value : fallback;
}

export function collectStyleDefinitions(
  source: string,
  extraOptionStrings: string[] = [],
): StyleMap {
  const styles: StyleMap = new Map();

  function addDefinition(token: ParsedOption) {
    const suffixMatch = token.key.match(/^(.*)\/\.(append|prefix)\s+style$/);
    const directMatch = token.key.match(/^(.*)\/\.style$/);
    if (!suffixMatch && !directMatch) return;
    if (!token.value) return;
    if (token.value.includes("#1")) return;
    const name = (suffixMatch?.[1] ?? directMatch?.[1] ?? "").trim();
    if (!name) return;
    const tokens = tokensFromOptionString(token.value.replace(/^\{|\}$/g, ""));
    const mode = (suffixMatch?.[2] as "append" | "prefix" | undefined) ?? "set";
    const existing = styles.get(name);
    if (existing && mode === "append") {
      existing.tokens = [...existing.tokens, ...tokens];
      return;
    }
    if (existing && mode === "prefix") {
      existing.tokens = [...tokens, ...existing.tokens];
      return;
    }
    styles.set(name, { tokens, mode: "set" });
  }

  for (const extra of extraOptionStrings) {
    for (const token of tokensFromOptionString(extra)) addDefinition(token);
  }

  const masked = maskComments(source);
  const tikzsetPattern = /\\tikzset\s*\{/g;
  for (const match of masked.matchAll(tikzsetPattern)) {
    const openIndex = (match.index ?? 0) + match[0].length - 1;
    const group = readBalancedContent(masked, openIndex);
    if (!group) continue;
    const tokens = parseOptionTokens(masked, group.innerStart, group.innerEnd);
    for (const token of tokens) addDefinition(token);
  }

  const tikzstylePattern = /\\tikzstyle\s*\{([^{}]+)\}\s*=\s*\[([^\]]*)\]/g;
  for (const match of masked.matchAll(tikzstylePattern)) {
    styles.set(match[1].trim(), {
      tokens: tokensFromOptionString(match[2]),
      mode: "set",
    });
  }

  return styles;
}

export function expandStyleTokens(
  tokens: ParsedOption[],
  styles: StyleMap,
  visited: Set<string> = new Set(),
  depth = 0,
): ParsedOption[] {
  if (depth > 12) return tokens;
  const expanded: ParsedOption[] = [];

  for (const token of tokens) {
    const styleName = token.key.trim();
    const isStyleDefinition = /\/\.(?:append|prefix)?\s*style$/.test(styleName);
    if (!isStyleDefinition && !token.value && styles.has(styleName)) {
      if (visited.has(styleName)) continue;
      const nextVisited = new Set(visited);
      nextVisited.add(styleName);
      const definition = styles.get(styleName);
      if (definition) {
        expanded.push(
          ...expandStyleTokens(definition.tokens, styles, nextVisited, depth + 1),
        );
      }
      continue;
    }
    if (!isStyleDefinition) expanded.push(token);
  }

  return expanded;
}

export function styleTokens(styles: StyleMap, name: string): ParsedOption[] {
  return styles.get(name)?.tokens ?? [];
}

export function parseArrowPair(value: string | undefined): {
  start: boolean;
  end: boolean;
} | null {
  if (!value) return null;
  const compact = value.replace(/\s+/g, "");
  if (!compact || compact === "-|" || compact === "|-") return null;
  if (
    /^(?:shorten|draw|fill|linewidth|bend|opacity|text|font|pos|label|inner|minimum|rounded|dash|looseness|out|in|anchor|align|scale|rotate|shift|xshift|yshift|node|transform|color)/i.test(
      compact,
    )
  ) {
    return null;
  }

  let start = false;
  let end = false;

  if (compact.startsWith("<") && !compact.startsWith("<=")) start = true;
  if (compact.endsWith(">") && !compact.startsWith(">=")) end = true;
  if (compact.startsWith("-") && compact.length > 1) end = true;
  if (compact.endsWith("-") && compact.length > 1) start = true;
  if (/^\{[\s\S]+\}-$/.test(compact)) start = true;
  if (/^-\{[\s\S]+\}$/.test(compact)) end = true;

  return start || end ? { start, end } : null;
}

export function stripOuterBraces(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    let depth = 0;
    for (let index = 0; index < trimmed.length; index += 1) {
      if (trimmed[index] === "\\") {
        index += 1;
        continue;
      }
      if (trimmed[index] === "{") depth += 1;
      if (trimmed[index] === "}") {
        depth -= 1;
        if (depth === 0 && index < trimmed.length - 1) return trimmed;
      }
    }
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}
