import type {
  Bounds,
  CurveGeometry,
  LineGeometry,
  NodeStyle,
  PathStyle,
  PathSubpath,
  Point,
  ResolvedEndpoint,
  Span,
  TikzCdSummary,
  TikzIssue,
  TikzLabel,
  TikzNode,
  TikzPath,
} from "./types";
import {
  DEFAULT_FONT_PX,
  PX_PER_CM,
  findBalanced,
  parseDimension,
  skipWhitespace,
} from "./options";
import { borderPoint, cubicPoint } from "./coordinates";
import { measureTikzText } from "./measure";
import { resolveTikzColor } from "./colors";

const CD_FONT_PX = DEFAULT_FONT_PX;
const CD_LABEL_FONT_PX = 10.5;
const CD_INNER_SEP = 0.11;
const CD_DEFAULT_SEP_EM = 2;
const CD_ENV_GAP_EM = 2;
const CD_BEND_ANGLE = 30;
const CD_LABEL_GAP = 0.08;
const CD_DEFAULT_DRAW = "#212720";

export interface TikzCdEnvironmentSpan {
  start: number;
  end: number;
}

export interface TikzCdParseResult {
  nodes: TikzNode[];
  paths: TikzPath[];
  issues: TikzIssue[];
  environments: TikzCdEnvironmentSpan[];
  summary: TikzCdSummary;
}

interface CdWarning {
  message: string;
  detail?: string;
}

interface CdEnvironment {
  index: number;
  span: Span;
  bodyStart: number;
  bodyEnd: number;
  rowSep: number;
  colSep: number;
  rows: CdCell[][];
  columnCount: number;
  rowHeights: number[];
  columnWidths: number[];
  width: number;
  height: number;
}

interface CdCell {
  row: number;
  col: number;
  span: Span;
  text: string;
  textSpan: Span;
  textEditable: boolean;
  width: number;
  height: number;
  arrows: CdArrow[];
}

interface CdArrow {
  commandSpan: Span;
  commandNameEnd: number;
  optionBlock?: Span;
  rowDelta: number;
  colDelta: number;
  bend: { direction: "left" | "right"; angle: number } | null;
  dashed: boolean;
  dotted: boolean;
  lineWidth: number;
  arrowStart: boolean;
  arrowEnd: boolean;
  crossing: boolean;
  draw: string | null;
  labels: CdLabel[];
  warnings: CdWarning[];
}

interface CdLabel {
  text: string;
  textSpan: Span;
  swap: boolean;
  description: boolean;
  fraction: number;
}

interface OptionChunk {
  text: string;
  start: number;
  end: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trimSpan(
  source: string,
  masked: string,
  start: number,
  end: number,
): { span: Span; text: string } {
  let left = start;
  while (left < end && /\s/.test(source[left])) left += 1;
  let right = end;
  while (right > left && /\s/.test(source[right - 1])) right -= 1;
  const visible = masked.slice(left, right);
  if (visible.trim().length === 0) {
    return { span: { start: left, end: left }, text: "" };
  }
  return {
    span: { start: left, end: right },
    text: source
      .slice(left, right)
      .replace(/\s+/g, " ")
      .trim(),
  };
}

function splitOptionChunks(masked: string, start: number, end: number): OptionChunk[] {
  const chunks: OptionChunk[] = [];
  let braceDepth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let inQuote = false;
  let chunkStart = start;

  for (let index = start; index < end; index += 1) {
    const char = masked[index];
    if (inQuote) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === '"') inQuote = false;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuote = true;
      continue;
    }
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (
      char === "," &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      parenDepth === 0
    ) {
      chunks.push({ text: masked.slice(chunkStart, index), start: chunkStart, end: index });
      chunkStart = index + 1;
    }
  }
  chunks.push({ text: masked.slice(chunkStart, end), start: chunkStart, end });
  return chunks.filter((chunk) => chunk.text.trim().length > 0);
}

