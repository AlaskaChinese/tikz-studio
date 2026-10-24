export interface Span {
  start: number;
  end: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export type NodeShape = "rectangle" | "rounded" | "circle" | "ellipse" | "diamond" | "none";

export type IssueSeverity = "warning" | "error";

export interface TikzIssue {
  id: string;
  message: string;
  detail?: string;
  severity: IssueSeverity;
}

export interface NodeStyle {
  draw: string | null;
  fill: string | null;
  textColor: string | null;
  lineWidth: number;
  dashed: boolean;
  dotted: boolean;
  shape: NodeShape;
  cornerRadius: number;
  minWidth?: number;
  minHeight?: number;
  minSize?: number;
  textWidth?: number;
  innerSep: number;
  fontSize: number;
  align: "left" | "center" | "right";
  opacity: number;
  fillOpacity: number;
  anchor: string;
}

export interface RelativePlacement {
  directions: Array<"above" | "below" | "left" | "right">;
  reference: string;
  distanceCm?: number;
}

export interface TikzNode {
  kind: "node";
  index: number;
  key: string;
  name: string;
  text: string;
  textSpan: Span;
  commandSpan: Span;
  commandNameEnd: number;
  contentOpen: number;
  contentClose: number;
  optionBlocks: Span[];
  style: NodeStyle;
  styleTokens: ParsedOption[];
  x: number;
  y: number;
  width: number;
  height: number;
  naturalWidth: number;
  naturalHeight: number;
  anchorPoint: string;
  positioning: "absolute" | "relative" | "default" | "unresolved";
  relative?: RelativePlacement;
  atCoordinates?: string;
  atInnerSpan?: Span;
  bounds: Bounds;
}

export interface TikzCoordinate {
  name: string;
  x: number;
  y: number;
  sourceSpan: Span;
}

export interface ParsedOption {
  key: string;
  value?: string;
  raw: string;
}

export interface PathStyle {
  draw: string | null;
  fill: string | null;
  lineWidth: number;
  dashed: boolean;
  dotted: boolean;
  opacity: number;
  fillOpacity: number;
  arrowStart: boolean;
  arrowEnd: boolean;
  bend?: { direction: "left" | "right"; angle: number };
  shortenStart: number;
  shortenEnd: number;
}

export type SegmentKind = "line" | "horizontal-vertical" | "vertical-horizontal" | "cubic";

export interface RawEndpoint {
  raw: string;
  nodeRef?: string;
  nodeAnchor?: string;
  isRelative: boolean;
  isCycle?: boolean;
}

export interface ResolvedEndpoint {
  point: Point;
  nodeRef?: TikzNode;
  rawAnchor?: string;
  isBorderPoint: boolean;
}

export interface CurveGeometry {
  from: Point;
  c1: Point;
  c2: Point;
  to: Point;
}

export interface LineGeometry {
  from: Point;
  to: Point;
  kind: "line" | "horizontal-vertical" | "vertical-horizontal";
}

export interface PathSegment {
  kind: SegmentKind;
  raw: RawEndpoint;
  geometry: LineGeometry | CurveGeometry;
  from: ResolvedEndpoint;
  to: ResolvedEndpoint;
  labels: TikzLabel[];
}

export interface TikzLabel {
  kind: "label";
  key: string;
  pathIndex: number;
  labelIndex: number;
  text: string;
  textSpan: Span;
  commandNameEnd: number;
  optionBlocks: Span[];
  sourceShift: Point;
  rawText: string;
  position: Point;
  fontSize: number;
  textColor: string | null;
  fill: string | null;
  draw: string | null;
  above: boolean;
  below: boolean;
  left: boolean;
  right: boolean;
  sourcePosition: number;
  bounds: Bounds;
}

export interface PathLabelDefinition {
  text: string;
  textSpan: Span;
  options: ParsedOption[];
  position: number;
  orientation: "above" | "below" | "left" | "right" | "center";
  xOffset: number;
  yOffset: number;
  style: {
    fontSize: number;
    textColor: string | null;
    fill: string | null;
    draw: string | null;
  };
}

export interface PathSubpath {
  segments: PathSegment[];
  start: ResolvedEndpoint;
  closed: boolean;
  shape?: {
    kind: "rectangle" | "circle" | "ellipse";
    center?: Point;
    radius?: number;
    radiusY?: number;
    corner1?: Point;
    corner2?: Point;
    corner1Span?: Span;
    corner2Span?: Span;
  };
}

export interface TikzFrame {
  kind: "frame";
  key: string;
  pathIndex: number;
  subpathIndex: number;
  commandSpan: Span;
  corner1Span: Span;
  corner2Span: Span;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  fill: string | null;
  draw: string | null;
  isBackground: boolean;
}

export interface TikzPath {
  kind: "path";
  index: number;
  key: string;
  commandSpan: Span;
  style: PathStyle;
  subpaths: PathSubpath[];
  labels: TikzLabel[];
  fill: boolean;
  stroke: boolean;
}

export interface SourceStats {
  nodes: number;
  paths: number;
  labels: number;
  lines: number;
}

export interface TikzDocument {
  source: string;
  nodes: TikzNode[];
  coordinates: TikzCoordinate[];
  paths: TikzPath[];
  labels: TikzLabel[];
  frames: TikzFrame[];
  issues: TikzIssue[];
  bounds: Bounds;
  stats: SourceStats;
  hasPicture: boolean;
  pictureSpan?: Span;
  colorDefinitions: Record<string, string>;
}

export interface DragSnapshot {
  source: string;
  object: TikzNode;
  startClientX: number;
  startClientY: number;
  startX: number;
  startY: number;
}

export interface ResizeSnapshot {
  source: string;
  object: TikzNode;
  startWidth: number;
  startHeight: number;
  startClientX: number;
  startClientY: number;
  corner: "nw" | "ne" | "sw" | "se";
}
