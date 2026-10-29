import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  CornerDownRight,
  Crosshair,
  Download,
  Hand,
  Layers,
  Loader2,
  Magnet,
  Maximize2,
  Minus,
  MousePointer2,
  Plus,
  RefreshCw,
  Scaling,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TriangleAlert,
  Unlink,
  X,
} from "lucide-react";
import { toBlob, toJpeg, toSvg } from "html-to-image";
import {
  collectAlignmentTargets,
  EMPTY_GUIDES,
  findAlignmentSnap,
  findFeatureAlignmentSnap,
  shiftedBounds,
  type AlignmentGuides,
  type AlignmentTargets,
} from "@/src/lib/tikz/alignment";
import { borderPoint, cubicPoint, nodeAnchorPoint } from "@/src/lib/tikz/coordinates";
import { latexToHtml } from "@/src/lib/tikz/latexText";
import { PX_PER_CM } from "@/src/lib/tikz/options";
import { parseTikz } from "@/src/lib/tikz/parser";
import {
  attachPathEndpoint,
  deleteSelectionObjects,
  detachPathEndpoints,
  insertConnector,
  insertShapeNode,
  isNumericCoordinate,
  patchFrameGeometry,
  patchLabelColor,
  patchLabelFontSize,
  patchLabelOffset,
  patchNodeColors,
  patchNodeFontSize,
  patchNodeGeometry,
  patchNodePosition,
  patchPathEndpoint,
  patchPathSegmentCurve,
  patchPathSegmentPolyline,
  patchPathVertex,
  patchSelectionScale,
  patchSelectionTranslation,
  patchText,
  patchTikzCdArrow,
  pathHasAttachedEndpoints,
  straightenPathVertex,
  validateNodeText,
  validateTikzCdCellText,
  validateTikzCdLabelText,
  type BasicShapeKind,
  type SelectionEditObjects,
  type TikzCdArrowStylePatch,
} from "@/src/lib/tikz/patch";
import {
  previewBounds,
  type PreviewSpec,
} from "@/src/lib/tikz/previews";
import { previewClickSpan } from "@/src/lib/tikz/preview-source";
import type { EngineCanvasInfo } from "@/src/lib/tikz/useTikzjax";
import type {
  Bounds,
  CurveGeometry,
  LineGeometry,
  PathSegment,
  PathSubpath,
  Point,
  Span,
  TikzDocument,
  TikzFrame,
  TikzLabel,
  TikzNode,
  TikzPath,
} from "@/src/lib/tikz/types";

const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;
const FIT_PADDING = 74;
const EXPORT_PADDING = 32;
const ALIGN_THRESHOLD_PX = 8;
const COARSE_ALIGN_THRESHOLD_PX = 14;
const ATTACH_REVEAL_PX = 96;
const ATTACH_SNAP_PX = 16;
const COARSE_ATTACH_SNAP_PX = 26;
const RIGHT_ANGLE_SNAP_DEG = 7;
const COARSE_RIGHT_ANGLE_SNAP_DEG = 12;
const ORTHO_SNAP_PX = 28;
const COARSE_ORTHO_SNAP_PX = 40;

type Corner = "nw" | "ne" | "sw" | "se";
type ExportFormat = "svg" | "png" | "jpg";
type ViewportSize = { width: number; height: number };
type Transform = { x: number; y: number; zoom: number };
type ShapeTool = BasicShapeKind;
type MarqueeType = "shapes" | "edges" | "labels" | "frames";
type MarqueeFilter = Record<MarqueeType, boolean>;
type NodeAnchor =
  | "north"
  | "north east"
  | "east"
  | "south east"
  | "south"
  | "south west"
  | "west"
  | "north west";

const NODE_ANCHORS: NodeAnchor[] = [
  "north",
  "north east",
  "east",
  "south east",
  "south",
  "south west",
  "west",
  "north west",
];

const ANCHOR_LABELS: Record<NodeAnchor, string> = {
  north: "上",
  "north east": "右上",
  east: "右",
  "south east": "右下",
  south: "下",
  "south west": "左下",
  west: "左",
  "north west": "左上",
};

const SHAPE_TOOLS: Array<{ kind: ShapeTool; label: string; title: string }> = [
  { kind: "rectangle", label: "矩形", title: "绘制矩形" },
  { kind: "rounded", label: "圆角", title: "绘制圆角矩形" },
  { kind: "circle", label: "圆形", title: "绘制圆形" },
  { kind: "diamond", label: "菱形", title: "绘制菱形" },
];

const MARQUEE_TYPES: Array<{ kind: MarqueeType; label: string; detail: string }> = [
  { kind: "shapes", label: "图形", detail: "节点与基本图案" },
  { kind: "edges", label: "连线", detail: "箭头和路径" },
  { kind: "labels", label: "标签", detail: "连线上的文字" },
  { kind: "frames", label: "背景", detail: "背景板与底板" },
];

const DEFAULT_MARQUEE_FILTER: MarqueeFilter = {
  shapes: true,
  edges: true,
  labels: true,
  frames: false,
};

const DEFAULT_SHAPE_SIZE: Record<ShapeTool, { width: number; height: number }> = {
  rectangle: { width: 2.4, height: 1.4 },
  rounded: { width: 2.4, height: 1.4 },
  circle: { width: 1.7, height: 1.7 },
  diamond: { width: 2.2, height: 1.6 },
};

interface ShapeDraftState {
  left: number;
  top: number;
  width: number;
  height: number;
  kind: ShapeTool;
}

interface ConnectorDraftState {
  from: Point;
  to: Point;
  targetNodeKey: string | null;
  targetAnchor: NodeAnchor | null;
}

interface DragState {
  source: string;
  node: TikzNode;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
  moved: boolean;
}

interface ResizeState {
  source: string;
  node: TikzNode;
  pointerId: number;
  corner: Corner;
  startClientX: number;
  startClientY: number;
  startWidth: number;
  startHeight: number;
  startX: number;
  startY: number;
  moved: boolean;
}

interface LabelDragState {
  source: string;
  label: TikzLabel;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startShiftX: number;
  startShiftY: number;
  moved: boolean;
}

interface FrameResizeState {
  source: string;
  frame: TikzFrame;
  pointerId: number;
  corner: Corner;
  startClientX: number;
  startClientY: number;
  startMinX: number;
  startMinY: number;
  startMaxX: number;
  startMaxY: number;
  moved: boolean;
}

interface PathEndpointHandle {
  subpathIndex: number;
  edge: "start" | "end";
  point: Point;
  attached: boolean;
}

interface JointSnapContext {
  from: Point;
  to: Point;
  fromNode: TikzNode | null;
  toNode: TikzNode | null;
}

interface PathCurveHandle extends JointSnapContext {
  subpathIndex: number;
  segmentIndex: number;
  point: Point;
  chordMid: Point;
  normal: Point;
  controls: { c1: Point; c2: Point };
  bent: boolean;
}

interface PathVertexHandle extends JointSnapContext {
  subpathIndex: number;
  segmentIndex: number;
  point: Point;
  angle: number;
  rightAngle: boolean;
}

type BendMode = "curve" | "polyline";

interface CurveDragState {
  source: string;
  path: TikzPath;
  handle: PathCurveHandle;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  moved: boolean;
}

interface PathAttachCandidate {
  node: TikzNode;
  anchor: NodeAnchor | "center";
  point: Point;
}

interface PathAttachHint extends PathAttachCandidate {
  active: boolean;
}

interface PinchState {
  pointerIds: [number, number];
  startDistance: number;
  startMidpoint: Point;
  startTransform: Transform;
}

interface MarqueeState {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface SelectionInfo {
  eyebrow: string;
  title: string;
  meta: string[];
  editable?: TikzNode | TikzLabel;
  path?: TikzPath;
  resizeHint?: boolean;
  multi?: boolean;
  locked?: boolean;
}

interface EditingState {
  key: string;
  kind: "node" | "label";
  title: string;
}

interface DiagramCanvasProps {
  doc: TikzDocument;
  source: string;
  preview: PreviewSpec | null;
  engine: EngineCanvasInfo;
  selectedKeys: string[];
  onSelect: (keys: string[]) => void;
  onSourceChange: (source: string) => void;
  fitSignal: number;
  onLoadExample: () => void;
  onPreviewReveal: (span: Span | null) => void;
  onEngineRetry: () => void;
  onEngineUseNative: () => void;
  onEngineUse: () => void;
  mobileActive: boolean;
}

function collectSelection(doc: TikzDocument, keys: string[]): SelectionEditObjects {
  const wanted = new Set(keys);
  return {
    nodes: doc.nodes.filter((node) => wanted.has(node.key)),
    labels: doc.labels.filter((label) => wanted.has(label.key)),
    frames: doc.frames.filter((frame) => wanted.has(frame.key)),
    paths: doc.paths.filter(
      (path) => wanted.has(path.key) && isSelectableEdge(path),
    ),
  };
}

function selectionSize(objects: SelectionEditObjects): number {
  return (
    objects.nodes.length +
    objects.labels.length +
    objects.frames.length +
    objects.paths.length
  );
}

function selectionBounds(objects: SelectionEditObjects): Bounds | null {
  let bounds: Bounds | null = null;
  const extend = (next: Bounds) => {
    if (!bounds) {
      bounds = { ...next };
      return;
    }
    bounds.minX = Math.min(bounds.minX, next.minX);
    bounds.minY = Math.min(bounds.minY, next.minY);
    bounds.maxX = Math.max(bounds.maxX, next.maxX);
    bounds.maxY = Math.max(bounds.maxY, next.maxY);
  };
  for (const node of objects.nodes) extend(node.bounds);
  for (const label of objects.labels) extend(label.bounds);
  for (const frame of objects.frames) {
    extend({
      minX: frame.minX,
      minY: frame.minY,
      maxX: frame.maxX,
      maxY: frame.maxY,
    });
  }
  for (const path of objects.paths) {
    const next = pathBounds(path);
    if (next) extend(next);
  }
  return bounds;
}

function boundsIntersect(a: Bounds, b: Bounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function snap(value: number, step: number): number {
  if (step <= 0) return value;
  return Math.round(value / step) * step;
}

function alignmentThreshold(zoom: number, coarse: boolean): number {
  const pixels = coarse ? COARSE_ALIGN_THRESHOLD_PX : ALIGN_THRESHOLD_PX;
  return pixels / Math.max(0.05, zoom * PX_PER_CM);
}

function axisConstrainedPoint(
  from: Point,
  to: Point,
  threshold: number,
  force: boolean,
): { point: Point; axis: "horizontal" | "vertical" | null } {
  const dx = Math.abs(to.x - from.x);
  const dy = Math.abs(to.y - from.y);
  if (!force && Math.min(dx, dy) > threshold) return { point: to, axis: null };
  if (dx <= dy) {
    return { point: { x: from.x, y: to.y }, axis: "vertical" };
  }
  return { point: { x: to.x, y: from.y }, axis: "horizontal" };
}

function isSelectableEdge(path: TikzPath): boolean {
  return (
    !path.generated &&
    path.stroke &&
    Boolean(path.style.draw) &&
    path.subpaths.some((subpath) => !subpath.shape && subpath.segments.length > 0)
  );
}

function selectionHasTikzCd(objects: SelectionEditObjects): boolean {
  return (
    objects.nodes.some((node) => node.origin === "tikzcd") ||
    objects.labels.some((label) => label.origin === "tikzcd") ||
    objects.paths.some((path) => path.origin === "tikzcd")
  );
}

function keyIsTikzCd(doc: TikzDocument, key: string): boolean {
  return (
    doc.nodes.some((node) => node.key === key && node.origin === "tikzcd") ||
    doc.labels.some((label) => label.key === key && label.origin === "tikzcd") ||
    doc.paths.some((path) => path.key === key && path.origin === "tikzcd")
  );
}

function tikzCdLineStyle(path: TikzPath): "solid" | "dashed" | "dotted" {
  return path.style.dotted ? "dotted" : path.style.dashed ? "dashed" : "solid";
}

function tikzCdArrowEnds(path: TikzPath): "->" | "<-" | "<->" | "-" {
  if (path.style.arrowStart && path.style.arrowEnd) return "<->";
  if (path.style.arrowStart) return "<-";
  if (path.style.arrowEnd) return "->";
  return "-";
}

function tikzCdBend(path: TikzPath): "none" | "left" | "right" {
  return path.style.bend ? path.style.bend.direction : "none";
}

function renderTikzText(text: string, mathMode?: boolean): string {
  if (!text) return "";
  return latexToHtml(mathMode ? `$${text}$` : text);
}

function subpathPolyline(subpath: PathSubpath): Point[] {
  const points: Point[] = [{ ...subpath.start.point }];
  for (const segment of subpath.segments) {
    if ("c1" in segment.geometry) {
      const curve = segment.geometry as CurveGeometry;
      for (let index = 1; index <= 16; index += 1) {
        const t = index / 16;
        const rest = 1 - t;
        points.push({
          x:
            rest ** 3 * curve.from.x +
            3 * rest ** 2 * t * curve.c1.x +
            3 * rest * t ** 2 * curve.c2.x +
            t ** 3 * curve.to.x,
          y:
            rest ** 3 * curve.from.y +
            3 * rest ** 2 * t * curve.c1.y +
            3 * rest * t ** 2 * curve.c2.y +
            t ** 3 * curve.to.y,
        });
      }
    } else {
      points.push({ ...segment.geometry.to });
    }
  }
  return points;
}

function pathBounds(path: TikzPath): Bounds | null {
  let bounds: Bounds | null = null;
  for (const subpath of path.subpaths) {
    if (subpath.shape) continue;
    for (const point of subpathPolyline(subpath)) {
      if (!bounds) {
        bounds = { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y };
      } else {
        bounds.minX = Math.min(bounds.minX, point.x);
        bounds.minY = Math.min(bounds.minY, point.y);
        bounds.maxX = Math.max(bounds.maxX, point.x);
        bounds.maxY = Math.max(bounds.maxY, point.y);
      }
    }
  }
  return bounds;
}

function distanceToSegment(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-9) return Math.hypot(point.x - from.x, point.y - from.y);
  const t = clamp(
    ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared,
    0,
    1,
  );
  return Math.hypot(point.x - (from.x + t * dx), point.y - (from.y + t * dy));
}

function distanceToPath(path: TikzPath, point: Point): number {
  let best = Number.POSITIVE_INFINITY;
  for (const subpath of path.subpaths) {
    if (subpath.shape) continue;
    const points = subpathPolyline(subpath);
    for (let index = 1; index < points.length; index += 1) {
      best = Math.min(best, distanceToSegment(point, points[index - 1], points[index]));
    }
  }
  return best;
}

function findEdgeAtPoint(
  doc: TikzDocument,
  point: Point,
  tolerance: number,
): TikzPath | null {
  for (let index = doc.paths.length - 1; index >= 0; index -= 1) {
    const path = doc.paths[index];
    if (!isSelectableEdge(path)) continue;
    if (distanceToPath(path, point) <= tolerance) return path;
  }
  return null;
}

function findFrameAtPoint(doc: TikzDocument, point: Point): TikzFrame | null {
  let hit: TikzFrame | null = null;
  for (const frame of doc.frames) {
    if (
      point.x < frame.minX ||
      point.x > frame.maxX ||
      point.y < frame.minY ||
      point.y > frame.maxY
    ) {
      continue;
    }
    if (!hit || frame.width * frame.height < hit.width * hit.height) hit = frame;
  }
  return hit;
}

function segmentIntersectsBounds(from: Point, to: Point, range: Bounds): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const checks: Array<[number, number]> = [
    [-dx, from.x - range.minX],
    [dx, range.maxX - from.x],
    [-dy, from.y - range.minY],
    [dy, range.maxY - from.y],
  ];
  for (const [direction, distance] of checks) {
    if (Math.abs(direction) < 1e-9) {
      if (distance < 0) return false;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) t0 = Math.max(t0, ratio);
    else t1 = Math.min(t1, ratio);
    if (t0 > t1) return false;
  }
  return true;
}

function pathIntersectsBounds(path: TikzPath, range: Bounds): boolean {
  for (const subpath of path.subpaths) {
    if (subpath.shape) continue;
    const points = subpathPolyline(subpath);
    for (const point of points) {
      if (
        point.x >= range.minX &&
        point.x <= range.maxX &&
        point.y >= range.minY &&
        point.y <= range.maxY
      ) {
        return true;
      }
    }
    for (let index = 1; index < points.length; index += 1) {
      if (segmentIntersectsBounds(points[index - 1], points[index], range)) return true;
    }
  }
  return false;
}

function pathLength(path: TikzPath): number {
  let total = 0;
  for (const subpath of path.subpaths) {
    if (subpath.shape) continue;
    const points = subpathPolyline(subpath);
    for (let index = 1; index < points.length; index += 1) {
      total += Math.hypot(
        points[index].x - points[index - 1].x,
        points[index].y - points[index - 1].y,
      );
    }
  }
  return total;
}

function pathEndpointHandles(path: TikzPath): PathEndpointHandle[] {
  const handles: PathEndpointHandle[] = [];
  path.subpaths.forEach((subpath, subpathIndex) => {
    if (subpath.shape || subpath.segments.length === 0) return;
    handles.push({
      subpathIndex,
      edge: "start",
      point: subpath.start.point,
      attached: Boolean(subpath.start.nodeRef),
    });
    if (!subpath.closed) {
      const segment = subpath.segments[subpath.segments.length - 1];
      handles.push({
        subpathIndex,
        edge: "end",
        point: segment.to.point,
        attached: Boolean(segment.to.nodeRef),
      });
    }
  });
  return handles;
}

function pathCurveHandles(path: TikzPath, source: string): PathCurveHandle[] {
  if (path.generated) return [];
  const handles: PathCurveHandle[] = [];
  path.subpaths.forEach((subpath, subpathIndex) => {
    if (subpath.shape || subpath.generated) return;
    subpath.segments.forEach((segment, segmentIndex) => {
      if (segment.generated || !segment.connectorSpan) return;
      if (segment.kind !== "line" && segment.kind !== "cubic") return;
      const connector = source
        .slice(segment.connectorSpan.start, segment.connectorSpan.end)
        .trim();
      if (connector !== "--" && connector !== "to" && !connector.startsWith("..")) {
        return;
      }
      const from = segment.geometry.from;
      const to = segment.geometry.to;
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      if (length < 0.25) return;
      const chordMid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      let point: Point;
      let controls: { c1: Point; c2: Point };
      if ("c1" in segment.geometry) {
        point = cubicPoint(from, segment.geometry.c1, segment.geometry.c2, to, 0.5);
        controls = { c1: segment.geometry.c1, c2: segment.geometry.c2 };
      } else {
        point = chordMid;
        controls = {
          c1: { x: from.x + (to.x - from.x) / 3, y: from.y + (to.y - from.y) / 3 },
          c2: {
            x: from.x + ((to.x - from.x) * 2) / 3,
            y: from.y + ((to.y - from.y) * 2) / 3,
          },
        };
      }
      const normal = { x: -(to.y - from.y) / length, y: (to.x - from.x) / length };
      const offset =
        (point.x - chordMid.x) * normal.x + (point.y - chordMid.y) * normal.y;
      handles.push({
        subpathIndex,
        segmentIndex,
        point,
        chordMid,
        normal,
        controls,
        bent: "c1" in segment.geometry || Math.abs(offset) > 0.02,
        from,
        to,
        fromNode: segment.from.isBorderPoint ? segment.from.nodeRef ?? null : null,
        toNode: segment.to.isBorderPoint ? segment.to.nodeRef ?? null : null,
      });
    });
  });
  return handles;
}

function segmentConnectorText(source: string, segment: PathSegment): string {
  if (!segment.connectorSpan) return "";
  return source.slice(segment.connectorSpan.start, segment.connectorSpan.end).trim();
}

function lineAngleDegrees(from: Point, joint: Point, to: Point): number {
  const ax = from.x - joint.x;
  const ay = from.y - joint.y;
  const bx = to.x - joint.x;
  const by = to.y - joint.y;
  const lengthA = Math.hypot(ax, ay);
  const lengthB = Math.hypot(bx, by);
  if (lengthA < 1e-6 || lengthB < 1e-6) return 180;
  const cosine = (ax * bx + ay * by) / (lengthA * lengthB);
  return (Math.acos(Math.min(1, Math.max(-1, cosine))) * 180) / Math.PI;
}

function rightAnglePoint(from: Point, to: Point, target: Point): Point | null {
  const radius = Math.hypot(to.x - from.x, to.y - from.y) / 2;
  if (radius < 0.05) return null;
  const center = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  const dx = target.x - center.x;
  const dy = target.y - center.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-4) return null;
  return {
    x: center.x + (dx / distance) * radius,
    y: center.y + (dy / distance) * radius,
  };
}

function jointEndpoint(node: TikzNode | null, fallback: Point, joint: Point): Point {
  return node ? borderPoint(node, joint) : fallback;
}

function jointAngleDegrees(context: JointSnapContext, joint: Point): number {
  return lineAngleDegrees(
    jointEndpoint(context.fromNode, context.from, joint),
    joint,
    jointEndpoint(context.toNode, context.to, joint),
  );
}

function rightAngleJoint(context: JointSnapContext, joint: Point): Point {
  let point = joint;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const from = jointEndpoint(context.fromNode, context.from, point);
    const to = jointEndpoint(context.toNode, context.to, point);
    const snapped = rightAnglePoint(from, to, point);
    if (!snapped) return point;
    if (Math.hypot(snapped.x - point.x, snapped.y - point.y) < 1e-4) return snapped;
    point = snapped;
  }
  return point;
}

function orthogonalJoint(
  context: JointSnapContext,
  joint: Point,
  radius: number,
): Point | null {
  const from = jointEndpoint(context.fromNode, context.from, joint);
  const to = jointEndpoint(context.toNode, context.to, joint);
  const options = [
    { point: { x: from.x, y: to.y }, verticalFirst: true },
    { point: { x: to.x, y: from.y }, verticalFirst: false },
  ].filter((option) => {
    const legA = Math.hypot(option.point.x - from.x, option.point.y - from.y);
    const legB = Math.hypot(to.x - option.point.x, to.y - option.point.y);
    return legA >= 0.3 && legB >= 0.3;
  });
  if (options.length === 0) return null;
  let best = options[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const option of options) {
    const distance = Math.hypot(option.point.x - joint.x, option.point.y - joint.y);
    if (distance < bestDistance) {
      best = option;
      bestDistance = distance;
    }
  }
  if (bestDistance > radius) return null;
  let point = best.point;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const liveFrom = jointEndpoint(context.fromNode, context.from, point);
    const liveTo = jointEndpoint(context.toNode, context.to, point);
    const next = best.verticalFirst
      ? { x: liveFrom.x, y: liveTo.y }
      : { x: liveTo.x, y: liveFrom.y };
    if (Math.hypot(next.x - point.x, next.y - point.y) < 1e-4) return next;
    point = next;
  }
  return point;
}

