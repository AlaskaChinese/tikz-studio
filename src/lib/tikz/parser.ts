import type {
  Bounds,
  CurveGeometry,
  LineGeometry,
  NodeShape,
  NodeStyle,
  ParsedOption,
  PathLabelDefinition,
  PathSegment,
  PathStyle,
  PathSubpath,
  Point,
  RawEndpoint,
  RelativePlacement,
  ResolvedEndpoint,
  Span,
  TikzCoordinate,
  TikzDocument,
  TikzFrame,
  TikzIssue,
  TikzLabel,
  TikzNode,
  TikzPath,
} from "./types";
import {
  DEFAULT_FONT_PX,
  DEFAULT_INNER_SEP_CM,
  PX_PER_CM,
  StyleMap,
  collectStyleDefinitions,
  evaluateExpression,
  expandStyleTokens,
  findBalanced,
  maskComments,
  parseArrowPair,
  parseDimension,
  parseFloatOption,
  parseFontSize,
  parseOptionTokens,
  readBalancedContent,
  skipWhitespace,
  splitTopLevel,
  styleTokens,
  tokensFromOptionString,
} from "./options";
import {
  CoordinateContext,
  anchorOffset,
  borderPoint,
  cubicPoint,
  distance,
  parseNamedReference,
  pointOnLine,
  resolveRawCoordinate,
} from "./coordinates";
import { measureTikzText } from "./measure";
import { parseColorDefinitions, resolveTikzColor } from "./colors";
import { compileMathExpression, compileSingleVariable } from "./mathExpr";

const KNOWN_PICTURE_COMMANDS = new Set([
  "node",
  "coordinate",
  "draw",
  "path",
  "fill",
  "filldraw",
  "tikzset",
  "tikzstyle",
  "definecolor",
  "colorlet",
]);

interface RawLabel {
  text: string;
  textSpan: Span;
  commandNameEnd: number;
  optionBlocks: Span[];
  options: ParsedOption[];
  position: number;
  orientation: "above" | "below" | "left" | "right" | "center";
  sourceShift: Point;
  xOffset: number;
  yOffset: number;
  style: PathLabelDefinition["style"];
}

interface RawPathEndpoint {
  raw: string;
  sourceStart: number;
  sourceSpan?: Span;
  relative: "++" | "+" | null;
  nodeRef?: TikzNode;
  rawAnchor?: string;
  point: Point;
  unresolvedName?: string;
}

interface RawSegment {
  kind: "line" | "horizontal-vertical" | "vertical-horizontal" | "curve";
  from: RawPathEndpoint;
  to: RawPathEndpoint;
  controls?: RawPathEndpoint[];
  labels: RawLabel[];
  bend?: { direction: "left" | "right"; angle: number };
  connectorSpan?: Span;
  generated?: boolean;
}

interface RawSubpath {
  start: RawPathEndpoint;
  segments: RawSegment[];
  closed: boolean;
  generated?: boolean;
  shape?: PathSubpath["shape"];
}

interface PlotDomain {
  min: number;
  max: number;
}

interface PlotDefaults {
  domain?: PlotDomain;
  samples?: number;
}

const DEFAULT_PLOT_DOMAIN: PlotDomain = { min: -5, max: 5 };
const DEFAULT_PLOT_SAMPLES = 25;

function evaluateDomainValue(raw: string): number | null {
  const text = raw.trim();
  if (!text) return null;
  const dimension = evaluateExpression(text);
  if (dimension != null && Number.isFinite(dimension)) return dimension;
  const compiled = compileMathExpression(text, []);
  if (!compiled) return null;
  const value = compiled({});
  return Number.isFinite(value) ? value : null;
}

function parsePlotDomain(value: string | undefined): PlotDomain | null {
  if (!value) return null;
  const parts = splitTopLevel(value, 0, value.length, ":");
  if (parts.length !== 2) return null;
  const min = evaluateDomainValue(parts[0].text);
  const max = evaluateDomainValue(parts[1].text);
  if (min == null || max == null || !(max > min)) return null;
  return { min, max };
}

function plotTokenDomain(tokens: ParsedOption[]): PlotDomain | undefined {
  const token = [...tokens].reverse().find((item) => item.key.trim() === "domain");
  return parsePlotDomain(token?.value) ?? undefined;
}

function plotTokenSamples(tokens: ParsedOption[]): number | undefined {
  const token = [...tokens].reverse().find((item) => item.key.trim() === "samples");
  if (!token?.value) return undefined;
  const value = Number.parseInt(token.value.trim(), 10);
  return Number.isFinite(value) ? Math.max(2, Math.min(400, value)) : undefined;
}

function generatedEndpoint(point: Point): RawPathEndpoint {
  return {
    raw: `${formatPlotNumber(point.x)},${formatPlotNumber(point.y)}`,
    sourceStart: -1,
    relative: null,
    point: { x: point.x, y: point.y },
  };
}

function formatPlotNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 1000) / 1000;
  return String(rounded);
}

interface ParserState {
  source: string;
  masked: string;
  definitions: Record<string, string>;
  issues: TikzIssue[];
  issueKeys: Set<string>;
  nodeDistanceX: number;
  nodeDistanceY: number;
  fontScale: number;
}

interface ParsedCoordinateCommand {
  name: string;
  raw: string;
  sourceSpan: Span;
}

function emptyBounds(): Bounds {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
}

function addBoundsPoint(bounds: Bounds, point: Point) {
  bounds.minX = Math.min(bounds.minX, point.x);
  bounds.minY = Math.min(bounds.minY, point.y);
  bounds.maxX = Math.max(bounds.maxX, point.x);
  bounds.maxY = Math.max(bounds.maxY, point.y);
}

function addBounds(bounds: Bounds, other: Bounds) {
  bounds.minX = Math.min(bounds.minX, other.minX);
  bounds.minY = Math.min(bounds.minY, other.minY);
  bounds.maxX = Math.max(bounds.maxX, other.maxX);
  bounds.maxY = Math.max(bounds.maxY, other.maxY);
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

function finalizeBounds(bounds: Bounds): Bounds {
  if (!Number.isFinite(bounds.minX)) {
    return { minX: -2, minY: -1.4, maxX: 2, maxY: 1.4 };
  }
  return bounds;
}

function addIssue(
  state: ParserState,
  id: string,
  message: string,
  options: { severity?: "warning" | "error"; detail?: string } = {},
) {
  if (state.issueKeys.has(id)) return;
  state.issueKeys.add(id);
  state.issues.push({
    id,
    message,
    detail: options.detail,
    severity: options.severity ?? "warning",
  });
}

function readCommand(source: string, start: number): number {
  let index = start + 1;
  while (index < source.length && /[A-Za-z@]/.test(source[index])) index += 1;
  return index;
}

function readOptionBlock(
  source: string,
  index: number,
  end: number,
): { innerStart: number; innerEnd: number; next: number } | null {
  const open = index;
  const close = findBalanced(source, open, "[", "]", end);
  if (close < 0) return null;
  return { innerStart: open + 1, innerEnd: close, next: close + 1 };
}

function findCommandEnd(masked: string, start: number, limit: number): number {
  let braceDepth = 0;
  let bracketDepth = 0;
  for (let index = start; index < limit; index += 1) {
    const char = masked[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    else if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === ";" && braceDepth === 0 && bracketDepth === 0) return index + 1;
  }
  return limit;
}

function lastToken(tokens: ParsedOption[], key: string): ParsedOption | undefined {
  return [...tokens].reverse().find((token) => token.key.replace(/\s+/g, " ").trim() === key);
}

function parsedNodeShape(tokens: ParsedOption[], hasDraw: boolean): {
  shape: NodeShape;
  cornerRadius: number;
} {
  let shape: NodeShape = hasDraw ? "rectangle" : "none";
  let cornerRadius = 0;
  let rounded = false;

  for (const token of tokens) {
    const key = token.key.trim();
    const value = token.value?.trim();
    if (key === "circle") shape = "circle";
    else if (key === "ellipse") shape = "ellipse";
    else if (key === "diamond") shape = "diamond";
    else if (key === "rectangle") shape = hasDraw ? "rectangle" : "none";
    else if (key === "rounded rectangle") {
      shape = "rounded";
      cornerRadius = parseDimension(value, 0.12) ?? 0.12;
    } else if (key === "rounded corners") {
      rounded = true;
      cornerRadius = parseDimension(value, 0.12) ?? 0.12;
    } else if (key === "shape" && value) {
      const normalized = value.replace(/[{}]/g, "").trim();
      if (normalized === "circle") shape = "circle";
      else if (normalized === "ellipse") shape = "ellipse";
      else if (normalized === "diamond") shape = "diamond";
      else if (normalized === "rectangle") shape = "rectangle";
    }
  }

  if (rounded && shape !== "none") shape = "rounded";
  return { shape, cornerRadius };
}

function parseColorToken(
  tokens: ParsedOption[],
  key: string,
  state: ParserState,
  fallback: string | null,
): string | null {
  const token = [...tokens].reverse().find((item) => item.key.trim() === key);
  if (!token) return fallback;
  if (token.value?.trim() === "none") return null;
  if (!token.value) return resolveTikzColor("black", state.definitions, fallback);
  return resolveTikzColor(token.value, state.definitions, fallback);
}

function parseNodeStyle(
  tokens: ParsedOption[],
  rawText: string,
  state: ParserState,
): {
  style: NodeStyle;
  naturalWidth: number;
  naturalHeight: number;
} {
  const hasDrawToken = Boolean(lastToken(tokens, "draw"));
  const draw = parseColorToken(tokens, "draw", state, hasDrawToken ? "#212720" : null);
  const fill = parseColorToken(tokens, "fill", state, null);
  const textColor = parseColorToken(tokens, "text", state, parseColorToken(tokens, "color", state, null));

  let lineWidth = 1.25;
  let dashed = false;
  let dotted = false;
  for (const token of tokens) {
    const key = token.key.trim();
    if (key === "thin") lineWidth = 0.9;
    else if (key === "very thin") lineWidth = 0.6;
    else if (key === "thick") lineWidth = 2.1;
    else if (key === "very thick") lineWidth = 3.2;
    else if (key === "ultra thick") lineWidth = 4.6;
    else if (key === "line width" && token.value) {
      const cm = parseDimension(token.value);
      if (cm != null) lineWidth = Math.max(0.5, cm * PX_PER_CM);
    } else if (key === "dashed") dashed = true;
    else if (key === "dotted") dotted = true;
  }

  const { shape, cornerRadius } = parsedNodeShape(tokens, Boolean(draw || fill));
  const fontSize = parseFontSize(tokens, DEFAULT_FONT_PX) * state.fontScale;
  const innerSep = parseDimension(lastToken(tokens, "inner sep")?.value, DEFAULT_INNER_SEP_CM) ?? 0.11;
  const minWidth = parseDimension(lastToken(tokens, "minimum width")?.value);
  const minHeight = parseDimension(lastToken(tokens, "minimum height")?.value);
  const minSize = parseDimension(lastToken(tokens, "minimum size")?.value);
  const textWidth = parseDimension(lastToken(tokens, "text width")?.value);
  const textHeight = parseDimension(lastToken(tokens, "text height")?.value);
  const textDepth = parseDimension(lastToken(tokens, "text depth")?.value);
  const opacity = parseFloatOption(tokens, "opacity", 1);
  const fillOpacity = parseFloatOption(tokens, "fill opacity", opacity);
  const alignRaw = lastToken(tokens, "align")?.value?.trim();
  const align = alignRaw === "left" || alignRaw === "right" ? alignRaw : "center";
  const anchor = lastToken(tokens, "anchor")?.value?.trim() ?? "center";

  const metrics = measureTikzText(rawText, fontSize);
  const innerPadding = innerSep * PX_PER_CM;
  let widthPx =
    textWidth != null
      ? textWidth * PX_PER_CM + innerPadding * 2
      : metrics.widthPx + innerPadding * 2;
  let heightPx =
    textHeight != null || textDepth != null
      ? ((textHeight ?? 0) + (textDepth ?? 0)) * PX_PER_CM + innerPadding * 2
      : metrics.heightPx + innerPadding * 2;

  if (minWidth != null) widthPx = Math.max(widthPx, minWidth * PX_PER_CM);
  if (minHeight != null) heightPx = Math.max(heightPx, minHeight * PX_PER_CM);
  if (minSize != null) {
    widthPx = Math.max(widthPx, minSize * PX_PER_CM);
    heightPx = Math.max(heightPx, minSize * PX_PER_CM);
  }

  if (shape === "circle") {
    const diameter = Math.max(widthPx, heightPx);
    widthPx = diameter;
    heightPx = diameter;
  } else if (shape === "diamond") {
    widthPx *= 1.24;
    heightPx *= 1.22;
  }

  const style: NodeStyle = {
    draw,
    fill,
    textColor,
    lineWidth,
    dashed,
    dotted,
    shape,
    cornerRadius,
    minWidth,
    minHeight,
    minSize,
    textWidth,
    textHeight,
    textDepth,
    innerSep,
    fontSize,
    align,
    opacity,
    fillOpacity,
    anchor,
  };

  return {
    style,
    naturalWidth: widthPx / PX_PER_CM,
    naturalHeight: heightPx / PX_PER_CM,
  };
}

function parseRelativePlacement(
  tokens: ParsedOption[],
): RelativePlacement | undefined {
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index];
    const key = token.key.trim().replace(/\s+/g, " ");
    const directionMatch = key.match(/^(above|below|left|right)(?:\s+(above|below|left|right))?$/);
    const directOfMatch = key.match(
      /^(above|below|left|right)(?:\s+(above|below|left|right))?\s+of$/,
    );

    if (!directionMatch && !directOfMatch) continue;
    const directions: RelativePlacement["directions"] = [];
    const words = (directionMatch?.[0] ?? directOfMatch?.[0] ?? "").split(" ").filter(Boolean);
    for (const word of words) {
      if (
        (word === "above" || word === "below" || word === "left" || word === "right") &&
        !directions.includes(word)
      ) {
        directions.push(word);
      }
    }
    if (directions.length === 0) continue;

    let referenceRaw = "";
    let distanceRaw = "";
    if (directOfMatch) {
      referenceRaw = token.value?.trim() ?? "";
    } else {
      const value = token.value?.trim() ?? "";
      const ofMatch = value.match(/^(.*?)\s*\bof\s+(.+)$/);
      if (!ofMatch) continue;
      distanceRaw = ofMatch[1].trim();
      referenceRaw = ofMatch[2].trim();
    }

    const reference = parseNamedReference(referenceRaw);
    if (!reference) continue;
    const distanceCm = distanceRaw ? evaluateExpression(distanceRaw) : undefined;
    return {
      directions,
      reference: reference.name,
      distanceCm: distanceCm ?? undefined,
    };
  }

  return undefined;
}

