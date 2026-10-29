import circuitSvg from "@/src/assets/previews/circuit.svg?raw";
import surfaceSvg from "@/src/assets/previews/surface.svg?raw";
import tikzcdSvg from "@/src/assets/previews/tikzcd.svg?raw";
import lactamSvg from "@/src/assets/previews/lactam.svg?raw";
import cageSvg from "@/src/assets/previews/cage.svg?raw";
import { TIKZ_EXAMPLES, type TikzExample } from "./examples";
import type { Bounds, Span } from "./types";

export type PreviewKind = NonNullable<TikzExample["preview"]>;

export interface PreviewSpec {
  exampleId: string;
  name: string;
  packageName: string;
  packageLabel: string;
  description: string;
  svg: string;
  widthCm: number;
  heightCm: number;
}

interface PreviewAsset {
  packageName: string;
  packageLabel: string;
  description: string;
  svg: string;
}

const PREVIEW_SCALE = 1.8;
const PT_TO_CM = 2.54 / 72;

const ASSETS: Record<PreviewKind, PreviewAsset> = {
  circuitikz: {
    packageName: "circuitikz",
    packageLabel: "电路宏包",
    description: "电流源、电阻、节点与支路标注",
    svg: circuitSvg,
  },
  pgfplots: {
    packageName: "pgfplots",
    packageLabel: "三维绘图",
    description: "18 × 18 采样曲面与 viridis 色图",
    svg: surfaceSvg,
  },
  "tikz-cd": {
    packageName: "tikz-cd",
    packageLabel: "交换图",
    description: "弯曲箭头、点线、交叉箭头与标签",
    svg: tikzcdSvg,
  },
  chemfig: {
    packageName: "chemfig",
    packageLabel: "化学结构",
    description: "β-内酰胺与含硫五元环骨架",
    svg: lactamSvg,
  },
  "chemfig-fragment": {
    packageName: "chemfig",
    packageLabel: "化学结构",
    description: "由 \\definesubmol 重复拼合的笼状分子",
    svg: cageSvg,
  },
};

function normalizeSvg(raw: string): string {
  const open = raw.match(/<svg\b[^>]*>/);
  if (!open) return raw;
  const attrs = open[0]
    .replace(/\s(width|height)=('[^']*'|"[^"]*")/g, "")
    .replace(/^<svg\b/, "")
    .replace(/\s*>$/, "");
  return `<svg${attrs} width="100%" height="100%" preserveAspectRatio="xMidYMid meet" aria-hidden="true">${raw.slice(open.index! + open[0].length)}`;
}

function svgSizePt(raw: string): { widthPt: number; heightPt: number } {
  const width = raw.match(/\bwidth='([\d.]+)pt'/)?.[1] ?? raw.match(/\bwidth="([\d.]+)pt"/)?.[1];
  const height = raw.match(/\bheight='([\d.]+)pt'/)?.[1] ?? raw.match(/\bheight="([\d.]+)pt"/)?.[1];
  return {
    widthPt: Number.parseFloat(width ?? "0") || 1,
    heightPt: Number.parseFloat(height ?? "0") || 1,
  };
}

const PREVIEWS = new Map<string, PreviewSpec>();
for (const example of TIKZ_EXAMPLES) {
  if (!example.preview) continue;
  const asset = ASSETS[example.preview];
  const size = svgSizePt(asset.svg);
  PREVIEWS.set(example.code.trim(), {
    exampleId: example.id,
    name: example.name,
    packageName: asset.packageName,
    packageLabel: asset.packageLabel,
    description: asset.description,
    svg: normalizeSvg(asset.svg),
    widthCm: size.widthPt * PT_TO_CM * PREVIEW_SCALE,
    heightCm: size.heightPt * PT_TO_CM * PREVIEW_SCALE,
  });
}

export function getExactPreview(source: string): PreviewSpec | null {
  return PREVIEWS.get(source.trim()) ?? null;
}

export function previewBounds(preview: PreviewSpec): Bounds {
  return {
    minX: -preview.widthCm / 2,
    minY: -preview.heightCm / 2,
    maxX: preview.widthCm / 2,
    maxY: preview.heightCm / 2,
  };
}

export function previewSourceAnchor(source: string): Span {
  const documentStart = source.indexOf("\\begin{document}");
  const searchFrom =
    documentStart >= 0 ? documentStart + "\\begin{document}".length : 0;
  const environment = /\\begin\s*\{[^}\n]+\}/g;
  environment.lastIndex = searchFrom;
  const match = environment.exec(source);
  if (match) {
    return { start: match.index, end: match.index + match[0].length };
  }
  const line = /[^\s][^\n]*/g;
  line.lastIndex = searchFrom;
  const fallback = line.exec(source);
  if (!fallback) return { start: 0, end: 0 };
  const token = fallback[0].match(/^\S+/)?.[0] ?? fallback[0];
  return {
    start: fallback.index,
    end: fallback.index + Math.min(token.length, 48),
  };
}
