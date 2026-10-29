import type {
  Bounds,
  Point,
  Span,
  TikzDocument,
  TikzFrame,
  TikzLabel,
  TikzNode,
  TikzPath,
} from "./types";
import { baseColorName, parseColorDefinitions, resolveTikzColor } from "./colors";
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
  paths: TikzPath[];
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
    normalized === "minimum size" ||
    normalized === "text width" ||
    normalized === "text height" ||
    normalized === "text depth"
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

interface PathEndpointRef {
  point: Point;
  nodeBound: boolean;
  raw?: string;
  span?: Span;
}

function pathEndpointRefs(path: TikzPath): PathEndpointRef[] {
  const refs: PathEndpointRef[] = [];
  for (const subpath of path.subpaths) {
    if (subpath.shape) continue;
    refs.push({
      point: subpath.start.point,
      nodeBound: Boolean(subpath.start.nodeRef),
      raw: subpath.start.raw,
      span: subpath.start.sourceSpan,
    });
    for (const segment of subpath.segments) {
      refs.push({
        point: segment.to.point,
        nodeBound: Boolean(segment.to.nodeRef),
        raw: segment.raw.raw,
        span: segment.raw.sourceSpan ?? segment.to.sourceSpan,
      });
    }
  }
  return refs;
}

function isNumericCoordinate(raw: string | undefined): boolean {
  if (!raw) return false;
  const parts = raw.split(",");
  if (parts.length !== 2) return false;
  return parts.every((part) =>
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:cm|mm|pt|in|em|ex)?$/.test(part.trim()),
  );
}

function endpointReplacement(source: string, span: Span, point: Point): SourceEdit {
  let start = span.start;
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start -= 1;
  let end = span.end;
  let text = `${formatTikzNumber(point.x)}, ${formatTikzNumber(point.y)}`;
  if (source[start - 1] === "(") {
    let before = start - 1;
    while (before > 0 && (source[before - 1] === " " || source[before - 1] === "\t")) {
      before -= 1;
    }
    if (source[before - 1] === "+") {
      let relativeStart = before - 1;
      if (source[relativeStart - 1] === "+") relativeStart -= 1;
      let close = span.end;
      while (close < source.length && source[close] !== ")") close += 1;
      if (close < source.length) {
        start = relativeStart;
        end = close + 1;
        text = `(${text})`;
      }
    }
  }
  return { start, end, text };
}

function pathCoordinateEdits(
  source: string,
  paths: TikzPath[],
  mapPoint: (point: Point) => Point,
): SourceEdit[] {
  const edits: SourceEdit[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    for (const endpoint of pathEndpointRefs(path)) {
      if (endpoint.nodeBound || !endpoint.span || !isNumericCoordinate(endpoint.raw)) continue;
      const id = `${endpoint.span.start}:${endpoint.span.end}`;
      if (seen.has(id)) continue;
      seen.add(id);
      edits.push(endpointReplacement(source, endpoint.span, mapPoint(endpoint.point)));
    }
  }
  return edits;
}

export function pathHasAttachedEndpoints(path: TikzPath): boolean {
  return pathEndpointRefs(path).some((endpoint) => endpoint.nodeBound);
}

export function patchPathEndpoint(
  source: string,
  path: TikzPath,
  subpathIndex: number,
  edge: "start" | "end",
  point: Point,
): string {
  const subpath = path.subpaths[subpathIndex];
  if (!subpath) return source;
  const segment = subpath.segments[subpath.segments.length - 1];
  const span =
    edge === "start"
      ? subpath.start.sourceSpan
      : (segment?.raw.sourceSpan ?? segment?.to.sourceSpan);
  if (!span) return source;
  return applySourceEdits(source, [endpointReplacement(source, span, point)]);
}

export function patchPathSegmentCurve(
  source: string,
  path: TikzPath,
  subpathIndex: number,
  segmentIndex: number,
  controls: { c1: Point; c2: Point } | null,
): string {
  const segment = path.subpaths[subpathIndex]?.segments[segmentIndex];
  if (!segment?.connectorSpan) return source;
  const text = controls
    ? `.. controls (${formatTikzNumber(controls.c1.x)}, ${formatTikzNumber(controls.c1.y)}) and (${formatTikzNumber(controls.c2.x)}, ${formatTikzNumber(controls.c2.y)}) ..`
    : "--";
  return applySourceEdits(source, [
    {
      start: segment.connectorSpan.start,
      end: segment.connectorSpan.end,
      text,
    },
  ]);
}