function pathPolylineHandles(path: TikzPath, source: string): PathCurveHandle[] {
  if (path.generated) return [];
  const handles: PathCurveHandle[] = [];
  path.subpaths.forEach((subpath, subpathIndex) => {
    if (subpath.shape || subpath.generated) return;
    subpath.segments.forEach((segment, segmentIndex) => {
      if (segment.generated || segment.kind !== "line" || !segment.connectorSpan) return;
      if (segmentConnectorText(source, segment) !== "--") return;
      const from = segment.geometry.from;
      const to = segment.geometry.to;
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      if (length < 0.25) return;
      const chordMid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
      handles.push({
        subpathIndex,
        segmentIndex,
        point: chordMid,
        chordMid,
        normal: { x: -(to.y - from.y) / length, y: (to.x - from.x) / length },
        controls: {
          c1: { x: from.x + (to.x - from.x) / 3, y: from.y + (to.y - from.y) / 3 },
          c2: {
            x: from.x + ((to.x - from.x) * 2) / 3,
            y: from.y + ((to.y - from.y) * 2) / 3,
          },
        },
        bent: false,
        from,
        to,
        fromNode: segment.from.isBorderPoint ? segment.from.nodeRef ?? null : null,
        toNode: segment.to.isBorderPoint ? segment.to.nodeRef ?? null : null,
      });
    });
  });
  return handles;
}

function pathVertexHandles(path: TikzPath, source: string): PathVertexHandle[] {
  if (path.generated) return [];
  const handles: PathVertexHandle[] = [];
  path.subpaths.forEach((subpath, subpathIndex) => {
    if (subpath.shape || subpath.generated || subpath.segments.length < 2) return;
    for (let index = 1; index < subpath.segments.length; index += 1) {
      const previous = subpath.segments[index - 1];
      const next = subpath.segments[index];
      if (previous.generated || next.generated) continue;
      if ("c1" in previous.geometry || "c1" in next.geometry) continue;
      if (segmentConnectorText(source, previous) !== "--") continue;
      if (segmentConnectorText(source, next) !== "--") continue;
      if (previous.raw.isRelative || !previous.raw.sourceSpan) continue;
      if (!isNumericCoordinate(previous.raw.raw)) continue;
      const from = previous.geometry.from;
      const to = next.geometry.to;
      const joint = next.geometry.from;
      if (Math.hypot(from.x - joint.x, from.y - joint.y) < 0.05) continue;
      if (Math.hypot(to.x - joint.x, to.y - joint.y) < 0.05) continue;
      const angle = lineAngleDegrees(from, joint, to);
      if (angle <= 1 || angle >= 179) continue;
      handles.push({
        subpathIndex,
        segmentIndex: index - 1,
        point: joint,
        from,
        to,
        fromNode: previous.from.isBorderPoint ? previous.from.nodeRef ?? null : null,
        toNode: next.to.isBorderPoint ? next.to.nodeRef ?? null : null,
        angle,
        rightAngle: Math.abs(angle - 90) <= 0.5,
      });
    }
  });
  return handles;
}

function pointToBoundsDistance(point: Point, bounds: Bounds): number {
  const dx = Math.max(bounds.minX - point.x, 0, point.x - bounds.maxX);
  const dy = Math.max(bounds.minY - point.y, 0, point.y - bounds.maxY);
  return Math.hypot(dx, dy);
}

function nearbyPathAnchors(
  doc: TikzDocument,
  points: Point[],
  revealRadius: number,
): PathAttachCandidate[] {
  const candidates: PathAttachCandidate[] = [];
  for (const node of doc.nodes) {
    if (!node.name) continue;
    if (
      !points.some(
        (point) => pointToBoundsDistance(point, node.bounds) <= revealRadius,
      )
    ) {
      continue;
    }
    for (const anchor of NODE_ANCHORS) {
      candidates.push({
        node,
        anchor,
        point: nodeAnchorPoint(node, anchor),
      });
    }
    candidates.push({
      node,
      anchor: "center",
      point: nodeAnchorPoint(node, "center"),
    });
  }
  return candidates;
}