function parsePictureOptions(
  state: ParserState,
  optionsRaw: string | undefined,
): {
  styles: StyleMap;
  everyNodeTokens: ParsedOption[];
  everyPathTokens: ParsedOption[];
  everyLabelTokens: ParsedOption[];
  plotDomain?: PlotDomain;
  plotSamples?: number;
} {
  const optionsText = optionsRaw ? maskComments(optionsRaw) : "";
  const extra = optionsText ? [optionsText] : [];
  const styles = collectStyleDefinitions(state.source, extra);
  const pictureTokens = optionsText ? tokensFromOptionString(optionsText) : [];

  const distanceToken = [...pictureTokens]
    .reverse()
    .find((token) => token.key.trim() === "node distance");
  if (distanceToken?.value) {
    const distanceParts = distanceToken.value.split(/\band\b/).map((part) => part.trim());
    const first = parseDimension(distanceParts[0]);
    const second = distanceParts.length > 1 ? parseDimension(distanceParts[1]) : first;
    if (first != null) state.nodeDistanceX = first;
    if (second != null) state.nodeDistanceY = second;
  }

  const scaleToken = [...pictureTokens]
    .reverse()
    .find((token) => token.key.trim() === "scale");
  const scaleValue = scaleToken?.value ? Number.parseFloat(scaleToken.value) : Number.NaN;
  const transformsShapes = pictureTokens.some(
    (token) => token.key.trim() === "transform shape",
  );
  state.fontScale =
    transformsShapes && Number.isFinite(scaleValue) && scaleValue > 0
      ? Math.max(0.2, Math.min(4, scaleValue))
      : 1;

  return {
    styles,
    everyNodeTokens: styleTokens(styles, "every node"),
    everyPathTokens: styleTokens(styles, "every path"),
    everyLabelTokens: styleTokens(styles, "every label"),
    plotDomain: plotTokenDomain(pictureTokens),
    plotSamples: plotTokenSamples(pictureTokens),
  };
}

function parseNodeCommand(
  state: ParserState,
  start: number,
  nameEnd: number,
  commandEnd: number,
  index: number,
  pictureDefinitions: {
    everyNodeTokens: ParsedOption[];
    styles: StyleMap;
  },
): {
  node: TikzNode;
  atRaw?: string;
  atSpan?: Span;
} | null {
  let cursor = nameEnd;
  const optionBlocks: Span[] = [];
  const localTokens: ParsedOption[] = [];
  let nodeName = "";
  let atRaw = "";
  let atSpan: Span | undefined;
  let contentOpen = commandEnd - 1;
  let contentClose = commandEnd - 1;
  let textSpan: Span = { start: commandEnd, end: commandEnd };
  let text = "";
  let sawContent = false;

  while (cursor < commandEnd) {
    cursor = skipWhitespace(state.masked, cursor, commandEnd);
    const char = state.masked[cursor];
    if (!char) break;

    if (char === "[") {
      const block = readOptionBlock(state.masked, cursor, commandEnd);
      if (!block) break;
      optionBlocks.push({ start: block.innerStart, end: block.innerEnd });
      localTokens.push(
        ...parseOptionTokens(state.masked, block.innerStart, block.innerEnd).map((token) => ({
          key: token.key,
          value: token.value,
          raw: token.raw,
        })),
      );
      cursor = block.next;
      continue;
    }

    if (char === "(") {
      const group = readBalancedContent(state.masked, cursor, "(", ")");
      if (!group) break;
      if (!nodeName) {
        nodeName = state.source.slice(group.innerStart, group.innerEnd).trim();
      }
      cursor = group.end;
      continue;
    }

    if (state.masked.startsWith("at", cursor) && !/[A-Za-z@]/.test(state.masked[cursor + 2] ?? "")) {
      cursor = skipWhitespace(state.masked, cursor + 2, commandEnd);
      if (state.masked[cursor] === "(") {
        const group = readBalancedContent(state.masked, cursor, "(", ")");
        if (!group) break;
        atRaw = state.source.slice(group.innerStart, group.innerEnd).trim();
        atSpan = { start: group.innerStart, end: group.innerEnd };
        cursor = group.end;
        continue;
      }
    }

    if (char === "{") {
      const group = readBalancedContent(state.masked, cursor);
      if (!group) break;
      contentOpen = group.start;
      contentClose = group.end - 1;
      textSpan = { start: group.innerStart, end: group.innerEnd };
      text = state.source.slice(group.innerStart, group.innerEnd);
      sawContent = true;
      cursor = group.end;
      break;
    }

    if (char === ";") break;
    cursor += 1;
  }

  if (!sawContent) {
    contentOpen = commandEnd;
    contentClose = commandEnd;
  }

  const expandedLocal = expandStyleTokens(localTokens, pictureDefinitions.styles);
  const effectiveTokens = expandStyleTokens(
    [...pictureDefinitions.everyNodeTokens, ...expandedLocal],
    pictureDefinitions.styles,
  );
  const { style, naturalWidth, naturalHeight } = parseNodeStyle(effectiveTokens, text, state);
  const relative = parseRelativePlacement(effectiveTokens);
  const key = `node-${index}`;

  const node: TikzNode = {
    kind: "node",
    index,
    key,
    name: nodeName,
    text,
    textSpan,
    commandSpan: { start, end: commandEnd },
    commandNameEnd: nameEnd,
    contentOpen,
    contentClose,
    optionBlocks,
    style,
    styleTokens: effectiveTokens,
    x: Number.NaN,
    y: Number.NaN,
    width: naturalWidth,
    height: naturalHeight,
    naturalWidth,
    naturalHeight,
    anchorPoint: style.anchor,
    positioning: relative ? "relative" : atRaw ? "absolute" : "default",
    relative,
    atCoordinates: atRaw || undefined,
    atInnerSpan: atSpan,
    bounds: {
      minX: Number.NaN,
      minY: Number.NaN,
      maxX: Number.NaN,
      maxY: Number.NaN,
    },
  };

  return { node, atRaw: atRaw || undefined, atSpan };
}

function parseCoordinateCommand(
  state: ParserState,
  start: number,
  nameEnd: number,
  commandEnd: number,
): ParsedCoordinateCommand | null {
  let cursor = skipWhitespace(state.masked, nameEnd, commandEnd);
  while (state.masked[cursor] === "[") {
    const block = readOptionBlock(state.masked, cursor, commandEnd);
    if (!block) return null;
    cursor = skipWhitespace(state.masked, block.next, commandEnd);
  }
  if (state.masked[cursor] !== "(") return null;
  const nameGroup = readBalancedContent(state.masked, cursor, "(", ")");
  if (!nameGroup) return null;
  const name = state.source.slice(nameGroup.innerStart, nameGroup.innerEnd).trim();
  cursor = skipWhitespace(state.masked, nameGroup.end, commandEnd);
  if (!state.masked.startsWith("at", cursor)) return null;
  cursor = skipWhitespace(state.masked, cursor + 2, commandEnd);
  if (state.masked[cursor] !== "(") return null;
  const coordGroup = readBalancedContent(state.masked, cursor, "(", ")");
  if (!coordGroup) return null;
  const raw = state.source.slice(coordGroup.innerStart, coordGroup.innerEnd).trim();
  return { name, raw, sourceSpan: { start, end: commandEnd } };
}