export function detachPathEndpoints(source: string, path: TikzPath): string {
  const edits: SourceEdit[] = [];
  const seen = new Set<string>();
  for (const endpoint of pathEndpointRefs(path)) {
    if (!endpoint.nodeBound || !endpoint.span) continue;
    const id = `${endpoint.span.start}:${endpoint.span.end}`;
    if (seen.has(id)) continue;
    seen.add(id);
    edits.push(endpointReplacement(source, endpoint.span, endpoint.point));
  }
  return applySourceEdits(source, edits);
}

function endpointGroupRange(source: string, span: Span): Span | null {
  let contentStart = span.start;
  while (
    contentStart > 0 &&
    (source[contentStart - 1] === " " || source[contentStart - 1] === "\t")
  ) {
    contentStart -= 1;
  }
  if (source[contentStart - 1] !== "(") return null;
  const open = contentStart - 1;
  let close = span.end;
  while (close < source.length && source[close] !== ")") close += 1;
  if (close >= source.length) return null;
  let start = open;
  let before = open;
  while (before > 0 && (source[before - 1] === " " || source[before - 1] === "\t")) {
    before -= 1;
  }
  if (source[before - 1] === "+") {
    start = before - 1;
    if (source[start - 1] === "+") start -= 1;
  }
  return { start, end: close + 1 };
}

export function attachPathEndpoint(
  source: string,
  path: TikzPath,
  subpathIndex: number,
  edge: "start" | "end",
  nodeName: string,
  anchor: string,
): string {
  if (!nodeName.trim()) return source;
  const subpath = path.subpaths[subpathIndex];
  if (!subpath) return source;
  const segment = subpath.segments[subpath.segments.length - 1];
  const span =
    edge === "start"
      ? subpath.start.sourceSpan
      : (segment?.raw.sourceSpan ?? segment?.to.sourceSpan);
  if (!span) return source;
  const range = endpointGroupRange(source, span);
  if (!range) return source;
  return applySourceEdits(source, [
    { start: range.start, end: range.end, text: `(${nodeName.trim()}.${anchor})` },
  ]);
}

function lineDeletionSpan(source: string, span: Span): Span {
  const lineStart = source.lastIndexOf("\n", Math.max(0, span.start - 1)) + 1;
  const lineEndIndex = source.indexOf("\n", span.end);
  const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex;
  const onlyIndentBefore = /^[ \t]*$/.test(source.slice(lineStart, span.start));
  const onlySpaceAfter = /^[ \t]*$/.test(source.slice(span.end, lineEnd));
  if (onlyIndentBefore && onlySpaceAfter) {
    return { start: lineStart, end: Math.min(source.length, lineEnd + 1) };
  }
  return span;
}

function labelDeletionSpan(source: string, label: TikzLabel): Span | null {
  const start = label.commandNameEnd - "node".length;
  if (start < 0 || source.slice(start, label.commandNameEnd) !== "node") return null;
  const close = label.textSpan.end;
  if (source[close] !== "}") return null;
  let from = start;
  while (from > 0 && (source[from - 1] === " " || source[from - 1] === "\t")) {
    from -= 1;
  }
  return { start: from, end: close + 1 };
}

function frameDeletionSpan(
  source: string,
  frame: TikzFrame,
  pathSpan: Span,
  subpathCount: number,
): Span {
  if (subpathCount <= 1) return lineDeletionSpan(source, pathSpan);
  const open = source.lastIndexOf("(", frame.corner1Span.start);
  const close = source.indexOf(")", frame.corner2Span.end);
  if (open < pathSpan.start || close < 0 || close >= pathSpan.end) {
    return { start: frame.corner1Span.start, end: frame.corner2Span.end };
  }
  let start = open;
  while (start > pathSpan.start && (source[start - 1] === " " || source[start - 1] === "\t")) {
    start -= 1;
  }
  return { start, end: close + 1 };
}

function pathReferencesNodeNames(
  path: TikzDocument["paths"][number],
  names: Set<string>,
): boolean {
  for (const subpath of path.subpaths) {
    if (subpath.start.nodeRef?.name && names.has(subpath.start.nodeRef.name)) return true;
    for (const segment of subpath.segments) {
      if (segment.raw.nodeRef && names.has(segment.raw.nodeRef)) return true;
      if (segment.from.nodeRef?.name && names.has(segment.from.nodeRef.name)) return true;
      if (segment.to.nodeRef?.name && names.has(segment.to.nodeRef.name)) return true;
    }
  }
  return false;
}