function nearestPathAnchor(
  candidates: PathAttachCandidate[],
  points: Point[],
  threshold: number,
): PathAttachCandidate | null {
  let best: PathAttachCandidate | null = null;
  let bestDistance = threshold;
  for (const candidate of candidates) {
    for (const point of points) {
      const distance = Math.hypot(
        candidate.point.x - point.x,
        candidate.point.y - point.y,
      );
      if (distance <= bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  return best;
}

function buildPathAttachHints(
  candidates: PathAttachCandidate[],
  active: PathAttachCandidate | null,
): PathAttachHint[] {
  return candidates.map((candidate) => ({
    ...candidate,
    active:
      active !== null &&
      candidate.node.key === active.node.key &&
      candidate.anchor === active.anchor,
  }));
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function anchorUiStyle(node: TikzNode, anchor: NodeAnchor): CSSProperties {
  const corner = anchor.includes(" ");
  const shape = node.style.shape;
  if (corner && shape === "rounded") {
    const radius = Math.min(node.style.cornerRadius, node.width / 2, node.height / 2);
    const inset = 1 - Math.SQRT1_2;
    const edgeX = (radius * inset * 100) / Math.max(node.width, 1e-3);
    const edgeY = (radius * inset * 100) / Math.max(node.height, 1e-3);
    return {
      left: `${anchor.includes("west") ? edgeX : 100 - edgeX}%`,
      top: `${anchor.includes("north") ? edgeY : 100 - edgeY}%`,
    };
  }
  let edge = 0;
  if (corner && (shape === "circle" || shape === "ellipse")) {
    edge = 50 - 50 * Math.SQRT1_2;
  } else if (corner && shape === "diamond") {
    edge = 25;
  }
  const left = anchor.includes("west") ? edge : anchor.includes("east") ? 100 - edge : 50;
  const top = anchor.includes("north") ? edge : anchor.includes("south") ? 100 - edge : 50;
  return { left: `${left}%`, top: `${top}%` };
}

function nearestNodeAnchor(node: TikzNode, point: Point): NodeAnchor {
  let best: NodeAnchor = "north";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const anchor of NODE_ANCHORS) {
    const target = nodeAnchorPoint(node, anchor);
    const distance = Math.hypot(target.x - point.x, target.y - point.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = anchor;
    }
  }
  return best;
}

function findConnectorTarget(
  doc: TikzDocument,
  sourceKey: string,
  point: Point,
): { node: TikzNode; anchor: NodeAnchor } | null {
  const margin = 0.14;
  for (let index = doc.nodes.length - 1; index >= 0; index -= 1) {
    const node = doc.nodes[index];
    if (node.key === sourceKey) continue;
    if (
      point.x < node.bounds.minX - margin ||
      point.x > node.bounds.maxX + margin ||
      point.y < node.bounds.minY - margin ||
      point.y > node.bounds.maxY + margin
    ) {
      continue;
    }
    return { node, anchor: nearestNodeAnchor(node, point) };
  }
  return null;
}

function ShapeToolIcon({ kind }: { kind: ShapeTool }) {
  return (
    <svg className="shape-tool-icon" viewBox="0 0 20 20" aria-hidden="true">
      {kind === "rectangle" ? (
        <rect x="2.6" y="4.8" width="14.8" height="10.4" rx="1.2" />
      ) : kind === "rounded" ? (
        <rect x="2.6" y="4.8" width="14.8" height="10.4" rx="4" />
      ) : kind === "circle" ? (
        <circle cx="10" cy="10" r="7.2" />
      ) : (
        <path d="M10 2.4 17.6 10 10 17.6 2.4 10Z" />
      )}
    </svg>
  );
}

type ColorSession =
  | { kind: "node"; key: string; source: string; node: TikzNode }
  | { kind: "label"; key: string; source: string; label: TikzLabel };

function ColorControl({
  label,
  value,
  fallback = "#ffffff",
  allowNone,
  onPick,
  onNone,
  onSessionStart,
}: {
  label: string;
  value: string | null;
  fallback?: string;
  allowNone?: boolean;
  onPick: (value: string) => void;
  onNone?: () => void;
  onSessionStart: () => void;
}) {
  const none = allowNone === true && value === null;
  const displayColor = value ?? fallback;
  return (
    <div className="color-row">
      <span className="color-row-label">{label}</span>
      <label
        className={`color-chip${none ? " is-none" : ""}`}
        title={`选择${label}颜色`}
        onPointerDown={onSessionStart}
      >
        <input
          type="color"
          value={displayColor}
          aria-label={`${label}颜色`}
          onFocus={onSessionStart}
          onChange={(event) => onPick(event.target.value)}
        />
        <span style={{ background: displayColor }} aria-hidden="true" />
      </label>
      <span className="color-row-value">{none ? "无" : (value ?? "默认").toUpperCase()}</span>
      {allowNone ? (
        <button
          type="button"
          className={`color-none${none ? " is-active" : ""}`}
          aria-pressed={none}
          title={none ? `恢复${label}` : `不显示${label}`}
          onPointerDown={onSessionStart}
          onClick={onNone}
        >
          无
        </button>
      ) : null}
    </div>
  );
}

const FONT_PT_MIN = 4;
const FONT_PT_MAX = 96;

function fontPointsFromPixels(px: number): number {
  return Math.round((px * 72) / 96);
}

function FontSizeControl({
  points,
  onStep,
}: {
  points: number;
  onStep: (delta: number) => void;
}) {
  return (
    <div className="selection-font-row">
      <span className="color-row-label">字号</span>
      <div className="font-size-stepper">
        <button
          type="button"
          className="font-size-button"
          aria-label="减小字号"
          title="减小 1pt"
          disabled={points <= FONT_PT_MIN}
          onClick={() => onStep(-1)}
        >
          <Minus size={11} />
        </button>
        <span className="font-size-value" aria-live="polite">
          {points}
          <small>pt</small>
        </span>
        <button
          type="button"
          className="font-size-button"
          aria-label="增大字号"
          title="增大 1pt"
          disabled={points >= FONT_PT_MAX}
          onClick={() => onStep(1)}
        >
          <Plus size={11} />
        </button>
      </div>
    </div>
  );
}

function screenX(x: number): number {
  return x * PX_PER_CM;
}

function screenY(y: number): number {
  return -y * PX_PER_CM;
}

function pathNumber(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function compactSvgMarkup(dataUrl: string): string | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return null;
  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  let markup: string;
  try {
    markup = header.includes(";base64") ? atob(payload) : decodeURIComponent(payload);
  } catch {
    return null;
  }
  const document = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = document.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg") return null;
  const rules: string[] = [];
  const classes = new Map<string, string>();
  root.querySelectorAll("[style]").forEach((element) => {
    const value = element.getAttribute("style");
    if (!value) return;
    let className = classes.get(value);
    if (!className) {
      className = `h2i-${classes.size}`;
      classes.set(value, className);
      rules.push(`.${className}{${value}}`);
    }
    const existing = element.getAttribute("class");
    element.setAttribute("class", existing ? `${existing} ${className}` : className);
    element.removeAttribute("style");
  });
  if (rules.length === 0) return markup;
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = rules.join("");
  root.insertBefore(style, root.firstChild);
  return new XMLSerializer().serializeToString(root);
}

function hexWithAlpha(color: string, alpha: number): string {
  if (alpha >= 0.999) return color;
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color;
  const value = Math.round(clamp(alpha, 0, 1) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${color}${value}`;
}

function subpathPathData(subpath: PathSubpath, fill: boolean): string {
  const shape = subpath.shape;
  if (shape) {
    if (shape.kind === "rectangle" && shape.corner1 && shape.corner2) {
      const x1 = screenX(Math.min(shape.corner1.x, shape.corner2.x));
      const x2 = screenX(Math.max(shape.corner1.x, shape.corner2.x));
      const y1 = screenY(Math.max(shape.corner1.y, shape.corner2.y));
      const y2 = screenY(Math.min(shape.corner1.y, shape.corner2.y));
      return `M ${pathNumber(x1)} ${pathNumber(y1)} H ${pathNumber(x2)} V ${pathNumber(y2)} H ${pathNumber(x1)} Z`;
    }
    if (shape.kind === "circle" && shape.center && shape.radius != null) {
      const cx = screenX(shape.center.x);
      const cy = screenY(shape.center.y);
      const radius = shape.radius * PX_PER_CM;
      const r = pathNumber(radius);
      return `M ${pathNumber(cx - radius)} ${pathNumber(cy)} a ${r} ${r} 0 1 0 ${pathNumber(radius * 2)} 0 a ${r} ${r} 0 1 0 ${pathNumber(-radius * 2)} 0 Z`;
    }
    if (shape.kind === "ellipse" && shape.center && shape.radius != null) {
      const cx = screenX(shape.center.x);
      const cy = screenY(shape.center.y);
      const rx = shape.radius * PX_PER_CM;
      const ry = (shape.radiusY ?? shape.radius) * PX_PER_CM;
      return `M ${pathNumber(cx - rx)} ${pathNumber(cy)} a ${pathNumber(rx)} ${pathNumber(ry)} 0 1 0 ${pathNumber(rx * 2)} 0 a ${pathNumber(rx)} ${pathNumber(ry)} 0 1 0 ${pathNumber(-rx * 2)} 0 Z`;
    }
  }

  const start = subpath.start.point;
  let data = `M ${pathNumber(screenX(start.x))} ${pathNumber(screenY(start.y))}`;
  for (const segment of subpath.segments) {
    if ("c1" in segment.geometry) {
      data += ` C ${pathNumber(screenX(segment.geometry.c1.x))} ${pathNumber(screenY(segment.geometry.c1.y))}, ${pathNumber(screenX(segment.geometry.c2.x))} ${pathNumber(screenY(segment.geometry.c2.y))}, ${pathNumber(screenX(segment.geometry.to.x))} ${pathNumber(screenY(segment.geometry.to.y))}`;
    } else {
      data += ` L ${pathNumber(screenX(segment.geometry.to.x))} ${pathNumber(screenY(segment.geometry.to.y))}`;
    }
  }
  if (subpath.closed || fill) data += " Z";
  return data;
}

function tangentAt(subpath: PathSubpath, edge: "start" | "end"): Point | null {
  const segment: PathSegment | undefined =
    edge === "start" ? subpath.segments[0] : subpath.segments[subpath.segments.length - 1];
  if (!segment) return null;
  if ("c1" in segment.geometry) {
    const geometry = segment.geometry as CurveGeometry;
    const x =
      edge === "start" ? geometry.c1.x - geometry.from.x : geometry.to.x - geometry.c2.x;
    const y =
      edge === "start" ? geometry.c1.y - geometry.from.y : geometry.to.y - geometry.c2.y;
    if (Math.hypot(x, y) < 0.0001) {
      return { x: geometry.to.x - geometry.from.x, y: geometry.to.y - geometry.from.y };
    }
    return { x, y };
  }
  const geometry = segment.geometry as LineGeometry;
  return {
    x: geometry.to.x - geometry.from.x,
    y: geometry.to.y - geometry.from.y,
  };
}

function ArrowHead({
  point,
  tangent,
  edge,
  color,
  opacity,
  size,
}: {
  point: Point;
  tangent: Point;
  edge: "start" | "end";
  color: string;
  opacity: number;
  size: number;
}) {
  const baseAngle = Math.atan2(-tangent.y, tangent.x);
  const angle = edge === "start" ? baseAngle + Math.PI : baseAngle;
  const length = 6.4 + size * 1.55;
  const half = length * 0.41;
  const notch = length * 0.74;
  const degrees = (angle * 180) / Math.PI;
  const x = screenX(point.x);
  const y = screenY(point.y);
  return (
    <path
      d={`M 0 0 L ${-length} ${-half} L ${-notch} 0 L ${-length} ${half} Z`}
      transform={`translate(${pathNumber(x)} ${pathNumber(y)}) rotate(${pathNumber(degrees)})`}
      fill={color}
      fillOpacity={opacity}
      stroke="none"
    />
  );
}

function EdgePath({ path }: { path: TikzPath }) {
  const stroke = path.style.draw ?? "#212720";
  const fill = path.style.fill ?? "#212720";
  const strokeOpacity = path.style.opacity;
  const dashArray = path.style.dashed
    ? `${path.style.lineWidth * 3.6} ${path.style.lineWidth * 2.8}`
    : path.style.dotted
      ? `${path.style.lineWidth * 0.4} ${path.style.lineWidth * 2.6}`
      : undefined;

  return (
    <g>
      {path.subpaths.map((subpath, subpathIndex) => {
        const data = subpathPathData(subpath, path.fill && Boolean(path.style.fill));
        const arrowStart =
          path.style.arrowStart && !subpath.closed
            ? tangentAt(subpath, "start")
            : null;
        const arrowEnd =
          path.style.arrowEnd && !subpath.closed ? tangentAt(subpath, "end") : null;
        return (
          <g key={`${path.key}-sub-${subpathIndex}`}>
            {path.style.crossing && !subpath.closed ? (
              <path
                d={data}
                fill="none"
                stroke="var(--paper)"
                strokeWidth={path.style.lineWidth + 6}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null}
            <path
              d={data}
              fill={path.fill && path.style.fill ? fill : "none"}
              fillOpacity={path.fill ? path.style.fillOpacity : 0}
              fillRule="evenodd"
              stroke={path.stroke && path.style.draw ? stroke : "none"}
              strokeOpacity={strokeOpacity}
              strokeWidth={path.style.lineWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeDasharray={dashArray}
            />
            {arrowStart ? (
              <ArrowHead
                point={subpath.start.point}
                tangent={arrowStart}
                edge="start"
                color={stroke}
                opacity={strokeOpacity}
                size={path.style.lineWidth}
              />
            ) : null}
            {arrowEnd ? (
              <ArrowHead
                point={subpath.segments[subpath.segments.length - 1].geometry.to}
                tangent={arrowEnd}
                edge="end"
                color={stroke}
                opacity={strokeOpacity}
                size={path.style.lineWidth}
              />
            ) : null}
          </g>
        );
      })}
    </g>
  );
}

function nodeShapeStyle(node: TikzNode): CSSProperties {
  const style = node.style;
  const alpha = style.opacity > 0 ? clamp(style.fillOpacity / style.opacity, 0, 1) : 0;
  const base: CSSProperties = {
    backgroundColor: style.fill ? hexWithAlpha(style.fill, alpha) : "transparent",
    borderColor: style.draw ?? "transparent",
    borderWidth: style.draw ? style.lineWidth : 0,
    borderStyle: style.dotted ? "dotted" : style.dashed ? "dashed" : "solid",
  };
  if (style.shape === "circle" || style.shape === "ellipse") {
    base.borderRadius = "50%";
  } else if (style.shape === "rounded") {
    base.borderRadius = `${Math.max(2, style.cornerRadius * PX_PER_CM)}px`;
  } else {
    base.borderRadius = "2px";
  }
  return base;
}

function DiamondShape({ node }: { node: TikzNode }) {
  const style = node.style;
  const alpha = style.opacity > 0 ? clamp(style.fillOpacity / style.opacity, 0, 1) : 0;
  return (
    <svg
      className="node-diamond"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polygon
        points="50,1.8 98.2,50 50,98.2 1.8,50"
        fill={style.fill ? hexWithAlpha(style.fill, alpha) : "none"}
        stroke={style.draw ?? "none"}
        strokeWidth={style.lineWidth}
        vectorEffect="non-scaling-stroke"
        strokeLinejoin="round"
        strokeDasharray={
          style.dashed ? `${style.lineWidth * 3.6} ${style.lineWidth * 2.8}` : undefined
        }
      />
    </svg>
  );
}

function isTouchInsideNodeBody(event: ReactPointerEvent<HTMLSpanElement>) {
  if (event.pointerType !== "touch") return false;
  const nodeElement = event.currentTarget.closest(".tikz-node");
  if (!(nodeElement instanceof HTMLElement)) return false;
  const rect = nodeElement.getBoundingClientRect();
  const marginX = Math.min(8, rect.width * 0.25);
  const marginY = Math.min(8, rect.height * 0.25);
  return (
    event.clientX > rect.left + marginX &&
    event.clientX < rect.right - marginX &&
    event.clientY > rect.top + marginY &&
    event.clientY < rect.bottom - marginY
  );
}

function NodeView({
  node,
  selected,
  showHandles,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onSelect,
  onEdit,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onAnchorPointerDown,
}: {
  node: TikzNode;
  selected: boolean;
  showHandles: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, node: TikzNode) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSelect: (key: string) => void;
  onEdit: (node: TikzNode) => void;
  onResizeStart: (
    event: ReactPointerEvent<HTMLSpanElement>,
    node: TikzNode,
    corner: Corner,
  ) => void;
  onResizeMove: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onResizeEnd: (event: ReactPointerEvent<HTMLSpanElement>) => void;
  onAnchorPointerDown: (
    event: ReactPointerEvent<HTMLSpanElement>,
    node: TikzNode,
    anchor: NodeAnchor,
  ) => void;
}) {
  const style = node.style;
  const isCdCell = node.origin === "tikzcd";
  const width = node.width * PX_PER_CM;
  const height = node.height * PX_PER_CM;
  const wrapperStyle: CSSProperties = {
    left: `${screenX(node.x)}px`,
    top: `${screenY(node.y)}px`,
    width: `${width}px`,
    height: `${height}px`,
    opacity: style.opacity,
  };
  const padding = Math.min(style.innerSep * PX_PER_CM, Math.min(width, height) * 0.22);
  const fixedTextHeight = style.textHeight != null || style.textDepth != null;
  const wrapsText = style.textWidth != null && !fixedTextHeight;
  const contentStyle: CSSProperties = {
    padding:
      style.shape === "diamond"
        ? `${Math.round(height * 0.2)}px ${Math.round(width * 0.2)}px`
        : `${Math.max(0, Math.round(padding))}px`,
    fontSize: `${style.fontSize}px`,
    color: style.textColor ?? "#232820",
    textAlign: style.align,
    whiteSpace: wrapsText ? "normal" : "nowrap",
    justifyContent:
      style.align === "left" ? "flex-start" : style.align === "right" ? "flex-end" : "center",
  };
  const corners: Corner[] = ["nw", "ne", "sw", "se"];

  return (
    <div
      className={`tikz-node${isCdCell ? " is-cd-cell" : ""}${selected ? " is-selected" : ""}`}
      style={wrapperStyle}
      data-node-key={node.key}
      role="button"
      tabIndex={0}
      aria-label={
        isCdCell
          ? `tikz-cd 单元格 ${node.text || "空"}，单击选中，双击编辑公式`
          : `节点 ${node.name || node.text || "未命名"}，拖拽移动，双击编辑文字`
      }
      onPointerDown={(event) => onPointerDown(event, node)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onEdit(node);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onEdit(node);
        } else if (event.key === " " || event.key === "Spacebar") {
          event.preventDefault();
          onSelect(node.key);
        }
      }}
    >
      {style.shape === "diamond" ? (
        <DiamondShape node={node} />
      ) : style.shape !== "none" ? (
        <span className="node-shape" style={nodeShapeStyle(node)} aria-hidden="true" />
      ) : null}
      <span
        className={`node-content${wrapsText ? " is-wrapping" : ""}`}
        style={contentStyle}
      >
        <span
          className="tikz-rich-text"
          dangerouslySetInnerHTML={{ __html: renderTikzText(node.text, node.mathMode) }}
        />
      </span>
      {selected ? <span className="selection-outline" aria-hidden="true" /> : null}
      {selected && showHandles && !isCdCell ? (
        <>
          <span className="node-badge" aria-hidden="true">
            {node.name || "node"}
          </span>
          {corners.map((corner) => (
            <span
              key={corner}
              className={`resize-handle handle-${corner}`}
              data-handle={corner}
              onPointerDown={(event) => onResizeStart(event, node, corner)}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeEnd}
              onPointerCancel={onResizeEnd}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            />
          ))}
          {NODE_ANCHORS.map((anchor) => (
            <span
              key={anchor}
              className={`node-anchor anchor-${anchor.replace(/\s+/g, "-")}`}
              style={anchorUiStyle(node, anchor)}
              data-anchor={anchor}
              title={`从${ANCHOR_LABELS[anchor]}侧锚点拖出连线`}
              onPointerDown={(event) => {
                if (isTouchInsideNodeBody(event)) return;
                event.stopPropagation();
                onAnchorPointerDown(event, node, anchor);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}

function LabelView({
  label,
  selected,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onSelect,
  onEdit,
}: {
  label: TikzLabel;
  selected: boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, label: TikzLabel) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onSelect: (key: string) => void;
  onEdit: (label: TikzLabel) => void;
}) {
  const style: CSSProperties = {
    left: `${screenX(label.position.x)}px`,
    top: `${screenY(label.position.y)}px`,
    fontSize: `${label.fontSize}px`,
    color: label.textColor ?? "#3a4036",
  };
  if (label.fill) {
    style.background = label.fill;
    style.padding = "2px 6px";
    style.borderRadius = "3px";
    style.border = label.draw ? `1px solid ${label.draw}` : undefined;
  }

  return (
    <div
      className={`edge-label${selected ? " is-selected" : ""}${label.fill ? " has-fill" : ""}${label.description ? " is-description" : ""}${label.origin === "tikzcd" ? " is-cd" : ""}`}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={
        label.origin === "tikzcd"
          ? `箭头标签 ${label.text || "空"}，单击选中，双击编辑公式`
          : `连线标签 ${label.text}，拖拽移动，双击编辑文字`
      }
      onPointerDown={(event) => onPointerDown(event, label)}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onEdit(label);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onEdit(label);
        }
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <span
        className="tikz-rich-text"
        dangerouslySetInnerHTML={{ __html: renderTikzText(label.text, label.mathMode) }}
      />
    </div>
  );
}

export function DiagramCanvas({
  doc,
  source,
  preview,
  engine,
  selectedKeys,
  onSelect,
  onSourceChange,
  fitSignal,
  onLoadExample,
  onPreviewReveal,
  onEngineRetry,
  onEngineUseNative,
  onEngineUse,
  mobileActive,
}: DiagramCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const exportControlRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef(source);
  const docRef = useRef(doc);
  const previewRef = useRef(preview);
  const engineRef = useRef(engine);
  const dragRef = useRef<DragState | null>(null);
  const curveDragRef = useRef<CurveDragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const labelDragRef = useRef<LabelDragState | null>(null);
  const cdLabelTapRef = useRef<{ key: string; at: number } | null>(null);
  const frameResizeRef = useRef<FrameResizeState | null>(null);
  const selectedKeysRef = useRef(selectedKeys);
  const editingRef = useRef<EditingState | null>(null);
  const guideTargetsRef = useRef<AlignmentTargets>({ vertical: [], horizontal: [] });
  const transformRef = useRef<Transform>({ x: 0, y: 0, zoom: 1 });
  const sizeRef = useRef<ViewportSize>({ width: 0, height: 0 });
  const autoFitRef = useRef(true);
  const lastFitSignal = useRef(fitSignal);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const marqueeMenuRef = useRef<HTMLDivElement>(null);
  const marqueeButtonRef = useRef<HTMLButtonElement>(null);
  const pinchRef = useRef<PinchState | null>(null);
  const touchPointsRef = useRef<Map<number, Point>>(new Map());
  const multiTouchRef = useRef(false);

  const [transform, setTransform] = useState<Transform>({ x: 0, y: 0, zoom: 1 });
  const [panning, setPanning] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [editing, setEditing] = useState<EditingState | null>(null);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exporting, setExporting] = useState<ExportFormat | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<MarqueeState | null>(null);
  const [marqueeFilter, setMarqueeFilter] = useState<MarqueeFilter>(DEFAULT_MARQUEE_FILTER);
  const [marqueeMenuOpen, setMarqueeMenuOpen] = useState(false);
  const [marqueeMenuPos, setMarqueeMenuPos] = useState({ left: 14, top: 56 });
  const [pinching, setPinching] = useState(false);
  const [shapeTool, setShapeTool] = useState<ShapeTool | null>(null);
  const [shapeDraft, setShapeDraft] = useState<ShapeDraftState | null>(null);
  const [panTool, setPanTool] = useState(false);
  const [spacePan, setSpacePan] = useState(false);
  const [magnetOn, setMagnetOn] = useState(true);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuides>(EMPTY_GUIDES);
  const [pathAttachHints, setPathAttachHints] = useState<PathAttachHint[]>([]);
  const [selectionPanelCollapsed, setSelectionPanelCollapsed] = useState(false);
  const [bendMode, setBendMode] = useState<BendMode>("curve");
  const [connectorDraft, setConnectorDraft] = useState<ConnectorDraftState | null>(null);
  const [connectorArrow, setConnectorArrow] = useState(true);
  const [connectorDashed, setConnectorDashed] = useState(false);
  const shapeToolRef = useRef<ShapeTool | null>(shapeTool);
  const panToolRef = useRef(panTool);
  const spacePanRef = useRef(spacePan);
  const magnetRef = useRef(magnetOn);
  const connectorArrowRef = useRef(connectorArrow);
  const connectorDashedRef = useRef(connectorDashed);
  const marqueeFilterRef = useRef(marqueeFilter);
  const colorSessionRef = useRef<ColorSession | null>(null);

  sourceRef.current = source;
  docRef.current = doc;
  previewRef.current = preview;
  engineRef.current = engine;
  selectedKeysRef.current = selectedKeys;
  editingRef.current = editing;
  transformRef.current = transform;
  shapeToolRef.current = shapeTool;
  panToolRef.current = panTool;
  spacePanRef.current = spacePan;
  magnetRef.current = magnetOn;
  connectorArrowRef.current = connectorArrow;
  connectorDashedRef.current = connectorDashed;
  marqueeFilterRef.current = marqueeFilter;

  const selectedKeySet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const selectionObjects = useMemo(
    () => collectSelection(doc, selectedKeys),
    [doc, selectedKeys],
  );
  const selectionLocked = useMemo(
    () => selectionHasTikzCd(selectionObjects),
    [selectionObjects],
  );
  const selectedCount = selectionSize(selectionObjects);
  const groupBounds = useMemo(() => selectionBounds(selectionObjects), [selectionObjects]);
  const soleKey = selectedKeys.length === 1 ? selectedKeys[0] : null;
  const selectedNode = useMemo(
    () => (soleKey ? doc.nodes.find((node) => node.key === soleKey) ?? null : null),
    [doc.nodes, soleKey],
  );
  const selectedLabel = useMemo(
    () => (soleKey ? doc.labels.find((label) => label.key === soleKey) ?? null : null),
    [doc.labels, soleKey],
  );
  const selectedFrame = useMemo(
    () => (soleKey ? doc.frames.find((frame) => frame.key === soleKey) ?? null : null),
    [doc.frames, soleKey],
  );
  const selectedPath = useMemo(
    () =>
      soleKey
        ? doc.paths.find(
            (path) => path.key === soleKey && isSelectableEdge(path),
          ) ?? null
        : null,
    [doc.paths, soleKey],
  );
  const selectedFontPoints = selectedNode
    ? fontPointsFromPixels(selectedNode.style.fontSize)
    : selectedLabel
      ? fontPointsFromPixels(selectedLabel.fontSize)
      : null;
  const selectedPathHandles = useMemo(
    () =>
      selectedPath && selectedPath.origin !== "tikzcd"
        ? pathEndpointHandles(selectedPath)
        : [],
    [selectedPath],
  );
  const selectedCurveHandles = useMemo(
    () =>
      selectedPath && selectedPath.origin !== "tikzcd"
        ? pathCurveHandles(selectedPath, source)
        : [],
    [selectedPath, source],
  );
  const selectedPolylineHandles = useMemo(
    () =>
      selectedPath && selectedPath.origin !== "tikzcd" && bendMode === "polyline"
        ? pathPolylineHandles(selectedPath, source)
        : [],
    [bendMode, selectedPath, source],
  );
  const selectedVertexHandles = useMemo(
    () =>
      selectedPath && selectedPath.origin !== "tikzcd"
        ? pathVertexHandles(selectedPath, source)
        : [],
    [selectedPath, source],
  );
  const pathAttachNodes = useMemo(() => {
    const nodes = new Map<string, { node: TikzNode; active: boolean }>();
    for (const hint of pathAttachHints) {
      const current = nodes.get(hint.node.key);
      nodes.set(hint.node.key, {
        node: hint.node,
        active: current?.active === true || hint.active,
      });
    }
    return Array.from(nodes.values());
  }, [pathAttachHints]);
  const connectorTargetNode = connectorDraft?.targetNodeKey
    ? (doc.nodes.find((node) => node.key === connectorDraft.targetNodeKey) ?? null)
    : null;

  const selectOnly = useCallback(
    (key: string | null) => {
      onSelect(key ? [key] : []);
    },
    [onSelect],
  );

  const toggleSelection = useCallback(
    (key: string) => {
      const current = selectedKeysRef.current;
      const doc = docRef.current;
      const nextIsCd = keyIsTikzCd(doc, key);
      const currentHasCd = current.some((item) => keyIsTikzCd(doc, item));
      const currentHasOther = current.some((item) => !keyIsTikzCd(doc, item));
      if (current.length > 0 && (nextIsCd ? currentHasOther : currentHasCd)) {
        onSelect([key]);
        return;
      }
      onSelect(
        current.includes(key)
          ? current.filter((item) => item !== key)
          : [...current, key],
      );
    },
    [onSelect],
  );

  const toggleMarqueeMenu = useCallback(() => {
    if (marqueeMenuOpen) {
      setMarqueeMenuOpen(false);
      return;
    }
    const button = marqueeButtonRef.current;
    const viewport = viewportRef.current;
    if (button && viewport) {
      const buttonRect = button.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      const menuWidth = 232;
      const margin = 8;
      const maxLeft = viewportRect.width - menuWidth - margin;
      let left = buttonRect.left - viewportRect.left;
      if (left > maxLeft) {
        left = buttonRect.right - viewportRect.left - menuWidth;
      }
      setMarqueeMenuPos({
        left: Math.max(margin, Math.min(left, maxLeft)),
        top: buttonRect.bottom - viewportRect.top + 6,
      });
    }
    setMarqueeMenuOpen(true);
  }, [marqueeMenuOpen]);

  const fitToContent = useCallback(() => {
    const viewport = viewportRef.current;
    const { width, height } = sizeRef.current;
    if (!viewport || width < 80 || height < 80) return;
    const activePreview = previewRef.current;
    const bounds = activePreview
      ? previewBounds(activePreview)
      : docRef.current.bounds;
    const contentWidth = Math.max((bounds.maxX - bounds.minX) * PX_PER_CM, 72);
    const contentHeight = Math.max((bounds.maxY - bounds.minY) * PX_PER_CM, 72);
    const padding = Math.min(FIT_PADDING, Math.max(26, Math.min(width, height) * 0.09));
    const zoom = clamp(
      Math.min((width - padding * 2) / contentWidth, (height - padding * 2) / contentHeight),
      0.2,
      1.8,
    );
    const centerX = ((bounds.minX + bounds.maxX) / 2) * PX_PER_CM;
    const centerY = ((bounds.minY + bounds.maxY) / 2) * PX_PER_CM;
    autoFitRef.current = true;
    setTransform({
      zoom,
      x: width / 2 - centerX * zoom,
      y: height / 2 + centerY * zoom,
    });
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const previous = sizeRef.current;
      const next = { width: rect.width, height: rect.height };
      sizeRef.current = next;
      if ((previous.width === 0 || previous.height === 0) && next.width > 0) {
        fitToContent();
        return;
      }
      if (autoFitRef.current) {
        fitToContent();
        return;
      }
      const deltaX = (next.width - previous.width) / 2;
      const deltaY = (next.height - previous.height) / 2;
      if (Math.abs(deltaX) > 0.5 || Math.abs(deltaY) > 0.5) {
        setTransform((current) => ({
          ...current,
          x: current.x + deltaX,
          y: current.y + deltaY,
        }));
      }
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [fitToContent]);

  useEffect(() => {
    if (lastFitSignal.current === fitSignal) return;
    lastFitSignal.current = fitSignal;
    fitToContent();
  }, [fitSignal, fitToContent]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      autoFitRef.current = false;
      const rect = viewport.getBoundingClientRect();
      const px = event.clientX - rect.left;
      const py = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * 0.0016);
      setTransform((current) => {
        const zoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
        const ratio = zoom / current.zoom;
        return {
          zoom,
          x: px - (px - current.x) * ratio,
          y: py - (py - current.y) * ratio,
        };
      });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let resetTimer: number | null = null;

    const localPoint = (event: PointerEvent): Point => {
      const rect = viewport.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    const clearResetTimer = () => {
      if (resetTimer != null) {
        window.clearTimeout(resetTimer);
        resetTimer = null;
      }
    };

    const handleDown = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      const target = event.target as Element | null;
      if (
        target?.closest(
          "[data-canvas-ui], input, textarea, select, [contenteditable='true']",
        )
      ) {
        return;
      }
      touchPointsRef.current.set(event.pointerId, localPoint(event));
      if (touchPointsRef.current.size < 2) return;

      if (!pinchRef.current) {
        clearResetTimer();
        multiTouchRef.current = true;
        dragRef.current = null;
        resizeRef.current = null;
        labelDragRef.current = null;
        frameResizeRef.current = null;
        setMarquee(null);
        setShapeDraft(null);
        setConnectorDraft(null);
        setAlignmentGuides(EMPTY_GUIDES);
        setPathAttachHints([]);
        setPanning(false);
        setIssuesOpen(false);
        setPinching(true);
        autoFitRef.current = false;
        const entries = Array.from(touchPointsRef.current.entries()).slice(0, 2);
        const first = entries[0];
        const second = entries[1];
        if (first && second) {
          pinchRef.current = {
            pointerIds: [first[0], second[0]],
            startDistance: Math.max(
              1,
              Math.hypot(first[1].x - second[1].x, first[1].y - second[1].y),
            ),
            startMidpoint: {
              x: (first[1].x + second[1].x) / 2,
              y: (first[1].y + second[1].y) / 2,
            },
            startTransform: { ...transformRef.current },
          };
        }
      }
      event.preventDefault();
      event.stopPropagation();
    };

    const handleMove = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      if (!touchPointsRef.current.has(event.pointerId)) return;
      touchPointsRef.current.set(event.pointerId, localPoint(event));
      const pinch = pinchRef.current;
      if (!pinch) return;
      const first = touchPointsRef.current.get(pinch.pointerIds[0]);
      const second = touchPointsRef.current.get(pinch.pointerIds[1]);
      if (!first || !second) return;
      event.preventDefault();
      event.stopPropagation();
      const midpoint = {
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
      };
      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const start = pinch.startTransform;
      const zoom = clamp(
        start.zoom * (distance / pinch.startDistance),
        MIN_ZOOM,
        MAX_ZOOM,
      );
      const anchorX =
        (pinch.startMidpoint.x - start.x) / (start.zoom * PX_PER_CM);
      const anchorY =
        -(pinch.startMidpoint.y - start.y) / (start.zoom * PX_PER_CM);
      setTransform({
        zoom,
        x: midpoint.x - anchorX * zoom * PX_PER_CM,
        y: midpoint.y + anchorY * zoom * PX_PER_CM,
      });
    };

    const handleUp = (event: PointerEvent) => {
      if (event.pointerType !== "touch") return;
      if (!touchPointsRef.current.has(event.pointerId)) return;
      touchPointsRef.current.delete(event.pointerId);
      if (pinchRef.current && touchPointsRef.current.size < 2) {
        pinchRef.current = null;
        setPinching(false);
      }
      if (touchPointsRef.current.size === 0 && multiTouchRef.current) {
        clearResetTimer();
        resetTimer = window.setTimeout(() => {
          resetTimer = null;
          multiTouchRef.current = false;
        }, 0);
      }
    };

    viewport.addEventListener("pointerdown", handleDown, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointermove", handleMove, {
      capture: true,
      passive: false,
    });
    window.addEventListener("pointerup", handleUp, true);
    window.addEventListener("pointercancel", handleUp, true);
    return () => {
      clearResetTimer();
      viewport.removeEventListener("pointerdown", handleDown, true);
      window.removeEventListener("pointermove", handleMove, true);
      window.removeEventListener("pointerup", handleUp, true);
      window.removeEventListener("pointercancel", handleUp, true);
    };
  }, []);

  useEffect(() => {
    if (!editing) return;
    const exists =
      editing.kind === "node"
        ? doc.nodes.some((node) => node.key === editing.key)
        : doc.labels.some((label) => label.key === editing.key);
    if (!exists) setEditing(null);
  }, [doc, editing]);

  useEffect(() => {
    if (!exportOpen) return;
    const handlePointer = (event: PointerEvent) => {
      if (!exportControlRef.current?.contains(event.target as Node)) setExportOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExportOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [exportOpen]);

  useEffect(() => {
    if (!marqueeMenuOpen) return;
    const handlePointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (marqueeMenuRef.current?.contains(target)) return;
      if (marqueeButtonRef.current?.contains(target)) return;
      setMarqueeMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMarqueeMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [marqueeMenuOpen]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (editingRef.current) return;
      if (shapeToolRef.current || panToolRef.current) return;
      if (marqueeMenuOpen) return;
      if (!selectedKeysRef.current.length) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable='true'], .cm-editor")
      ) {
        return;
      }
      event.preventDefault();
      onSelect([]);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [marqueeMenuOpen, onSelect]);

  useEffect(() => {
    if (!editing) return;
    const frame = requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [editing]);

  const openEditor = useCallback(
    (object: TikzNode | TikzLabel) => {
      const isNode = object.kind === "node";
      if (isNode && object.origin === "tikzcd" && !object.textEditable) return;
      setIssuesOpen(false);
      setDraft(object.text);
      setDraftError(null);
      setEditing({
        key: object.key,
        kind: isNode ? "node" : "label",
        title: isNode
          ? object.origin === "tikzcd" && object.tikzcdCell
            ? `编辑单元格 · 第 ${object.tikzcdCell.row + 1} 行第 ${object.tikzcdCell.col + 1} 列`
            : `编辑节点 · ${object.name || `#${(object as TikzNode).index + 1}`}`
          : object.origin === "tikzcd"
            ? "编辑箭头标签"
            : "编辑连线标签",
      });
      selectOnly(object.key);
    },
    [selectOnly],
  );

  const closeEditor = useCallback(() => {
    setEditing(null);
    setDraftError(null);
  }, []);

  const saveEditor = useCallback(() => {
    if (!editing) return;
    const object =
      editing.kind === "node"
        ? doc.nodes.find((node) => node.key === editing.key)
        : doc.labels.find((label) => label.key === editing.key);
    if (!object) {
      closeEditor();
      return;
    }
    const error =
      object.origin === "tikzcd"
        ? editing.kind === "node"
          ? validateTikzCdCellText(draft)
          : validateTikzCdLabelText(draft)
        : validateNodeText(draft);
    if (error) {
      setDraftError(error);
      return;
    }
    onSourceChange(patchText(sourceRef.current, object, draft));
    closeEditor();
  }, [closeEditor, doc.labels, doc.nodes, draft, editing, onSourceChange]);

  const beginColorSession = useCallback(
    (kind: "node" | "label") => {
      if (kind === "node") {
        const key = selectedNode?.key;
        if (!key) return;
        const node = docRef.current.nodes.find((item) => item.key === key);
        if (node) {
          colorSessionRef.current = {
            kind: "node",
            key,
            source: sourceRef.current,
            node,
          };
        }
        return;
      }
      const key = selectedLabel?.key;
      if (!key) return;
      const label = docRef.current.labels.find((item) => item.key === key);
      if (label) {
        colorSessionRef.current = {
          kind: "label",
          key,
          source: sourceRef.current,
          label,
        };
      }
    },
    [selectedLabel?.key, selectedNode?.key],
  );

  const changeNodeColor = useCallback(
    (channel: "fill" | "draw" | "text", value: string | null) => {
      const key = selectedNode?.key;
      if (!key) return;
      const session =
        colorSessionRef.current?.kind === "node" && colorSessionRef.current.key === key
          ? colorSessionRef.current
          : null;
      const node =
        session?.node ?? docRef.current.nodes.find((item) => item.key === key);
      if (!node) return;
      const baseSource = session?.source ?? sourceRef.current;
      const change =
        channel === "fill"
          ? { fill: value }
          : channel === "draw"
            ? { draw: value }
            : { text: value };
      const next = patchNodeColors(baseSource, node, change);
      if (session) {
        const nextNode =
          parseTikz(next).nodes.find((item) => item.key === node.key) ?? null;
        colorSessionRef.current = nextNode
          ? { kind: "node", key, source: next, node: nextNode }
          : null;
      }
      onSourceChange(next);
    },
    [onSourceChange, selectedNode?.key],
  );

  const changeLabelColor = useCallback(
    (value: string) => {
      const key = selectedLabel?.key;
      if (!key) return;
      const session =
        colorSessionRef.current?.kind === "label" && colorSessionRef.current.key === key
          ? colorSessionRef.current
          : null;
      const label =
        session?.label ?? docRef.current.labels.find((item) => item.key === key);
      if (!label) return;
      const baseSource = session?.source ?? sourceRef.current;
      const next = patchLabelColor(baseSource, label, value);
      if (session) {
        const nextLabel =
          parseTikz(next).labels.find((item) => item.key === label.key) ?? null;
        colorSessionRef.current = nextLabel
          ? { kind: "label", key, source: next, label: nextLabel }
          : null;
      }
      onSourceChange(next);
    },
    [onSourceChange, selectedLabel?.key],
  );

  const changeTikzCdArrow = useCallback(
    (change: TikzCdArrowStylePatch) => {
      const key = selectedPath?.key;
      if (!key) return;
      const currentSource = sourceRef.current;
      const path = parseTikz(currentSource).paths.find((item) => item.key === key);
      if (!path || path.origin !== "tikzcd") return;
      if (
        (change.line && tikzCdLineStyle(path) === change.line) ||
        (change.ends && tikzCdArrowEnds(path) === change.ends) ||
        (change.bend && tikzCdBend(path) === change.bend)
      ) {
        return;
      }
      onSourceChange(patchTikzCdArrow(currentSource, path, change));
    },
    [onSourceChange, selectedPath?.key],
  );

  const stepSelectedFontSize = useCallback(
    (delta: number) => {
      if (selectedNode) {
        const current = fontPointsFromPixels(selectedNode.style.fontSize);
        const next = Math.max(FONT_PT_MIN, Math.min(FONT_PT_MAX, current + delta));
        if (next === current) return;
        onSourceChange(
          patchNodeFontSize(sourceRef.current, selectedNode, next),
        );
        return;
      }
      if (selectedLabel) {
        const current = fontPointsFromPixels(selectedLabel.fontSize);
        const next = Math.max(FONT_PT_MIN, Math.min(FONT_PT_MAX, current + delta));
        if (next === current) return;
        onSourceChange(
          patchLabelFontSize(sourceRef.current, selectedLabel, next),
        );
      }
    },
    [onSourceChange, selectedLabel, selectedNode],
  );

  const activateShapeTool = useCallback(
    (tool: ShapeTool | null) => {
      setPanTool(false);
      setShapeTool(tool);
      setShapeDraft(null);
      if (tool) {
        setIssuesOpen(false);
        if (editingRef.current) closeEditor();
        onSelect([]);
      }
    },
    [closeEditor, onSelect],
  );

  const togglePanTool = useCallback(() => {
    const next = !panToolRef.current;
    setPanTool(next);
    if (!next) return;
    setShapeTool(null);
    setShapeDraft(null);
    setIssuesOpen(false);
    setAlignmentGuides(EMPTY_GUIDES);
    if (editingRef.current) closeEditor();
  }, [closeEditor]);

  useEffect(() => {
    if (!shapeTool && !panTool) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setShapeTool(null);
      setShapeDraft(null);
      setPanTool(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [shapeTool, panTool]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      const element = target as HTMLElement | null;
      return Boolean(
        element?.closest(
          "input, textarea, select, [contenteditable='true'], .cm-editor, .tikz-node, .edge-label, button",
        ),
      );
    };
    const handleDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (editingRef.current) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      spacePanRef.current = true;
      setSpacePan(true);
      setAlignmentGuides(EMPTY_GUIDES);
    };
    const handleUp = (event: KeyboardEvent) => {
      if (event.code !== "Space" || !spacePanRef.current) return;
      event.preventDefault();
      spacePanRef.current = false;
      setSpacePan(false);
    };
    const handleBlur = () => {
      spacePanRef.current = false;
      setSpacePan(false);
    };
    window.addEventListener("keydown", handleDown);
    window.addEventListener("keyup", handleUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleDown);
      window.removeEventListener("keyup", handleUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  const startConnector = useCallback(
    (
      event: ReactPointerEvent<HTMLSpanElement>,
      node: TikzNode,
      anchor: NodeAnchor,
    ) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      setIssuesOpen(false);
      if (editingRef.current) closeEditor();
      const viewport = viewportRef.current;
      if (!viewport) return;
      const rect = viewport.getBoundingClientRect();
      const start = nodeAnchorPoint(node, anchor);
      const pointerId = event.pointerId;
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      let moved = false;

      const modelPoint = (clientX: number, clientY: number): Point => {
        const current = transformRef.current;
        return {
          x: (clientX - rect.left - current.x) / (current.zoom * PX_PER_CM),
          y: -(clientY - rect.top - current.y) / (current.zoom * PX_PER_CM),
        };
      };

      setConnectorDraft({
        from: start,
        to: start,
        targetNodeKey: null,
        targetAnchor: null,
      });
      setAlignmentGuides(EMPTY_GUIDES);

      const resolvePoint = (
        clientX: number,
        clientY: number,
        shiftKey: boolean,
        altKey: boolean,
        pointerType: string,
      ) => {
        const point = modelPoint(clientX, clientY);
        const target = findConnectorTarget(docRef.current, node.key, point);
        if (target) {
          return {
            point: nodeAnchorPoint(target.node, target.anchor),
            target,
            guides: EMPTY_GUIDES,
          };
        }
        let constrained: { point: Point; axis: "horizontal" | "vertical" | null } = {
          point,
          axis: null,
        };
        if (shiftKey) {
          constrained = axisConstrainedPoint(start, point, 0, true);
        } else if (magnetRef.current && !altKey) {
          constrained = axisConstrainedPoint(
            start,
            point,
            alignmentThreshold(transformRef.current.zoom, pointerType === "touch"),
            false,
          );
        }
        return {
          point: constrained.point,
          target: null,
          guides:
            constrained.axis === "horizontal"
              ? { vertical: [], horizontal: [start.y] }
              : constrained.axis === "vertical"
                ? { vertical: [start.x], horizontal: [] }
                : EMPTY_GUIDES,
        };
      };

      let lastResolved: {
        point: Point;
        target: { node: TikzNode; anchor: NodeAnchor } | null;
        guides: AlignmentGuides;
      } | null = null;

      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId) return;
        if (multiTouchRef.current) return;
        if (
          !moved &&
          Math.hypot(moveEvent.clientX - startClientX, moveEvent.clientY - startClientY) < 3
        ) {
          return;
        }
        moved = true;
        const resolved = resolvePoint(
          moveEvent.clientX,
          moveEvent.clientY,
          moveEvent.shiftKey,
          moveEvent.altKey,
          moveEvent.pointerType,
        );
        lastResolved = resolved;
        setAlignmentGuides(moveEvent.altKey ? EMPTY_GUIDES : resolved.guides);
        setConnectorDraft({
          from: start,
          to: resolved.point,
          targetNodeKey: resolved.target?.node.key ?? null,
          targetAnchor: resolved.target?.anchor ?? null,
        });
      };

      const finish = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        setConnectorDraft(null);
        setAlignmentGuides(EMPTY_GUIDES);
        if (!moved || !lastResolved || upEvent.type === "pointercancel" || multiTouchRef.current) {
          return;
        }
        const resolved = lastResolved;
        const result = insertConnector(sourceRef.current, docRef.current, {
          from: { node, anchor },
          to: resolved.target
            ? { node: resolved.target.node, anchor: resolved.target.anchor }
            : undefined,
          point: resolved.point,
          arrow: connectorArrowRef.current,
          dashed: connectorDashedRef.current,
        });
        onSourceChange(result.source);
        if (result.fromKey) onSelect([result.fromKey]);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [closeEditor, onSelect, onSourceChange],
  );

  const exportDiagram = useCallback(
    async (format: ExportFormat) => {
      const layer = layerRef.current;
      if (!layer || exporting) return;
      setExportError(null);
      setExporting(format);
      const activePreview = previewRef.current;
      const bounds = activePreview
        ? previewBounds(activePreview)
        : docRef.current.bounds;
      let minX = bounds.minX * PX_PER_CM;
      let maxX = bounds.maxX * PX_PER_CM;
      let minY = -bounds.maxY * PX_PER_CM;
      let maxY = -bounds.minY * PX_PER_CM;
      const layerRect = layer.getBoundingClientRect();
      if (transform.zoom > 0) {
        layer
          .querySelectorAll<HTMLElement>(
            ".node-content:not(.is-wrapping) > .tikz-rich-text, .edge-label",
          )
          .forEach((element) => {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return;
            minX = Math.min(minX, (rect.left - layerRect.left) / transform.zoom);
            maxX = Math.max(maxX, (rect.right - layerRect.left) / transform.zoom);
            minY = Math.min(minY, (rect.top - layerRect.top) / transform.zoom);
            maxY = Math.max(maxY, (rect.bottom - layerRect.top) / transform.zoom);
          });
      }
      const width = Math.ceil(maxX - minX + EXPORT_PADDING * 2);
      const height = Math.ceil(maxY - minY + EXPORT_PADDING * 2);
      const stage = document.createElement("div");
      stage.setAttribute("aria-hidden", "true");
      stage.style.cssText = [
        "position: fixed",
        "left: -100000px",
        "top: 0",
        `width: ${width}px`,
        `height: ${height}px`,
        "pointer-events: none",
        "background: transparent",
      ].join(";");
      const clone = layer.cloneNode(true) as HTMLDivElement;
      clone.style.transform = `translate(${EXPORT_PADDING - minX}px, ${EXPORT_PADDING - minY}px)`;
      clone.style.willChange = "auto";
      clone
        .querySelectorAll(
          ".selection-outline, .node-badge, .resize-handle, .node-anchor, .frame-overlay, .group-selection, .frame-highlight, .edge-selection-layer, .path-endpoint-handle, .path-attach-node, .path-attach-anchor, .marquee-box, .connector-preview, .connector-target-outline, .shape-draft",
        )
        .forEach((element) => element.remove());
      clone.querySelectorAll(".is-selected").forEach((element) => {
        element.classList.remove("is-selected");
      });
      stage.appendChild(clone);
      document.body.appendChild(stage);
      try {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await document.fonts.ready;
        const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-");
        const filename = `tikz-diagram-${stamp}.${format}`;
        const captureOptions = {
          width,
          height,
          cacheBust: true,
          style: {
            position: "static",
            inset: "auto",
            margin: "0",
            transform: "none",
            opacity: "1",
            visibility: "visible",
          },
        };
        if (format === "svg") {
          const dataUrl = await toSvg(stage, captureOptions);
          const markup = compactSvgMarkup(dataUrl);
          const blob = markup
            ? new Blob([markup], { type: "image/svg+xml;charset=utf-8" })
            : await fetch(dataUrl).then((response) => response.blob());
          downloadBlob(blob, filename);
        } else if (format === "png") {
          const blob = await toBlob(stage, {
            ...captureOptions,
            pixelRatio: 2,
            backgroundColor: "#ffffff",
          });
          if (!blob) throw new Error("Empty export");
          downloadBlob(blob, filename);
        } else {
          const dataUrl = await toJpeg(stage, {
            ...captureOptions,
            pixelRatio: 2,
            backgroundColor: "#ffffff",
            quality: 0.96,
          });
          const blob = await fetch(dataUrl).then((response) => response.blob());
          downloadBlob(blob, filename);
        }
        setExportOpen(false);
      } catch (error) {
        console.error("Diagram export failed", error);
        setExportError("导出失败，请重试。");
      } finally {
        stage.remove();
        setExporting(null);
      }
    },
    [exporting, transform.zoom],
  );

  const beginGroupMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>, clickedKey?: string) => {
      if (event.button !== 0) return;
      const objects = collectSelection(docRef.current, selectedKeysRef.current);
      if (selectionSize(objects) < 2) return;
      if (selectionHasTikzCd(objects)) return;
      event.preventDefault();
      event.stopPropagation();
      setIssuesOpen(false);
      if (editingRef.current) closeEditor();
      guideTargetsRef.current = collectAlignmentTargets(
        docRef.current,
        new Set(selectedKeysRef.current),
      );
      setAlignmentGuides(EMPTY_GUIDES);
      const target = event.currentTarget;
      const source = sourceRef.current;
      const pointerId = event.pointerId;
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      let moved = false;
      try {
        target.setPointerCapture(pointerId);
      } catch {
        // Ignore a pointer that the browser cannot capture.
      }

      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId || multiTouchRef.current) return;
        const deltaX = moveEvent.clientX - startClientX;
        const deltaY = moveEvent.clientY - startClientY;
        if (!moved && Math.hypot(deltaX, deltaY) < 2) return;
        moved = true;
        const cmPerPixel = 1 / (transformRef.current.zoom * PX_PER_CM);
        let dx = deltaX * cmPerPixel;
        let dy = -deltaY * cmPerPixel;
        if (moveEvent.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const allowX = !moveEvent.shiftKey || dx !== 0;
        const allowY = !moveEvent.shiftKey || dy !== 0;
        const bounds = selectionBounds(objects);
        const guide =
          bounds === null
            ? null
            : findAlignmentSnap(
                shiftedBounds(bounds, dx, dy),
                guideTargetsRef.current,
                alignmentThreshold(
                  transformRef.current.zoom,
                  moveEvent.pointerType === "touch",
                ),
              );
        const magnet = magnetRef.current && !moveEvent.altKey;
        if (guide && magnet && allowX && guide.snappedX) dx += guide.dx;
        if (guide && magnet && allowY && guide.snappedY) dy += guide.dy;
        setAlignmentGuides(
          moveEvent.altKey || !guide
            ? EMPTY_GUIDES
            : {
                vertical: allowX ? guide.guides.vertical : [],
                horizontal: allowY ? guide.guides.horizontal : [],
              },
        );
        const step = moveEvent.altKey ? 0 : 0.1;
        const finalDx =
          guide && magnet && allowX && guide.snappedX ? dx : snap(dx, step);
        const finalDy =
          guide && magnet && allowY && guide.snappedY ? dy : snap(dy, step);
        onSourceChange(
          patchSelectionTranslation(source, objects, finalDx, finalDy),
        );
      };

      const finish = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        setAlignmentGuides(EMPTY_GUIDES);
        try {
          target.releasePointerCapture(pointerId);
        } catch {
          // Ignore a pointer that the browser already released.
        }
        if (
          !moved &&
          clickedKey &&
          upEvent.type !== "pointercancel" &&
          !multiTouchRef.current
        ) {
          selectOnly(clickedKey);
        }
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [closeEditor, onSourceChange, selectOnly],
  );

  const startGroupResize = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>, corner: Corner) => {
      if (event.button !== 0) return;
      const objects = collectSelection(docRef.current, selectedKeysRef.current);
      const bounds = selectionBounds(objects);
      if (!bounds || selectionSize(objects) < 2) return;
      if (selectionHasTikzCd(objects)) return;
      event.preventDefault();
      event.stopPropagation();
      setIssuesOpen(false);
      if (editingRef.current) closeEditor();
      const target = event.currentTarget;
      const source = sourceRef.current;
      const pointerId = event.pointerId;
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      let moved = false;
      try {
        target.setPointerCapture(pointerId);
      } catch {
        // Ignore a pointer that the browser cannot capture.
      }

      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId || multiTouchRef.current) return;
        const deltaX = moveEvent.clientX - startClientX;
        const deltaY = moveEvent.clientY - startClientY;
        if (!moved && Math.hypot(deltaX, deltaY) < 1) return;
        moved = true;
        const cmPerPixel = 1 / (transformRef.current.zoom * PX_PER_CM);
        const dx = deltaX * cmPerPixel;
        const dy = -deltaY * cmPerPixel;
        const step = moveEvent.altKey ? 0 : 0.05;
        const width = bounds.maxX - bounds.minX;
        const height = bounds.maxY - bounds.minY;
        const minWidth = Math.min(0.6, width);
        const minHeight = Math.min(0.6, height);
        let minX = bounds.minX;
        let minY = bounds.minY;
        let maxX = bounds.maxX;
        let maxY = bounds.maxY;
        if (corner === "ne" || corner === "se") {
          maxX = Math.max(snap(bounds.maxX + dx, step), minX + minWidth);
        } else {
          minX = Math.min(snap(bounds.minX + dx, step), maxX - minWidth);
        }
        if (corner === "nw" || corner === "ne") {
          maxY = Math.max(snap(bounds.maxY + dy, step), minY + minHeight);
        } else {
          minY = Math.min(snap(bounds.minY + dy, step), maxY - minHeight);
        }
        onSourceChange(
          patchSelectionScale(source, objects, bounds, { minX, minY, maxX, maxY }),
        );
      };

      const finish = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        try {
          target.releasePointerCapture(pointerId);
        } catch {
          // Ignore a pointer that the browser already released.
        }
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [closeEditor, onSourceChange],
  );

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, node: TikzNode) => {
      if (shapeToolRef.current) return;
      if (event.button !== 0) return;
      if (node.origin === "tikzcd") {
        event.stopPropagation();
        event.preventDefault();
        (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        setIssuesOpen(false);
        if (editing && editing.key !== node.key) closeEditor();
        if (event.shiftKey) toggleSelection(node.key);
        else selectOnly(node.key);
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      (event.currentTarget as HTMLElement).focus({ preventScroll: true });
      setIssuesOpen(false);
      if (editing && editing.key !== node.key) closeEditor();
      if (event.shiftKey) {
        toggleSelection(node.key);
        return;
      }
      const current = selectedKeysRef.current;
      if (current.length > 1 && current.includes(node.key)) {
        beginGroupMove(event, node.key);
        return;
      }
      selectOnly(node.key);
      guideTargetsRef.current = collectAlignmentTargets(
        docRef.current,
        new Set([...selectedKeysRef.current, node.key]),
      );
      setAlignmentGuides(EMPTY_GUIDES);
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        source: sourceRef.current,
        node,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: node.x,
        startY: node.y,
        moved: false,
      };
    },
    [beginGroupMove, closeEditor, editing, selectOnly, toggleSelection],
  );

  const moveDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId || multiTouchRef.current) return;
      const deltaX = event.clientX - drag.startClientX;
      const deltaY = event.clientY - drag.startClientY;
      if (!drag.moved && Math.hypot(deltaX, deltaY) < 2) return;
      drag.moved = true;
      const cmPerPixel = 1 / (transform.zoom * PX_PER_CM);
      let dx = deltaX * cmPerPixel;
      let dy = -deltaY * cmPerPixel;
      if (event.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const allowX = !event.shiftKey || dx !== 0;
      const allowY = !event.shiftKey || dy !== 0;
      const guide = findAlignmentSnap(
        shiftedBounds(drag.node.bounds, dx, dy),
        guideTargetsRef.current,
        alignmentThreshold(transformRef.current.zoom, event.pointerType === "touch"),
      );
      const magnet = magnetRef.current && !event.altKey;
      if (magnet && allowX && guide.snappedX) dx += guide.dx;
      if (magnet && allowY && guide.snappedY) dy += guide.dy;
      setAlignmentGuides(
        event.altKey
          ? EMPTY_GUIDES
          : {
              vertical: allowX ? guide.guides.vertical : [],
              horizontal: allowY ? guide.guides.horizontal : [],
            },
      );
      const step = event.altKey ? 0 : 0.1;
      const x =
        magnet && allowX && guide.snappedX
          ? drag.startX + dx
          : snap(drag.startX + dx, step);
      const y =
        magnet && allowY && guide.snappedY
          ? drag.startY + dy
          : snap(drag.startY + dy, step);
      onSourceChange(patchNodePosition(drag.source, drag.node, x, y));
    },
    [onSourceChange, transform.zoom],
  );

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    setAlignmentGuides(EMPTY_GUIDES);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
  }, []);

  const startLabelDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, label: TikzLabel) => {
      if (shapeToolRef.current) return;
      if (event.button !== 0) return;
      if (label.origin === "tikzcd") {
        event.stopPropagation();
        (event.currentTarget as HTMLElement).focus({ preventScroll: true });
        setIssuesOpen(false);
        if (editing && editing.key !== label.key) closeEditor();
        if (event.shiftKey) {
          toggleSelection(label.key);
          return;
        }
        const now = Date.now();
        const lastTap = cdLabelTapRef.current;
        if (lastTap && lastTap.key === label.key && now - lastTap.at < 400) {
          cdLabelTapRef.current = null;
          openEditor(label);
          return;
        }
        cdLabelTapRef.current = { key: label.key, at: now };
        selectOnly(label.key);
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      (event.currentTarget as HTMLElement).focus({ preventScroll: true });
      setIssuesOpen(false);
      if (editing && editing.key !== label.key) closeEditor();
      if (event.shiftKey) {
        toggleSelection(label.key);
        return;
      }
      const current = selectedKeysRef.current;
      if (current.length > 1 && current.includes(label.key)) {
        beginGroupMove(event, label.key);
        return;
      }
      selectOnly(label.key);
      guideTargetsRef.current = collectAlignmentTargets(
        docRef.current,
        new Set([...selectedKeysRef.current, label.key]),
      );
      setAlignmentGuides(EMPTY_GUIDES);
      event.currentTarget.setPointerCapture(event.pointerId);
      labelDragRef.current = {
        source: sourceRef.current,
        label,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startShiftX: label.sourceShift.x,
        startShiftY: label.sourceShift.y,
        moved: false,
      };
    },
    [beginGroupMove, closeEditor, editing, openEditor, selectOnly, toggleSelection],
  );

  const moveLabelDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = labelDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId || multiTouchRef.current) return;
      const deltaX = event.clientX - drag.startClientX;
      const deltaY = event.clientY - drag.startClientY;
      if (!drag.moved && Math.hypot(deltaX, deltaY) < 2) return;
      drag.moved = true;
      const cmPerPixel = 1 / (transform.zoom * PX_PER_CM);
      let shiftX = drag.startShiftX + deltaX * cmPerPixel;
      let shiftY = drag.startShiftY - deltaY * cmPerPixel;
      if (event.shiftKey) {
        if (Math.abs(deltaX) >= Math.abs(deltaY)) shiftY = drag.startShiftY;
        else shiftX = drag.startShiftX;
      }
      const allowX = !event.shiftKey || shiftX !== drag.startShiftX;
      const allowY = !event.shiftKey || shiftY !== drag.startShiftY;
      const guide = findAlignmentSnap(
        shiftedBounds(
          drag.label.bounds,
          shiftX - drag.startShiftX,
          shiftY - drag.startShiftY,
        ),
        guideTargetsRef.current,
        alignmentThreshold(transformRef.current.zoom, event.pointerType === "touch"),
      );
      const magnet = magnetRef.current && !event.altKey;
      if (magnet && allowX && guide.snappedX) shiftX += guide.dx;
      if (magnet && allowY && guide.snappedY) shiftY += guide.dy;
      setAlignmentGuides(
        event.altKey
          ? EMPTY_GUIDES
          : {
              vertical: allowX ? guide.guides.vertical : [],
              horizontal: allowY ? guide.guides.horizontal : [],
            },
      );
      const step = event.altKey ? 0 : 0.1;
      const nextShiftX =
        magnet && allowX && guide.snappedX ? shiftX : snap(shiftX, step);
      const nextShiftY =
        magnet && allowY && guide.snappedY ? shiftY : snap(shiftY, step);
      onSourceChange(
        patchLabelOffset(drag.source, drag.label, nextShiftX, nextShiftY),
      );
    },
    [onSourceChange, transform.zoom],
  );

  const endLabelDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = labelDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    labelDragRef.current = null;
    setAlignmentGuides(EMPTY_GUIDES);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
  }, []);

  const startResize = useCallback(
    (
      event: ReactPointerEvent<HTMLSpanElement>,
      node: TikzNode,
      corner: Corner,
    ) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setIssuesOpen(false);
      resizeRef.current = {
        source: sourceRef.current,
        node,
        pointerId: event.pointerId,
        corner,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startWidth: node.width,
        startHeight: node.height,
        startX: node.x,
        startY: node.y,
        moved: false,
      };
    },
    [],
  );

  const moveResize = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      const resize = resizeRef.current;
      if (!resize || event.pointerId !== resize.pointerId || multiTouchRef.current) return;
      const deltaX = event.clientX - resize.startClientX;
      const deltaY = event.clientY - resize.startClientY;
      if (!resize.moved && Math.hypot(deltaX, deltaY) < 1) return;
      resize.moved = true;
      const cmPerPixel = 1 / (transform.zoom * PX_PER_CM);
      const dx = deltaX * cmPerPixel;
      const dyScreen = deltaY * cmPerPixel;
      const east = resize.corner === "ne" || resize.corner === "se";
      const south = resize.corner === "se" || resize.corner === "sw";
      const rawWidth = resize.startWidth + (east ? dx : -dx);
      const rawHeight = resize.startHeight + (south ? dyScreen : -dyScreen);
      let width = Math.max(0.35, snap(rawWidth, 0.05));
      let height = Math.max(0.35, snap(rawHeight, 0.05));
      if (resize.node.style.shape === "circle") {
        const diameter = Math.max(0.35, snap((width + height) / 2, 0.05));
        width = diameter;
        height = diameter;
      }
      const x = snap(
        resize.startX + (east ? 1 : -1) * ((width - resize.startWidth) / 2),
        0.05,
      );
      const y = snap(
        resize.startY - (south ? 1 : -1) * ((height - resize.startHeight) / 2),
        0.05,
      );
      onSourceChange(
        patchNodeGeometry(resize.source, resize.node, {
          x,
          y,
          width,
          height,
        }),
      );
    },
    [onSourceChange, transform.zoom],
  );

  const endResize = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    const resize = resizeRef.current;
    if (!resize || event.pointerId !== resize.pointerId) return;
    resizeRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
  }, []);

  const startFrameResize = useCallback(
    (
      event: ReactPointerEvent<HTMLSpanElement>,
      frame: TikzFrame,
      corner: Corner,
    ) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      viewportRef.current?.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      setIssuesOpen(false);
      selectOnly(frame.key);
      frameResizeRef.current = {
        source: sourceRef.current,
        frame,
        pointerId: event.pointerId,
        corner,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startMinX: frame.minX,
        startMinY: frame.minY,
        startMaxX: frame.maxX,
        startMaxY: frame.maxY,
        moved: false,
      };
    },
    [selectOnly],
  );

  const moveFrameResize = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      const resize = frameResizeRef.current;
      if (!resize || event.pointerId !== resize.pointerId || multiTouchRef.current) return;
      const deltaX = event.clientX - resize.startClientX;
      const deltaY = event.clientY - resize.startClientY;
      if (!resize.moved && Math.hypot(deltaX, deltaY) < 1) return;
      resize.moved = true;
      const cmPerPixel = 1 / (transform.zoom * PX_PER_CM);
      const dx = deltaX * cmPerPixel;
      const dy = -deltaY * cmPerPixel;
      const step = event.altKey ? 0 : 0.1;
      const minSize = 0.6;
      let minX = resize.startMinX;
      let minY = resize.startMinY;
      let maxX = resize.startMaxX;
      let maxY = resize.startMaxY;
      if (resize.corner === "ne" || resize.corner === "se") {
        maxX = Math.max(snap(resize.startMaxX + dx, step), minX + minSize);
      } else {
        minX = Math.min(snap(resize.startMinX + dx, step), maxX - minSize);
      }
      if (resize.corner === "nw" || resize.corner === "ne") {
        maxY = Math.max(snap(resize.startMaxY + dy, step), minY + minSize);
      } else {
        minY = Math.min(snap(resize.startMinY + dy, step), maxY - minSize);
      }
      onSourceChange(
        patchFrameGeometry(resize.source, resize.frame, { minX, minY, maxX, maxY }),
      );
    },
    [onSourceChange, transform.zoom],
  );

  const endFrameResize = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    const resize = frameResizeRef.current;
    if (!resize || event.pointerId !== resize.pointerId) return;
    frameResizeRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
  }, []);

  const beginFrameDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, frame: TikzFrame) => {
      if (event.button !== 0 || multiTouchRef.current) return;
      const current = selectedKeysRef.current;
      if (event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        viewportRef.current?.focus({ preventScroll: true });
        toggleSelection(frame.key);
        return;
      }
      if (current.length > 1 && current.includes(frame.key)) {
        beginGroupMove(event, frame.key);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      viewportRef.current?.focus({ preventScroll: true });
      setIssuesOpen(false);
      if (editingRef.current) closeEditor();
      selectOnly(frame.key);
      guideTargetsRef.current = collectAlignmentTargets(
        docRef.current,
        new Set([frame.key]),
      );
      setAlignmentGuides(EMPTY_GUIDES);
      const source = sourceRef.current;
      const pointerId = event.pointerId;
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      const width = frame.maxX - frame.minX;
      const height = frame.maxY - frame.minY;
      let moved = false;

      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId || multiTouchRef.current) return;
        const deltaX = moveEvent.clientX - startClientX;
        const deltaY = moveEvent.clientY - startClientY;
        if (!moved && Math.hypot(deltaX, deltaY) < 2) return;
        moved = true;
        const cmPerPixel = 1 / (transformRef.current.zoom * PX_PER_CM);
        let dx = deltaX * cmPerPixel;
        let dy = -deltaY * cmPerPixel;
        if (moveEvent.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const allowX = !moveEvent.shiftKey || dx !== 0;
        const allowY = !moveEvent.shiftKey || dy !== 0;
        const guide = findAlignmentSnap(
          shiftedBounds(
            {
              minX: frame.minX,
              minY: frame.minY,
              maxX: frame.maxX,
              maxY: frame.maxY,
            },
            dx,
            dy,
          ),
          guideTargetsRef.current,
          alignmentThreshold(
            transformRef.current.zoom,
            moveEvent.pointerType === "touch",
          ),
        );
        const magnet = magnetRef.current && !moveEvent.altKey;
        if (magnet && allowX && guide.snappedX) dx += guide.dx;
        if (magnet && allowY && guide.snappedY) dy += guide.dy;
        setAlignmentGuides(
          moveEvent.altKey
            ? EMPTY_GUIDES
            : {
                vertical: allowX ? guide.guides.vertical : [],
                horizontal: allowY ? guide.guides.horizontal : [],
              },
        );
        const step = moveEvent.altKey ? 0 : 0.1;
        const minX =
          magnet && allowX && guide.snappedX
            ? frame.minX + dx
            : snap(frame.minX + dx, step);
        const minY =
          magnet && allowY && guide.snappedY
            ? frame.minY + dy
            : snap(frame.minY + dy, step);
        onSourceChange(
          patchFrameGeometry(source, frame, {
            minX,
            minY,
            maxX: minX + width,
            maxY: minY + height,
          }),
        );
      };

      const finish = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        setAlignmentGuides(EMPTY_GUIDES);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [beginGroupMove, closeEditor, selectOnly, toggleSelection],
  );

  const beginPathDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>, path: TikzPath) => {
      if (event.button !== 0 || multiTouchRef.current) return;
      if (path.origin === "tikzcd") {
        event.preventDefault();
        event.stopPropagation();
        viewportRef.current?.focus({ preventScroll: true });
        setIssuesOpen(false);
        if (editingRef.current) closeEditor();
        if (event.shiftKey) toggleSelection(path.key);
        else selectOnly(path.key);
        return;
      }
      const current = selectedKeysRef.current;
      if (current.length > 1 && current.includes(path.key)) {
        beginGroupMove(event, path.key);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      viewportRef.current?.focus({ preventScroll: true });
      setIssuesOpen(false);
      if (editingRef.current) closeEditor();
      selectOnly(path.key);
      const bounds = pathBounds(path);
      if (!bounds) return;
      const freeEndpoints = pathEndpointHandles(path).filter(
        (handle) => !handle.attached,
      );
      const objects: SelectionEditObjects = {
        nodes: [],
        labels: [],
        frames: [],
        paths: [path],
      };
      guideTargetsRef.current = collectAlignmentTargets(
        docRef.current,
        new Set([path.key]),
      );
      setAlignmentGuides(EMPTY_GUIDES);
      setPathAttachHints([]);
      const source = sourceRef.current;
      const pointerId = event.pointerId;
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      let moved = false;
      let lastSource = source;
      let activeAttach: PathAttachCandidate | null = null;
      let activeEndpoint: PathEndpointHandle | null = null;

      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId || multiTouchRef.current) return;
        const deltaX = moveEvent.clientX - startClientX;
        const deltaY = moveEvent.clientY - startClientY;
        if (!moved && Math.hypot(deltaX, deltaY) < 2) return;
        moved = true;
        const zoom = transformRef.current.zoom;
        const cmPerPixel = 1 / (zoom * PX_PER_CM);
        let dx = deltaX * cmPerPixel;
        let dy = -deltaY * cmPerPixel;
        if (moveEvent.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const allowX = !moveEvent.shiftKey || dx !== 0;
        const allowY = !moveEvent.shiftKey || dy !== 0;
        const magnet = magnetRef.current && !moveEvent.altKey;
        const snappedPoints = freeEndpoints.map((handle) => ({
          x: handle.point.x + dx,
          y: handle.point.y + dy,
        }));
        const revealRadius =
          ATTACH_REVEAL_PX / Math.max(0.05, zoom * PX_PER_CM);
        const snapRadius =
          (moveEvent.pointerType === "touch"
            ? COARSE_ATTACH_SNAP_PX
            : ATTACH_SNAP_PX) /
          Math.max(0.05, zoom * PX_PER_CM);
        const candidates = nearbyPathAnchors(
          docRef.current,
          snappedPoints,
          revealRadius,
        );

        activeAttach = null;
        activeEndpoint = null;
        if (magnet) {
          let bestDistance = snapRadius;
          for (const handle of freeEndpoints) {
            const point = {
              x: handle.point.x + dx,
              y: handle.point.y + dy,
            };
            for (const candidate of candidates) {
              const anchorDx = candidate.point.x - point.x;
              const anchorDy = candidate.point.y - point.y;
              if (!allowX && Math.abs(anchorDx) > 0.002) continue;
              if (!allowY && Math.abs(anchorDy) > 0.002) continue;
              const distance = Math.hypot(anchorDx, anchorDy);
              if (distance <= bestDistance) {
                bestDistance = distance;
                activeAttach = candidate;
                activeEndpoint = handle;
              }
            }
          }
        }

        let snappedX = false;
        let snappedY = false;
        if (activeAttach && activeEndpoint) {
          dx = activeAttach.point.x - activeEndpoint.point.x;
          dy = activeAttach.point.y - activeEndpoint.point.y;
          setAlignmentGuides({
            vertical: [activeAttach.point.x],
            horizontal: [activeAttach.point.y],
          });
        } else {
          const guide = findFeatureAlignmentSnap(
            shiftedBounds(bounds, dx, dy),
            snappedPoints,
            guideTargetsRef.current,
            alignmentThreshold(
              zoom,
              moveEvent.pointerType === "touch",
            ),
          );
          snappedX = magnet && allowX && guide.snappedX;
          snappedY = magnet && allowY && guide.snappedY;
          if (snappedX) dx += guide.dx;
          if (snappedY) dy += guide.dy;
          setAlignmentGuides(
            moveEvent.altKey
              ? EMPTY_GUIDES
              : {
                  vertical: allowX ? guide.guides.vertical : [],
                  horizontal: allowY ? guide.guides.horizontal : [],
                },
          );
        }
        setPathAttachHints(buildPathAttachHints(candidates, activeAttach));

        const step = moveEvent.altKey ? 0 : 0.1;
        const finalDx = activeAttach || snappedX ? dx : snap(dx, step);
        const finalDy = activeAttach || snappedY ? dy : snap(dy, step);
        lastSource = patchSelectionTranslation(source, objects, finalDx, finalDy);
        onSourceChange(lastSource);
      };

      const finish = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        setAlignmentGuides(EMPTY_GUIDES);
        setPathAttachHints([]);
        if (upEvent.type === "pointercancel" || !activeAttach || !activeEndpoint) {
          return;
        }
        const currentPath = parseTikz(lastSource).paths.find(
          (item) => item.key === path.key,
        );
        if (!currentPath) return;
        onSourceChange(
          attachPathEndpoint(
            lastSource,
            currentPath,
            activeEndpoint.subpathIndex,
            activeEndpoint.edge,
            activeAttach.node.name,
            activeAttach.anchor,
          ),
        );
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [beginGroupMove, closeEditor, onSourceChange, selectOnly, toggleSelection],
  );

  const startPathEndpointDrag = useCallback(
    (
      event: ReactPointerEvent<HTMLSpanElement>,
      path: TikzPath,
      handle: PathEndpointHandle,
    ) => {
      if (event.button !== 0 || multiTouchRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      viewportRef.current?.focus({ preventScroll: true });
      setIssuesOpen(false);
      if (editingRef.current) closeEditor();
      guideTargetsRef.current = collectAlignmentTargets(
        docRef.current,
        new Set([path.key]),
      );
      setAlignmentGuides(EMPTY_GUIDES);
      setPathAttachHints([]);
      const source = sourceRef.current;
      const pointerId = event.pointerId;
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      let moved = false;
      let lastSource = source;
      let activeAttach: PathAttachCandidate | null = null;

      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId || multiTouchRef.current) return;
        const deltaX = moveEvent.clientX - startClientX;
        const deltaY = moveEvent.clientY - startClientY;
        if (!moved && Math.hypot(deltaX, deltaY) < 1.5) return;
        moved = true;
        const zoom = transformRef.current.zoom;
        const cmPerPixel = 1 / (zoom * PX_PER_CM);
        let dx = deltaX * cmPerPixel;
        let dy = -deltaY * cmPerPixel;
        if (moveEvent.shiftKey) {
          if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        const allowX = !moveEvent.shiftKey || dx !== 0;
        const allowY = !moveEvent.shiftKey || dy !== 0;
        const magnet = magnetRef.current && !moveEvent.altKey;
        let point = { x: handle.point.x + dx, y: handle.point.y + dy };
        const revealRadius =
          ATTACH_REVEAL_PX / Math.max(0.05, zoom * PX_PER_CM);
        const snapRadius =
          (moveEvent.pointerType === "touch"
            ? COARSE_ATTACH_SNAP_PX
            : ATTACH_SNAP_PX) /
          Math.max(0.05, zoom * PX_PER_CM);
        const candidates = nearbyPathAnchors(
          docRef.current,
          [point],
          revealRadius,
        );
        const compatible = candidates.filter((candidate) => {
          const anchorDx = candidate.point.x - point.x;
          const anchorDy = candidate.point.y - point.y;
          return (
            (allowX || Math.abs(anchorDx) <= 0.002) &&
            (allowY || Math.abs(anchorDy) <= 0.002)
          );
        });
        activeAttach = magnet
          ? nearestPathAnchor(compatible, [point], snapRadius)
          : null;

        const step = moveEvent.altKey ? 0 : 0.05;
        let guideSnappedX = false;
        let guideSnappedY = false;
        if (activeAttach) {
          point = { ...activeAttach.point };
          setAlignmentGuides({
            vertical: [point.x],
            horizontal: [point.y],
          });
        } else {
          const guide = findFeatureAlignmentSnap(
            { minX: point.x, minY: point.y, maxX: point.x, maxY: point.y },
            [],
            guideTargetsRef.current,
            alignmentThreshold(zoom, moveEvent.pointerType === "touch"),
          );
          guideSnappedX = magnet && allowX && guide.snappedX;
          guideSnappedY = magnet && allowY && guide.snappedY;
          if (guideSnappedX) point.x += guide.dx;
          if (guideSnappedY) point.y += guide.dy;
          setAlignmentGuides(
            moveEvent.altKey
              ? EMPTY_GUIDES
              : {
                  vertical: allowX ? guide.guides.vertical : [],
                  horizontal: allowY ? guide.guides.horizontal : [],
                },
          );
          if (!guideSnappedX) point.x = snap(point.x, step);
          if (!guideSnappedY) point.y = snap(point.y, step);
        }
        setPathAttachHints(buildPathAttachHints(candidates, activeAttach));
        lastSource = patchPathEndpoint(
          source,
          path,
          handle.subpathIndex,
          handle.edge,
          point,
        );
        onSourceChange(lastSource);
      };

      const finish = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        setAlignmentGuides(EMPTY_GUIDES);
        setPathAttachHints([]);
        if (upEvent.type === "pointercancel" || !activeAttach) return;
        const currentPath = parseTikz(lastSource).paths.find(
          (item) => item.key === path.key,
        );
        if (!currentPath) return;
        onSourceChange(
          attachPathEndpoint(
            lastSource,
            currentPath,
            handle.subpathIndex,
            handle.edge,
            activeAttach.node.name,
            activeAttach.anchor,
          ),
        );
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [closeEditor, onSourceChange],
  );

  const startCurveDrag = useCallback(
    (
      event: ReactPointerEvent<HTMLSpanElement>,
      path: TikzPath,
      handle: PathCurveHandle,
    ) => {
      if (event.button !== 0 || multiTouchRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      viewportRef.current?.focus({ preventScroll: true });
      setIssuesOpen(false);
      if (editingRef.current) closeEditor();
      selectOnly(path.key);
      setAlignmentGuides(EMPTY_GUIDES);
      const source = sourceRef.current;
      const pointerId = event.pointerId;
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      let moved = false;

      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId || multiTouchRef.current) return;
        const deltaX = moveEvent.clientX - startClientX;
        const deltaY = moveEvent.clientY - startClientY;
        if (!moved && Math.hypot(deltaX, deltaY) < 1.5) return;
        moved = true;
        const zoom = transformRef.current.zoom;
        const cmPerPixel = 1 / (zoom * PX_PER_CM);
        const dx = deltaX * cmPerPixel;
        const dy = -deltaY * cmPerPixel;
        const target = { x: handle.point.x + dx, y: handle.point.y + dy };
        const offset =
          (target.x - handle.chordMid.x) * handle.normal.x +
          (target.y - handle.chordMid.y) * handle.normal.y;
        const straightThreshold =
          (moveEvent.pointerType === "touch" ? 13 : 7) /
          Math.max(0.05, zoom * PX_PER_CM);
        const magnet = magnetRef.current && !moveEvent.altKey;
        if (magnet && Math.abs(offset) <= straightThreshold) {
          onSourceChange(
            patchPathSegmentCurve(
              source,
              path,
              handle.subpathIndex,
              handle.segmentIndex,
              null,
            ),
          );
          setAlignmentGuides(EMPTY_GUIDES);
          return;
        }
        const scale = 4 / 3;
        onSourceChange(
          patchPathSegmentCurve(source, path, handle.subpathIndex, handle.segmentIndex, {
            c1: {
              x: handle.controls.c1.x + dx * scale,
              y: handle.controls.c1.y + dy * scale,
            },
            c2: {
              x: handle.controls.c2.x + dx * scale,
              y: handle.controls.c2.y + dy * scale,
            },
          }),
        );
      };

      const finish = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        setAlignmentGuides(EMPTY_GUIDES);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [closeEditor, onSourceChange, selectOnly],
  );

  const straightenCurve = useCallback(
    (path: TikzPath, handle: PathCurveHandle) => {
      onSourceChange(
        patchPathSegmentCurve(
          sourceRef.current,
          path,
          handle.subpathIndex,
          handle.segmentIndex,
          null,
        ),
      );
    },
    [onSourceChange],
  );

  const startPolylineDrag = useCallback(
    (
      event: ReactPointerEvent<HTMLSpanElement>,
      path: TikzPath,
      handle: PathCurveHandle,
    ) => {
      if (event.button !== 0 || multiTouchRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      viewportRef.current?.focus({ preventScroll: true });
      setIssuesOpen(false);
      if (editingRef.current) closeEditor();
      selectOnly(path.key);
      setAlignmentGuides(EMPTY_GUIDES);
      const source = sourceRef.current;
      const pointerId = event.pointerId;
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      let moved = false;

      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId || multiTouchRef.current) return;
        const deltaX = moveEvent.clientX - startClientX;
        const deltaY = moveEvent.clientY - startClientY;
        if (!moved && Math.hypot(deltaX, deltaY) < 1.5) return;
        moved = true;
        const zoom = transformRef.current.zoom;
        const cmPerPixel = 1 / (zoom * PX_PER_CM);
        const dx = deltaX * cmPerPixel;
        const dy = -deltaY * cmPerPixel;
        let point = { x: handle.chordMid.x + dx, y: handle.chordMid.y + dy };
        const offset =
          (point.x - handle.chordMid.x) * handle.normal.x +
          (point.y - handle.chordMid.y) * handle.normal.y;
        const straightThreshold =
          (moveEvent.pointerType === "touch" ? 13 : 7) /
          Math.max(0.05, zoom * PX_PER_CM);
        if (Math.abs(offset) <= straightThreshold) return;
        const step = moveEvent.altKey ? 0 : 0.05;
        point = { x: snap(point.x, step), y: snap(point.y, step) };
        const magnet = magnetRef.current && !moveEvent.altKey;
        if (magnet) {
          const orthoRadius =
            (moveEvent.pointerType === "touch" ? COARSE_ORTHO_SNAP_PX : ORTHO_SNAP_PX) /
            Math.max(0.05, zoom * PX_PER_CM);
          const ortho = orthogonalJoint(handle, point, orthoRadius);
          if (ortho) {
            point = ortho;
          } else {
            const angle = jointAngleDegrees(handle, point);
            const threshold =
              moveEvent.pointerType === "touch"
                ? COARSE_RIGHT_ANGLE_SNAP_DEG
                : RIGHT_ANGLE_SNAP_DEG;
            if (Math.abs(angle - 90) <= threshold) {
              point = rightAngleJoint(handle, point);
            }
          }
        }
        onSourceChange(
          patchPathSegmentPolyline(
            source,
            path,
            handle.subpathIndex,
            handle.segmentIndex,
            point,
          ),
        );
      };

      const finish = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        setAlignmentGuides(EMPTY_GUIDES);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [closeEditor, onSourceChange, selectOnly],
  );

  const startVertexDrag = useCallback(
    (
      event: ReactPointerEvent<HTMLSpanElement>,
      path: TikzPath,
      vertex: PathVertexHandle,
    ) => {
      if (event.button !== 0 || multiTouchRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      viewportRef.current?.focus({ preventScroll: true });
      setIssuesOpen(false);
      if (editingRef.current) closeEditor();
      selectOnly(path.key);
      setAlignmentGuides(EMPTY_GUIDES);
      const source = sourceRef.current;
      const pointerId = event.pointerId;
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      let moved = false;

      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId || multiTouchRef.current) return;
        const deltaX = moveEvent.clientX - startClientX;
        const deltaY = moveEvent.clientY - startClientY;
        if (!moved && Math.hypot(deltaX, deltaY) < 1.5) return;
        moved = true;
        const zoom = transformRef.current.zoom;
        const cmPerPixel = 1 / (zoom * PX_PER_CM);
        const dx = deltaX * cmPerPixel;
        const dy = -deltaY * cmPerPixel;
        let point = { x: vertex.point.x + dx, y: vertex.point.y + dy };
        const step = moveEvent.altKey ? 0 : 0.05;
        point = { x: snap(point.x, step), y: snap(point.y, step) };
        const magnet = magnetRef.current && !moveEvent.altKey;
        if (magnet) {
          const orthoRadius =
            (moveEvent.pointerType === "touch" ? COARSE_ORTHO_SNAP_PX : ORTHO_SNAP_PX) /
            Math.max(0.05, zoom * PX_PER_CM);
          const ortho = orthogonalJoint(vertex, point, orthoRadius);
          if (ortho) {
            point = ortho;
          } else {
            const angle = jointAngleDegrees(vertex, point);
            const threshold =
              moveEvent.pointerType === "touch"
                ? COARSE_RIGHT_ANGLE_SNAP_DEG
                : RIGHT_ANGLE_SNAP_DEG;
            if (Math.abs(angle - 90) <= threshold) {
              point = rightAngleJoint(vertex, point);
            }
          }
        }
        onSourceChange(
          patchPathVertex(
            source,
            path,
            vertex.subpathIndex,
            vertex.segmentIndex,
            point,
          ),
        );
      };

      const finish = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", finish);
        window.removeEventListener("pointercancel", finish);
        setAlignmentGuides(EMPTY_GUIDES);
      };

      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", finish);
      window.addEventListener("pointercancel", finish);
    },
    [closeEditor, onSourceChange, selectOnly],
  );

  const straightenVertex = useCallback(
    (path: TikzPath, vertex: PathVertexHandle) => {
      onSourceChange(
        straightenPathVertex(
          sourceRef.current,
          path,
          vertex.subpathIndex,
          vertex.segmentIndex,
        ),
      );
    },
    [onSourceChange],
  );

  const detachSelectedPath = useCallback(() => {
    if (!selectedPath) return;
    onSourceChange(detachPathEndpoints(sourceRef.current, selectedPath));
  }, [onSourceChange, selectedPath]);

  const handleBackgroundPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
      if (multiTouchRef.current) return;
      const target = event.target as HTMLElement;
      if (target.closest("[data-canvas-ui]")) return;
      const viewport = viewportRef.current;
      if (!viewport) return;
      const focusCanvas = () => viewport.focus({ preventScroll: true });

      const wantsPan =
        event.button === 1 ||
        event.button === 2 ||
        (event.button === 0 &&
          (panToolRef.current ||
            spacePanRef.current ||
            previewRef.current != null ||
            engineRef.current.active));
      if (wantsPan) {
        event.preventDefault();
        focusCanvas();
        setIssuesOpen(false);
        setAlignmentGuides(EMPTY_GUIDES);
        if (editing) closeEditor();
        autoFitRef.current = false;
        setPanning(true);
        viewport.setPointerCapture(event.pointerId);
        const pointerId = event.pointerId;
        const startClientX = event.clientX;
        const startClientY = event.clientY;
        const startX = transformRef.current.x;
        const startY = transformRef.current.y;
        const previewSpec = previewRef.current;
        const previewElement = previewSpec
          ? ((event.target as Element).closest?.(
              ".advanced-preview",
            ) as HTMLElement | null)
          : null;
        let moved = false;
        const handleMove = (moveEvent: PointerEvent) => {
          if (moveEvent.pointerId !== pointerId || multiTouchRef.current) return;
          if (
            !moved &&
            Math.hypot(
              moveEvent.clientX - startClientX,
              moveEvent.clientY - startClientY,
            ) < 4
          ) {
            return;
          }
          moved = true;
          setTransform((current) => ({
            ...current,
            x: startX + moveEvent.clientX - startClientX,
            y: startY + moveEvent.clientY - startClientY,
          }));
        };
        const finish = (upEvent: PointerEvent) => {
          if (upEvent.pointerId !== pointerId) return;
          setPanning(false);
          viewport.removeEventListener("pointermove", handleMove);
          viewport.removeEventListener("pointerup", finish);
          viewport.removeEventListener("pointercancel", finish);
          try {
            viewport.releasePointerCapture(pointerId);
          } catch {
            // Ignore a pointer that the browser already released.
          }
          if (
            upEvent.type === "pointerup" &&
            event.button === 0 &&
            previewElement &&
            !moved &&
            !multiTouchRef.current
          ) {
            if (previewElement && previewSpec && previewSpec.exampleId !== "engine") {
              onPreviewReveal(
                previewClickSpan(
                  previewElement,
                  upEvent.clientX,
                  upEvent.clientY,
                  sourceRef.current,
                  upEvent.pointerType,
                ),
              );
            }
          }
        };
        viewport.addEventListener("pointermove", handleMove);
        viewport.addEventListener("pointerup", finish);
        viewport.addEventListener("pointercancel", finish);
        return;
      }

      const tool = shapeToolRef.current;
      if (tool) {
        event.preventDefault();
        focusCanvas();
        autoFitRef.current = false;
        setIssuesOpen(false);
        if (editing) closeEditor();
        const rect = viewport.getBoundingClientRect();
        const pointerId = event.pointerId;
        const startClientX = event.clientX;
        const startClientY = event.clientY;
        const startTransform = transformRef.current;
        const modelPoint = (clientX: number, clientY: number) => ({
          x: (clientX - rect.left - startTransform.x) / (startTransform.zoom * PX_PER_CM),
          y: -(clientY - rect.top - startTransform.y) / (startTransform.zoom * PX_PER_CM),
        });
        const startPoint = modelPoint(startClientX, startClientY);
        const preset = DEFAULT_SHAPE_SIZE[tool];
        let moved = false;
        viewport.setPointerCapture(pointerId);
        setShapeDraft({
          kind: tool,
          left: snap(startPoint.x - preset.width / 2, 0.1),
          top: snap(startPoint.y - preset.height / 2, 0.1),
          width: preset.width,
          height: preset.height,
        });

        const draftBounds = (
          endClientX: number,
          endClientY: number,
          altKey: boolean,
        ): ShapeDraftState => {
          const step = altKey ? 0 : 0.1;
          const end = modelPoint(endClientX, endClientY);
          const x0 = snap(startPoint.x, step);
          const y0 = snap(startPoint.y, step);
          const x1 = snap(end.x, step);
          const y1 = snap(end.y, step);
          let left = Math.min(x0, x1);
          let top = Math.min(y0, y1);
          let width = Math.abs(x1 - x0);
          let height = Math.abs(y1 - y0);
          if (tool === "circle") {
            const size = Math.max(width, height);
            if (x1 < x0) left = x0 - size;
            if (y1 < y0) top = y0 - size;
            width = size;
            height = size;
          }
          return { kind: tool, left, top, width, height };
        };

        const handleMove = (moveEvent: PointerEvent) => {
          if (moveEvent.pointerId !== pointerId || multiTouchRef.current) return;
          if (
            !moved &&
            Math.hypot(
              moveEvent.clientX - startClientX,
              moveEvent.clientY - startClientY,
            ) < 4
          ) {
            return;
          }
          moved = true;
          setShapeDraft(
            draftBounds(moveEvent.clientX, moveEvent.clientY, moveEvent.altKey),
          );
        };

        const finish = (upEvent: PointerEvent) => {
          if (upEvent.pointerId !== pointerId) return;
          viewport.removeEventListener("pointermove", handleMove);
          viewport.removeEventListener("pointerup", finish);
          viewport.removeEventListener("pointercancel", finish);
          try {
            viewport.releasePointerCapture(pointerId);
          } catch {
            // Ignore a pointer that the browser already released.
          }
          setShapeDraft(null);
          if (upEvent.type === "pointercancel" || multiTouchRef.current) return;
          const dragged =
            moved &&
            Math.hypot(
              upEvent.clientX - startClientX,
              upEvent.clientY - startClientY,
            ) >= 8;
          let bounds: ShapeDraftState;
          if (dragged) {
            const raw = draftBounds(
              upEvent.clientX,
              upEvent.clientY,
              upEvent.altKey,
            );
            const width = Math.max(0.4, raw.width);
            const height =
              tool === "circle" ? width : Math.max(0.4, raw.height);
            bounds = { ...raw, width, height };
          } else {
            const centerX = snap(startPoint.x, 0.1);
            const centerY = snap(startPoint.y, 0.1);
            bounds = {
              kind: tool,
              left: centerX - preset.width / 2,
              top: centerY - preset.height / 2,
              width: preset.width,
              height: preset.height,
            };
          }
          setShapeTool(null);
          const result = insertShapeNode(sourceRef.current, docRef.current, {
            kind: tool,
            x: bounds.left + bounds.width / 2,
            y: bounds.top + bounds.height / 2,
            width: bounds.width,
            height: bounds.height,
            fill: "white",
            draw: "black!75",
          });
          onSourceChange(result.source);
          if (result.key) onSelect([result.key]);
        };

        viewport.addEventListener("pointermove", handleMove);
        viewport.addEventListener("pointerup", finish);
        viewport.addEventListener("pointercancel", finish);
        return;
      }

      if (target.closest(".tikz-node, .edge-label, .frame-overlay, .group-selection")) {
        return;
      }

      const hitRect = viewport.getBoundingClientRect();
      const hitTransform = transformRef.current;
      const hitPoint = (clientX: number, clientY: number): Point => ({
        x: (clientX - hitRect.left - hitTransform.x) / (hitTransform.zoom * PX_PER_CM),
        y: -(clientY - hitRect.top - hitTransform.y) / (hitTransform.zoom * PX_PER_CM),
      });
      const pointerModel = hitPoint(event.clientX, event.clientY);
      const edgeTolerance =
        (event.pointerType === "touch" ? 14 : 7) /
        Math.max(0.05, hitTransform.zoom * PX_PER_CM);
      const edgeHit = findEdgeAtPoint(docRef.current, pointerModel, edgeTolerance);
      if (edgeHit) {
        if (event.shiftKey) {
          event.preventDefault();
          focusCanvas();
          toggleSelection(edgeHit.key);
          return;
        }
        beginPathDrag(event, edgeHit);
        return;
      }

      event.preventDefault();
      focusCanvas();
      autoFitRef.current = false;
      setIssuesOpen(false);
      if (editing) closeEditor();
      const rect = viewport.getBoundingClientRect();
      const pointerId = event.pointerId;
      const startClientX = event.clientX;
      const startClientY = event.clientY;
      const startTransform = transform;
      const baseSelection = selectedKeysRef.current;
      let moved = false;
      let additive = event.shiftKey;
      viewport.setPointerCapture(pointerId);

      const modelPoint = (clientX: number, clientY: number) => ({
        x: (clientX - rect.left - startTransform.x) / (startTransform.zoom * PX_PER_CM),
        y: -(clientY - rect.top - startTransform.y) / (startTransform.zoom * PX_PER_CM),
      });

      const handleMove = (moveEvent: PointerEvent) => {
        if (moveEvent.pointerId !== pointerId || multiTouchRef.current) return;
        if (moveEvent.shiftKey) additive = true;
        if (!moved) {
          if (
            Math.hypot(
              moveEvent.clientX - startClientX,
              moveEvent.clientY - startClientY,
            ) < 3
          ) {
            return;
          }
          moved = true;
        }
        const left = Math.min(startClientX, moveEvent.clientX) - rect.left;
        const top = Math.min(startClientY, moveEvent.clientY) - rect.top;
        setMarquee({
          left,
          top,
          width: Math.abs(moveEvent.clientX - startClientX),
          height: Math.abs(moveEvent.clientY - startClientY),
        });
      };

      const finish = (upEvent: PointerEvent) => {
        if (upEvent.pointerId !== pointerId) return;
        viewport.removeEventListener("pointermove", handleMove);
        viewport.removeEventListener("pointerup", finish);
        viewport.removeEventListener("pointercancel", finish);
        try {
          viewport.releasePointerCapture(pointerId);
        } catch {
          // Ignore a pointer that the browser already released.
        }
        setMarquee(null);
        if (upEvent.type === "pointercancel" || multiTouchRef.current) return;

        if (moved) {
          const topLeft = modelPoint(
            Math.min(startClientX, upEvent.clientX),
            Math.min(startClientY, upEvent.clientY),
          );
          const bottomRight = modelPoint(
            Math.max(startClientX, upEvent.clientX),
            Math.max(startClientY, upEvent.clientY),
          );
          const range: Bounds = {
            minX: topLeft.x,
            maxX: bottomRight.x,
            minY: bottomRight.y,
            maxY: topLeft.y,
          };
          const filter = marqueeFilterRef.current;
          const hits: string[] = [];
          if (filter.shapes) {
            for (const node of docRef.current.nodes) {
              if (node.origin === "tikzcd") continue;
              if (boundsIntersect(node.bounds, range)) hits.push(node.key);
            }
          }
          if (filter.labels) {
            for (const label of docRef.current.labels) {
              if (label.origin === "tikzcd") continue;
              if (boundsIntersect(label.bounds, range)) hits.push(label.key);
            }
          }
          if (filter.edges) {
            for (const path of docRef.current.paths) {
              if (path.origin === "tikzcd") continue;
              if (isSelectableEdge(path) && pathIntersectsBounds(path, range)) {
                hits.push(path.key);
              }
            }
          }
          if (filter.frames) {
            for (const frame of docRef.current.frames) {
              if (
                boundsIntersect(
                  {
                    minX: frame.minX,
                    minY: frame.minY,
                    maxX: frame.maxX,
                    maxY: frame.maxY,
                  },
                  range,
                )
              ) {
                hits.push(frame.key);
              }
            }
          }
          onSelect(
            Array.from(
              new Set(additive ? [...baseSelection, ...hits] : hits),
            ),
          );
          return;
        }

        const point = modelPoint(upEvent.clientX, upEvent.clientY);
        const hit = findFrameAtPoint(docRef.current, point);
        if (additive || upEvent.shiftKey) {
          if (hit) toggleSelection(hit.key);
        } else {
          onSelect(hit ? [hit.key] : []);
        }
      };

      viewport.addEventListener("pointermove", handleMove);
      viewport.addEventListener("pointerup", finish);
      viewport.addEventListener("pointercancel", finish);
    },
    [
      beginFrameDrag,
      beginPathDrag,
      closeEditor,
      editing,
      onPreviewReveal,
      onSelect,
      onSourceChange,
      toggleSelection,
      transform,
    ],
  );

  const nudgeSelection = useCallback(
    (dx: number, dy: number) => {
      const objects = collectSelection(docRef.current, selectedKeysRef.current);
      if (selectionSize(objects) === 0) return;
      if (selectionHasTikzCd(objects)) return;
      onSourceChange(
        patchSelectionTranslation(sourceRef.current, objects, dx, dy),
      );
    },
    [onSourceChange],
  );

  const deleteSelection = useCallback(() => {
    const objects = collectSelection(docRef.current, selectedKeysRef.current);
    if (selectionSize(objects) === 0) return;
    const removable =
      objects.nodes.some((node) => node.origin !== "tikzcd") ||
      objects.labels.some((label) => label.origin !== "tikzcd") ||
      objects.frames.length > 0 ||
      objects.paths.some((path) => path.origin === "tikzcd");
    if (!removable) return;
    closeEditor();
    onSelect([]);
    onSourceChange(
      deleteSelectionObjects(sourceRef.current, docRef.current, objects),
    );
  }, [closeEditor, onSelect, onSourceChange]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (editingRef.current || previewRef.current || engineRef.current.active) return;
      if (!selectedKeysRef.current.length) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable='true'], .cm-editor")
      ) {
        return;
      }
      if (target?.isContentEditable) return;
      event.preventDefault();
      event.stopPropagation();
      deleteSelection();
    };
    document.addEventListener("keydown", handleKey, true);
    return () => document.removeEventListener("keydown", handleKey, true);
  }, [deleteSelection]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      if (event.key.toLowerCase() !== "a") return;
      if (editingRef.current) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          "input, textarea, select, [contenteditable='true'], .cm-editor, [role='dialog'], .source-pane",
        ) ||
        target?.isContentEditable
      ) {
        return;
      }
      const pane = viewportRef.current?.closest(".canvas-pane");
      if (!pane || (pane as HTMLElement).offsetParent === null) return;
      if (previewRef.current || engineRef.current.active) return;
      const current = docRef.current;
      const keys = [
        ...current.nodes.filter((node) => node.origin !== "tikzcd").map((node) => node.key),
        ...current.labels.filter((label) => label.origin !== "tikzcd").map((label) => label.key),
        ...current.paths
          .filter((path) => path.origin !== "tikzcd" && isSelectableEdge(path))
          .map((path) => path.key),
        ...current.frames.map((frame) => frame.key),
      ];
      if (keys.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      onSelect(keys);
    };
    document.addEventListener("keydown", handleKey, true);
    return () => document.removeEventListener("keydown", handleKey, true);
  }, [onSelect]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (editingRef.current || previewRef.current || engineRef.current.active) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!event.key.startsWith("Arrow")) return;
      if (!selectedKeysRef.current.length) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest("input, textarea, select, [contenteditable='true'], .cm-editor")
      ) {
        return;
      }
      if (target?.isContentEditable) return;
      const step = event.shiftKey ? 0.1 : 0.01;
      let dx = 0;
      let dy = 0;
      if (event.key === "ArrowLeft") dx = -step;
      else if (event.key === "ArrowRight") dx = step;
      else if (event.key === "ArrowUp") dy = step;
      else if (event.key === "ArrowDown") dy = -step;
      else return;
      event.preventDefault();
      event.stopPropagation();
      nudgeSelection(dx, dy);
    };
    document.addEventListener("keydown", handleKey, true);
    return () => document.removeEventListener("keydown", handleKey, true);
  }, [nudgeSelection]);

  const zoomAroundCenter = useCallback((factor: number) => {
    autoFitRef.current = false;
    const { width, height } = sizeRef.current;
    setTransform((current) => {
      const zoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      const ratio = zoom / current.zoom;
      return {
        zoom,
        x: width / 2 - (width / 2 - current.x) * ratio,
        y: height / 2 - (height / 2 - current.y) * ratio,
      };
    });
  }, []);

  const resetZoom = useCallback(() => {
    autoFitRef.current = false;
    const { width, height } = sizeRef.current;
    setTransform((current) => {
      const ratio = 1 / current.zoom;
      return {
        zoom: 1,
        x: width / 2 - (width / 2 - current.x) * ratio,
        y: height / 2 - (height / 2 - current.y) * ratio,
      };
    });
  }, []);

  const gridSize = 24 * transform.zoom;
  const showMinorDots = gridSize >= 11;
  const gridStyle: CSSProperties = {
    backgroundImage: showMinorDots
      ? "radial-gradient(circle, rgba(93, 83, 63, 0.17) 1px, transparent 1.1px), radial-gradient(circle, rgba(93, 83, 63, 0.3) 1.3px, transparent 1.4px)"
      : "radial-gradient(circle, rgba(93, 83, 63, 0.28) 1.3px, transparent 1.4px)",
    backgroundSize: showMinorDots
      ? `${gridSize}px ${gridSize}px, ${gridSize * 5}px ${gridSize * 5}px`
      : `${gridSize * 5}px ${gridSize * 5}px`,
    backgroundPosition: `${transform.x}px ${transform.y}px, ${transform.x}px ${transform.y}px`,
  };

  const empty = preview
    ? false
    : !doc.hasPicture || (doc.stats.nodes === 0 && doc.stats.paths === 0);
  const engineBusy = engine.active && !preview;
  const issueCount = doc.issues.length;

  const multiMeta = useMemo(() => {
    if (!groupBounds) return [];
    const counts: string[] = [];
    if (selectionObjects.nodes.length > 0) {
      counts.push(`${selectionObjects.nodes.length} 节点`);
    }
    if (selectionObjects.labels.length > 0) {
      counts.push(`${selectionObjects.labels.length} 标签`);
    }
    if (selectionObjects.frames.length > 0) {
      counts.push(`${selectionObjects.frames.length} 底板`);
    }
    if (selectionObjects.paths.length > 0) {
      counts.push(`${selectionObjects.paths.length} 连线`);
    }
    return [
      counts.join(" · "),
      `${formatNumber(groupBounds.maxX - groupBounds.minX)} × ${formatNumber(groupBounds.maxY - groupBounds.minY)} cm`,
    ];
  }, [groupBounds, selectionObjects]);

  let selectionInfo: SelectionInfo | null = null;
  if (selectedCount > 1 && groupBounds) {
    selectionInfo = {
      eyebrow: "多选",
      title: `已选择 ${selectedCount} 个组件`,
      meta: multiMeta,
      multi: true,
      locked: selectionLocked,
    };
  } else if (selectedNode) {
    if (selectedNode.origin === "tikzcd") {
      const cell = selectedNode.tikzcdCell;
      selectionInfo = {
        eyebrow: "tikz-cd 单元格",
        title: selectedNode.text || "空单元格",
        meta: [
          cell ? `第 ${cell.row + 1} 行 · 第 ${cell.col + 1} 列` : "表格单元格",
          "数学模式",
          selectedNode.textEditable ? "双击编辑公式" : "含箭头，文字由源码拆分",
        ],
        editable: selectedNode.textEditable ? selectedNode : undefined,
      };
    } else {
      selectionInfo = {
        eyebrow: "节点",
        title: selectedNode.name ? `(${selectedNode.name})` : "未命名节点",
        meta: [
          `x ${formatNumber(selectedNode.x)}`,
          `y ${formatNumber(selectedNode.y)}`,
          `${formatNumber(selectedNode.width)} × ${formatNumber(selectedNode.height)} cm`,
        ],
        editable: selectedNode,
      };
    }
  } else if (selectedLabel) {
    if (selectedLabel.origin === "tikzcd") {
      selectionInfo = {
        eyebrow: "箭头标签",
        title: selectedLabel.text || "空标签",
        meta: [
          `位于箭头 ${Math.round(selectedLabel.sourcePosition * 100)}%`,
          selectedLabel.description ? "描述标签 · 覆盖连线" : "侧向标签 · swap 换边",
        ],
        editable: selectedLabel,
      };
    } else {
      selectionInfo = {
        eyebrow: "标签",
        title: selectedLabel.above
          ? "上方标签"
          : selectedLabel.below
            ? "下方标签"
            : selectedLabel.left
              ? "左侧标签"
              : selectedLabel.right
                ? "右侧标签"
                : "连线标签",
        meta: [
          `${formatNumber(selectedLabel.position.x)}, ${formatNumber(selectedLabel.position.y)}`,
        ],
        editable: selectedLabel,
      };
    }
  } else if (selectedPath) {
    if (selectedPath.origin === "tikzcd") {
      const ends = tikzCdArrowEnds(selectedPath);
      selectionInfo = {
        eyebrow: "tikz-cd 箭头",
        title: `${selectedPath.tikzcd?.fromText || "·"} → ${selectedPath.tikzcd?.toText || "·"}`,
        meta: [
          tikzCdLineStyle(selectedPath) === "dotted"
            ? "点线"
            : tikzCdLineStyle(selectedPath) === "dashed"
              ? "虚线"
              : "实线",
          ends === "<->"
            ? "双向箭头"
            : ends === "<-"
              ? "反向箭头"
              : ends === "-"
                ? "无箭头"
                : "单向箭头",
          selectedPath.style.bend
            ? `${selectedPath.style.bend.direction === "left" ? "左" : "右"}弯 ${selectedPath.style.bend.angle}°`
            : "直线",
          selectedPath.style.crossing ? "crossing over" : "",
        ].filter(Boolean),
        path: selectedPath,
      };
    } else {
      selectionInfo = {
        eyebrow: "连线",
        title: `路径 #${selectedPath.index + 1}`,
        meta: [
          selectedPath.style.dotted
            ? "点线"
            : selectedPath.style.dashed
              ? "虚线"
              : "实线",
          `${selectedPath.subpaths.reduce((total, subpath) => total + subpath.segments.length, 0)} 段`,
          `${formatNumber(pathLength(selectedPath))} cm`,
          selectedPath.style.arrowStart || selectedPath.style.arrowEnd
            ? "带箭头"
            : "无箭头",
        ],
        path: selectedPath,
      };
    }
  } else if (selectedFrame) {
    selectionInfo = {
      eyebrow: selectedFrame.isBackground ? "背景板" : "矩形底板",
      title: selectedFrame.isBackground ? "背景底板" : "矩形框",
      meta: [
        `${formatNumber(selectedFrame.width)} × ${formatNumber(selectedFrame.height)} cm`,
        `x ${formatNumber(selectedFrame.minX)} → ${formatNumber(selectedFrame.maxX)}`,
        `y ${formatNumber(selectedFrame.minY)} → ${formatNumber(selectedFrame.maxY)}`,
      ],
      resizeHint: true,
    };
  }

  const selectionIsCdCell = selectedNode?.origin === "tikzcd";
  const selectionIsCdLabel = selectedLabel?.origin === "tikzcd";
  const selectionIsCdArrow = selectedPath?.origin === "tikzcd";
  const editingObject = editing
    ? editing.kind === "node"
      ? doc.nodes.find((node) => node.key === editing.key) ?? null
      : doc.labels.find((label) => label.key === editing.key) ?? null
    : null;
  const editorDefaultHint =
    editingObject?.origin === "tikzcd"
      ? editing?.kind === "node"
        ? "单元格处于数学模式，直接写公式；不能包含 &、\\\\ 或换行。"
        : '箭头标签处于数学模式；不能包含未转义的英文引号 " 或换行。'
      : "直接编辑 TikZ 文本，支持 $公式$、\\textbf{} 与 \\\\ 换行。";

  return (
    <section
      className={`canvas-pane${mobileActive ? " is-mobile-active" : ""}${preview || engine.active ? " is-exact-preview" : ""}`}
    >
      <header className="pane-head canvas-head">
        <div className="pane-title">
          <span className="pane-index accent">02</span>
          <span className="pane-name">画布</span>
          <span className="live-pill">
            <span className="live-dot" />
            实时
          </span>
        </div>
        <div className="pane-head-actions">
          {preview ? (
            preview.exampleId === "engine" ? (
              <span
                className="render-clean is-preview is-engine"
                title="由内置 TeX 引擎即时编译的完整矢量输出"
              >
                <Check size={13} />
                TikZ 引擎 · 完整渲染
              </span>
            ) : (
              <span className="render-clean is-preview" title="由 TeX 预编译的精确矢量预览">
                <Check size={13} />
                {preview.packageName} 精确预览
              </span>
            )
          ) : engine.active ? (
            engine.status === "error" ? (
              <span className="render-clean is-engine is-error" title="TeX 引擎未能编译这段源码">
                <TriangleAlert size={13} />
                引擎渲染失败
              </span>
            ) : (
              <span className="render-clean is-engine" title="正在用内置 TeX 引擎编译">
                <Loader2 size={13} className="export-spin" />
                引擎编译中
              </span>
            )
          ) : issueCount > 0 ? (
            <button
              type="button"
              className={`issue-toggle${issuesOpen ? " is-open" : ""}`}
              onClick={() => {
                setIssuesOpen((open) => !open);
                closeEditor();
              }}
            >
              <TriangleAlert size={13} />
              {issueCount} 条兼容提示
            </button>
          ) : (
            <span className="render-clean">
              <Check size={13} />
              已完整渲染
            </span>
          )}
          <div className="export-control" ref={exportControlRef}>
            <button
              type="button"
              className={`export-button${exportOpen ? " is-open" : ""}`}
              onClick={() => {
                setExportError(null);
                setExportOpen((open) => !open);
              }}
              disabled={empty || engineBusy || exporting != null}
              aria-haspopup="menu"
              aria-expanded={exportOpen}
              title={empty ? "画布为空，暂无可导出的图形" : "导出当前图形"}
            >
              {exporting ? (
                <Loader2 size={13} className="export-spin" />
              ) : (
                <Download size={13} />
              )}
              <span>{exporting ? "导出中" : "导出"}</span>
              <ChevronDown size={11} className="export-chevron" />
            </button>
            {exportOpen ? (
              <div className="export-menu" role="menu" aria-label="选择导出格式">
                {(
                  [
                    ["svg", "SVG", "矢量图形", "矢量线条，浏览器中清晰缩放"],
                    ["png", "PNG", "高清位图", "2 倍像素，白色背景"],
                    ["jpg", "JPG", "通用图片", "通用格式，白色背景"],
                  ] as const
                ).map(([format, tag, title, detail]) => (
                  <button
                    key={format}
                    type="button"
                    role="menuitem"
                    onClick={() => void exportDiagram(format)}
                    disabled={exporting != null}
                  >
                    <span className="export-format">{tag}</span>
                    <span className="export-copy">
                      <strong>{title}</strong>
                      <small>{detail}</small>
                    </span>
                  </button>
                ))}
                {exportError ? <p className="export-error">{exportError}</p> : null}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div
        ref={viewportRef}
        className={`diagram-viewport${panning ? " is-panning" : ""}${pinching ? " is-pinching" : ""}${shapeTool ? " is-shape-tool" : ""}${panTool || spacePan ? " is-pan-tool" : ""}${connectorDraft ? " is-connecting" : ""}`}
        tabIndex={-1}
        onPointerDown={handleBackgroundPointerDown}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="canvas-grid" style={gridStyle} aria-hidden="true" />
        <div className="canvas-grain" aria-hidden="true" />

        <div
          className="shape-toolbar"
          data-canvas-ui="true"
          role="toolbar"
          aria-label="图形与连线工具"
        >
          <div className="shape-toolbar-group">
            <button
              type="button"
              className={`shape-tool${shapeTool === null && !panTool ? " is-active" : ""}`}
              aria-pressed={shapeTool === null && !panTool}
              title="选择与移动"
              onClick={() => activateShapeTool(null)}
            >
              <MousePointer2 size={15} />
              <span>选择</span>
            </button>
            <button
              type="button"
              className={`shape-tool${panTool ? " is-active" : ""}`}
              aria-pressed={panTool}
              title="手形平移：左键拖动画布，或按住空格临时平移"
              aria-label="手形平移工具"
              onClick={togglePanTool}
            >
              <Hand size={15} />
              <span>平移</span>
            </button>
          </div>
          <span className="shape-toolbar-divider" aria-hidden="true" />
          <div className="shape-toolbar-group">
            {SHAPE_TOOLS.map((tool) => (
              <button
                key={tool.kind}
                type="button"
                className={`shape-tool${shapeTool === tool.kind ? " is-active" : ""}`}
                aria-pressed={shapeTool === tool.kind}
                title={tool.title}
                onClick={() =>
                  activateShapeTool(shapeTool === tool.kind ? null : tool.kind)
                }
              >
                <ShapeToolIcon kind={tool.kind} />
                <span>{tool.label}</span>
              </button>
            ))}
          </div>
          <span className="shape-toolbar-divider" aria-hidden="true" />
          <div className="shape-toolbar-group">
            <span className="shape-toolbar-label">连线</span>
            <button
              type="button"
              className={`shape-tool${connectorArrow ? " is-active" : ""}`}
              aria-pressed={connectorArrow}
              title="新连线末端带箭头"
              onClick={() => setConnectorArrow((value) => !value)}
            >
              <ArrowRight size={15} />
              <span>箭头</span>
            </button>
            <button
              type="button"
              className={`shape-tool${connectorDashed ? " is-active" : ""}`}
              aria-pressed={connectorDashed}
              title="新连线使用虚线"
              onClick={() => setConnectorDashed((value) => !value)}
            >
              <svg className="shape-tool-icon" viewBox="0 0 20 20" aria-hidden="true">
                <path d="M2.8 10h3.4M9 10h3.4M15.2 10h2" />
              </svg>
              <span>虚线</span>
            </button>
          </div>
          <span className="shape-toolbar-divider" aria-hidden="true" />
          <div className="shape-toolbar-group">
            <button
              type="button"
              className={`shape-tool${magnetOn ? " is-active" : ""}`}
              aria-pressed={magnetOn}
              title={
                magnetOn
                  ? "磁吸吸附已开启：拖动时自动吸附对齐"
                  : "磁吸吸附已关闭：拖动时不吸附，仍显示对齐参考线"
              }
              aria-label="磁吸对齐"
              onClick={() => setMagnetOn((value) => !value)}
            >
              <Magnet size={15} />
              <span>磁吸</span>
            </button>
          </div>
          <span className="shape-toolbar-divider" aria-hidden="true" />
          <div className="shape-toolbar-group">
            <button
              ref={marqueeButtonRef}
              type="button"
              className={`shape-tool marquee-filter-tool${marqueeMenuOpen ? " is-active" : ""}`}
              aria-haspopup="menu"
              aria-expanded={marqueeMenuOpen}
              title="框选类型：选择左键框选包含的组件"
              aria-label="框选类型"
              onClick={toggleMarqueeMenu}
            >
              <span className="marquee-filter-icon">
                <Layers size={15} />
                <i className="shape-tool-count">
                  {Object.values(marqueeFilter).filter(Boolean).length}
                </i>
              </span>
              <span>框选</span>
              <ChevronDown
                size={11}
                className={`marquee-filter-chevron${marqueeMenuOpen ? " is-open" : ""}`}
              />
            </button>
          </div>
        </div>

        {marqueeMenuOpen ? (
          <div
            ref={marqueeMenuRef}
            className="marquee-type-menu"
            data-canvas-ui="true"
            role="menu"
            aria-label="框选类型"
            style={{
              left: `${marqueeMenuPos.left}px`,
              top: `${marqueeMenuPos.top}px`,
            }}
          >
            <div className="marquee-type-head">
              <span>左键框选类型</span>
              <small>可多选</small>
            </div>
            {MARQUEE_TYPES.map((item) => {
              const enabled = marqueeFilter[item.kind];
              return (
                <button
                  key={item.kind}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={enabled}
                  className={`marquee-type-item${enabled ? " is-on" : ""}`}
                  onClick={() =>
                    setMarqueeFilter((current) => ({
                      ...current,
                      [item.kind]: !current[item.kind],
                    }))
                  }
                >
                  <span className="marquee-type-check" aria-hidden="true">
                    {enabled ? <Check size={11} /> : null}
                  </span>
                  <span className="marquee-type-copy">
                    <strong>{item.label}</strong>
                    <small>{item.detail}</small>
                  </span>
                </button>
              );
            })}
            <p className="marquee-type-foot">
              关闭「背景」可避免框选时带上整块底板。
            </p>
          </div>
        ) : null}

        {shapeTool ? (
          <div className="shape-tool-hint" data-canvas-ui="true">
            <span className="shape-tool-hint-dot" aria-hidden="true" />
            点击画布放置图形，或拖拽调整大小
            <kbd>Esc</kbd>
            退出
          </div>
        ) : null}

        <div
          ref={layerRef}
          className="diagram-layer"
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`,
          }}
        >
          {preview ? (
            <div
              className={`advanced-preview${preview.exampleId === "engine" ? " is-engine" : ""}`}
              role="img"
              title={
                preview.exampleId === "engine"
                  ? "由 TeX 引擎完整渲染；拖动平移画布"
                  : "单击节点、箭头或标签定位到源码；拖动平移画布"
              }
              aria-label={`${preview.name}：${preview.packageName} 矢量预览`}
              style={{
                left: `${(-preview.widthCm / 2) * PX_PER_CM}px`,
                top: `${(-preview.heightCm / 2) * PX_PER_CM}px`,
                width: `${preview.widthCm * PX_PER_CM}px`,
                height: `${preview.heightCm * PX_PER_CM}px`,
              }}
              dangerouslySetInnerHTML={{ __html: preview.svg }}
            />
          ) : (
            <>
          <svg className="edge-layer" width="1" height="1" aria-hidden="true">
            {[...doc.paths]
              .sort(
                (a, b) =>
                  Number(Boolean(a.style.crossing)) -
                  Number(Boolean(b.style.crossing)),
              )
              .map((path) => (
                <EdgePath key={path.key} path={path} />
              ))}
          </svg>

          {selectedPath ? (
            <svg
              className="edge-selection-layer"
              width="1"
              height="1"
              aria-hidden="true"
            >
              {selectedPath.subpaths.map((subpath, subpathIndex) =>
                !subpath.shape && subpath.segments.length > 0 ? (
                  <path
                    key={`edge-selected-${subpathIndex}`}
                    d={subpathPathData(subpath, false)}
                    className="edge-selection-path"
                  />
                ) : null,
              )}
            </svg>
          ) : null}

          {doc.nodes.map((node) =>
            node.origin === "tikzcd" && !node.text && !node.textEditable ? null : (
              <NodeView
                key={node.key}
                node={node}
                selected={selectedKeySet.has(node.key)}
                showHandles={selectedKeys.length === 1 && selectedKeySet.has(node.key)}
                onPointerDown={startDrag}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onSelect={selectOnly}
                onEdit={openEditor}
                onResizeStart={startResize}
                onResizeMove={moveResize}
                onResizeEnd={endResize}
                onAnchorPointerDown={startConnector}
              />
            ),
          )}

          {doc.labels.map((label) => (
            <LabelView
              key={label.key}
              label={label}
              selected={selectedKeySet.has(label.key)}
              onPointerDown={startLabelDrag}
              onPointerMove={moveLabelDrag}
              onPointerUp={endLabelDrag}
              onSelect={selectOnly}
              onEdit={openEditor}
            />
          ))}

          {pathAttachNodes.map(({ node, active }) => (
            <span
              key={`path-attach-node-${node.key}`}
              className={`path-attach-node${active ? " is-active" : ""}`}
              style={{
                left: `${screenX(node.bounds.minX)}px`,
                top: `${screenY(node.bounds.maxY)}px`,
                width: `${(node.bounds.maxX - node.bounds.minX) * PX_PER_CM}px`,
                height: `${(node.bounds.maxY - node.bounds.minY) * PX_PER_CM}px`,
              }}
              aria-hidden="true"
            />
          ))}
          {pathAttachHints.map((hint) => (
            <span
              key={`path-attach-${hint.node.key}-${hint.anchor}`}
              className={`path-attach-anchor${hint.active ? " is-active" : ""}${hint.anchor === "center" ? " is-center" : ""}`}
              style={{
                left: `${screenX(hint.point.x)}px`,
                top: `${screenY(hint.point.y)}px`,
              }}
              data-node={hint.node.name}
              data-anchor={hint.anchor}
              aria-hidden="true"
            />
          ))}

          {selectedPath
            ? selectedPathHandles.map((handle, index) => (
                <span
                  key={`path-handle-${handle.subpathIndex}-${handle.edge}-${index}`}
                  className={`path-endpoint-handle${handle.attached ? " is-attached" : ""}`}
                  style={{
                    left: `${screenX(handle.point.x)}px`,
                    top: `${screenY(handle.point.y)}px`,
                  }}
                  data-subpath={handle.subpathIndex}
                  data-edge={handle.edge}
                  title={
                    handle.attached
                      ? "端点连接节点，拖动后会从节点取下"
                      : "拖动移动端点，靠近节点锚点松手可重新连接"
                  }
                  onPointerDown={(event) =>
                    startPathEndpointDrag(event, selectedPath, handle)
                  }
                  onDoubleClick={(event) => event.stopPropagation()}
                />
              ))
            : null}

          {selectedPath
            ? bendMode === "curve"
              ? selectedCurveHandles.map((handle, index) => (
                  <span
                    key={`path-curve-${handle.subpathIndex}-${handle.segmentIndex}-${index}`}
                    className={`path-curve-handle${handle.bent ? " is-bent" : ""}`}
                    style={{
                      left: `${screenX(handle.point.x)}px`,
                      top: `${screenY(handle.point.y)}px`,
                    }}
                    data-subpath={handle.subpathIndex}
                    data-segment={handle.segmentIndex}
                    title="拖动弯曲连线；靠近直线自动磁吸，双击恢复直线"
                    onPointerDown={(event) =>
                      startCurveDrag(event, selectedPath, handle)
                    }
                    onDoubleClick={(event) => {
                      event.stopPropagation();
                      straightenCurve(selectedPath, handle);
                    }}
                  >
                    <i aria-hidden="true" />
                  </span>
                ))
              : selectedPolylineHandles.map((handle, index) => (
                  <span
                    key={`path-polyline-${handle.subpathIndex}-${handle.segmentIndex}-${index}`}
                    className="path-curve-handle is-polyline"
                    style={{
                      left: `${screenX(handle.point.x)}px`,
                      top: `${screenY(handle.point.y)}px`,
                    }}
                    data-subpath={handle.subpathIndex}
                    data-segment={handle.segmentIndex}
                    data-bend="polyline"
                    title="拖动生成折点；实时显示角度，靠近 90° 自动吸附"
                    onPointerDown={(event) =>
                      startPolylineDrag(event, selectedPath, handle)
                    }
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <i aria-hidden="true" />
                  </span>
                ))
            : null}

          {selectedPath
            ? selectedVertexHandles.map((vertex, index) => (
                <span
                  key={`path-vertex-${vertex.subpathIndex}-${vertex.segmentIndex}-${index}`}
                  className={`path-vertex-handle${vertex.rightAngle ? " is-right" : ""}`}
                  style={{
                    left: `${screenX(vertex.point.x)}px`,
                    top: `${screenY(vertex.point.y)}px`,
                  }}
                  data-subpath={vertex.subpathIndex}
                  data-segment={vertex.segmentIndex}
                  data-angle={vertex.angle.toFixed(1)}
                  title="拖动折点调整角度，靠近 90° 自动吸附；双击恢复直线"
                  onPointerDown={(event) =>
                    startVertexDrag(event, selectedPath, vertex)
                  }
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    straightenVertex(selectedPath, vertex);
                  }}
                >
                  <span
                    className={`path-angle-badge${vertex.rightAngle ? " is-right" : ""}`}
                    aria-hidden="true"
                  >
                    {Math.round(vertex.angle)}°
                  </span>
                </span>
              ))
            : null}

          {selectedFrame ? (
            <div
              className="frame-overlay"
              style={{
                left: `${screenX(selectedFrame.minX)}px`,
                top: `${screenY(selectedFrame.maxY)}px`,
                width: `${selectedFrame.width * PX_PER_CM}px`,
                height: `${selectedFrame.height * PX_PER_CM}px`,
              }}
              data-frame-key={selectedFrame.key}
            >
              <span className="frame-outline" aria-hidden="true" />
              <span
                className="frame-badge"
                title="拖拽移动底板"
                onPointerDown={(event) => beginFrameDrag(event, selectedFrame)}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                {selectedFrame.isBackground ? "背景板" : "矩形底板"}
                <span className="frame-badge-grip">⠿ 拖动移动</span>
              </span>
              {(["top", "right", "bottom", "left"] as const).map((edge) => (
                <span
                  key={edge}
                  className={`frame-move-edge edge-${edge}`}
                  title="拖拽移动底板"
                  onPointerDown={(event) => beginFrameDrag(event, selectedFrame)}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                />
              ))}
              {(["nw", "ne", "sw", "se"] as Corner[]).map((corner) => (
                <span
                  key={corner}
                  className={`resize-handle frame-handle handle-${corner}`}
                  data-handle={corner}
                  onPointerDown={(event) => startFrameResize(event, selectedFrame, corner)}
                  onPointerMove={moveFrameResize}
                  onPointerUp={endFrameResize}
                  onPointerCancel={endFrameResize}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onClick={(event) => event.stopPropagation()}
                />
              ))}
            </div>
          ) : null}

          {selectedCount > 1
            ? selectionObjects.frames.map((frame) => (
                <div
                  key={`frame-highlight-${frame.key}`}
                  className="frame-highlight"
                  style={{
                    left: `${screenX(frame.minX)}px`,
                    top: `${screenY(frame.maxY)}px`,
                    width: `${frame.width * PX_PER_CM}px`,
                    height: `${frame.height * PX_PER_CM}px`,
                  }}
                  aria-hidden="true"
                />
              ))
            : null}

          {selectedCount > 1 && groupBounds && !selectionLocked ? (
            <div
              className="group-selection"
              style={{
                left: `${screenX(groupBounds.minX)}px`,
                top: `${screenY(groupBounds.maxY)}px`,
                width: `${(groupBounds.maxX - groupBounds.minX) * PX_PER_CM}px`,
                height: `${(groupBounds.maxY - groupBounds.minY) * PX_PER_CM}px`,
              }}
            >
              <span className="group-outline" aria-hidden="true" />
              <span
                className="group-badge"
                title="拖动移动全部选中组件"
                onPointerDown={(event) => beginGroupMove(event)}
                onDoubleClick={(event) => event.stopPropagation()}
              >
                已选 {selectedCount} 项 · 拖动移动
              </span>
              {(["nw", "ne", "sw", "se"] as Corner[]).map((corner) => (
                <span
                  key={corner}
                  className={`group-handle handle-${corner}`}
                  title="拖拽整体缩放"
                  onPointerDown={(event) => startGroupResize(event, corner)}
                  onDoubleClick={(event) => event.stopPropagation()}
                />
              ))}
            </div>
          ) : null}

          {connectorTargetNode ? (
            <span
              className="connector-target-outline"
              style={{
                left: `${screenX(connectorTargetNode.bounds.minX)}px`,
                top: `${screenY(connectorTargetNode.bounds.maxY)}px`,
                width: `${(connectorTargetNode.bounds.maxX - connectorTargetNode.bounds.minX) * PX_PER_CM}px`,
                height: `${(connectorTargetNode.bounds.maxY - connectorTargetNode.bounds.minY) * PX_PER_CM}px`,
              }}
              aria-hidden="true"
            />
          ) : null}

          {connectorDraft ? (
            <svg
              className="connector-preview"
              width="1"
              height="1"
              aria-hidden="true"
            >
              <defs>
                <marker
                  id="connector-preview-arrow"
                  markerWidth="7"
                  markerHeight="7"
                  refX="6"
                  refY="3.5"
                  orient="auto"
                >
                  <path d="M0 0 7 3.5 0 7Z" fill="var(--accent)" />
                </marker>
              </defs>
              <line
                x1={screenX(connectorDraft.from.x)}
                y1={screenY(connectorDraft.from.y)}
                x2={screenX(connectorDraft.to.x)}
                y2={screenY(connectorDraft.to.y)}
                stroke="var(--accent)"
                strokeWidth={2}
                strokeDasharray={connectorDashed ? "7 5" : undefined}
                markerEnd={
                  connectorArrow ? "url(#connector-preview-arrow)" : undefined
                }
              />
              <circle
                cx={screenX(connectorDraft.from.x)}
                cy={screenY(connectorDraft.from.y)}
                r={3.5}
                fill="var(--accent)"
              />
            </svg>
          ) : null}

          {shapeDraft ? (
            <div
              className="shape-draft"
              style={{
                left: `${screenX(shapeDraft.left)}px`,
                top: `${screenY(shapeDraft.top + shapeDraft.height)}px`,
                width: `${shapeDraft.width * PX_PER_CM}px`,
                height: `${shapeDraft.height * PX_PER_CM}px`,
              }}
              aria-hidden="true"
            >
              <span className={`shape-draft-shape is-${shapeDraft.kind}`} />
              <span className="shape-draft-size">
                {formatNumber(shapeDraft.width)} × {formatNumber(shapeDraft.height)} cm
              </span>
            </div>
          ) : null}
            </>
          )}
        </div>

        {engineBusy ? (
          <div className="engine-overlay">
            <div
              className={`engine-card${engine.status === "error" ? " is-error" : ""}`}
              data-canvas-ui="true"
              role={engine.status === "error" ? "alert" : "status"}
            >
              {engine.status === "error" ? (
                <>
                  <div className="engine-card-head">
                    <TriangleAlert size={16} />
                    <strong>TeX 引擎未能渲染这段源码</strong>
                  </div>
                  <p className="engine-card-message">{engine.error}</p>
                  {engine.hint ? (
                    <p className="engine-card-hint">{engine.hint}</p>
                  ) : null}
                  {engine.detail ? (
                    <details className="engine-card-log">
                      <summary>查看编译日志</summary>
                      <pre>{engine.detail}</pre>
                    </details>
                  ) : null}
                  <div className="engine-card-actions">
                    <button
                      type="button"
                      className="button button-accent button-small"
                      onClick={onEngineRetry}
                    >
                      <RefreshCw size={13} />
                      重试编译
                    </button>
                    <button
                      type="button"
                      className="button button-ghost button-small"
                      onClick={onEngineUseNative}
                    >
                      <MousePointer2 size={13} />
                      改用原生渲染
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="engine-card-head">
                    <Loader2 size={16} className="export-spin" />
                    <strong>正在用 TeX 引擎编译</strong>
                  </div>
                  <p className="engine-card-message">
                    通过 WebAssembly 运行原生 TeX 排版，完整还原复杂图形。
                  </p>
                  {engine.reasons.length > 0 ? (
                    <div className="engine-reasons">
                      {engine.reasons.slice(0, 4).map((reason) => (
                        <span key={reason}>{reason}</span>
                      ))}
                    </div>
                  ) : null}
                  <p className="engine-card-foot">
                    首次编译需加载约 14 MB 本地引擎资源，之后会缓存复用。
                  </p>
                </>
              )}
            </div>
          </div>
        ) : null}

        {preview ? (
          preview.exampleId === "engine" ? (
            <div className="advanced-preview-note is-engine" data-canvas-ui="true">
              <span className="advanced-preview-package">TikZ</span>
              <span className="advanced-preview-copy">
                <strong>{preview.name}</strong>
                <small>{preview.description}</small>
              </span>
              <span className="advanced-preview-actions">
                <button type="button" onClick={onEngineRetry}>
                  重新编译
                </button>
                <button type="button" onClick={onEngineUseNative}>
                  转为可编辑
                </button>
              </span>
            </div>
          ) : (
            <div className="advanced-preview-note" data-canvas-ui="true">
              <span className="advanced-preview-package">{preview.packageName}</span>
              <span className="advanced-preview-copy">
                <strong>{preview.name}</strong>
                <small>{preview.description}</small>
              </span>
              <span className="advanced-preview-hint">
                单击组件定位源码 · 拖动平移
              </span>
            </div>
          )
        ) : null}

        {alignmentGuides.vertical.length > 0 || alignmentGuides.horizontal.length > 0 ? (
          <div className="alignment-guides" aria-hidden="true">
            {alignmentGuides.vertical.map((x) => (
              <span
                key={`guide-x-${x}`}
                className="alignment-guide is-vertical"
                style={{
                  left: `${transform.x + x * PX_PER_CM * transform.zoom}px`,
                }}
              />
            ))}
            {alignmentGuides.horizontal.map((y) => (
              <span
                key={`guide-y-${y}`}
                className="alignment-guide is-horizontal"
                style={{
                  top: `${transform.y - y * PX_PER_CM * transform.zoom}px`,
                }}
              />
            ))}
          </div>
        ) : null}

        {marquee ? (
          <div
            className="marquee-box"
            style={{
              left: `${marquee.left}px`,
              top: `${marquee.top}px`,
              width: `${marquee.width}px`,
              height: `${marquee.height}px`,
            }}
            data-canvas-ui="true"
            aria-hidden="true"
          />
        ) : null}

        {empty && !engine.active ? (
          <div className="canvas-empty" data-canvas-ui="true">
            <div className="empty-mark" aria-hidden="true">
              <Crosshair size={22} />
            </div>
            <h3>{doc.hasPicture ? "这张图还没有元素" : "还没有 TikZ 图形"}</h3>
            <p>
              {doc.hasPicture
                ? "用左上角图形工具直接绘制，或在源码里添加 \\node、\\draw 或 \\path。"
                : "在左侧粘贴包含 \\begin{tikzpicture} … \\end{tikzpicture} 的源码，或用图形工具从空白开始。"}
            </p>
            <button type="button" className="button button-ink button-small" onClick={onLoadExample}>
              载入示例
            </button>
          </div>
        ) : null}

        <div className="zoom-cluster" data-canvas-ui="true">
          <button
            type="button"
            className="zoom-button"
            onClick={() => zoomAroundCenter(0.82)}
            aria-label="缩小画布"
            title="缩小"
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            className="zoom-value"
            onClick={resetZoom}
            title="重置为 100%"
          >
            {Math.round(transform.zoom * 100)}%
          </button>
          <button
            type="button"
            className="zoom-button"
            onClick={() => zoomAroundCenter(1.22)}
            aria-label="放大画布"
            title="放大"
          >
            <Plus size={15} />
          </button>
          <span className="zoom-divider" />
          <button
            type="button"
            className="zoom-button fit-button"
            onClick={fitToContent}
            aria-label="适应画布"
            title="适应画布"
          >
            <Maximize2 size={14} />
            <span>适应</span>
          </button>
        </div>

        {selectionInfo ? (
          selectionPanelCollapsed ? (
            <button
              type="button"
              className="selection-panel-fab"
              data-canvas-ui="true"
              aria-label="展开属性面板"
              aria-expanded="false"
              title="展开属性面板"
              onClick={() => setSelectionPanelCollapsed(false)}
            >
              <SlidersHorizontal size={14} />
              <span>属性</span>
            </button>
          ) : (
          <aside className="selection-panel" data-canvas-ui="true" aria-label="属性面板">
            <div className="selection-top">
              <span className="selection-eyebrow">{selectionInfo.eyebrow}</span>
              <div className="selection-top-actions">
                <button
                  type="button"
                  className="selection-close selection-collapse"
                  aria-label="收起属性面板"
                  title="收起属性面板；点击其他组件时保持收起"
                  onClick={() => setSelectionPanelCollapsed(true)}
                >
                  <ChevronDown size={14} />
                </button>
                <button
                  type="button"
                  className="selection-close"
                  aria-label="取消选择"
                  onClick={() => {
                    closeEditor();
                    onSelect([]);
                  }}
                >
                  <X size={13} />
                </button>
              </div>
            </div>
            <strong>{selectionInfo.title}</strong>
            <div className="selection-meta">
              {selectionInfo.meta.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
            {selectedNode && !selectionIsCdCell ? (
              <div className="selection-colors">
                <div className="selection-colors-head">
                  <span>样式</span>
                  <small>实时写入 TikZ</small>
                </div>
                <ColorControl
                  label="填充"
                  value={selectedNode.style.fill}
                  allowNone
                  onSessionStart={() => beginColorSession("node")}
                  onPick={(value) => changeNodeColor("fill", value)}
                  onNone={() =>
                    changeNodeColor(
                      "fill",
                      selectedNode.style.fill ? null : "#ffffff",
                    )
                  }
                />
                <ColorControl
                  label="描边"
                  value={selectedNode.style.draw}
                  allowNone
                  onSessionStart={() => beginColorSession("node")}
                  onPick={(value) => changeNodeColor("draw", value)}
                  onNone={() =>
                    changeNodeColor(
                      "draw",
                      selectedNode.style.draw ? null : "#20251f",
                    )
                  }
                />
                <ColorControl
                  label="文字"
                  value={selectedNode.style.textColor}
                  fallback="#232820"
                  onSessionStart={() => beginColorSession("node")}
                  onPick={(value) => changeNodeColor("text", value)}
                />
                {selectedFontPoints !== null ? (
                  <FontSizeControl
                    points={selectedFontPoints}
                    onStep={stepSelectedFontSize}
                  />
                ) : null}
                <p className="selection-anchor-hint">
                  <span className="selection-anchor-dot" aria-hidden="true" />
                  拖拽八向锚点引出连线，移动图形时连线自动跟随
                </p>
              </div>
            ) : selectedLabel && !selectionIsCdLabel ? (
              <div className="selection-colors">
                <div className="selection-colors-head">
                  <span>样式</span>
                  <small>实时写入 TikZ</small>
                </div>
                <ColorControl
                  label="文字"
                  value={selectedLabel.textColor}
                  fallback="#3a4036"
                  onSessionStart={() => beginColorSession("label")}
                  onPick={changeLabelColor}
                />
                {selectedFontPoints !== null ? (
                  <FontSizeControl
                    points={selectedFontPoints}
                    onStep={stepSelectedFontSize}
                  />
                ) : null}
              </div>
            ) : null}
            {selectionIsCdArrow && selectedPath ? (
              <div className="selection-edge selection-cd-arrow">
                <div className="selection-bend">
                  <span className="selection-bend-label">线型</span>
                  <div
                    className="selection-bend-switch"
                    role="group"
                    aria-label="箭头线型"
                  >
                    {(
                      [
                        ["solid", "实线"],
                        ["dashed", "虚线"],
                        ["dotted", "点线"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={tikzCdLineStyle(selectedPath) === value ? "is-active" : ""}
                        aria-pressed={tikzCdLineStyle(selectedPath) === value}
                        onClick={() => changeTikzCdArrow({ line: value })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="selection-bend">
                  <span className="selection-bend-label">箭头</span>
                  <div
                    className="selection-bend-switch"
                    role="group"
                    aria-label="箭头方向"
                  >
                    {(
                      [
                        ["->", "→"],
                        ["<-", "←"],
                        ["<->", "↔"],
                        ["-", "—"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={tikzCdArrowEnds(selectedPath) === value ? "is-active" : ""}
                        aria-pressed={tikzCdArrowEnds(selectedPath) === value}
                        title={
                          value === "->"
                            ? "箭头指向目标单元格"
                            : value === "<-"
                              ? "箭头指向来源单元格"
                              : value === "<->"
                                ? "双向箭头"
                                : "无箭头"
                        }
                        onClick={() => changeTikzCdArrow({ ends: value })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="selection-bend">
                  <span className="selection-bend-label">弯曲</span>
                  <div
                    className="selection-bend-switch"
                    role="group"
                    aria-label="箭头弯曲方向"
                  >
                    {(
                      [
                        ["none", "无"],
                        ["left", "左"],
                        ["right", "右"],
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={tikzCdBend(selectedPath) === value ? "is-active" : ""}
                        aria-pressed={tikzCdBend(selectedPath) === value}
                        onClick={() => changeTikzCdArrow({ bend: value })}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <p className="selection-bend-hint">
                  修改会写回 \arrow 选项；标签、crossing over 与其他选项保持不变。
                </p>
              </div>
            ) : selectedPath ? (
              <div className="selection-edge">
                <p className="selection-edge-hint">
                  <span
                    className={`edge-endpoint-sample${pathHasAttachedEndpoints(selectedPath) ? " is-attached" : ""}`}
                    aria-hidden="true"
                  />
                  <span>
                    拖动端点可改变走向；拖到节点锚点时高亮吸附，松手即可重新连接。
                  </span>
                </p>
                <div className="selection-bend">
                  <span className="selection-bend-label">中点拖动</span>
                  <div
                    className="selection-bend-switch"
                    role="group"
                    aria-label="连线中点拖动方式"
                  >
                    <button
                      type="button"
                      className={bendMode === "curve" ? "is-active" : ""}
                      aria-pressed={bendMode === "curve"}
                      onClick={() => setBendMode("curve")}
                    >
                      弧线
                    </button>
                    <button
                      type="button"
                      className={bendMode === "polyline" ? "is-active" : ""}
                      aria-pressed={bendMode === "polyline"}
                      onClick={() => setBendMode("polyline")}
                    >
                      折线
                    </button>
                  </div>
                </div>
                <p className="selection-bend-hint">
                  {bendMode === "curve"
                    ? "拖动中点弯曲，靠近直线自动磁吸；双击中点复原。"
                    : "拖动中点生成折点，实时显示角度；接近 90° 吸附直角，双击折点复原。"}
                </p>
                {pathHasAttachedEndpoints(selectedPath) ? (
                  <button
                    type="button"
                    className="selection-detach"
                    onClick={detachSelectedPath}
                  >
                    <Unlink size={13} />
                    <span>从节点取下</span>
                  </button>
                ) : null}
              </div>
            ) : null}
            {selectionInfo.editable ? (
              <button
                type="button"
                className="selection-edit"
                onClick={() => openEditor(selectionInfo.editable!)}
              >
                编辑文字
              </button>
            ) : selectionInfo.multi ? (
              selectionInfo.locked ? (
                <p className="selection-resize-hint selection-multi-hint">
                  <Scaling size={12} />
                  <span>
                    tikz-cd 单元格与箭头由表格源码定位，不能整体移动
                    <br />
                    可逐个选中编辑公式、箭头样式或删除箭头
                  </span>
                </p>
              ) : (
                <p className="selection-resize-hint selection-multi-hint">
                  <Scaling size={12} />
                  <span>
                    拖动任一组件移动全部，四角调整整体大小
                    <br />
                    方向键微调 0.01cm，Shift + 方向键 0.1cm
                  </span>
                </p>
              )
            ) : selectionInfo.resizeHint ? (
              <p className="selection-resize-hint">
                <Scaling size={12} />
                拖动选中框的边框或顶部标签移动，四角调整大小；框内拖动可继续框选
              </p>
            ) : null}
            {selectionIsCdCell ? (
              <p className="selection-resize-hint">
                <Scaling size={12} />
                单元格位置由 &amp; 与 \\ 决定；双击编辑公式，删除请调整表格源码
              </p>
            ) : selectionIsCdLabel ? (
              <p className="selection-resize-hint">
                <Scaling size={12} />
                标签位置由箭头选项决定；双击编辑文字，删除请在源码中移除引号选项
              </p>
            ) : null}
            {selectionIsCdCell || selectionIsCdLabel ? null : (
              <div className="selection-actions">
                <button
                  type="button"
                  className="selection-delete"
                  onClick={deleteSelection}
                  title={
                    selectionIsCdArrow
                      ? "从单元格中删除该 \\arrow 命令（Delete / Backspace）"
                      : "删除所选组件（Delete / Backspace）"
                  }
                >
                  <Trash2 size={13} />
                  <span>{selectionIsCdArrow ? "删除箭头" : "删除所选"}</span>
                  <kbd>Del</kbd>
                </button>
              </div>
            )}
          </aside>
          )
        ) : null}

        {editing ? (
          <div className="text-editor-card" data-canvas-ui="true">
            <div className="text-editor-head">
              <div>
                <span className="selection-eyebrow">TEXT</span>
                <h3>{editing.title}</h3>
              </div>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭文字编辑"
                onClick={closeEditor}
              >
                <X size={15} />
              </button>
            </div>
            <textarea
              ref={textareaRef}
              value={draft}
              spellCheck={false}
              rows={4}
              onChange={(event) => {
                setDraft(event.target.value);
                setDraftError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  closeEditor();
                } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  saveEditor();
                }
              }}
            />
            <p className={`editor-hint${draftError ? " has-error" : ""}`}>
              {draftError ?? editorDefaultHint}
            </p>
            <div className="text-editor-actions">
              <span className="shortcut-hint">⌘/Ctrl + Enter</span>
              <button type="button" className="button button-ghost button-small" onClick={closeEditor}>
                取消
              </button>
              <button type="button" className="button button-accent button-small" onClick={saveEditor}>
                <CornerDownRight size={13} />
                写回源码
              </button>
            </div>
          </div>
        ) : null}

        {issuesOpen && issueCount > 0 ? (
          <aside className="issues-panel" data-canvas-ui="true">
            <div className="issues-head">
              <span>
                <TriangleAlert size={14} />
                兼容性提示
              </span>
              <button
                type="button"
                className="icon-button"
                aria-label="关闭提示"
                onClick={() => setIssuesOpen(false)}
              >
                <X size={14} />
              </button>
            </div>
            <p className="issues-intro">以下语法超出了当前渲染器的支持范围，图形其他部分不受影响。</p>
            <ul>
              {doc.issues.map((issue, index) => (
                <li key={`${issue.id}-${index}`} className={issue.severity}>
                  <span>{issue.message}</span>
                  {issue.detail ? <small>{issue.detail}</small> : null}
                </li>
              ))}
            </ul>
            {engine.available ? (
              <button
                type="button"
                className="issues-engine-cta"
                onClick={() => {
                  setIssuesOpen(false);
                  onEngineUse();
                }}
              >
                <Sparkles size={13} />
                <span>
                  <strong>用 TeX 引擎完整渲染</strong>
                  <small>支持 \foreach、calc、scope 与自定义宏</small>
                </span>
                <ArrowRight size={13} />
              </button>
            ) : engine.unavailableHint ? (
              <p className="issues-engine-hint">{engine.unavailableHint}</p>
            ) : null}
          </aside>
        ) : null}
      </div>
    </section>
  );
}