function parsePathStyle(
  tokens: ParsedOption[],
  state: ParserState,
  command: string,
): { style: PathStyle; stroke: boolean; fill: boolean } {
  const drawToken = [...tokens].reverse().find((token) => token.key.trim() === "draw");
  const fillToken = [...tokens].reverse().find((token) => token.key.trim() === "fill");
  let arrowStart = false;
  let arrowEnd = false;
  for (const token of tokens) {
    const arrows = parseArrowPair(token.key) ?? parseArrowPair(token.raw);
    if (arrows) {
      arrowStart = arrows.start;
      arrowEnd = arrows.end;
    }
  }

  let lineWidth = 1.25;
  let dashed = false;
  let dotted = false;
  let bend: PathStyle["bend"];
  let shortenStart = 0;
  let shortenEnd = 0;

  for (const token of tokens) {
    const key = token.key.trim();
    const raw = token.raw.replace(/\s+/g, "");
    const keys = [key];
    if (raw !== key) keys.push(raw);

    for (const candidate of keys) {
      if (candidate === "thin") lineWidth = 0.9;
      else if (candidate === "very thin") lineWidth = 0.6;
      else if (candidate === "thick") lineWidth = 2.1;
      else if (candidate === "very thick") lineWidth = 3.2;
      else if (candidate === "ultra thick") lineWidth = 4.6;
      else if (candidate === "dashed") dashed = true;
      else if (candidate === "dotted") dotted = true;
      else if (candidate === "bend left" || candidate === "bend right") {
        bend = { direction: candidate.endsWith("left") ? "left" : "right", angle: 20 };
      }
    }

    if (key === "line width" && token.value) {
      const cm = parseDimension(token.value);
      if (cm != null) lineWidth = Math.max(0.5, cm * PX_PER_CM);
    }
    if ((key === "bend left" || key === "bend right") && token.value) {
      const angle = parseFloatOption(tokens, key, 20);
      bend = { direction: key.endsWith("left") ? "left" : "right", angle };
    }
    if (key === "shorten >" && token.value) {
      shortenEnd = Math.max(0, (parseDimension(token.value) ?? 0) * PX_PER_CM);
    }
    if (key === "shorten <" && token.value) {
      shortenStart = Math.max(0, (parseDimension(token.value) ?? 0) * PX_PER_CM);
    }
    if (key === "draw" && token.value) {
      const arrowsFromDraw = parseArrowPair(token.value);
      if (arrowsFromDraw) {
        arrowStart = arrowsFromDraw.start;
        arrowEnd = arrowsFromDraw.end;
      }
    }
  }

  let stroke =
    command === "draw" || command === "filldraw"
      ? true
      : command === "path"
        ? false
        : false;
  let fill = command === "fill" || command === "filldraw";

  if (drawToken) {
    stroke = !drawToken.value || drawToken.value.trim() !== "none";
  }
  if (fillToken) {
    fill = !fillToken.value || fillToken.value.trim() !== "none";
  }
  if ((arrowStart || arrowEnd) && (!drawToken || drawToken.value?.trim() !== "none")) {
    stroke = true;
  }

  const inheritedColor = parseColorToken(tokens, "color", state, null);
  const draw = drawToken
    ? parseColorToken(tokens, "draw", state, stroke ? inheritedColor ?? "#212720" : null)
    : stroke
      ? inheritedColor ?? "#212720"
      : null;
  const fillColor = fillToken
    ? parseColorToken(tokens, "fill", state, inheritedColor ?? "#212720")
    : fill
      ? inheritedColor ?? "#212720"
      : null;
  const opacity = parseFloatOption(tokens, "opacity", 1);
  const fillOpacity = parseFloatOption(tokens, "fill opacity", opacity);

  return {
    style: {
      draw,
      fill: fillColor,
      lineWidth,
      dashed,
      dotted,
      opacity,
      fillOpacity,
      arrowStart,
      arrowEnd,
      bend,
      shortenStart,
      shortenEnd,
    },
    stroke,
    fill,
  };
}

function parsePathNodeLabel(
  state: ParserState,
  cursor: number,
  end: number,
  defaultPosition: number,
  everyLabelTokens: ParsedOption[],
  styles: StyleMap,
  definitions: Record<string, string>,
): { label: RawLabel; next: number } | null {
  let index = cursor;
  if (!state.masked.startsWith("node", index)) return null;
  if (/[A-Za-z@]/.test(state.masked[index + 4] ?? "")) return null;
  index += 4;
  const commandNameEnd = index;
  const optionBlocks: Span[] = [];
  const localTokens: ParsedOption[] = [];

  while (true) {
    index = skipWhitespace(state.masked, index, end);
    if (state.masked[index] !== "[") break;
    const block = readOptionBlock(state.masked, index, end);
    if (!block) return null;
    optionBlocks.push({ start: block.innerStart, end: block.innerEnd });
    localTokens.push(
      ...parseOptionTokens(state.masked, block.innerStart, block.innerEnd).map((token) => ({
        key: token.key,
        value: token.value,
        raw: token.raw,
      })),
    );
    index = block.next;
  }

  index = skipWhitespace(state.masked, index, end);
  if (state.masked[index] === "(") {
    const nameGroup = readBalancedContent(state.masked, index, "(", ")");
    if (!nameGroup) return null;
    index = skipWhitespace(state.masked, nameGroup.end, end);
  }
  if (state.masked[index] !== "{") return null;
  const textGroup = readBalancedContent(state.masked, index);
  if (!textGroup) return null;
  const text = state.source.slice(textGroup.innerStart, textGroup.innerEnd);

  const tokens = expandStyleTokens([...everyLabelTokens, ...localTokens], styles);
  let position = defaultPosition;
  let orientation: RawLabel["orientation"] = "center";
  let xShift = 0;
  let yShift = 0;
  let labelDistance = 0.22;
  let fontSize = parseFontSize(tokens, 13.5) * state.fontScale;
  let textColor: string | null = null;
  let fill: string | null = null;
  let draw: string | null = null;

  const hasDirection = (direction: string) =>
    tokens.some((token) => new RegExp(`(^|\\s)${direction}(\\s|$)`).test(token.key.trim()));
  const hasAbove = hasDirection("above");
  const hasBelow = hasDirection("below");
  const hasLeft = hasDirection("left");
  const hasRight = hasDirection("right");
  if (hasAbove) orientation = "above";
  else if (hasBelow) orientation = "below";
  else if (hasLeft) orientation = "left";
  else if (hasRight) orientation = "right";

  for (const token of tokens) {
    const key = token.key.trim();
    if (key === "pos" && token.value) {
      const value = Number.parseFloat(token.value);
      if (Number.isFinite(value)) position = Math.max(0, Math.min(1, value));
    } else if (key === "midway") position = 0.5;
    else if (key === "near start") position = 0.25;
    else if (key === "near end") position = 0.75;
    else if (key === "very near start") position = 0.1;
    else if (key === "very near end") position = 0.9;
    else if (key === "at start") position = 0;
    else if (key === "at end") position = 1;
    else if (key === "xshift" && token.value) xShift += parseDimension(token.value) ?? 0;
    else if (key === "yshift" && token.value) yShift += parseDimension(token.value) ?? 0;
    else if (key === "label distance" && token.value) {
      labelDistance = parseDimension(token.value) ?? labelDistance;
    } else if (key === "text" && token.value) {
      textColor = resolveTikzColor(token.value, state.definitions, null);
    } else if (key === "color" && token.value) {
      textColor = resolveTikzColor(token.value, state.definitions, textColor);
    } else if (key === "fill") {
      fill =
        token.value?.trim() === "none"
          ? null
          : token.value
            ? resolveTikzColor(token.value, state.definitions, "#fffdf8")
            : "#fffdf8";
    } else if (key === "draw") {
      draw =
        token.value?.trim() === "none"
          ? null
          : token.value
            ? resolveTikzColor(token.value, state.definitions, "#212720")
            : "#212720";
    } else if (key === "font") {
      fontSize = parseFontSize(tokens, 13.5) * state.fontScale;
    }
  }

  const sourceShift = { x: xShift, y: yShift };
  const metrics = measureTikzText(text, fontSize);
  const width = metrics.widthPx / PX_PER_CM;
  const height = metrics.heightPx / PX_PER_CM;
  if (hasAbove) yShift += labelDistance + height / 2;
  else if (hasBelow) yShift -= labelDistance + height / 2;
  if (hasLeft) xShift -= labelDistance + width / 2;
  else if (hasRight) xShift += labelDistance + width / 2;

  return {
    label: {
      text,
      textSpan: { start: textGroup.innerStart, end: textGroup.innerEnd },
      commandNameEnd,
      optionBlocks,
      options: tokens,
      position,
      orientation,
      sourceShift,
      xOffset: xShift,
      yOffset: yShift,
      style: { fontSize, textColor, fill, draw },
    },
    next: textGroup.end,
  };
}

function resolvePathEndpoint(
  raw: string,
  startOffset: number,
  relative: "++" | "+" | null,
  context: CoordinateContext,
  lastPoint: Point | null,
): RawPathEndpoint {
  const resolved = resolveRawCoordinate(raw, context);
  if (!resolved || !Number.isFinite(resolved.point.x)) {
    return {
      raw,
      sourceStart: startOffset,
      relative,
      point: lastPoint ?? { x: 0, y: 0 },
      unresolvedName: resolved?.unresolvedName,
    };
  }

  let point = resolved.point;
  if (relative && lastPoint) {
    point = { x: lastPoint.x + point.x, y: lastPoint.y + point.y };
  }

  return {
    raw,
    sourceStart: startOffset,
    relative,
    nodeRef: resolved.nodeRef,
    rawAnchor: resolved.rawAnchor,
    point,
    unresolvedName: resolved.unresolvedName,
  };
}