export function deleteSelectionObjects(
  source: string,
  doc: TikzDocument,
  objects: SelectionEditObjects,
): string {
  const edits: SourceEdit[] = [];
  const selectedNodeNames = new Set(objects.nodes.map((node) => node.name).filter(Boolean));
  const selectedNodeKeys = new Set(objects.nodes.map((node) => node.key));

  for (const node of objects.nodes) {
    const span = lineDeletionSpan(source, node.commandSpan);
    edits.push({ ...span, text: "" });
  }

  if (selectedNodeNames.size > 0) {
    for (const node of doc.nodes) {
      if (selectedNodeKeys.has(node.key)) continue;
      const reference = node.relative?.reference;
      if (!reference || !selectedNodeNames.has(reference)) continue;
      edits.push(...nodePositionEdits(source, node, node.x, node.y));
    }
  }

  const removedPaths = new Set<number>();
  for (const path of objects.paths) {
    if (removedPaths.has(path.index)) continue;
    removedPaths.add(path.index);
    const span = lineDeletionSpan(source, path.commandSpan);
    edits.push({ ...span, text: "" });
  }

  if (selectedNodeNames.size > 0) {
    for (const path of doc.paths) {
      if (removedPaths.has(path.index)) continue;
      if (!pathReferencesNodeNames(path, selectedNodeNames)) continue;
      removedPaths.add(path.index);
      const span = lineDeletionSpan(source, path.commandSpan);
      edits.push({ ...span, text: "" });
    }
  }

  const framesByPath = new Map<number, TikzFrame[]>();
  for (const frame of objects.frames) {
    const frames = framesByPath.get(frame.pathIndex) ?? [];
    frames.push(frame);
    framesByPath.set(frame.pathIndex, frames);
  }
  for (const [pathIndex, frames] of framesByPath) {
    if (removedPaths.has(pathIndex)) continue;
    const path = doc.paths.find((item) => item.index === pathIndex);
    if (!path) continue;
    if (path.subpaths.length <= frames.length) {
      removedPaths.add(pathIndex);
      const span = lineDeletionSpan(source, path.commandSpan);
      edits.push({ ...span, text: "" });
      continue;
    }
    for (const frame of frames) {
      const span = frameDeletionSpan(source, frame, path.commandSpan, path.subpaths.length);
      edits.push({ start: span.start, end: span.end, text: "" });
    }
  }

  for (const label of objects.labels) {
    if (removedPaths.has(label.pathIndex)) continue;
    const span = labelDeletionSpan(source, label);
    if (span) edits.push({ start: span.start, end: span.end, text: "" });
  }

  return applySourceEdits(source, edits);
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
  edits.push(
    ...pathCoordinateEdits(source, objects.paths, (point) => ({
      x: point.x + dx,
      y: point.y + dy,
    })),
  );
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

  edits.push(
    ...pathCoordinateEdits(source, objects.paths, (point) => ({
      x: mapX(point.x),
      y: mapY(point.y),
    })),
  );

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

function normalizeHexColor(value: string): string | null {
  let hex = value.trim();
  if (!hex.startsWith("#")) hex = `#${hex}`;
  if (/^#[0-9a-f]{3}$/i.test(hex)) {
    hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex.toLowerCase() : null;
}

/** Ensures every requested hex color has a reusable TikZ color name. */
function colorReferencePlan(
  source: string,
  values: string[],
): { edits: SourceEdit[]; references: Map<string, string> } {
  const definitions = parseColorDefinitions(source);
  const existing = new Map<string, string>();
  for (const name of Object.keys(definitions)) {
    const resolved = resolveTikzColor(name, definitions, null);
    const normalized = resolved ? normalizeHexColor(resolved) : null;
    if (normalized && !existing.has(normalized)) existing.set(normalized, name);
  }

  const references = new Map<string, string>();
  const missing: Array<{ name: string; hex: string }> = [];
  const usedNames = new Set(Object.keys(definitions));

  for (const value of values) {
    const normalized = normalizeHexColor(value);
    if (!normalized || references.has(normalized)) continue;
    const base = baseColorName(normalized);
    if (base) {
      references.set(normalized, base);
      continue;
    }
    const defined = existing.get(normalized);
    if (defined) {
      references.set(normalized, defined);
      continue;
    }
    const stem = `ts${normalized.slice(1)}`;
    let name = stem;
    let suffix = 1;
    while (usedNames.has(name)) {
      const resolved = resolveTikzColor(name, definitions, null);
      if (resolved && normalizeHexColor(resolved) === normalized) break;
      suffix += 1;
      name = `${stem}${suffix}`;
    }
    if (!usedNames.has(name)) {
      usedNames.add(name);
      missing.push({ name, hex: normalized });
    }
    references.set(normalized, name);
  }

  if (missing.length === 0) return { edits: [], references };

  const begin = /\\begin\s*\{tikzpicture\}/.exec(source);
  let point = begin ? begin.index : 0;
  if (begin) {
    const lineStart = source.lastIndexOf("\n", point - 1) + 1;
    if (source.slice(lineStart, point).trim() === "") point = lineStart;
  }
  const leading = point > 0 && !source.slice(0, point).endsWith("\n") ? "\n" : "";
  const text = `${leading}${missing
    .map(
      ({ name, hex }) =>
        `\\definecolor{${name}}{HTML}{${hex.slice(1).toUpperCase()}}`,
    )
    .join("\n")}\n`;

  return {
    edits: [{ start: point, end: point, text }],
    references,
  };
}

function normalizedOptionKey(key: string): string {
  return key.trim().replace(/\s+/g, " ");
}

export interface NodeColorPatch {
  fill?: string | null;
  draw?: string | null;
  text?: string | null;
}

export function patchNodeColors(
  source: string,
  node: TikzNode,
  change: NodeColorPatch,
): string {
  const requested = [change.fill, change.draw, change.text].filter(
    (value): value is string => typeof value === "string",
  );
  const plan = colorReferencePlan(source, requested);
  const additions: string[] = [];

  const push = (key: "fill" | "draw" | "text", value: string | null | undefined) => {
    if (value === undefined) return;
    if (value === null) {
      additions.push(`${key}=none`);
      return;
    }
    const normalized = normalizeHexColor(value);
    const reference = normalized ? plan.references.get(normalized) : null;
    if (reference) additions.push(`${key}=${reference}`);
  };
  push("fill", change.fill);
  push("draw", change.draw);
  push("text", change.text);
  if (additions.length === 0) return source;

  const changedKeys = new Set<string>();
  if (change.fill !== undefined) changedKeys.add("fill");
  if (change.draw !== undefined) changedKeys.add("draw");
  if (change.text !== undefined) changedKeys.add("text");

  const replacements: SourceEdit[] = [...plan.edits];
  let written = false;
  for (let index = 0; index < node.optionBlocks.length; index += 1) {
    const block = node.optionBlocks[index];
    const tokens = parseOptionTokens(source, block.start, block.end);
    const kept = tokens.filter(
      (token) => !changedKeys.has(normalizedOptionKey(token.key)),
    );
    const isLast = index === node.optionBlocks.length - 1;
    if (kept.length === tokens.length && !isLast) continue;
    const parts = kept.map((token) => token.raw.trim()).filter(Boolean);
    if (isLast) {
      parts.push(...additions);
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
      start: node.commandNameEnd,
      end: node.commandNameEnd,
      text: `[${additions.join(", ")}]`,
    });
  }

  return applySourceEdits(source, replacements);
}

export function patchLabelColor(
  source: string,
  label: TikzLabel,
  color: string,
): string {
  const normalized = normalizeHexColor(color);
  if (!normalized) return source;
  const plan = colorReferencePlan(source, [normalized]);
  const reference = plan.references.get(normalized);
  if (!reference) return source;

  const replacements: SourceEdit[] = [...plan.edits];
  let written = false;
  for (let index = 0; index < label.optionBlocks.length; index += 1) {
    const block = label.optionBlocks[index];
    const tokens = parseOptionTokens(source, block.start, block.end);
    const kept = tokens.filter(
      (token) => normalizedOptionKey(token.key) !== "text",
    );
    const isLast = index === label.optionBlocks.length - 1;
    if (kept.length === tokens.length && !isLast) continue;
    const parts = kept.map((token) => token.raw.trim()).filter(Boolean);
    if (isLast) {
      parts.push(`text=${reference}`);
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
      text: `[text=${reference}]`,
    });
  }

  return applySourceEdits(source, replacements);
}

