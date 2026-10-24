import { DEFAULT_FONT_PX } from "./options";

const sansFont =
  '"Segoe UI Variable Text", "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';

let measurementCanvas: HTMLCanvasElement | null = null;

function getContext(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (!measurementCanvas) measurementCanvas = document.createElement("canvas");
  return measurementCanvas.getContext("2d");
}

const greekMap: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  theta: "θ",
  lambda: "λ",
  mu: "μ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  phi: "φ",
  omega: "ω",
  Delta: "Δ",
  Gamma: "Γ",
  Lambda: "Λ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Omega: "Ω",
};

export function splitTextLines(text: string): string[] {
  const normalized = text.replace(/\\\\\s*\[[^\]]*\]/g, "\\\\");
  return normalized.split(/\\\\|\n/);
}

export function latexToPlain(raw: string): string {
  let output = raw;
  output = output.replace(/\\text(?:bf|it|sf|tt|rm|normal)?\s*\{/g, "");
  output = output.replace(/\\(?:emph|underline)\s*\{/g, "");
  output = output.replace(/\\(?:alpha|beta|gamma|delta|epsilon|theta|lambda|mu|pi|rho|sigma|tau|phi|omega|Delta|Gamma|Lambda|Pi|Sigma|Phi|Omega)\b/g, (match) =>
    greekMap[match.slice(1)] ?? match,
  );
  output = output.replace(/\\(?:quad|qquad|enspace|thinspace)(?![a-zA-Z])/g, " ");
  output = output.replace(/\\[,;:!]/g, " ");
  output = output.replace(/\\(?:ldots|dots)\b/g, "…");
  output = output.replace(/\\([%&#_{}$])/g, "$1");
  output = output.replace(/\\[a-zA-Z]+\s*/g, "");
  output = output.replace(/\$/g, "");
  output = output.replace(/[{}]/g, "");
  output = output.replace(/~/g, " ");
  return output;
}

export interface TextMetrics {
  widthPx: number;
  heightPx: number;
  lineCount: number;
  lines: string[];
}

export function measureTikzText(
  raw: string,
  fontSizePx = DEFAULT_FONT_PX,
  lineHeight = 1.3,
): TextMetrics {
  const rawLines = splitTextLines(raw);
  const lines = rawLines.map((line) => latexToPlain(line));
  const context = getContext();
  const fontSpec = `500 ${fontSizePx}px ${sansFont}`;
  if (context) context.font = fontSpec;

  let width = 0;
  for (const line of lines) {
    const measured = context ? context.measureText(line).width : line.length * fontSizePx * 0.56;
    width = Math.max(width, measured);
  }

  return {
    widthPx: Math.max(width, fontSizePx * 0.8),
    heightPx: Math.max(lines.length, 1) * fontSizePx * lineHeight,
    lineCount: Math.max(lines.length, 1),
    lines,
  };
}