function parseLabelModifiers(raw: string): {
  swap: boolean | null;
  description: boolean | null;
  fraction: number | null;
  unsupported: string[];
} {
  const result = {
    swap: null as boolean | null,
    description: null as boolean | null,
    fraction: null as number | null,
    unsupported: [] as string[],
  };
  let rest = raw.trim();
  while (rest.length > 0) {
    let match = rest.match(/^['’]\s*/);
    if (match) {
      result.swap = true;
      rest = rest.slice(match[0].length);
      continue;
    }
    match = rest.match(/^swap\b\s*/);
    if (match) {
      result.swap = true;
      rest = rest.slice(match[0].length);
      continue;
    }
    match = rest.match(/^description\b\s*/);
    if (match) {
      result.description = true;
      rest = rest.slice(match[0].length);
      continue;
    }
    match = rest.match(/^near\s+start\b\s*/);
    if (match) {
      result.fraction = 0.25;
      rest = rest.slice(match[0].length);
      continue;
    }
    match = rest.match(/^near\s+end\b\s*/);
    if (match) {
      result.fraction = 0.75;
      rest = rest.slice(match[0].length);
      continue;
    }
    match = rest.match(/^pos\s*=\s*\{?([0-9.]+)\}?\s*/);
    if (match) {
      const value = Number.parseFloat(match[1]);
      if (Number.isFinite(value)) result.fraction = Math.min(1, Math.max(0, value));
      rest = rest.slice(match[0].length);
      continue;
    }
    match = rest.match(/^[,;]?\s*([^\s,;]+)\s*/);
    if (!match || match[0].trim().length === 0) break;
    result.unsupported.push(match[1]);
    rest = rest.slice(match[0].length);
  }
  return result;
}

function parseQuotedLabel(
  source: string,
  masked: string,
  chunk: OptionChunk,
): { label: CdLabel; unsupported: string[] } | null {
  const start = skipWhitespace(masked, chunk.start, chunk.end);
  if (masked[start] !== '"') return null;
  let quoteEnd = start + 1;
  while (quoteEnd < chunk.end) {
    if (masked[quoteEnd] === "\\") {
      quoteEnd += 2;
      continue;
    }
    if (masked[quoteEnd] === '"') break;
    quoteEnd += 1;
  }
  if (quoteEnd >= chunk.end) return null;
  const text = source.slice(start + 1, quoteEnd);
  const modifiers = parseLabelModifiers(source.slice(quoteEnd + 1, chunk.end));
  return {
    label: {
      text,
      textSpan: { start: start + 1, end: quoteEnd },
      swap: modifiers.swap ?? false,
      description: modifiers.description ?? false,
      fraction: modifiers.fraction ?? 0.5,
    },
    unsupported: modifiers.unsupported,
  };
}

function normalizeOptionToken(raw: string): string {
  return raw.replace(/\s+/g, " ").replace(/\s*=\s*/g, "=").trim();
}

function parseArrowOptions(
  source: string,
  masked: string,
  optionBlock: Span,
  definitions: Record<string, string>,
): Omit<CdArrow, "commandSpan" | "commandNameEnd" | "optionBlock" | "rowDelta" | "colDelta"> {
  const chunks = splitOptionChunks(masked, optionBlock.start, optionBlock.end);
  const labels: CdLabel[] = [];
  const warnings: CdWarning[] = [];
  let bend: CdArrow["bend"] = null;
  let dashed = false;
  let dotted = false;
  let lineWidth = 1.25;
  let arrowStart = false;
  let arrowEnd = true;
  let crossing = false;
  let draw: string | null = null;
  let swapAll = false;
  let descriptionAll = false;
  let fractionAll: number | null = null;

  for (const chunk of chunks) {
    const raw = chunk.text.trim();
    if (!raw) continue;
    if (raw.startsWith('"')) {
      const parsed = parseQuotedLabel(source, masked, chunk);
      if (!parsed) {
        warnings.push({ message: `无法解析标签 ${raw}` });
        continue;
      }
      labels.push(parsed.label);
      for (const token of parsed.unsupported) {
        warnings.push({ message: `标签选项「${token}」暂不支持` });
      }
      continue;
    }
    const token = normalizeOptionToken(raw);
    if (/^[lrud]+$/.test(token)) {
      continue;
    }
    if (token === "swap") {
      swapAll = true;
      continue;
    }
    if (token === "description") {
      descriptionAll = true;
      continue;
    }
    if (token === "near start") {
      fractionAll = 0.25;
      continue;
    }
    if (token === "near end") {
      fractionAll = 0.75;
      continue;
    }
    if (token.startsWith("pos=")) {
      const value = Number.parseFloat(token.slice(4));
      if (Number.isFinite(value)) fractionAll = Math.min(1, Math.max(0, value));
      continue;
    }
    const bendMatch = token.match(/^bend (left|right)(?:=([0-9.]+))?$/);
    if (bendMatch) {
      const angle = bendMatch[2] ? Number.parseFloat(bendMatch[2]) : CD_BEND_ANGLE;
      bend = {
        direction: bendMatch[1] as "left" | "right",
        angle: Number.isFinite(angle) ? angle : CD_BEND_ANGLE,
      };
      continue;
    }
    if (token === "dotted") {
      dotted = true;
      dashed = false;
      continue;
    }
    if (token === "dashed") {
      dashed = true;
      dotted = false;
      continue;
    }
    if (token === "solid") {
      dashed = false;
      dotted = false;
      continue;
    }
    if (token === "thick") {
      lineWidth = 2.1;
      continue;
    }
    if (token === "very thick") {
      lineWidth = 3.2;
      continue;
    }
    if (token === "thin") {
      lineWidth = 0.9;
      continue;
    }
    if (token.startsWith("line width=")) {
      const width = parseDimension(token.slice("line width=".length));
      if (width != null) lineWidth = Math.max(0.4, width * PX_PER_CM);
      continue;
    }
    if (token === "crossing over") {
      crossing = true;
      continue;
    }
    if (token === "->") {
      arrowStart = false;
      arrowEnd = true;
      continue;
    }
    if (token === "<-") {
      arrowStart = true;
      arrowEnd = false;
      continue;
    }
    if (token === "<->") {
      arrowStart = true;
      arrowEnd = true;
      continue;
    }
    if (token === "-") {
      arrowStart = false;
      arrowEnd = false;
      continue;
    }
    const colorMatch = token.match(/^(?:draw|color)=(.+)$/);
    if (colorMatch) {
      draw = resolveTikzColor(colorMatch[1], definitions, CD_DEFAULT_DRAW);
      continue;
    }
    warnings.push({ message: `箭头选项「${raw.trim()}」暂不支持` });
  }

  for (const label of labels) {
    label.swap = label.swap || swapAll;
    label.description = label.description || descriptionAll;
    if (label.fraction === 0.5 && fractionAll != null) label.fraction = fractionAll;
  }

  return {
    bend,
    dashed,
    dotted,
    lineWidth,
    arrowStart,
    arrowEnd,
    crossing,
    draw,
    labels,
    warnings: warnings.length > 0 ? [{ message: warnings[0].message }] : [],
  };
}

function findArrowCommands(
  masked: string,
  start: number,
  end: number,
): Array<{ start: number; nameEnd: number; end: number; optionBlock?: Span }> {
  const results: Array<{ start: number; nameEnd: number; end: number; optionBlock?: Span }> = [];
  let cursor = start;
  while (cursor < end) {
    const match = /\\(?:arrow|ar)(?![A-Za-z@])/g;
    match.lastIndex = cursor;
    const found = match.exec(masked.slice(0, end));
    if (!found || found.index < cursor) break;
    const commandStart = found.index;
    const nameEnd = commandStart + found[0].length;
    let after = skipWhitespace(masked, nameEnd, end);
    let optionBlock: Span | undefined;
    let commandEnd = nameEnd;
    if (masked[after] === "[") {
      const close = findBalanced(masked, after, "[", "]", end);
      if (close >= 0) {
        optionBlock = { start: after + 1, end: close };
        commandEnd = close + 1;
      }
    }
    results.push({ start: commandStart, nameEnd, end: commandEnd, optionBlock });
    cursor = Math.max(commandEnd, nameEnd + 1);
    if (commandEnd === nameEnd) {
      cursor = skipWhitespace(masked, nameEnd, end);
      if (cursor === nameEnd) cursor = nameEnd;
    }
  }
  return results;
}

function parseCellArrows(
  source: string,
  masked: string,
  cellStart: number,
  cellEnd: number,
  definitions: Record<string, string>,
): {
  arrows: CdArrow[];
  runs: Array<{ span: Span; text: string }>;
  warnings: CdWarning[];
} {
  const commands = findArrowCommands(masked, cellStart, cellEnd);
  const arrows: CdArrow[] = [];
  const runs: Array<{ span: Span; text: string }> = [];
  const warnings: CdWarning[] = [];
  let cursor = cellStart;

  for (const command of commands) {
    if (command.start > cursor) {
      const run = trimSpan(source, masked, cursor, command.start);
      if (run.text) runs.push(run);
    }
    cursor = Math.max(cursor, command.end);
    if (!command.optionBlock) {
      warnings.push({ message: "\\arrow 缺少方向选项" });
      continue;
    }
    const parsed = parseArrowOptions(
      source,
      masked,
      command.optionBlock,
      definitions,
    );
    let rowDelta = 0;
    let colDelta = 0;
    let direction = "";
    for (const chunk of splitOptionChunks(masked, command.optionBlock.start, command.optionBlock.end)) {
      const token = normalizeOptionToken(chunk.text);
      if (/^[lrud]+$/.test(token)) {
        direction = token;
        break;
      }
    }
    if (!direction) {
      warnings.push({ message: "\\arrow 缺少方向选项" });
      continue;
    }
    for (const letter of direction) {
      if (letter === "d") rowDelta += 1;
      else if (letter === "u") rowDelta -= 1;
      else if (letter === "r") colDelta += 1;
      else if (letter === "l") colDelta -= 1;
    }
    for (const warning of parsed.warnings) warnings.push(warning);
    arrows.push({
      commandSpan: { start: command.start, end: command.end },
      commandNameEnd: command.nameEnd,
      optionBlock: command.optionBlock,
      rowDelta,
      colDelta,
      bend: parsed.bend,
      dashed: parsed.dashed,
      dotted: parsed.dotted,
      lineWidth: parsed.lineWidth,
      arrowStart: parsed.arrowStart,
      arrowEnd: parsed.arrowEnd,
      crossing: parsed.crossing,
      draw: parsed.draw,
      labels: parsed.labels,
      warnings: [],
    });
  }

  if (cursor < cellEnd) {
    const run = trimSpan(source, masked, cursor, cellEnd);
    if (run.text) runs.push(run);
  }

  return { arrows, runs, warnings };
}

function parseEnvironmentRows(
  source: string,
  masked: string,
  start: number,
  end: number,
  envIndex: number,
  definitions: Record<string, string>,
): { rows: CdCell[][]; warnings: CdWarning[] } {
  const rawRows: Span[][] = [];
  let currentRow: Span[] = [];
  let cellStart = start;
  let braceDepth = 0;
  let bracketDepth = 0;
  let inQuote = false;

  const pushCell = (cellEnd: number) => {
    currentRow.push({ start: cellStart, end: cellEnd });
  };
  const pushRow = (rowEnd: number) => {
    pushCell(rowEnd);
    rawRows.push(currentRow);
    currentRow = [];
  };

  for (let index = start; index < end; index += 1) {
    const char = masked[index];
    if (inQuote) {
      if (char === "\\") index += 1;
      else if (char === '"') inQuote = false;
      continue;
    }
    if (char === "\\") {
      if (
        masked[index + 1] === "\\" &&
        braceDepth === 0 &&
        bracketDepth === 0
      ) {
        pushRow(index);
        index += 1;
        let next = skipWhitespace(masked, index + 1, end);
        if (masked[next] === "[") {
          const close = findBalanced(masked, next, "[", "]", end);
          if (close >= 0) next = close + 1;
        }
        cellStart = next;
        index = next - 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuote = true;
      continue;
    }
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === "&" && braceDepth === 0 && bracketDepth === 0) {
      pushCell(index);
      cellStart = index + 1;
    }
  }
  pushCell(end);
  if (currentRow.some((cell) => masked.slice(cell.start, cell.end).trim())) {
    rawRows.push(currentRow);
  }

  const warnings: CdWarning[] = [];
  const rows: CdCell[][] = [];
  for (let rowIndex = 0; rowIndex < rawRows.length; rowIndex += 1) {
    const spans = rawRows[rowIndex];
    while (spans.length > 1) {
      const last = spans[spans.length - 1];
      if (masked.slice(last.start, last.end).trim()) break;
      spans.pop();
    }
    const row: CdCell[] = [];
    for (let colIndex = 0; colIndex < spans.length; colIndex += 1) {
      const span = spans[colIndex];
      const { arrows, runs, warnings: cellWarnings } = parseCellArrows(
        source,
        masked,
        span.start,
        span.end,
        definitions,
      );
      for (const warning of cellWarnings) warnings.push(warning);
      const text = runs.map((run) => run.text).join(" ");
      const metrics = measureCdText(text, CD_FONT_PX);
      row.push({
        row: rowIndex,
        col: colIndex,
        span,
        text,
        textSpan: runs[0]?.span ?? { start: span.start, end: span.start },
        textEditable: runs.length <= 1,
        width: metrics.widthCm,
        height: metrics.heightCm,
        arrows,
      });
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    warnings.push({ message: "第 " + (envIndex + 1) + " 个 tikzcd 环境为空" });
  }

  return { rows, warnings };
}

function prepareCdMeasurement(text: string): string {
  return text
    .replace(/\\times(?![A-Za-z])/g, "×")
    .replace(/\\otimes(?![A-Za-z])/g, "⊗")
    .replace(/\\oplus(?![A-Za-z])/g, "⊕")
    .replace(/\\cdot(?![A-Za-z])/g, "·")
    .replace(/\\circ(?![A-Za-z])/g, "∘")
    .replace(/\\cong(?![A-Za-z])/g, "≅")
    .replace(/\\simeq(?![A-Za-z])/g, "≃")
    .replace(/\\(?:rightarrow|to)(?![A-Za-z])/g, "→")
    .replace(/\\leftarrow(?![A-Za-z])/g, "←")
    .replace(/\\Rightarrow(?![A-Za-z])/g, "⇒")
    .replace(/\\hookrightarrow(?![A-Za-z])/g, "↪")
    .replace(/\\mapsto(?![A-Za-z])/g, "↦")
    .replace(/\\infty(?![A-Za-z])/g, "∞")
    .replace(/\\partial(?![A-Za-z])/g, "∂")
    .replace(/\\nabla(?![A-Za-z])/g, "∇")
    .replace(/\\pm(?![A-Za-z])/g, "±")
    .replace(/\\mp(?![A-Za-z])/g, "∓")
    .replace(/\\le(?![A-Za-z])/g, "≤")
    .replace(/\\ge(?![A-Za-z])/g, "≥")
    .replace(/\\ne(?![A-Za-z])/g, "≠")
    .replace(/\\subset(?![A-Za-z])/g, "⊂")
    .replace(/\\cup(?![A-Za-z])/g, "∪")
    .replace(/\\cap(?![A-Za-z])/g, "∩")
    .replace(/\\wedge(?![A-Za-z])/g, "∧")
    .replace(/\\vee(?![A-Za-z])/g, "∨")
    .replace(/\\prime(?![A-Za-z])/g, "′");
}

function measureCdText(
  text: string,
  fontSize: number,
): { widthCm: number; heightCm: number; widthPx: number; heightPx: number } {
  const metrics = measureTikzText(prepareCdMeasurement(text), fontSize);
  const padding = CD_INNER_SEP * PX_PER_CM * 2;
  return {
    widthCm: (metrics.widthPx + padding) / PX_PER_CM,
    heightCm: (metrics.heightPx + padding) / PX_PER_CM,
    widthPx: metrics.widthPx,
    heightPx: metrics.heightPx,
  };
}

function cellNodeStyle(): NodeStyle {
  return {
    draw: null,
    fill: null,
    textColor: null,
    lineWidth: 1.25,
    dashed: false,
    dotted: false,
    shape: "none",
    cornerRadius: 0,
    innerSep: CD_INNER_SEP,
    fontSize: CD_FONT_PX,
    align: "center",
    opacity: 1,
    fillOpacity: 1,
    anchor: "center",
  };
}

function nodeBounds(node: TikzNode): Bounds {
  return {
    minX: node.x - node.width / 2,
    minY: node.y - node.height / 2,
    maxX: node.x + node.width / 2,
    maxY: node.y + node.height / 2,
  };
}

function labelBounds(point: Point, width: number, height: number): Bounds {
  return {
    minX: point.x - width / 2,
    minY: point.y - height / 2,
    maxX: point.x + width / 2,
    maxY: point.y + height / 2,
  };
}

function cellTargetText(cell: CdCell | undefined): string {
  if (!cell || !cell.text) return "";
  return cell.text;
}

function createCellNode(
  envIndex: number,
  cell: CdCell,
  index: number,
  x: number,
  y: number,
  width: number,
  height: number,
): TikzNode {
  const node: TikzNode = {
    kind: "node",
    index,
    key: `tikzcd-${envIndex}-${cell.row}-${cell.col}`,
    name: "",
    text: cell.text,
    textSpan: cell.textSpan,
    commandSpan: cell.span,
    commandNameEnd: cell.span.start,
    contentOpen: cell.textSpan.start,
    contentClose: cell.textSpan.end,
    optionBlocks: [],
    origin: "tikzcd",
    mathMode: true,
    textEditable: cell.textEditable,
    tikzcdCell: {
      envIndex,
      row: cell.row,
      col: cell.col,
      editable: cell.textEditable,
    },
    style: cellNodeStyle(),
    styleTokens: [],
    x,
    y,
    width,
    height,
    naturalWidth: width,
    naturalHeight: height,
    anchorPoint: "center",
    positioning: "absolute",
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  };
  node.bounds = nodeBounds(node);
  return node;
}

function tangentOnGeometry(
  geometry: LineGeometry | CurveGeometry,
  fraction: number,
): Point {
  if ("c1" in geometry) {
    const t = fraction;
    const rest = 1 - t;
    const x =
      3 * rest * rest * (geometry.c1.x - geometry.from.x) +
      6 * rest * t * (geometry.c2.x - geometry.c1.x) +
      3 * t * t * (geometry.to.x - geometry.c2.x);
    const y =
      3 * rest * rest * (geometry.c1.y - geometry.from.y) +
      6 * rest * t * (geometry.c2.y - geometry.c1.y) +
      3 * t * t * (geometry.to.y - geometry.c2.y);
    if (Math.hypot(x, y) > 1e-8) return { x, y };
    return { x: geometry.to.x - geometry.from.x, y: geometry.to.y - geometry.from.y };
  }
  return {
    x: geometry.to.x - geometry.from.x,
    y: geometry.to.y - geometry.from.y,
  };
}

function pointOnGeometry(
  geometry: LineGeometry | CurveGeometry,
  fraction: number,
): Point {
  if ("c1" in geometry) {
    return cubicPoint(geometry.from, geometry.c1, geometry.c2, geometry.to, fraction);
  }
  return {
    x: geometry.from.x + (geometry.to.x - geometry.from.x) * fraction,
    y: geometry.from.y + (geometry.to.y - geometry.from.y) * fraction,
  };
}

function buildCdLabel(
  pathIndex: number,
  labelIndex: number,
  raw: CdLabel,
  geometry: LineGeometry | CurveGeometry,
): TikzLabel {
  const point = pointOnGeometry(geometry, raw.fraction);
  const tangent = tangentOnGeometry(geometry, raw.fraction);
  const length = Math.max(Math.hypot(tangent.x, tangent.y), 1e-6);
  let normal = { x: -tangent.y / length, y: tangent.x / length };
  if (raw.swap) normal = { x: -normal.x, y: -normal.y };
  const metrics = measureTikzText(prepareCdMeasurement(raw.text), CD_LABEL_FONT_PX);
  const width = metrics.widthPx / PX_PER_CM + 0.1;
  const height = metrics.heightPx / PX_PER_CM + 0.06;
  let position = point;
  if (!raw.description) {
    const projected =
      Math.abs(normal.x) * (width / 2) + Math.abs(normal.y) * (height / 2);
    const distance = projected + CD_LABEL_GAP;
    position = {
      x: point.x + normal.x * distance,
      y: point.y + normal.y * distance,
    };
  }
  return {
    kind: "label",
    key: `tikzcd-label-${pathIndex}-${labelIndex}`,
    pathIndex,
    labelIndex,
    text: raw.text,
    textSpan: raw.textSpan,
    commandNameEnd: raw.textSpan.start,
    optionBlocks: [],
    origin: "tikzcd",
    mathMode: true,
    description: raw.description,
    sourceShift: { x: 0, y: 0 },
    rawText: raw.text,
    position,
    fontSize: CD_LABEL_FONT_PX,
    textColor: null,
    fill: null,
    draw: null,
    above: false,
    below: false,
    left: false,
    right: false,
    sourcePosition: raw.fraction,
    bounds: labelBounds(position, width, height),
  };
}

function buildArrowPath(
  envIndex: number,
  pathIndex: number,
  fromNode: TikzNode,
  toNode: TikzNode,
  fromText: string,
  toText: string,
  arrow: CdArrow,
): TikzPath {
  const start = borderPoint(fromNode, { x: toNode.x, y: toNode.y });
  const end = borderPoint(toNode, { x: fromNode.x, y: fromNode.y });
  let geometry: LineGeometry | CurveGeometry;
  if (arrow.bend) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.max(Math.hypot(dx, dy), 0.001);
    const nx = -dy / length;
    const ny = dx / length;
    const sign = arrow.bend.direction === "left" ? 1 : -1;
    const offset =
      Math.tan((arrow.bend.angle * Math.PI) / 180) * (length / 3) * sign;
    geometry = {
      from: start,
      c1: { x: start.x + dx / 3 + nx * offset, y: start.y + dy / 3 + ny * offset },
      c2: {
        x: start.x + (dx * 2) / 3 + nx * offset,
        y: start.y + (dy * 2) / 3 + ny * offset,
      },
      to: end,
    };
  } else {
    geometry = { from: start, to: end, kind: "line" };
  }

  const labels = arrow.labels.map((label, index) =>
    buildCdLabel(pathIndex, index, label, geometry),
  );

  const from: ResolvedEndpoint = {
    point: start,
    nodeRef: fromNode,
    isBorderPoint: true,
    raw: fromNode.key,
  };
  const to: ResolvedEndpoint = {
    point: end,
    nodeRef: toNode,
    isBorderPoint: true,
    raw: toNode.key,
  };
  const subpath: PathSubpath = {
    start: from,
    segments: [
      {
        kind: arrow.bend ? "cubic" : "line",
        raw: { raw: toNode.key, nodeRef: toNode.key, isRelative: false },
        geometry,
        from,
        to,
        labels,
      },
    ],
    closed: false,
  };

  const style: PathStyle = {
    draw: arrow.draw ?? CD_DEFAULT_DRAW,
    fill: null,
    lineWidth: arrow.lineWidth,
    dashed: arrow.dashed,
    dotted: arrow.dotted,
    opacity: 1,
    fillOpacity: 0,
    arrowStart: arrow.arrowStart,
    arrowEnd: arrow.arrowEnd,
    bend: arrow.bend ?? undefined,
    shortenStart: 0,
    shortenEnd: 0,
    crossing: arrow.crossing,
  };

  return {
    kind: "path",
    index: pathIndex,
    key: `path-${pathIndex}`,
    commandSpan: arrow.commandSpan,
    style,
    subpaths: [subpath],
    labels,
    fill: false,
    stroke: true,
    origin: "tikzcd",
    tikzcd: {
      envIndex,
      commandNameEnd: arrow.commandNameEnd,
      optionBlock: arrow.optionBlock,
      fromText,
      toText,
    },
  };
}

export function parseTikzCd(
  source: string,
  masked: string,
  options: {
    nodeIndexStart: number;
    pathIndexStart: number;
    definitions: Record<string, string>;
  },
): TikzCdParseResult | null {
  const environments: CdEnvironment[] = [];
  const issues: TikzIssue[] = [];
  const warnings: string[] = [];
  const spans: TikzCdEnvironmentSpan[] = [];
  const defaultSep = (CD_DEFAULT_SEP_EM * CD_FONT_PX) / PX_PER_CM;
  const beginPattern = /\\begin\s*\{\s*(tikzcd\*?)\s*\}/g;
  let match: RegExpExecArray | null;

  while ((match = beginPattern.exec(masked))) {
    const envName = match[1];
    const beginStart = match.index;
    let cursor = beginStart + match[0].length;
    let rowSep = defaultSep;
    let colSep = defaultSep;
    let envIssues: string[] = [];

    const optionStart = skipWhitespace(masked, cursor);
    if (masked[optionStart] === "[") {
      const close = findBalanced(masked, optionStart, "[", "]", masked.length);
      if (close >= 0) {
        const innerStart = optionStart + 1;
        const innerEnd = close;
        for (const chunk of splitOptionChunks(masked, innerStart, innerEnd)) {
          const token = normalizeOptionToken(chunk.text);
          const sepMatch = token.match(/^(row sep|column sep|rowsep|columnsep)=(.+)$/);
          if (sepMatch) {
            const value = parseDimension(sepMatch[2]);
            if (value != null) {
              if (sepMatch[1].startsWith("row")) rowSep = value;
              else colSep = value;
            } else {
              envIssues.push(`环境选项「${chunk.text.trim()}」暂不支持`);
            }
          } else if (token === "cramped") {
            // 紧凑排版不影响箭头的语义，保持默认间距。
          } else if (token) {
            envIssues.push(`环境选项「${chunk.text.trim()}」暂不支持`);
          }
        }
        cursor = close + 1;
      } else {
        envIssues.push("tikzcd 选项块未闭合");
      }
    }

    const endPattern = new RegExp(`\\\\end\\s*\\{\\s*${escapeRegExp(envName)}\\s*\\}`, "g");
    endPattern.lastIndex = cursor;
    const endMatch = endPattern.exec(masked);
    if (!endMatch) {
      envIssues.push("缺少 \\end{tikzcd}");
      break;
    }
    const bodyStart = cursor;
    const bodyEnd = endMatch.index;
    const span = { start: beginStart, end: endMatch.index + endMatch[0].length };
    spans.push(span);
    beginPattern.lastIndex = span.end;

    const envIndex = environments.length;
    for (const warning of envIssues) {
      warnings.push(`第 ${envIndex + 1} 个 tikzcd：${warning}`);
      issues.push({
        id: `tikzcd-env-${envIndex}-${warning}`,
        message: warning,
        severity: "warning",
      });
    }
    envIssues = [];

    const parsedRows = parseEnvironmentRows(
      source,
      masked,
      bodyStart,
      bodyEnd,
      envIndex,
      options.definitions,
    );
    for (const warning of parsedRows.warnings) {
      warnings.push(`第 ${envIndex + 1} 个 tikzcd：${warning.message}`);
      issues.push({
        id: `tikzcd-cell-${envIndex}-${warning.message}`,
        message: warning.message,
        severity: "warning",
      });
    }
    const rows = parsedRows.rows;
    const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
    if (rows.length === 0 || columnCount === 0) {
      environments.push({
        index: envIndex,
        span,
        bodyStart,
        bodyEnd,
        rowSep,
        colSep,
        rows,
        columnCount,
        rowHeights: [],
        columnWidths: [],
        width: 0,
        height: 0,
      });
      continue;
    }

    const rowHeights = rows.map((row) => {
      let height = (CD_FONT_PX * 1.3) / PX_PER_CM + CD_INNER_SEP * 2;
      for (const cell of row) height = Math.max(height, cell.height);
      return height;
    });
    const columnWidths = new Array<number>(columnCount).fill(0);
    for (const row of rows) {
      for (const cell of row) {
        columnWidths[cell.col] = Math.max(columnWidths[cell.col], cell.width);
      }
    }
    for (let col = 0; col < columnCount; col += 1) {
      columnWidths[col] = Math.max(columnWidths[col], CD_INNER_SEP * 2 + 0.04);
    }

    const width =
      columnWidths.reduce((sum, value) => sum + value, 0) +
      Math.max(0, columnCount - 1) * colSep;
    const height =
      rowHeights.reduce((sum, value) => sum + value, 0) +
      Math.max(0, rows.length - 1) * rowSep;

    environments.push({
      index: envIndex,
      span,
      bodyStart,
      bodyEnd,
      rowSep,
      colSep,
      rows,
      columnCount,
      rowHeights,
      columnWidths,
      width,
      height,
    });
  }

  if (environments.length === 0) return null;

  const gap = (CD_ENV_GAP_EM * CD_FONT_PX) / PX_PER_CM;
  const totalWidth =
    environments.reduce((sum, env) => sum + env.width, 0) +
    Math.max(0, environments.length - 1) * gap;
  const maxHeight = environments.reduce((max, env) => Math.max(max, env.height), 0);

  const nodes: TikzNode[] = [];
  const paths: TikzPath[] = [];
  let nodeIndex = options.nodeIndexStart;
  let pathIndex = options.pathIndexStart;
  let left = -totalWidth / 2;

  for (const env of environments) {
    const top = maxHeight / 2;
    const columnCenters: number[] = [];
    let x = left;
    for (let col = 0; col < env.columnCount; col += 1) {
      columnCenters[col] = x + env.columnWidths[col] / 2;
      x += env.columnWidths[col] + env.colSep;
    }
    const rowCenters: number[] = [];
    let y = top;
    for (let row = 0; row < env.rows.length; row += 1) {
      rowCenters[row] = y - env.rowHeights[row] / 2;
      y -= env.rowHeights[row] + env.rowSep;
    }

    const needed = new Set<string>();
    for (const row of env.rows) {
      for (const cell of row) {
        if (cell.text) needed.add(`${cell.row}-${cell.col}`);
        for (const arrow of cell.arrows) {
          const targetRow = cell.row + arrow.rowDelta;
          const targetCol = cell.col + arrow.colDelta;
          if (
            targetRow < 0 ||
            targetRow >= env.rows.length ||
            targetCol < 0 ||
            targetCol >= env.columnCount
          ) {
            continue;
          }
          needed.add(`${targetRow}-${targetCol}`);
        }
      }
    }

    const nodesByCell = new Map<string, TikzNode>();
    for (const key of needed) {
      const [rowText, colText] = key.split("-");
      const rowIndex = Number(rowText);
      const colIndex = Number(colText);
      const explicit = env.rows[rowIndex]?.find((item) => item.col === colIndex);
      const cell: CdCell = explicit ?? {
        row: rowIndex,
        col: colIndex,
        span: { start: env.bodyEnd, end: env.bodyEnd },
        text: "",
        textSpan: { start: env.bodyEnd, end: env.bodyEnd },
        textEditable: false,
        width: 0,
        height: 0,
        arrows: [],
      };
      const emptyNode = !cell.text;
      const width = emptyNode ? CD_INNER_SEP * 2 : cell.width;
      const height = emptyNode ? CD_INNER_SEP * 2 : cell.height;
      const node = createCellNode(
        env.index,
        cell,
        nodeIndex,
        columnCenters[cell.col],
        rowCenters[cell.row],
        width,
        height,
      );
      nodesByCell.set(key, node);
      nodes.push(node);
      nodeIndex += 1;
    }

    for (const row of env.rows) {
      for (const cell of row) {
        const fromNode = nodesByCell.get(`${cell.row}-${cell.col}`);
        if (!fromNode) continue;
        for (const arrow of cell.arrows) {
          const targetRow = cell.row + arrow.rowDelta;
          const targetCol = cell.col + arrow.colDelta;
          const targetCell = env.rows[targetRow]?.find((item) => item.col === targetCol);
          const toNode = nodesByCell.get(`${targetRow}-${targetCol}`);
          if (
            targetRow < 0 ||
            targetRow >= env.rows.length ||
            targetCol < 0 ||
            targetCol >= env.columnCount ||
            !toNode
          ) {
            warnings.push(
              `第 ${env.index + 1} 个 tikzcd：箭头目标 (${targetRow + 1}, ${targetCol + 1}) 超出表格范围`,
            );
            issues.push({
              id: `tikzcd-arrow-${env.index}-${cell.row}-${cell.col}-${arrow.rowDelta}-${arrow.colDelta}`,
              message: "箭头目标超出表格范围",
              detail: "该箭头已跳过，请检查箭头方向或补充目标单元格。",
              severity: "warning",
            });
            continue;
          }
          const fromText = cellTargetText(cell);
          const toText = cellTargetText(targetCell);
          paths.push(
            buildArrowPath(
              env.index,
              pathIndex,
              fromNode,
              toNode,
              fromText,
              toText,
              arrow,
            ),
          );
          pathIndex += 1;
        }
      }
    }

    left += env.width + gap;
  }

  const native = warnings.length === 0;
  return {
    nodes,
    paths,
    issues,
    environments: spans,
    summary: {
      environments: environments.length,
      native,
      warnings,
    },
  };
}