function patchFontToken(
  source: string,
  optionBlocks: Span[],
  commandNameEnd: number,
  points: number,
  fixedTextSize?: { width: number; height: number },
): string {
  if (!Number.isFinite(points) || points <= 0) return source;
  const size = formatTikzNumber(points);
  const baseline = formatTikzNumber(points * 1.2);
  const additions = [`font=\\fontsize{${size}pt}{${baseline}pt}\\selectfont`];
  if (fixedTextSize) {
    additions.push(
      `text width=${formatTikzNumber(fixedTextSize.width)}cm`,
      `text height=${formatTikzNumber(fixedTextSize.height)}cm`,
      "text depth=0pt",
    );
  }
  const replacements: SourceEdit[] = [];
  let written = false;

  for (let index = 0; index < optionBlocks.length; index += 1) {
    const block = optionBlocks[index];
    const tokens = parseOptionTokens(source, block.start, block.end);
    const kept = tokens.filter((token) => {
      const key = normalizedOptionKey(token.key);
      if (key === "font") return false;
      if (
        fixedTextSize &&
        (key === "text width" || key === "text height" || key === "text depth")
      ) {
        return false;
      }
      return true;
    });
    const isLast = index === optionBlocks.length - 1;
    if (kept.length === tokens.length && !isLast) continue;
    const parts = kept.map((token) => token.raw.trim()).filter(Boolean);
    if (isLast) {
      parts.push(...additions);
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
      start: commandNameEnd,
      end: commandNameEnd,
      text: `[${additions.join(", ")}]`,
    });
  }

  return applySourceEdits(source, replacements);
}

