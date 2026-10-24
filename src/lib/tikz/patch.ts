import type { Bounds, Point, Span, TikzFrame, TikzLabel, TikzNode } from "./types";
import { parseOptionTokens } from "./options";
import { parseTikz } from "./parser";

export interface SourceEdit {
  start: number;
  end: number;
  text: string;
}

export interface SelectionEditObjects {
  nodes: TikzNode[];
  labels: TikzLabel[];
  frames: TikzFrame[];
}

export function applySourceEdits(source: string, replacements: SourceEdit[]): string {
  const valid = replacements
    .filter((replacement) => replacement.start >= 0 && replacement.end >= replacement.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  let result = "";
  let cursor = 0;
  for (const replacement of valid) {
    if (replacement.start < cursor) continue;
    result += source.slice(cursor, replacement.start);
    result += replacement.text;
    cursor = replacement.end;
  }
  result += source.slice(cursor);
  return result;
}

export function formatTikzNumber(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  if (Math.abs(rounded) < 0.0005) return "0";
  return String(rounded);
}

function insertionPoint(source: string, node: TikzNode): number {
  if (node.contentOpen < node.commandSpan.end) return node.contentOpen;
  const semicolon = source.lastIndexOf(";", node.commandSpan.end);
  return semicolon >= node.commandSpan.start ? semicolon : node.commandSpan.end;
}

function isRelativeOption(key: string, value: string | undefined): boolean {
  const normalized = key.trim().replace(/\s+/g, " ");
  const directional =
    /^(above|below|left|right)(?:\s+(above|below|left|right))?$/.test(normalized);
  if (directional && /\bof\b/.test(value ?? "")) return true;
  return /^(above|below|left|right)(?:\s+(above|below|left|right))?\s+of$/.test(normalized);
}

function isSizeOption(key: string): boolean {
  const normalized = key.trim();
  return (
    normalized === "minimum width" ||
    normalized === "minimum height" ||
    normalized === "minimum size"
  );
}

interface NodeGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Rewrites a node into an absolute position and explicit size. Only the
 * option blocks and the `at (...)` coordinate are touched, so surrounding
 * comments, formatting and other node options survive.
 */
function nodeGeometryEdits(
  source: string,
  node: TikzNode,
  geometry: NodeGeometry,
): SourceEdit[] {
  const replacements: SourceEdit[] = [];
  const sizeText = `minimum width=${formatTikzNumber(Math.max(0.3, geometry.width))}cm, minimum height=${formatTikzNumber(Math.max(0.3, geometry.height))}cm`;
  let sizeWritten = false;

  for (let index = 0; index < node.optionBlocks.length; index += 1) {
    const block = node.optionBlocks[index];
    const tokens = parseOptionTokens(source, block.start, block.end);
    const kept = tokens.filter(
      (token) => !isRelativeOption(token.key, token.value) && !isSizeOption(token.key),
    );
    const isLast = index === node.optionBlocks.length - 1;
    if (kept.length === tokens.length && !isLast) continue;
    const parts = kept.map((token) => token.raw.trim()).filter(Boolean);
    if (isLast) parts.push(sizeText);
    if (isLast) sizeWritten = true;
    replacements.push({
      start: block.start,
      end: block.end,
      text: parts.join(", "),
    });
  }

  const coordinate = `${formatTikzNumber(geometry.x)}, ${formatTikzNumber(geometry.y)}`;
  if (node.atInnerSpan) {
    replacements.push({
      start: node.atInnerSpan.start,
      end: node.atInnerSpan.end,
      text: coordinate,
    });
  } else {
    const point = insertionPoint(source, node);
    replacements.push({
      start: point,
      end: point,
      text: ` at (${coordinate}) `,
    });
  }

  if (!sizeWritten) {
    const point = node.commandNameEnd < insertionPoint(source, node)
      ? node.commandNameEnd
      : insertionPoint(source, node);
    replacements.push({
      start: point,
      end: point,
      text: ` [${sizeText}] `,
    });
  }

  return replacements;
}

export function patchNodeGeometry(
  source: string,
  node: TikzNode,
  geometry: NodeGeometry,
): string {
  return applySourceEdits(source, nodeGeometryEdits(source, node, geometry));
}

function nodePositionEdits(
  source: string,
  node: TikzNode,
  x: number,
  y: number,
): SourceEdit[] {
  const replacements: SourceEdit[] = [];

  for (const block of node.optionBlocks) {
    const tokens = parseOptionTokens(source, block.start, block.end);
    const kept = tokens.filter((token) => !isRelativeOption(token.key, token.value));
    if (kept.length === tokens.length) continue;
    replacements.push({
      start: block.start,
      end: block.end,
      text: kept.map((token) => token.raw.trim()).join(", "),
    });
  }

  const coordinate = `${formatTikzNumber(x)}, ${formatTikzNumber(y)}`;
  if (node.atInnerSpan) {
    replacements.push({
      start: node.atInnerSpan.start,
      end: node.atInnerSpan.end,
      text: coordinate,
    });
  } else {
    const point = insertionPoint(source, node);
    replacements.push({
      start: point,
      end: point,
      text: ` at (${coordinate}) `,
    });
  }

  return replacements;
}

export function patchNodePosition(
  source: string,
  node: TikzNode,
  x: number,
  y: number,
): string {
  return applySourceEdits(source, nodePositionEdits(source, node, x, y));
}

export function patchNodeSize(
  source: string,
  node: TikzNode,
  width: number,
  height: number,
): string {
  return patchNodeGeometry(source, node, {
    x: node.x,
    y: node.y,
    width,
    height,
  });
}

function frameGeometryEdits(
  frame: TikzFrame,
  geometry: { minX: number; minY: number; maxX: number; maxY: number },
): SourceEdit[] {
  return [
    {
      start: frame.corner1Span.start,
      end: frame.corner1Span.end,
      text: `${formatTikzNumber(geometry.minX)}, ${formatTikzNumber(geometry.minY)}`,
    },
    {
      start: frame.corner2Span.start,
      end: frame.corner2Span.end,
      text: `${formatTikzNumber(geometry.maxX)}, ${formatTikzNumber(geometry.maxY)}`,
    },
  ];
}

export function patchFrameGeometry(
  source: string,
  frame: TikzFrame,
  geometry: { minX: number; minY: number; maxX: number; maxY: number },
): string {
  return applySourceEdits(source, frameGeometryEdits(frame, geometry));
}

export function patchText(source: string, object: TikzNode | TikzLabel, text: string): string {
  return applySourceEdits(source, [
    {
      start: object.textSpan.start,
      end: object.textSpan.end,
      text,
    },
  ]);
}

function isShiftOption(key: string): boolean {
  const normalized = key.trim();
  return normalized === "xshift" || normalized === "yshift";
}

function labelOffsetEdits(
  source: string,
  label: TikzLabel,
  xShift: number,
  yShift: number,
): SourceEdit[] {
  const shiftText = `xshift=${formatTikzNumber(xShift)}cm, yshift=${formatTikzNumber(yShift)}cm`;
  const replacements: SourceEdit[] = [];
  let written = false;

  for (let index = 0; index < label.optionBlocks.length; index += 1) {
    const block = label.optionBlocks[index];
    const tokens = parseOptionTokens(source, block.start, block.end);
    const kept = tokens.filter((token) => !isShiftOption(token.key));
    const isLast = index === label.optionBlocks.length - 1;
    if (kept.length === tokens.length && !isLast) continue;
    const parts = kept.map((token) => token.raw.trim()).filter(Boolean);
    if (isLast) {
      parts.push(shiftText);
      written = true;
    }
    replacements.push({
      start: block.start,
      end: block.end,
      text: parts.join(", "),
    });
  }

  if (!written) {
    replacements.push({
      start: label.commandNameEnd,
      end: label.commandNameEnd,
      text: ` [${shiftText}]`,
    });
  }

  return replacements;
}

export function patchLabelOffset(
  source: string,
  label: TikzLabel,
  xShift: number,
  yShift: number,
): string {
  return applySourceEdits(source, labelOffsetEdits(source, label, xShift, yShift));
}

function applySelectionEdits(
  source: string,
  labelTargets: Map<string, Point>,
  structuralEdits: SourceEdit[],
): string {
  const intermediate = applySourceEdits(source, structuralEdits);
  if (labelTargets.size === 0) return intermediate;
  const reparsed = parseTikz(intermediate);
  const edits: SourceEdit[] = [];
  for (const [key, target] of labelTargets) {
    const label = reparsed.labels.find((item) => item.key === key);
    if (!label) continue;
    edits.push(
      ...labelOffsetEdits(
        intermediate,
        label,
        label.sourceShift.x + target.x - label.position.x,
        label.sourceShift.y + target.y - label.position.y,
      ),
    );
  }
  return applySourceEdits(intermediate, edits);
}

export function patchSelectionTranslation(
  source: string,
  objects: SelectionEditObjects,
  dx: number,
  dy: number,
): string {
  const edits: SourceEdit[] = [];
  for (const node of objects.nodes) {
    edits.push(...nodePositionEdits(source, node, node.x + dx, node.y + dy));
  }
  for (const frame of objects.frames) {
    edits.push(
      ...frameGeometryEdits(frame, {
        minX: frame.minX + dx,
        minY: frame.minY + dy,
        maxX: frame.maxX + dx,
        maxY: frame.maxY + dy,
      }),
    );
  }
  const labelTargets = new Map<string, Point>();
  for (const label of objects.labels) {
    labelTargets.set(label.key, {
      x: label.position.x + dx,
      y: label.position.y + dy,
    });
  }
  return applySelectionEdits(source, labelTargets, edits);
}

export function patchSelectionScale(
  source: string,
  objects: SelectionEditObjects,
  from: Bounds,
  to: Bounds,
): string {
  const scaleX = (to.maxX - to.minX) / Math.max(from.maxX - from.minX, 0.0001);
  const scaleY = (to.maxY - to.minY) / Math.max(from.maxY - from.minY, 0.0001);
  const mapX = (value: number) => to.minX + (value - from.minX) * scaleX;
  const mapY = (value: number) => to.minY + (value - from.minY) * scaleY;
  const edits: SourceEdit[] = [];

  for (const node of objects.nodes) {
    edits.push(
      ...nodeGeometryEdits(source, node, {
        x: mapX(node.x),
        y: mapY(node.y),
        width: Math.max(0.3, node.width * scaleX),
        height: Math.max(0.3, node.height * scaleY),
      }),
    );
  }

  const labelTargets = new Map<string, Point>();
  for (const label of objects.labels) {
    labelTargets.set(label.key, {
      x: mapX(label.position.x),
      y: mapY(label.position.y),
    });
  }

  for (const frame of objects.frames) {
    const minX = mapX(frame.minX);
    const minY = mapY(frame.minY);
    edits.push(
      ...frameGeometryEdits(frame, {
        minX,
        minY,
        maxX: Math.max(minX + 0.2, mapX(frame.maxX)),
        maxY: Math.max(minY + 0.2, mapY(frame.maxY)),
      }),
    );
  }

  return applySelectionEdits(source, labelTargets, edits);
}

function isBalancedText(text: string): boolean {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

export function validateNodeText(text: string): string | null {
  if (!isBalancedText(text)) return "花括号未闭合，请检查文本中的 { 和 }";
  const dollars = (text.match(/(?<!\\)\$/g) ?? []).length;
  if (dollars % 2 !== 0) return "公式的 $ 符号数量不是成对的";
  return null;
}
