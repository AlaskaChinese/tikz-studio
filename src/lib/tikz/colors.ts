const BASE_COLORS: Record<string, string> = {
  black: "#171a17",
  white: "#fffdf8",
  gray: "#8b8b83",
  grey: "#8b8b83",
  darkgray: "#555a53",
  darkgrey: "#555a53",
  lightgray: "#d8d4c9",
  lightgrey: "#d8d4c9",
  red: "#c84030",
  green: "#3f7a55",
  blue: "#3a5f92",
  cyan: "#2f7f8b",
  magenta: "#a94a88",
  yellow: "#d6a927",
  orange: "#d76a32",
  purple: "#715596",
  brown: "#806044",
  lime: "#81993a",
  olive: "#6c713a",
  teal: "#2c7370",
  violet: "#8456a3",
  pink: "#ce7d98",
};

export type ColorDefinitions = Record<string, string>;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function parseHex(value: string): Rgb | null {
  let hex = value.trim();
  if (!hex.startsWith("#")) hex = `#${hex}`;
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return null;
  if (hex.length === 4) {
    hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function toHex(rgb: Rgb): string {
  const part = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

function mix(first: Rgb, second: Rgb, firstPercent: number): Rgb {
  const p = Math.max(0, Math.min(100, firstPercent)) / 100;
  return {
    r: first.r * p + second.r * (1 - p),
    g: first.g * p + second.g * (1 - p),
    b: first.b * p + second.b * (1 - p),
  };
}

const WHITE: Rgb = { r: 255, g: 253, b: 248 };

export function baseColorName(hex: string): string | null {
  const parsed = parseHex(hex);
  if (!parsed) return null;
  const normalized = toHex(parsed);
  for (const [name, value] of Object.entries(BASE_COLORS)) {
    if (value.toLowerCase() === normalized.toLowerCase()) return name;
  }
  return null;
}

function resolveDefinition(value: string, definitions: ColorDefinitions, seen: Set<string>): Rgb | null {
  const name = value.trim();
  if (!name || seen.has(name)) return null;
  seen.add(name);

  const custom = definitions[name];
  if (custom) return resolveDefinition(custom, definitions, seen);

  const base = BASE_COLORS[name.toLowerCase()];
  if (base) return parseHex(base);

  const hex = parseHex(name);
  if (hex) return hex;

  return null;
}

export function resolveTikzColor(
  spec: string | undefined,
  definitions: ColorDefinitions,
  fallback: string | null = null,
): string | null {
  if (spec == null) return fallback;
  let value = spec.trim();
  if (!value || value === "none") return fallback;
  if (value.startsWith("{") && value.endsWith("}")) {
    value = value.slice(1, -1).trim();
  }
  if (!value) return fallback;

  if (!value.includes("!")) {
    const resolved = resolveDefinition(value, definitions, new Set());
    return resolved ? toHex(resolved) : fallback;
  }

  const parts = value.split("!").map((part) => part.trim());
  let current = resolveDefinition(parts[0] ?? "", definitions, new Set());
  if (!current) return fallback;

  let index = 1;
  while (index < parts.length) {
    const percent = Number.parseFloat(parts[index] ?? "");
    if (!Number.isFinite(percent)) break;
    const nextPart = parts[index + 1];
    const hasColorTarget = Boolean(nextPart && !Number.isFinite(Number.parseFloat(nextPart)));
    const target = hasColorTarget
      ? resolveDefinition(nextPart as string, definitions, new Set())
      : WHITE;
    if (!target) break;
    current = mix(target, current, 100 - percent);
    index += hasColorTarget ? 2 : 1;
  }

  return toHex(current);
}

export function parseColorDefinitions(source: string): ColorDefinitions {
  const definitions: ColorDefinitions = {};
  const defineColorPattern =
    /\\definecolor\s*\{([^{}]+)\}\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g;

  for (const match of source.matchAll(defineColorPattern)) {
    const [, name, model, rawValue] = match;
    const trimmedModel = model.trim();
    const normalizedModel = trimmedModel.toLowerCase();
    const normalizedName = name.trim();
    if (!normalizedName) continue;

    if (normalizedModel === "rgb") {
      const values = rawValue.split(",").map((part) => Number.parseFloat(part.trim()));
      if (values.length >= 3 && values.every(Number.isFinite)) {
        const scale = trimmedModel === "RGB" ? 1 : 255;
        definitions[normalizedName] = toHex({
          r: values[0] * scale,
          g: values[1] * scale,
          b: values[2] * scale,
        });
      }
    } else if (normalizedModel === "gray") {
      const value = Number.parseFloat(rawValue.trim());
      if (Number.isFinite(value)) {
        const normalized = trimmedModel === "Gray" ? value : value * 255;
        definitions[normalizedName] = toHex({
          r: normalized,
          g: normalized,
          b: normalized,
        });
      }
    } else if (normalizedModel === "cmyk") {
      const values = rawValue.split(",").map((part) => Number.parseFloat(part.trim()));
      if (values.length >= 4 && values.every(Number.isFinite)) {
        const [c, m, y, k] = values;
        definitions[normalizedName] = toHex({
          r: 255 * (1 - Math.min(1, c + k)),
          g: 255 * (1 - Math.min(1, m + k)),
          b: 255 * (1 - Math.min(1, y + k)),
        });
      }
    } else if (normalizedModel === "html") {
      const hex = parseHex(rawValue.trim());
      if (hex) definitions[normalizedName] = toHex(hex);
    }
  }

  const colorletPattern = /\\colorlet\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g;
  for (const match of source.matchAll(colorletPattern)) {
    definitions[match[1].trim()] = match[2].trim();
  }

  return definitions;
}