function nodeFixedTextSize(node: TikzNode): { width: number; height: number } {
  const padding = Math.max(0, node.style.innerSep);
  const shapeWidth =
    node.style.shape === "diamond" ? node.width / 1.24 : node.width;
  const shapeHeight =
    node.style.shape === "diamond" ? node.height / 1.22 : node.height;
  return {
    width: Math.max(0.05, shapeWidth - padding * 2),
    height: Math.max(0.05, shapeHeight - padding * 2),
  };
}

export function patchNodeFontSize(
  source: string,
  node: TikzNode,
  points: number,
): string {
  return patchFontToken(
    source,
    node.optionBlocks,
    node.commandNameEnd,
    points,
    nodeFixedTextSize(node),
  );
}

export function patchLabelFontSize(
  source: string,
  label: TikzLabel,
  points: number,
): string {
  return patchFontToken(source, label.optionBlocks, label.commandNameEnd, points);
}

export type BasicShapeKind = "rectangle" | "rounded" | "circle" | "diamond";

export interface NewShapeSpec {
  kind: BasicShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  fill?: string | null;
  draw?: string;
}

const SHAPE_NAME_PREFIX: Record<BasicShapeKind, string> = {
  rectangle: "rect",
  rounded: "rounded",
  circle: "circle",
  diamond: "diamond",
};

function collectReservedNames(doc: TikzDocument): Set<string> {
  const used = new Set<string>();
  for (const node of doc.nodes) {
    if (node.name) used.add(node.name);
  }
  for (const coordinate of doc.coordinates) used.add(coordinate.name);
  return used;
}

function uniqueNodeName(prefix: string, used: Set<string>): string {
  let index = 1;
  let name = `${prefix}${index}`;
  while (used.has(name)) {
    index += 1;
    name = `${prefix}${index}`;
  }
  used.add(name);
  return name;
}

function pictureCommandEdit(
  source: string,
  doc: TikzDocument,
  command: string,
): SourceEdit {
  if (!doc.pictureSpan) {
    const point = source.length;
    const leading = source.length > 0 && !source.endsWith("\n") ? "\n" : "";
    return { start: point, end: point, text: `${leading}${command}\n` };
  }

  const endIndex = source.lastIndexOf("\\end", doc.pictureSpan.end);
  let point = endIndex >= doc.pictureSpan.start ? endIndex : doc.pictureSpan.end;
  const lineStart = source.lastIndexOf("\n", point - 1) + 1;
  if (source.slice(lineStart, point).trim() === "") point = lineStart;
  const leading = point > 0 && !source.slice(0, point).endsWith("\n") ? "\n" : "";
  return { start: point, end: point, text: `${leading}  ${command}\n` };
}