function readPathEndpoint(
  state: ParserState,
  cursor: number,
  end: number,
  context: CoordinateContext,
  lastPoint: Point | null,
): { endpoint: RawPathEndpoint; next: number; base: Point } | null {
  let index = skipWhitespace(state.masked, cursor, end);
  let relative: "++" | "+" | null = null;
  if (state.masked.startsWith("++", index)) {
    relative = "++";
    index = skipWhitespace(state.masked, index + 2, end);
  } else if (state.masked[index] === "+") {
    relative = "+";
    index = skipWhitespace(state.masked, index + 1, end);
  }

  if (state.masked[index] !== "(") return null;
  const group = readBalancedContent(state.masked, index, "(", ")");
  if (!group) return null;
  const raw = state.source.slice(group.innerStart, group.innerEnd).trim();
  const leading = state.source.slice(group.innerStart, group.innerEnd).indexOf(raw);
  const endpoint = resolvePathEndpoint(raw, group.innerStart, relative, context, lastPoint);
  if (leading >= 0) {
    endpoint.sourceSpan = {
      start: group.innerStart + leading,
      end: group.innerStart + leading + raw.length,
    };
  }
  const base = relative === "++" ? endpoint.point : lastPoint;

  if (endpoint.unresolvedName) {
    addIssue(
      state,
      `unresolved-${endpoint.unresolvedName}`,
      `找不到坐标引用「${endpoint.unresolvedName}」`,
      { severity: "warning", detail: "请检查节点名是否在画布源码中已定义。" },
    );
  }

  return { endpoint, next: group.end, base: base ?? endpoint.point };
}

function segmentLabelsFromPending(pending: RawLabel[], defaultPosition: number): RawLabel[] {
  return pending.map((label) => ({
    ...label,
    position: label.position < 0 ? defaultPosition : label.position,
  }));
}

function makeSegment(
  kind: RawSegment["kind"],
  from: RawPathEndpoint,
  to: RawPathEndpoint,
  labels: RawLabel[],
  controls?: RawPathEndpoint[],
  bend?: RawSegment["bend"],
): RawSegment {
  return { kind, from, to, labels, controls, bend };
}

function positionOnOrthogonal(
  from: Point,
  to: Point,
  kind: "horizontal-vertical" | "vertical-horizontal",
  fraction: number,
): Point {
  const corner =
    kind === "horizontal-vertical"
      ? { x: to.x, y: from.y }
      : { x: from.x, y: to.y };
  const firstLength = distance(from, corner);
  const secondLength = distance(corner, to);
  const total = firstLength + secondLength;
  if (total <= 1e-9) return from;
  const target = total * fraction;
  if (target <= firstLength) return pointOnLine(from, corner, firstLength ? target / firstLength : 0);
  return pointOnLine(corner, to, secondLength ? (target - firstLength) / secondLength : 0);
}

function pathD(
  subpath: PathSubpath,
): string {
  const commands: string[] = [];
  if (subpath.shape) {
    const shape = subpath.shape;
    if (shape.kind === "rectangle" && shape.corner1 && shape.corner2) {
      const x = Math.min(shape.corner1.x, shape.corner2.x);
      const y = Math.min(shape.corner1.y, shape.corner2.y);
      const width = Math.abs(shape.corner2.x - shape.corner1.x);
      const height = Math.abs(shape.corner2.y - shape.corner1.y);
      commands.push(
        `M ${x * PX_PER_CM} ${-y * PX_PER_CM} h ${width * PX_PER_CM} v ${-height * PX_PER_CM} h ${-width * PX_PER_CM} Z`,
      );
    } else if (shape.kind === "circle" && shape.center && shape.radius != null) {
      const cx = shape.center.x * PX_PER_CM;
      const cy = -shape.center.y * PX_PER_CM;
      const radius = shape.radius * PX_PER_CM;
      commands.push(
        `M ${cx - radius} ${cy} a ${radius} ${radius} 0 1 0 ${radius * 2} 0 a ${radius} ${radius} 0 1 0 ${-radius * 2} 0`,
      );
    } else if (
      shape.kind === "ellipse" &&
      shape.center &&
      shape.radius != null &&
      shape.radiusY != null
    ) {
      const cx = shape.center.x * PX_PER_CM;
      const cy = -shape.center.y * PX_PER_CM;
      const rx = shape.radius * PX_PER_CM;
      const ry = shape.radiusY * PX_PER_CM;
      commands.push(
        `M ${cx - rx} ${cy} a ${rx} ${ry} 0 1 0 ${rx * 2} 0 a ${rx} ${ry} 0 1 0 ${-rx * 2} 0`,
      );
    }
  }

  let current: string | null = null;
  for (const segment of subpath.segments) {
    const from = segment.from.point;
    const to = segment.to.point;
    const fromX = from.x * PX_PER_CM;
    const fromY = -from.y * PX_PER_CM;
    if (
      current === null ||
      Math.abs(current.length) === 0
    ) {
      commands.push(`M ${fromX} ${fromY}`);
    } else {
      commands.push(`M ${fromX} ${fromY}`);
    }
    current = `${fromX},${fromY}`;

    if (segment.kind === "cubic") {
      const geometry = segment.geometry as CurveGeometry;
      commands.push(
        `C ${geometry.c1.x * PX_PER_CM} ${-geometry.c1.y * PX_PER_CM} ${geometry.c2.x * PX_PER_CM} ${-geometry.c2.y * PX_PER_CM} ${to.x * PX_PER_CM} ${-to.y * PX_PER_CM}`,
      );
    } else if (segment.kind === "horizontal-vertical") {
      commands.push(`H ${to.x * PX_PER_CM} V ${-to.y * PX_PER_CM}`);
    } else if (segment.kind === "vertical-horizontal") {
      commands.push(`V ${-to.y * PX_PER_CM} H ${to.x * PX_PER_CM}`);
    } else {
      commands.push(`L ${to.x * PX_PER_CM} ${-to.y * PX_PER_CM}`);
    }
  }
  if (subpath.closed && commands.length > 0) commands.push("Z");
  return commands.join(" ");
}

