import type { Point, TikzNode } from "./types";
import { evaluateExpression, splitTopLevel } from "./options";

export interface CoordinateContext {
  nodes: Map<string, TikzNode>;
  coordinates: Map<string, Point>;
}

export interface ResolvedRawCoordinate {
  point: Point;
  nodeRef?: TikzNode;
  rawAnchor?: string;
  unresolvedName?: string;
}

export interface NamedReference {
  name: string;
  anchor?: string;
}

export function parseNamedReference(raw: string): NamedReference | null {
  const text = raw.trim();
  if (!text) return null;

  const anchorMatch = text.match(/^([A-Za-z0-9@:_\-]+)\.([A-Za-z ]+)$/);
  if (anchorMatch) {
    return { name: anchorMatch[1].trim(), anchor: anchorMatch[2].trim() };
  }
  if (/^[A-Za-z0-9@:_\-]+$/.test(text)) {
    return { name: text };
  }
  return null;
}

export function roundedCornerRadius(node: TikzNode): number {
  if (node.style.shape !== "rounded") return 0;
  return Math.max(
    0,
    Math.min(node.style.cornerRadius, node.width / 2, node.height / 2),
  );
}

export function anchorOffset(node: TikzNode, anchorRaw: string | undefined): Point {
  const anchor = (anchorRaw ?? "center").trim().toLowerCase().replace(/\s+/g, " ");
  const halfWidth = node.width / 2;
  const halfHeight = node.height / 2;
  const round = node.style.shape === "circle" || node.style.shape === "ellipse";
  const diamond = node.style.shape === "diamond";
  const radius = roundedCornerRadius(node);
  const rounded = radius > 0;
  const roundedInset = radius * (1 - Math.SQRT1_2);
  const cornerX = round
    ? halfWidth * Math.SQRT1_2
    : diamond
      ? halfWidth / 2
      : rounded
        ? halfWidth - roundedInset
        : halfWidth;
  const cornerY = round
    ? halfHeight * Math.SQRT1_2
    : diamond
      ? halfHeight / 2
      : rounded
        ? halfHeight - roundedInset
        : halfHeight;

  switch (anchor) {
    case "north":
      return { x: 0, y: halfHeight };
    case "south":
      return { x: 0, y: -halfHeight };
    case "east":
      return { x: halfWidth, y: 0 };
    case "west":
      return { x: -halfWidth, y: 0 };
    case "north east":
    case "northeast":
      return { x: cornerX, y: cornerY };
    case "north west":
    case "northwest":
      return { x: -cornerX, y: cornerY };
    case "south east":
    case "southeast":
      return { x: cornerX, y: -cornerY };
    case "south west":
    case "southwest":
      return { x: -cornerX, y: -cornerY };
    case "base":
      return { x: 0, y: -halfHeight + node.style.fontSize * 0.18 / 48 };
    case "mid":
    case "center":
    default:
      return { x: 0, y: 0 };
  }
}

export function nodeAnchorPoint(node: TikzNode, anchor: string | undefined): Point {
  const offset = anchorOffset(node, anchor);
  return { x: node.x + offset.x, y: node.y + offset.y };
}

function isFinitePoint(node: TikzNode): boolean {
  return Number.isFinite(node.x) && Number.isFinite(node.y);
}

function resolveCalcCoordinate(
  raw: string,
  context: CoordinateContext,
): ResolvedRawCoordinate | null {
  if (!raw.startsWith("$") || !raw.endsWith("$")) return null;
  const expression = raw.slice(1, -1).trim();

  const midpointMatch = expression.match(
    /^\(([^)]+)\)\s*!\s*([0-9.]+)\s*!\s*\(([^)]+)\)$/,
  );
  if (midpointMatch) {
    const first = resolveRawCoordinate(midpointMatch[1], context);
    const second = resolveRawCoordinate(midpointMatch[3], context);
    if (!first || !second) return null;
    const fraction = Number.parseFloat(midpointMatch[2]);
    if (!Number.isFinite(fraction)) return null;
    return {
      point: {
        x: first.point.x + (second.point.x - first.point.x) * fraction,
        y: first.point.y + (second.point.y - first.point.y) * fraction,
      },
    };
  }

  const sumMatch = expression.match(/^\(([^)]+)\)\s*\+\s*\(([^)]+)\)$/);
  if (sumMatch) {
    const first = resolveRawCoordinate(sumMatch[1], context);
    const offset = parseNumericPair(sumMatch[2]);
    if (!first || !offset) return null;
    return { point: { x: first.point.x + offset.x, y: first.point.y + offset.y } };
  }

  const differenceMatch = expression.match(/^\(([^)]+)\)\s*-\s*\(([^)]+)\)$/);
  if (differenceMatch) {
    const first = resolveRawCoordinate(differenceMatch[1], context);
    const offset = parseNumericPair(differenceMatch[2]);
    if (!first || !offset) return null;
    return { point: { x: first.point.x - offset.x, y: first.point.y - offset.y } };
  }

  return null;
}

export function parseNumericPair(raw: string): Point | null {
  const parts = splitTopLevel(raw, 0, raw.length, ",");
  if (parts.length !== 2) return null;
  const x = evaluateExpression(parts[0].text);
  const y = evaluateExpression(parts[1].text);
  if (x == null || y == null) return null;
  return { x, y };
}