function nodeNameEdit(
  source: string,
  node: TikzNode,
  name: string,
): SourceEdit {
  const point =
    node.optionBlocks.length > 0
      ? node.optionBlocks[node.optionBlocks.length - 1].end
      : node.commandNameEnd;
  return { start: point, end: point, text: ` (${name})` };
}

export function insertShapeNode(
  source: string,
  doc: TikzDocument,
  spec: NewShapeSpec,
): { source: string; name: string; key: string | null; node: TikzNode | null } {
  const used = collectReservedNames(doc);
  const name = uniqueNodeName(SHAPE_NAME_PREFIX[spec.kind], used);
  const width = Math.max(0.4, spec.width);
  const height = Math.max(0.4, spec.height);
  const fill = spec.fill === null ? "none" : (spec.fill ?? "white");
  const options: string[] = [`draw=${spec.draw ?? "black!75"}`, `fill=${fill}`];

  if (spec.kind === "circle") {
    const diameter = Math.max(width, height);
    options.push("circle", `minimum size=${formatTikzNumber(diameter)}cm`, "inner sep=0pt");
  } else if (spec.kind === "diamond") {
    options.push(
      "diamond",
      `minimum width=${formatTikzNumber(width / 1.24)}cm`,
      `minimum height=${formatTikzNumber(height / 1.22)}cm`,
      "inner sep=0pt",
    );
  } else {
    if (spec.kind === "rounded") options.push("rounded corners=4pt");
    options.push(
      `minimum width=${formatTikzNumber(width)}cm`,
      `minimum height=${formatTikzNumber(height)}cm`,
    );
  }

  const command = `\\node[${options.join(", ")}] (${name}) at (${formatTikzNumber(spec.x)}, ${formatTikzNumber(spec.y)}) {};`;
  let next: string;
  if (doc.pictureSpan) {
    next = applySourceEdits(source, [pictureCommandEdit(source, doc, command)]);
  } else {
    const separator =
      source.trim().length === 0 ? "" : source.endsWith("\n") ? "\n" : "\n\n";
    next = `${source}${separator}\\begin{tikzpicture}\n  ${command}\n\\end{tikzpicture}\n`;
  }
  const parsed = parseTikz(next);
  const node = parsed.nodes.find((item) => item.name === name) ?? null;
  return { source: next, name, key: node?.key ?? null, node };
}

export interface ConnectorEndpoint {
  node: TikzNode;
  anchor: string;
}

export interface ConnectorSpec {
  from: ConnectorEndpoint;
  to?: ConnectorEndpoint;
  point?: Point;
  arrow: boolean;
  dashed: boolean;
}

export function insertConnector(
  source: string,
  doc: TikzDocument,
  spec: ConnectorSpec,
): { source: string; fromKey: string | null; toKey: string | null } {
  const used = collectReservedNames(doc);
  const edits: SourceEdit[] = [];
  const ensureName = (node: TikzNode): string => {
    if (node.name) return node.name;
    const name = uniqueNodeName("node", used);
    edits.push(nodeNameEdit(source, node, name));
    return name;
  };

  const fromName = ensureName(spec.from.node);
  const toName = spec.to ? ensureName(spec.to.node) : null;
  const fromAnchor = spec.from.anchor.trim().toLowerCase().replace(/\s+/g, " ");
  const toAnchor = spec.to?.anchor.trim().toLowerCase().replace(/\s+/g, " ") ?? null;
  const style = ["draw=black!70", "thick"];
  if (spec.arrow) style.push("-{Stealth[length=2.2mm]}");
  if (spec.dashed) style.push("dashed");

  const target =
    toName && toAnchor
      ? `(${toName}.${toAnchor})`
      : `(${formatTikzNumber(spec.point?.x ?? 0)}, ${formatTikzNumber(spec.point?.y ?? 0)})`;
  const command = `\\draw[${style.join(", ")}] (${fromName}.${fromAnchor}) -- ${target};`;
  edits.push(pictureCommandEdit(source, doc, command));

  const next = applySourceEdits(source, edits);
  const parsed = parseTikz(next);
  return {
    source: next,
    fromKey: parsed.nodes.find((node) => node.name === fromName)?.key ?? null,
    toKey: toName
      ? (parsed.nodes.find((node) => node.name === toName)?.key ?? null)
      : null,
  };
}