export function parseTikz(source: string): TikzDocument {
  try {
    return parseInternal(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知解析错误";
    return {
      source,
      nodes: [],
      coordinates: [],
      paths: [],
      labels: [],
      frames: [],
      issues: [
        {
          id: "fatal",
          message: "解析源码时出现问题",
          detail: message,
          severity: "error",
        },
      ],
      bounds: finalizeBounds(emptyBounds()),
      stats: { nodes: 0, paths: 0, labels: 0, lines: 0 },
      hasPicture: false,
      colorDefinitions: {},
    };
  }
}

function parseInternal(source: string): TikzDocument {
  const masked = maskComments(source);
  const state: ParserState = {
    source,
    masked,
    definitions: parseColorDefinitions(source),
    issues: [],
    issueKeys: new Set(),
    nodeDistanceX: 1,
    nodeDistanceY: 1,
    fontScale: 1,
  };

  const beginRegex = /\\begin\s*\{tikzpicture\}/g;
  const begins = [...masked.matchAll(beginRegex)];
  let bodyStart = 0;
  let bodyEnd = source.length;
  let hasPicture = false;
  let pictureSpan: Span | undefined;
  let pictureOptionsRaw: string | undefined;

  if (begins.length > 0) {
    hasPicture = true;
    const begin = begins[0];
    const beginIndex = begin.index ?? 0;
    const beginEnd = beginIndex + begin[0].length;
    bodyStart = beginEnd;

    const optionIndex = skipWhitespace(masked, bodyStart);
    if (masked[optionIndex] === "[") {
      const block = readOptionBlock(masked, optionIndex, source.length);
      if (block) {
        pictureOptionsRaw = source.slice(block.innerStart, block.innerEnd);
        bodyStart = block.next;
      }
    }

    const endRegex = /\\end\s*\{tikzpicture\}/g;
    endRegex.lastIndex = bodyStart;
    const endMatch = endRegex.exec(masked);
    if (endMatch) {
      bodyEnd = endMatch.index;
      pictureSpan = { start: beginIndex, end: endMatch.index + endMatch[0].length };
    } else {
      bodyEnd = source.length;
      pictureSpan = { start: beginIndex, end: source.length };
      addIssue(state, "missing-end", "没有找到 \\end{tikzpicture}", {
        severity: "warning",
        detail: "已尝试渲染到文件末尾。",
      });
    }

    if (begins.length > 1) {
      addIssue(state, "multiple-pictures", "当前仅实时渲染第一个 tikzpicture", {
        detail: "其余图形源码会保留，但不会出现在画布中。",
      });
    }

    if (!endMatch) {
      // The first picture continues to the end of the source.
    }
  } else {
    const hasDrawingCommands = /\\(?:node|draw|path|fill|filldraw|coordinate)\b/.test(masked);
    if (hasDrawingCommands) {
      addIssue(state, "no-picture", "未检测到 tikzpicture 环境", {
        detail: "已按裸绘图命令解析；推荐使用完整的 tikzpicture 环境。",
      });
    }
  }

  const picture = parsePictureOptions(state, pictureOptionsRaw);
  const definitions = state.definitions;

  const nodeCommands: Array<{ start: number; nameEnd: number; end: number }> = [];
  const coordinateCommands: Array<{ start: number; nameEnd: number; end: number }> = [];
  const pathCommands: Array<{ start: number; nameEnd: number; end: number; name: string }> = [];

  let cursor = bodyStart;
  while (cursor < bodyEnd) {
    cursor = skipWhitespace(masked, cursor, bodyEnd);
    if (cursor >= bodyEnd) break;
    if (masked[cursor] !== "\\") {
      cursor += 1;
      continue;
    }

    const nameEnd = readCommand(masked, cursor);
    const commandName = masked.slice(cursor + 1, nameEnd);

    if (commandName === "begin") {
      const env = readEnvironmentName(masked, nameEnd, bodyEnd);
      if (!env) {
        cursor = nameEnd;
        continue;
      }
      cursor = env.afterBegin;
      if (env.name === "scope") {
        addIssue(state, "scope", "scope 局部变换尚未应用", {
          detail: "当前会解析 scope 内的节点与连线，但会忽略局部的 shift、scale 和样式作用域。",
        });
        continue;
      }
      if (env.name !== "tikzpicture") {
        const endTag = `\\end{${env.name}}`;
        const envEnd = masked.indexOf(endTag, cursor);
        if (envEnd >= 0) {
          cursor = envEnd + endTag.length;
        } else {
          cursor = bodyEnd;
        }
        addIssue(state, `env-${env.name}`, `暂不支持 ${env.name} 环境`, {
          detail: "该环境内的内容已跳过。",
        });
      }
      continue;
    }

    if (commandName === "end") {
      const env = readEnvironmentName(masked, nameEnd, bodyEnd);
      cursor = env?.afterBegin ?? nameEnd;
      continue;
    }

    const commandEnd = findCommandEnd(masked, nameEnd, bodyEnd);
    if (commandName === "node") {
      nodeCommands.push({ start: cursor, nameEnd, end: commandEnd });
      cursor = commandEnd;
      continue;
    }
    if (commandName === "coordinate") {
      coordinateCommands.push({ start: cursor, nameEnd, end: commandEnd });
      cursor = commandEnd;
      continue;
    }
    if (
      commandName === "draw" ||
      commandName === "path" ||
      commandName === "fill" ||
      commandName === "filldraw"
    ) {
      pathCommands.push({ start: cursor, nameEnd, end: commandEnd, name: commandName });
      cursor = commandEnd;
      continue;
    }
    if (commandName === "tikzset" || commandName === "tikzstyle" || commandName === "definecolor" || commandName === "colorlet") {
      cursor = commandEnd;
      continue;
    }
    if (commandName === "foreach") {
      addIssue(state, "foreach", "暂不支持 \\foreach 循环", {
        detail: "循环生成的图形不会被渲染，可在源码中展开后再编辑。",
      });
      cursor = skipGroupCommand(masked, nameEnd, bodyEnd);
      continue;
    }
    if (commandName === "matrix" || commandName === "pic") {
      addIssue(state, `command-${commandName}`, `暂不支持 \\${commandName}`, {
        detail: "该命令已跳过，周围的节点与连线仍会正常渲染。",
      });
      cursor = commandEnd;
      continue;
    }
    if (commandName === "clip" || commandName === "useasboundingbox") {
      addIssue(state, `command-${commandName}`, `已忽略 \\${commandName}`, {
        detail: "裁剪或自定义边界不会应用到画布预览。",
      });
      cursor = commandEnd;
      continue;
    }
    if (KNOWN_PICTURE_COMMANDS.has(commandName)) {
      cursor = commandEnd;
      continue;
    }

    cursor = commandEnd > nameEnd ? commandEnd : nameEnd;
  }

  const nodes: TikzNode[] = [];
  for (let index = 0; index < nodeCommands.length; index += 1) {
    const command = nodeCommands[index];
    const parsed = parseNodeCommand(state, command.start, command.nameEnd, command.end, index, {
      everyNodeTokens: picture.everyNodeTokens,
      styles: picture.styles,
    });
    if (parsed) nodes.push(parsed.node);
  }

  for (const node of nodes) {
    node.key = `node-${node.index}-${node.name || "unnamed"}`;
  }

  const nodesByName = new Map<string, TikzNode>();
  for (const node of nodes) {
    if (!node.name) continue;
    if (nodesByName.has(node.name)) {
      addIssue(state, `duplicate-node-${node.name}`, `节点名「${node.name}」重复`, {
        detail: "后出现的定义会覆盖前一个同名节点。",
      });
    }
    nodesByName.set(node.name, node);
  }

  const coordinateCommandsParsed: ParsedCoordinateCommand[] = [];
  for (const command of coordinateCommands) {
    const parsed = parseCoordinateCommand(state, command.start, command.nameEnd, command.end);
    if (parsed) coordinateCommandsParsed.push(parsed);
  }

  const coordinatesMap = new Map<string, Point>();
  const context: CoordinateContext = { nodes: nodesByName, coordinates: coordinatesMap };

  const passes = Math.max(nodes.length + coordinateCommandsParsed.length + 3, 6);
  for (let pass = 0; pass < passes; pass += 1) {
    let changed = false;

    for (const node of nodes) {
      if (Number.isFinite(node.x) && Number.isFinite(node.y)) continue;

      if (node.positioning === "absolute" && node.atCoordinates) {
        const resolved = resolveRawCoordinate(node.atCoordinates, context);
        if (resolved && Number.isFinite(resolved.point.x)) {
          const ownOffset = anchorOffset(node, node.anchorPoint);
          node.x = resolved.point.x - ownOffset.x;
          node.y = resolved.point.y - ownOffset.y;
          changed = true;
        }
      } else if (node.positioning === "relative" && node.relative) {
        const referenceNode = nodesByName.get(node.relative.reference);
        const referenceCoordinate = coordinatesMap.get(node.relative.reference);
        let base: Point | null = null;
        let referenceWidth = 0;
        let referenceHeight = 0;

        if (
          referenceNode &&
          Number.isFinite(referenceNode.x) &&
          Number.isFinite(referenceNode.y)
        ) {
          base = { x: referenceNode.x, y: referenceNode.y };
          referenceWidth = referenceNode.width;
          referenceHeight = referenceNode.height;
        } else if (referenceCoordinate) {
          base = referenceCoordinate;
        }

        if (base) {
          const hasAbove = node.relative.directions.includes("above");
          const hasBelow = node.relative.directions.includes("below");
          const hasLeft = node.relative.directions.includes("left");
          const hasRight = node.relative.directions.includes("right");
          const customDistance = node.relative.distanceCm;
          const gapX = customDistance ?? state.nodeDistanceX;
          const gapY = customDistance ?? state.nodeDistanceY;
          let x = base.x;
          let y = base.y;

          if (hasRight) x = base.x + referenceWidth / 2 + gapX + node.width / 2;
          else if (hasLeft) x = base.x - referenceWidth / 2 - gapX - node.width / 2;
          if (hasAbove) y = base.y + referenceHeight / 2 + gapY + node.height / 2;
          else if (hasBelow) y = base.y - referenceHeight / 2 - gapY - node.height / 2;

          node.x = x;
          node.y = y;
          changed = true;
        } else if (referenceNode) {
          addIssue(
            state,
            `relative-unresolved-${node.relative.reference}`,
            `节点「${node.name || node.index + 1}」的相对位置无法解析`,
            { detail: `引用了尚未定位的节点「${node.relative.reference}」。` },
          );
        }
      } else if (node.positioning === "default") {
        node.x = 0;
        node.y = 0;
        changed = true;
      }
    }

    for (const coordinate of coordinateCommandsParsed) {
      if (coordinatesMap.has(coordinate.name)) continue;
      const resolved = resolveRawCoordinate(coordinate.raw, context);
      if (resolved && Number.isFinite(resolved.point.x)) {
        coordinatesMap.set(coordinate.name, resolved.point);
        changed = true;
      }
    }

    if (!changed) break;
  }

  for (const node of nodes) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      node.x = 0;
      node.y = 0;
      addIssue(state, `unresolved-node-${node.key}`, `节点「${node.name || node.index + 1}」未能定位`, {
        detail: "已将位置回退到原点，请检查相对定位引用。",
      });
    }
    node.bounds = nodeBounds(node);
  }

  const coordinates: TikzCoordinate[] = coordinateCommandsParsed.map((command) => {
    const point = coordinatesMap.get(command.name) ?? { x: 0, y: 0 };
    if (!coordinatesMap.has(command.name)) {
      addIssue(state, `unresolved-coordinate-${command.name}`, `坐标「${command.name}」未解析`, {
        detail: "已将坐标回退到原点。",
      });
    }
    return { name: command.name, x: point.x, y: point.y, sourceSpan: command.sourceSpan };
  });

  const paths: TikzPath[] = [];
  for (let pathIndex = 0; pathIndex < pathCommands.length; pathIndex += 1) {
    const command = pathCommands[pathIndex];
    const parsed = parsePathCommand(
      state,
      command.start,
      command.nameEnd,
      command.end,
      pathIndex,
      command.name,
      picture,
      context,
    );
    if (parsed) paths.push(parsed);
  }

  const frames: TikzFrame[] = [];
  for (const path of paths) {
    path.subpaths.forEach((subpath, subpathIndex) => {
      const shape = subpath.shape;
      if (
        !shape ||
        shape.kind !== "rectangle" ||
        !shape.corner1 ||
        !shape.corner2 ||
        !shape.corner1Span ||
        !shape.corner2Span
      ) {
        return;
      }
      const minX = Math.min(shape.corner1.x, shape.corner2.x);
      const minY = Math.min(shape.corner1.y, shape.corner2.y);
      const maxX = Math.max(shape.corner1.x, shape.corner2.x);
      const maxY = Math.max(shape.corner1.y, shape.corner2.y);
      const width = maxX - minX;
      const height = maxY - minY;
      if (width <= 1e-6 || height <= 1e-6) return;
      frames.push({
        kind: "frame",
        key: `frame-${path.index}-${subpathIndex}`,
        pathIndex: path.index,
        subpathIndex,
        commandSpan: path.commandSpan,
        corner1Span: shape.corner1Span,
        corner2Span: shape.corner2Span,
        minX,
        minY,
        maxX,
        maxY,
        width,
        height,
        fill: path.style.fill,
        draw: path.style.draw,
        isBackground: false,
      });
    });
  }
  if (frames.length > 0) {
    let largest = frames[0];
    for (const frame of frames) {
      if (frame.width * frame.height > largest.width * largest.height) largest = frame;
    }
    largest.isBackground = true;
  }

  const labels = paths.flatMap((path) => path.labels);
  const bounds = emptyBounds();
  for (const node of nodes) addBounds(bounds, node.bounds);
  for (const path of paths) {
    for (const subpath of path.subpaths) {
      if (subpath.shape) {
        const shape = subpath.shape;
        if (shape.kind === "rectangle" && shape.corner1 && shape.corner2) {
          addBoundsPoint(bounds, shape.corner1);
          addBoundsPoint(bounds, shape.corner2);
        } else if (
          shape.kind === "circle" &&
          shape.center &&
          shape.radius != null
        ) {
          addBoundsPoint(bounds, {
            x: shape.center.x - shape.radius,
            y: shape.center.y - shape.radius,
          });
          addBoundsPoint(bounds, {
            x: shape.center.x + shape.radius,
            y: shape.center.y + shape.radius,
          });
        } else if (
          shape.kind === "ellipse" &&
          shape.center &&
          shape.radius != null &&
          shape.radiusY != null
        ) {
          addBoundsPoint(bounds, {
            x: shape.center.x - shape.radius,
            y: shape.center.y - shape.radiusY,
          });
          addBoundsPoint(bounds, {
            x: shape.center.x + shape.radius,
            y: shape.center.y + shape.radiusY,
          });
        }
      }
      for (const segment of subpath.segments) {
        addBoundsPoint(bounds, segment.from.point);
        addBoundsPoint(bounds, segment.to.point);
        if (segment.kind === "cubic") {
          const geometry = segment.geometry as CurveGeometry;
          for (let step = 1; step < 8; step += 1) {
            addBoundsPoint(
              bounds,
              cubicPoint(geometry.from, geometry.c1, geometry.c2, geometry.to, step / 8),
            );
          }
        }
      }
    }
  }
  for (const label of labels) addBounds(bounds, label.bounds);

  return {
    source,
    nodes,
    coordinates,
    paths,
    labels,
    frames,
    issues: state.issues,
    bounds: finalizeBounds(bounds),
    stats: {
      nodes: nodes.length,
      paths: paths.length,
      labels: labels.length,
      lines: paths.reduce(
        (count, path) =>
          count + path.subpaths.reduce((sum, subpath) => sum + subpath.segments.length, 0),
        0,
      ),
    },
    hasPicture,
    pictureSpan,
    colorDefinitions: state.definitions,
  };
}