export function resolveRawCoordinate(
  raw: string,
  context: CoordinateContext,
): ResolvedRawCoordinate | null {
  const text = raw.trim();
  if (!text) return null;

  const plusMinus = text.match(/^([+-])\s*\((.*)\)$/s);
  if (plusMinus) {
    return resolveRawCoordinate(plusMinus[2], context);
  }

  if (text.startsWith("$")) {
    const calc = resolveCalcCoordinate(text, context);
    if (calc) return calc;
  }

  const named = parseNamedReference(text);
  if (named) {
    const node = context.nodes.get(named.name);
    if (node) {
      if (!isFinitePoint(node)) return { point: { x: Number.NaN, y: Number.NaN }, nodeRef: node };
      return {
        point: nodeAnchorPoint(node, named.anchor),
        nodeRef: node,
        rawAnchor: named.anchor,
      };
    }
    const coordinate = context.coordinates.get(named.name);
    if (coordinate) {
      return {
        point: {
          ...coordinate,
          x: coordinate.x + (named.anchor === "east" ? 0 : 0),
        },
      };
    }
    return {
      point: { x: Number.NaN, y: Number.NaN },
      unresolvedName: named.name,
    };
  }

  if (!text.includes(",")) {
    const colonParts = splitTopLevel(text, 0, text.length, ":");
    if (colonParts.length === 2) {
      const angle = evaluateExpression(colonParts[0].text);
      const radius = evaluateExpression(colonParts[1].text);
      if (angle != null && radius != null) {
        const radians = (angle * Math.PI) / 180;
        return {
          point: { x: Math.cos(radians) * radius, y: Math.sin(radians) * radius },
        };
      }
    }
  }

  const pair = parseNumericPair(text);
  if (pair) return { point: pair };

  const mixed = text.match(/^(.+?)\s*\|\-\s*(.+)$/);
  if (mixed) {
    const x = evaluateExpression(mixed[1]);
    const second = resolveRawCoordinate(mixed[2], context);
    if (x != null && second) return { point: { x, y: second.point.y } };
  }

  const mixedSecond = text.match(/^(.+?)\s*-\|\s*(.+)$/);
  if (mixedSecond) {
    const y = evaluateExpression(mixedSecond[1]);
    const second = resolveRawCoordinate(mixedSecond[2], context);
    if (y != null && second) return { point: { x: second.point.x, y } };
  }

  return null;
}

export function borderPoint(node: TikzNode, target: Point): Point {
  const dx = target.x - node.x;
  const dy = target.y - node.y;
  if (Math.abs(dx) < 1e-8 && Math.abs(dy) < 1e-8) {
    return { x: node.x, y: node.y };
  }

  const halfWidth = Math.max(node.width / 2, 0.001);
  const halfHeight = Math.max(node.height / 2, 0.001);
  const shape = node.style.shape;

  let scale = 1;
  if (shape === "circle" || shape === "ellipse") {
    scale = 1 / Math.sqrt((dx / halfWidth) ** 2 + (dy / halfHeight) ** 2);
  } else if (shape === "diamond") {
    scale = 1 / (Math.abs(dx) / halfWidth + Math.abs(dy) / halfHeight);
  } else {
    const xScale = Math.abs(dx) > 1e-8 ? halfWidth / Math.abs(dx) : Number.POSITIVE_INFINITY;
    const yScale = Math.abs(dy) > 1e-8 ? halfHeight / Math.abs(dy) : Number.POSITIVE_INFINITY;
    scale = Math.min(xScale, yScale);
    const radius = roundedCornerRadius(node);
    if (radius > 0) {
      const edgeX = dx * scale;
      const edgeY = dy * scale;
      if (
        Math.abs(edgeX) > halfWidth - radius + 1e-8 &&
        Math.abs(edgeY) > halfHeight - radius + 1e-8
      ) {
        const cornerX = Math.sign(edgeX) * (halfWidth - radius);
        const cornerY = Math.sign(edgeY) * (halfHeight - radius);
        const a = dx * dx + dy * dy;
        const b = -2 * (dx * cornerX + dy * cornerY);
        const c = cornerX * cornerX + cornerY * cornerY - radius * radius;
        const discriminant = b * b - 4 * a * c;
        if (discriminant >= 0) {
          const arcScale = (-b + Math.sqrt(discriminant)) / (2 * a);
          if (arcScale > 0 && arcScale <= scale + 1e-8) scale = arcScale;
        }
      }
    }
  }

  return { x: node.x + dx * scale, y: node.y + dy * scale };
}

export function pointOnLine(from: Point, to: Point, fraction: number): Point {
  return {
    x: from.x + (to.x - from.x) * fraction,
    y: from.y + (to.y - from.y) * fraction,
  };
}

export function cubicPoint(
  from: Point,
  c1: Point,
  c2: Point,
  to: Point,
  t: number,
): Point {
  const inv = 1 - t;
  return {
    x: inv ** 3 * from.x + 3 * inv ** 2 * t * c1.x + 3 * inv * t ** 2 * c2.x + t ** 3 * to.x,
    y: inv ** 3 * from.y + 3 * inv ** 2 * t * c1.y + 3 * inv * t ** 2 * c2.y + t ** 3 * to.y,
  };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}