function readEnvironmentName(
  masked: string,
  cursor: number,
  limit: number,
): { name: string; afterBegin: number } | null {
  let index = skipWhitespace(masked, cursor, limit);
  if (masked[index] !== "{") return null;
  const group = readBalancedContent(masked, index);
  if (!group) return null;
  const name = masked.slice(group.innerStart, group.innerEnd).trim();
  index = group.end;
  index = skipWhitespace(masked, index, limit);
  if (masked[index] === "[") {
    const optionBlock = readOptionBlock(masked, index, limit);
    if (optionBlock) index = optionBlock.next;
  }
  return { name, afterBegin: index };
}

function skipGroupCommand(masked: string, cursor: number, limit: number): number {
  let index = cursor;
  let lastGroupEnd = cursor;

  while (index < limit) {
    index = skipWhitespace(masked, index, limit);
    const char = masked[index];
    if (char === "[") {
      const group = readBalancedContent(masked, index, "[", "]");
      if (!group) break;
      index = group.end;
      continue;
    }
    if (char === "(") {
      const group = readBalancedContent(masked, index, "(", ")");
      if (!group) break;
      index = group.end;
      continue;
    }
    if (char === "{") {
      const group = readBalancedContent(masked, index);
      if (!group) break;
      lastGroupEnd = group.end;
      index = group.end;
      continue;
    }
    break;
  }

  if (lastGroupEnd > cursor) {
    const semicolon = skipWhitespace(masked, lastGroupEnd, limit);
    return masked[semicolon] === ";" ? semicolon + 1 : lastGroupEnd;
  }

  const end = findCommandEnd(masked, cursor, limit);
  return end;
}

function parsePathCommand(
  state: ParserState,
  start: number,
  nameEnd: number,
  commandEnd: number,
  index: number,
  commandName: string,
  picture: {
    everyPathTokens: ParsedOption[];
    everyLabelTokens: ParsedOption[];
    styles: StyleMap;
    plotDomain?: PlotDomain;
    plotSamples?: number;
  },
  context: CoordinateContext,
): TikzPath | null {
  let cursor = skipWhitespace(state.masked, nameEnd, commandEnd);
  const localTokens: ParsedOption[] = [];
  while (state.masked[cursor] === "[") {
    const block = readOptionBlock(state.masked, cursor, commandEnd);
    if (!block) break;
    localTokens.push(
      ...parseOptionTokens(state.masked, block.innerStart, block.innerEnd).map((token) => ({
        key: token.key,
        value: token.value,
        raw: token.raw,
      })),
    );
    cursor = block.next;
    cursor = skipWhitespace(state.masked, cursor, commandEnd);
  }

  const expanded = expandStyleTokens([...picture.everyPathTokens, ...localTokens], picture.styles);
  const { style, stroke, fill } = parsePathStyle(expanded, state, commandName);
  const pathDomain = plotTokenDomain(expanded) ?? picture.plotDomain;
  const pathSamples = plotTokenSamples(expanded) ?? picture.plotSamples;
  const pathStepToken = [...expanded].reverse().find((token) => token.key.trim() === "step");
  const pathXStepToken = [...expanded].reverse().find((token) => token.key.trim() === "xstep");
  const pathYStepToken = [...expanded].reverse().find((token) => token.key.trim() === "ystep");
  const defaultGridStep = parseDimension(pathStepToken?.value, 1) ?? 1;
  const defaultGridXStep = parseDimension(pathXStepToken?.value, defaultGridStep) ?? defaultGridStep;
  const defaultGridYStep = parseDimension(pathYStepToken?.value, defaultGridStep) ?? defaultGridStep;

  const rawSubpaths: RawSubpath[] = [];
  let currentRawEndpoint: RawPathEndpoint | null = null;
  let currentSubpath: RawSubpath | null = null;
  let lastPoint: Point | null = null;
  let lastSegment: RawSegment | null = null;
  let pendingLabels: RawLabel[] = [];
  let subpathOpen = false;

  const createSubpath = (endpoint: RawPathEndpoint): RawSubpath => ({
    start: endpoint,
    segments: [],
    closed: false,
  });

  while (cursor < commandEnd) {
    cursor = skipWhitespace(state.masked, cursor, commandEnd);
    if (cursor >= commandEnd) break;
    if (state.masked[cursor] === ";") break;

    if (state.masked.startsWith("node", cursor) && !/[A-Za-z@]/.test(state.masked[cursor + 4] ?? "")) {
      const parsed = parsePathNodeLabel(
        state,
        cursor,
        commandEnd,
        subpathOpen ? 1 : 0.5,
        picture.everyLabelTokens,
        picture.styles,
        state.definitions,
      );
      if (parsed) {
        if (lastSegment) {
          parsed.label.position = parsed.label.position < 0 ? 1 : parsed.label.position;
          lastSegment.labels.push(parsed.label);
        } else {
          pendingLabels.push(parsed.label);
        }
        cursor = parsed.next;
        continue;
      }
    }

    if (state.masked.startsWith("--", cursor)) {
      const connectorSpan = { start: cursor, end: cursor + 2 };
      cursor += 2;
      const labels: RawLabel[] = [];
      cursor = skipWhitespace(state.masked, cursor, commandEnd);
      while (
        cursor < commandEnd &&
        state.masked.startsWith("node", cursor) &&
        !/[A-Za-z@]/.test(state.masked[cursor + 4] ?? "")
      ) {
        const parsed = parsePathNodeLabel(
          state,
          cursor,
          commandEnd,
          0.5,
          picture.everyLabelTokens,
          picture.styles,
          state.definitions,
        );
        if (!parsed) break;
        labels.push(parsed.label);
        cursor = parsed.next;
        cursor = skipWhitespace(state.masked, cursor, commandEnd);
      }
      if (state.masked.startsWith("cycle", cursor)) {
        if (currentSubpath) currentSubpath.closed = true;
        cursor += 5;
        lastSegment = null;
        subpathOpen = false;
        continue;
      }
      const endpointResult = readPathEndpoint(state, cursor, commandEnd, context, lastPoint);
      if (!endpointResult) {
        cursor += 1;
        continue;
      }
      if (!currentSubpath || !currentRawEndpoint) {
        currentSubpath = createSubpath(endpointResult.endpoint);
        rawSubpaths.push(currentSubpath);
        currentRawEndpoint = endpointResult.endpoint;
        lastSegment = null;
        subpathOpen = true;
      } else {
        const segment = makeSegment(
          "line",
          currentRawEndpoint,
          endpointResult.endpoint,
          [...pendingLabels, ...labels],
        );
        segment.connectorSpan = connectorSpan;
        currentSubpath.segments.push(segment);
        lastSegment = segment;
        currentRawEndpoint = endpointResult.endpoint;
      }
      pendingLabels = [];
      lastPoint = endpointResult.endpoint.point;
      cursor = endpointResult.next;
      subpathOpen = true;
      continue;
    }

    if (state.masked.startsWith("-|", cursor) || state.masked.startsWith("|-", cursor)) {
      const kind = state.masked.startsWith("-|", cursor)
        ? "horizontal-vertical"
        : "vertical-horizontal";
      const connectorSpan = { start: cursor, end: cursor + 2 };
      cursor += 2;
      const labels: RawLabel[] = [];
      cursor = skipWhitespace(state.masked, cursor, commandEnd);
      while (
        cursor < commandEnd &&
        state.masked.startsWith("node", cursor) &&
        !/[A-Za-z@]/.test(state.masked[cursor + 4] ?? "")
      ) {
        const parsed = parsePathNodeLabel(
          state,
          cursor,
          commandEnd,
          0.5,
          picture.everyLabelTokens,
          picture.styles,
          state.definitions,
        );
        if (!parsed) break;
        labels.push(parsed.label);
        cursor = parsed.next;
        cursor = skipWhitespace(state.masked, cursor, commandEnd);
      }
      const endpointResult = readPathEndpoint(state, cursor, commandEnd, context, lastPoint);
      if (!endpointResult) {
        cursor += 1;
        continue;
      }
      if (!currentSubpath || !currentRawEndpoint) {
        currentSubpath = createSubpath(endpointResult.endpoint);
        rawSubpaths.push(currentSubpath);
        currentRawEndpoint = endpointResult.endpoint;
        lastSegment = null;
        subpathOpen = true;
      } else {
        const segment = makeSegment(
          kind,
          currentRawEndpoint,
          endpointResult.endpoint,
          [...pendingLabels, ...labels],
        );
        segment.connectorSpan = connectorSpan;
        currentSubpath.segments.push(segment);
        lastSegment = segment;
        currentRawEndpoint = endpointResult.endpoint;
      }
      pendingLabels = [];
      lastPoint = endpointResult.endpoint.point;
      cursor = endpointResult.next;
      subpathOpen = true;
      continue;
    }

    if (state.masked.startsWith("to", cursor) && !/[A-Za-z@]/.test(state.masked[cursor + 2] ?? "")) {
      const connectorStart = cursor;
      cursor += 2;
      const toTokens: ParsedOption[] = [];
      cursor = skipWhitespace(state.masked, cursor, commandEnd);
      if (state.masked[cursor] === "[") {
        const block = readOptionBlock(state.masked, cursor, commandEnd);
        if (block) {
          toTokens.push(
            ...parseOptionTokens(state.masked, block.innerStart, block.innerEnd).map((token) => ({
              key: token.key,
              value: token.value,
              raw: token.raw,
            })),
          );
          cursor = block.next;
        }
      }
      const connectorSpan = { start: connectorStart, end: cursor };
      const labels: RawLabel[] = [];
      cursor = skipWhitespace(state.masked, cursor, commandEnd);
      while (
        cursor < commandEnd &&
        state.masked.startsWith("node", cursor) &&
        !/[A-Za-z@]/.test(state.masked[cursor + 4] ?? "")
      ) {
        const parsed = parsePathNodeLabel(
          state,
          cursor,
          commandEnd,
          0.5,
          picture.everyLabelTokens,
          picture.styles,
          state.definitions,
        );
        if (!parsed) break;
        labels.push(parsed.label);
        cursor = parsed.next;
        cursor = skipWhitespace(state.masked, cursor, commandEnd);
      }
      const endpointResult = readPathEndpoint(state, cursor, commandEnd, context, lastPoint);
      if (!endpointResult) {
        cursor += 1;
        continue;
      }
      let bend: RawSegment["bend"] | undefined = style.bend;
      const bendToken = [...toTokens]
        .reverse()
        .find((token) => token.key.trim() === "bend left" || token.key.trim() === "bend right");
      if (bendToken) {
        const angle = bendToken.value ? Number.parseFloat(bendToken.value) : 20;
        bend = {
          direction: bendToken.key.trim().endsWith("left") ? "left" : "right",
          angle: Number.isFinite(angle) ? angle : 20,
        };
      }
      if (!currentSubpath || !currentRawEndpoint) {
        currentSubpath = createSubpath(endpointResult.endpoint);
        rawSubpaths.push(currentSubpath);
        currentRawEndpoint = endpointResult.endpoint;
        lastSegment = null;
        subpathOpen = true;
      } else {
        const segment = makeSegment(
          bend ? "curve" : "line",
          currentRawEndpoint,
          endpointResult.endpoint,
          [...pendingLabels, ...labels],
          undefined,
          bend,
        );
        segment.connectorSpan = connectorSpan;
        currentSubpath.segments.push(segment);
        lastSegment = segment;
        currentRawEndpoint = endpointResult.endpoint;
      }
      pendingLabels = [];
      lastPoint = endpointResult.endpoint.point;
      cursor = endpointResult.next;
      subpathOpen = true;
      continue;
    }

    if (state.masked.startsWith("plot", cursor) && !/[A-Za-z@]/.test(state.masked[cursor + 4] ?? "")) {
      const plotTokens: ParsedOption[] = [];
      let plotCursor = skipWhitespace(state.masked, cursor + 4, commandEnd);
      while (state.masked[plotCursor] === "[") {
        const block = readOptionBlock(state.masked, plotCursor, commandEnd);
        if (!block) break;
        plotTokens.push(
          ...parseOptionTokens(state.masked, block.innerStart, block.innerEnd).map((token) => ({
            key: token.key,
            value: token.value,
            raw: token.raw,
          })),
        );
        plotCursor = skipWhitespace(state.masked, block.next, commandEnd);
      }

      const plotDomain = plotTokenDomain(plotTokens) ?? pathDomain ?? DEFAULT_PLOT_DOMAIN;
      const plotSamples = plotTokenSamples(plotTokens) ?? pathSamples ?? DEFAULT_PLOT_SAMPLES;
      const variableToken = [...plotTokens].reverse().find((token) => token.key.trim() === "variable");
      const variable = (variableToken?.value ?? "x").replace(/\\/g, "").trim() || "x";
      const isCoordinates =
        state.masked.startsWith("coordinates", plotCursor) &&
        !/[A-Za-z@]/.test(state.masked[plotCursor + "coordinates".length] ?? "");
      const sampledPoints: Point[] = [];

      if (isCoordinates) {
        let groupCursor = skipWhitespace(
          state.masked,
          plotCursor + "coordinates".length,
          commandEnd,
        );
        if (state.masked[groupCursor] !== "{") {
          addIssue(state, "plot-coordinates", "plot coordinates 缺少坐标组", {
            detail: "已跳过该 plot，其余图形仍会渲染。",
          });
          cursor = plotCursor;
          continue;
        }
        const group = readBalancedContent(state.masked, groupCursor);
        if (!group) {
          cursor = plotCursor;
          continue;
        }
        let inner = group.innerStart;
        while (inner < group.innerEnd) {
          inner = skipWhitespace(state.masked, inner, group.innerEnd);
          if (state.masked[inner] !== "(") {
            inner += 1;
            continue;
          }
          const pointGroup = readBalancedContent(state.masked, inner, "(", ")");
          if (!pointGroup) break;
          const raw = state.source.slice(pointGroup.innerStart, pointGroup.innerEnd).trim();
          const resolved = resolveRawCoordinate(raw, context);
          if (resolved && Number.isFinite(resolved.point.x)) {
            sampledPoints.push(resolved.point);
          }
          inner = pointGroup.end;
        }
        plotCursor = group.end;
      } else if (state.masked[plotCursor] === "(") {
        const group = readBalancedContent(state.masked, plotCursor, "(", ")");
        if (!group) {
          cursor = plotCursor;
          continue;
        }
        const parts = splitTopLevel(state.source, group.innerStart, group.innerEnd, ",");
        if (parts.length !== 2) {
          addIssue(state, "plot-expression", "plot 需要 (x,y) 两个坐标表达式", {
            detail: "已跳过该 plot，其余图形仍会渲染。",
          });
          cursor = group.end;
          continue;
        }
        const xExpression = compileMathExpression(parts[0].text, [variable]);
        const yExpression = compileMathExpression(parts[1].text, [variable]);
        if (!xExpression || !yExpression) {
          addIssue(state, "plot-expression", `无法解析函数 plot (${parts[0].text},${parts[1].text})`, {
            detail: "支持 sin、cos、exp、sqrt 等 PGF 数学函数与 + - * / ^ 运算。",
          });
          cursor = group.end;
          continue;
        }
        const samples = Math.max(2, plotSamples);
        for (let sample = 0; sample < samples; sample += 1) {
          const t =
            samples === 1
              ? plotDomain.min
              : plotDomain.min + ((plotDomain.max - plotDomain.min) * sample) / (samples - 1);
          const values = { [variable]: t };
          const x = xExpression(values);
          const y = yExpression(values);
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
          sampledPoints.push({ x, y });
        }
        plotCursor = group.end;
      } else {
        cursor = plotCursor;
        continue;
      }

      if (sampledPoints.length >= 2) {
        const start = generatedEndpoint(sampledPoints[0]);
        const generatedSubpath: RawSubpath = {
          start,
          segments: [],
          closed: false,
          generated: true,
        };
        let previous = start;
        for (let sample = 1; sample < sampledPoints.length; sample += 1) {
          const to = generatedEndpoint(sampledPoints[sample]);
          const segment = makeSegment(
            "line",
            previous,
            to,
            sample === 1 ? [...pendingLabels] : [],
          );
          segment.generated = true;
          generatedSubpath.segments.push(segment);
          previous = to;
        }
        pendingLabels = [];
        rawSubpaths.push(generatedSubpath);
        currentSubpath = generatedSubpath;
        currentRawEndpoint = previous;
        lastSegment = generatedSubpath.segments[generatedSubpath.segments.length - 1];
        lastPoint = sampledPoints[sampledPoints.length - 1];
      } else {
        addIssue(state, "plot-empty", "plot 没有产生可渲染的采样点", {
          detail: "请检查 domain 与函数表达式。",
        });
      }
      cursor = plotCursor;
      subpathOpen = true;
      continue;
    }

    if (state.masked.startsWith("grid", cursor) && !/[A-Za-z@]/.test(state.masked[cursor + 4] ?? "")) {
      const gridTokens: ParsedOption[] = [];
      let gridCursor = skipWhitespace(state.masked, cursor + 4, commandEnd);
      while (state.masked[gridCursor] === "[") {
        const block = readOptionBlock(state.masked, gridCursor, commandEnd);
        if (!block) break;
        gridTokens.push(
          ...parseOptionTokens(state.masked, block.innerStart, block.innerEnd).map((token) => ({
            key: token.key,
            value: token.value,
            raw: token.raw,
          })),
        );
        gridCursor = skipWhitespace(state.masked, block.next, commandEnd);
      }
      const endpointResult = readPathEndpoint(state, gridCursor, commandEnd, context, lastPoint);
      if (!endpointResult) {
        cursor = gridCursor;
        continue;
      }
      const from = currentRawEndpoint?.point ?? lastPoint;
      if (!from) {
        cursor = endpointResult.next;
        continue;
      }
      const gridStepToken = [...gridTokens].reverse().find((token) => token.key.trim() === "step");
      const gridXStepToken = [...gridTokens].reverse().find((token) => token.key.trim() === "xstep");
      const gridYStepToken = [...gridTokens].reverse().find((token) => token.key.trim() === "ystep");
      const step = parseDimension(gridStepToken?.value, defaultGridStep) ?? defaultGridStep;
      const xStep = parseDimension(gridXStepToken?.value, step) ?? step;
      const yStep = parseDimension(gridYStepToken?.value, step) ?? step;
      const target = endpointResult.endpoint.point;

      const axisValues = (startValue: number, endValue: number, stride: number): number[] => {
        const values = [startValue];
        const distanceValue = endValue - startValue;
        if (Math.abs(distanceValue) < 1e-9) return values;
        const directionValue = Math.sign(distanceValue);
        const stepValue = Math.max(0.02, Math.abs(stride)) * directionValue;
        let current = startValue;
        let guard = 0;
        while (guard < 200) {
          current += stepValue;
          if (directionValue > 0 ? current >= endValue - 1e-9 : current <= endValue + 1e-9) break;
          values.push(current);
          guard += 1;
        }
        if (Math.abs(values[values.length - 1] - endValue) > 1e-6) values.push(endValue);
        return values;
      };

      const xs = axisValues(from.x, target.x, xStep);
      const ys = axisValues(from.y, target.y, yStep);
      let gridSegmentCount = 0;
      let lastGridSegment: RawSegment | null = null;

      for (const x of xs) {
        const start = generatedEndpoint({ x, y: from.y });
        const to = generatedEndpoint({ x, y: target.y });
        const segment = makeSegment("line", start, to, []);
        segment.generated = true;
        rawSubpaths.push({ start, segments: [segment], closed: false, generated: true });
        lastGridSegment = segment;
        gridSegmentCount += 1;
      }
      for (const y of ys) {
        const start = generatedEndpoint({ x: from.x, y });
        const to = generatedEndpoint({ x: target.x, y });
        const segment = makeSegment("line", start, to, []);
        segment.generated = true;
        rawSubpaths.push({ start, segments: [segment], closed: false, generated: true });
        lastGridSegment = segment;
        gridSegmentCount += 1;
      }
      if (gridSegmentCount > 0) {
        lastSegment = lastGridSegment;
      }
      const continuation: RawSubpath = {
        start: endpointResult.endpoint,
        segments: [],
        closed: false,
        generated: true,
      };
      rawSubpaths.push(continuation);
      currentSubpath = continuation;
      currentRawEndpoint = endpointResult.endpoint;
      lastPoint = target;
      cursor = endpointResult.next;
      subpathOpen = true;
      continue;
    }

    if (state.masked.startsWith("..", cursor)) {
      const connectorStart = cursor;
      cursor += 2;
      cursor = skipWhitespace(state.masked, cursor, commandEnd);
      if (state.masked.startsWith("controls", cursor)) {
        cursor += "controls".length;
        cursor = skipWhitespace(state.masked, cursor, commandEnd);
        const first = readPathEndpoint(state, cursor, commandEnd, context, lastPoint);
        if (!first) {
          cursor += 1;
          continue;
        }
        cursor = skipWhitespace(state.masked, first.next, commandEnd);
        let second: { endpoint: RawPathEndpoint; next: number } | null = null;
        if (state.masked.startsWith("and", cursor)) {
          cursor = skipWhitespace(state.masked, cursor + 3, commandEnd);
          second = readPathEndpoint(state, cursor, commandEnd, context, lastPoint);
          if (second) cursor = second.next;
        }
        cursor = skipWhitespace(state.masked, cursor, commandEnd);
        if (state.masked.startsWith("..", cursor)) cursor += 2;
        const connectorSpan = { start: connectorStart, end: cursor };
        cursor = skipWhitespace(state.masked, cursor, commandEnd);
        const labels: RawLabel[] = [];
        while (
          cursor < commandEnd &&
          state.masked.startsWith("node", cursor) &&
          !/[A-Za-z@]/.test(state.masked[cursor + 4] ?? "")
        ) {
          const parsed = parsePathNodeLabel(
            state,
            cursor,
            commandEnd,
            0.5,
            picture.everyLabelTokens,
            picture.styles,
            state.definitions,
          );
          if (!parsed) break;
          labels.push(parsed.label);
          cursor = parsed.next;
          cursor = skipWhitespace(state.masked, cursor, commandEnd);
        }
        const endpointResult = readPathEndpoint(state, cursor, commandEnd, context, lastPoint);
        if (!endpointResult) {
          cursor += 1;
          continue;
        }
        if (currentSubpath && currentRawEndpoint) {
          const segment = makeSegment(
            "curve",
            currentRawEndpoint,
            endpointResult.endpoint,
            [...pendingLabels, ...labels],
            [first.endpoint, second?.endpoint ?? first.endpoint],
          );
          segment.connectorSpan = connectorSpan;
          currentSubpath.segments.push(segment);
          lastSegment = segment;
          currentRawEndpoint = endpointResult.endpoint;
        } else {
          currentSubpath = createSubpath(endpointResult.endpoint);
          rawSubpaths.push(currentSubpath);
          currentRawEndpoint = endpointResult.endpoint;
          lastSegment = null;
          subpathOpen = true;
        }
        pendingLabels = [];
        lastPoint = endpointResult.endpoint.point;
        cursor = endpointResult.next;
        subpathOpen = true;
        continue;
      }
      cursor += 1;
      continue;
    }

    if (state.masked.startsWith("rectangle", cursor)) {
      cursor += "rectangle".length;
      const endpointResult = readPathEndpoint(state, cursor, commandEnd, context, lastPoint);
      if (endpointResult && currentSubpath && currentRawEndpoint) {
        const patchable =
          !currentRawEndpoint.relative &&
          !currentRawEndpoint.nodeRef &&
          !endpointResult.endpoint.relative &&
          !endpointResult.endpoint.nodeRef &&
          !endpointResult.endpoint.rawAnchor &&
          Boolean(currentRawEndpoint.sourceSpan) &&
          Boolean(endpointResult.endpoint.sourceSpan);
        currentSubpath.shape = {
          kind: "rectangle",
          corner1: currentRawEndpoint.point,
          corner2: endpointResult.endpoint.point,
          corner1Span: patchable ? currentRawEndpoint.sourceSpan : undefined,
          corner2Span: patchable ? endpointResult.endpoint.sourceSpan : undefined,
        };
      }
      lastPoint = endpointResult?.endpoint.point ?? lastPoint;
      cursor = endpointResult?.next ?? cursor + 1;
      continue;
    }

    if (state.masked.startsWith("circle", cursor)) {
      cursor += "circle".length;
      cursor = skipWhitespace(state.masked, cursor, commandEnd);
      let radius: number | null = null;
      if (state.masked[cursor] === "(") {
        const group = readBalancedContent(state.masked, cursor, "(", ")");
        if (group) {
          radius = parseDimension(state.source.slice(group.innerStart, group.innerEnd).trim()) ?? null;
          cursor = group.end;
        }
      }
      if (radius != null && currentSubpath && currentRawEndpoint) {
        currentSubpath.shape = {
          kind: "circle",
          center: currentRawEndpoint.point,
          radius,
        };
      }
      continue;
    }

    if (state.masked[cursor] === "(" || state.masked.startsWith("++", cursor) || state.masked[cursor] === "+") {
      const endpointResult = readPathEndpoint(state, cursor, commandEnd, context, lastPoint);
      if (!endpointResult) {
        cursor += 1;
        continue;
      }
      currentSubpath = createSubpath(endpointResult.endpoint);
      rawSubpaths.push(currentSubpath);
      currentRawEndpoint = endpointResult.endpoint;
      lastSegment = null;
      subpathOpen = true;
      pendingLabels = [];
      lastPoint = endpointResult.endpoint.point;
      cursor = endpointResult.next;
      continue;
    }

    if (state.masked.startsWith("arc", cursor)) {
      addIssue(state, "arc", "arc 暂时按直线连接处理", {
        detail: "可用节点与 -- 连接得到等效的简化图形。",
      });
      const nextOpen = state.masked.indexOf("(", cursor);
      if (nextOpen >= 0) {
        const group = readBalancedContent(state.masked, nextOpen, "(", ")");
        cursor = group?.end ?? nextOpen + 1;
      } else {
        cursor += 3;
      }
      continue;
    }

    cursor += 1;
  }

  const subpaths: PathSubpath[] = [];
  let labelCounter = 0;
  for (const rawSubpath of rawSubpaths) {
    const subpath: PathSubpath = {
      start: resolveEndpointForRender(rawSubpath.start),
      segments: [],
      closed: rawSubpath.closed || Boolean(fill),
      shape: rawSubpath.shape,
      generated: rawSubpath.generated,
    };

    for (const rawSegment of rawSubpath.segments) {
      const fromBase = resolveEndpointForRender(rawSegment.from);
      const toBase = resolveEndpointForRender(rawSegment.to);
      const controlPoints =
        rawSegment.controls?.map((control) => resolveEndpointForRender(control).point) ?? [];

      let fromPoint = fromBase.point;
      let toPoint = toBase.point;
      if (fromBase.nodeRef && !fromBase.rawAnchor) {
        fromPoint = borderPoint(
          fromBase.nodeRef,
          controlPoints[0] ?? toBase.point,
        );
      }
      if (toBase.nodeRef && !toBase.rawAnchor) {
        toPoint = borderPoint(
          toBase.nodeRef,
          controlPoints[1] ?? fromBase.point,
        );
      }

      const from: ResolvedEndpoint = {
        ...fromBase,
        point: fromPoint,
        isBorderPoint: Boolean(fromBase.nodeRef && !fromBase.rawAnchor),
      };
      const to: ResolvedEndpoint = {
        ...toBase,
        point: toPoint,
        isBorderPoint: Boolean(toBase.nodeRef && !toBase.rawAnchor),
      };

      let geometry: LineGeometry | CurveGeometry;

      if (rawSegment.kind === "curve") {
        if (controlPoints.length === 2) {
          geometry = {
            from: from.point,
            c1: controlPoints[0],
            c2: controlPoints[1],
            to: to.point,
          };
        } else if (rawSegment.bend) {
          const dx = to.point.x - from.point.x;
          const dy = to.point.y - from.point.y;
          const length = Math.max(Math.hypot(dx, dy), 0.001);
          const nx = -dy / length;
          const ny = dx / length;
          const sign = rawSegment.bend.direction === "left" ? 1 : -1;
          const offset = Math.tan((rawSegment.bend.angle * Math.PI) / 180) * length * 0.5 * sign;
          geometry = {
            from: from.point,
            c1: {
              x: from.point.x + dx / 3 + nx * offset,
              y: from.point.y + dy / 3 + ny * offset,
            },
            c2: {
              x: from.point.x + (dx * 2) / 3 + nx * offset,
              y: from.point.y + (dy * 2) / 3 + ny * offset,
            },
            to: to.point,
          };
        } else {
          geometry = {
            from: from.point,
            to: to.point,
            kind: "line",
          };
        }
      } else {
        geometry = {
          from: from.point,
          to: to.point,
          kind: rawSegment.kind,
        };
      }

      const labels = rawSegment.labels.map((rawLabel) => {
        const labelPoint = labelPointOnGeometry(geometry, rawLabel.position, rawSegment.kind);
        const point = {
          x: labelPoint.x + rawLabel.xOffset,
          y: labelPoint.y + rawLabel.yOffset,
        };
        const fontMetrics = measureTikzText(rawLabel.text, rawLabel.style.fontSize);
        const bounds = labelBounds(
          point,
          fontMetrics.widthPx / PX_PER_CM + 0.12,
          fontMetrics.heightPx / PX_PER_CM + 0.06,
        );
        const currentLabelIndex = labelCounter;
        labelCounter += 1;
        const label: TikzLabel = {
          kind: "label",
          key: `label-${index}-${currentLabelIndex}`,
          pathIndex: index,
          labelIndex: currentLabelIndex,
          text: rawLabel.text,
          textSpan: rawLabel.textSpan,
          commandNameEnd: rawLabel.commandNameEnd,
          optionBlocks: rawLabel.optionBlocks,
          sourceShift: rawLabel.sourceShift,
          rawText: rawLabel.text,
          position: point,
          fontSize: rawLabel.style.fontSize,
          textColor: rawLabel.style.textColor,
          fill: rawLabel.style.fill,
          draw: rawLabel.style.draw,
          above: rawLabel.orientation === "above",
          below: rawLabel.orientation === "below",
          left: rawLabel.orientation === "left",
          right: rawLabel.orientation === "right",
          sourcePosition: rawLabel.position,
          bounds,
        };
        return label;
      });

      subpath.segments.push({
        kind: rawSegment.kind === "curve" ? "cubic" : rawSegment.kind,
        raw: {
          raw: rawSegment.to.raw,
          nodeRef: rawSegment.to.nodeRef?.name,
          nodeAnchor: rawSegment.to.rawAnchor,
          isRelative: Boolean(rawSegment.to.relative),
          sourceSpan: rawSegment.to.sourceSpan,
        },
        geometry,
        from,
        to,
        labels,
        connectorSpan: rawSegment.connectorSpan,
        generated: rawSegment.generated,
      });
    }

    subpaths.push(subpath);
  }

  return {
    kind: "path",
    key: `path-${index}`,
    index,
    commandSpan: { start, end: commandEnd },
    style,
    subpaths,
    labels: subpaths.flatMap((subpath) => subpath.segments.flatMap((segment) => segment.labels)),
    fill,
    stroke,
    generated:
      subpaths.length > 0 &&
      subpaths.every(
        (subpath) =>
          subpath.generated &&
          (subpath.segments.length === 0 ||
            subpath.segments.every((segment) => segment.generated)),
      ),
  };
}

function labelPointOnGeometry(
  geometry: LineGeometry | CurveGeometry,
  fraction: number,
  kind: RawSegment["kind"],
): Point {
  if ("c1" in geometry) {
    return cubicPoint(geometry.from, geometry.c1, geometry.c2, geometry.to, fraction);
  }
  if (kind === "horizontal-vertical" || kind === "vertical-horizontal") {
    return positionOnOrthogonal(
      geometry.from,
      geometry.to,
      kind,
      fraction,
    );
  }
  return pointOnLine(geometry.from, geometry.to, fraction);
}

function resolveEndpointForRender(endpoint: RawPathEndpoint): ResolvedEndpoint {
  return {
    point: endpoint.point,
    nodeRef: endpoint.nodeRef,
    rawAnchor: endpoint.rawAnchor,
    isBorderPoint: Boolean(endpoint.nodeRef && !endpoint.rawAnchor),
    raw: endpoint.raw,
    sourceSpan: endpoint.sourceSpan,
  };
}
