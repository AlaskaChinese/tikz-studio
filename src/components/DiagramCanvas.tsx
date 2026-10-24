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
  Check,
  ChevronDown,
  CornerDownRight,
  Crosshair,
  Download,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  Scaling,
  TriangleAlert,
  X,
} from "lucide-react";
import { toBlob, toJpeg, toSvg } from "html-to-image";
import { latexToHtml } from "@/src/lib/tikz/latexText";
import { PX_PER_CM } from "@/src/lib/tikz/options";
import {
  patchFrameGeometry,
  patchLabelOffset,
  patchNodeGeometry,
  patchNodePosition,
  patchSelectionScale,
  patchSelectionTranslation,
  patchText,
  validateNodeText,
  type SelectionEditObjects,
} from "@/src/lib/tikz/patch";
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

type Corner = "nw" | "ne" | "sw" | "se";
type ExportFormat = "svg" | "png" | "jpg";
type ViewportSize = { width: number; height: number };
type Transform = { x: number; y: number; zoom: number };

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

interface FrameMoveState {
  source: string;
  frame: TikzFrame;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startMinX: number;
  startMinY: number;
  startMaxX: number;
  startMaxY: number;
  moved: boolean;
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
  resizeHint?: boolean;
  multi?: boolean;
}

interface EditingState {
  key: string;
  kind: "node" | "label";
  title: string;
}

interface DiagramCanvasProps {
  doc: TikzDocument;
  source: string;
  selectedKeys: string[];
  onSelect: (keys: string[]) => void;
  onSourceChange: (source: string) => void;
  fitSignal: number;
  onLoadExample: () => void;
  mobileActive: boolean;
}

function collectSelection(doc: TikzDocument, keys: string[]): SelectionEditObjects {
  const wanted = new Set(keys);
  return {
    nodes: doc.nodes.filter((node) => wanted.has(node.key)),
    labels: doc.labels.filter((label) => wanted.has(label.key)),
    frames: doc.frames.filter((frame) => wanted.has(frame.key)),
  };
}

function selectionSize(objects: SelectionEditObjects): number {
  return objects.nodes.length + objects.labels.length + objects.frames.length;
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

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
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
}) {
  const style = node.style;
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
  const contentStyle: CSSProperties = {
    padding:
      style.shape === "diamond"
        ? `${Math.round(height * 0.2)}px ${Math.round(width * 0.2)}px`
        : `${Math.max(0, Math.round(padding))}px`,
    fontSize: `${style.fontSize}px`,
    color: style.textColor ?? "#232820",
    textAlign: style.align,
    whiteSpace: style.textWidth ? "normal" : "nowrap",
    justifyContent:
      style.align === "left" ? "flex-start" : style.align === "right" ? "flex-end" : "center",
  };
  const corners: Corner[] = ["nw", "ne", "sw", "se"];

  return (
    <div
      className={`tikz-node${selected ? " is-selected" : ""}`}
      style={wrapperStyle}
      data-node-key={node.key}
      role="button"
      tabIndex={0}
      aria-label={`节点 ${node.name || node.text || "未命名"}，拖拽移动，双击编辑文字`}
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
        className={`node-content${style.textWidth ? " is-wrapping" : ""}`}
        style={contentStyle}
      >
        <span
          className="tikz-rich-text"
          dangerouslySetInnerHTML={{ __html: latexToHtml(node.text) }}
        />
      </span>
      {selected ? <span className="selection-outline" aria-hidden="true" /> : null}
      {selected && showHandles ? (
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
      className={`edge-label${selected ? " is-selected" : ""}${label.fill ? " has-fill" : ""}`}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={`连线标签 ${label.text}，拖拽移动，双击编辑文字`}
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
        dangerouslySetInnerHTML={{ __html: latexToHtml(label.text) }}
      />
    </div>
  );
}

export function DiagramCanvas({
  doc,
  source,
  selectedKeys,
  onSelect,
  onSourceChange,
  fitSignal,
  onLoadExample,
  mobileActive,
}: DiagramCanvasProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const exportControlRef = useRef<HTMLDivElement>(null);
  const sourceRef = useRef(source);
  const docRef = useRef(doc);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const labelDragRef = useRef<LabelDragState | null>(null);
  const frameResizeRef = useRef<FrameResizeState | null>(null);
  const frameMoveRef = useRef<FrameMoveState | null>(null);
  const selectedKeysRef = useRef(selectedKeys);
  const editingRef = useRef<EditingState | null>(null);
  const transformRef = useRef<Transform>({ x: 0, y: 0, zoom: 1 });
  const sizeRef = useRef<ViewportSize>({ width: 0, height: 0 });
  const autoFitRef = useRef(true);
  const lastFitSignal = useRef(fitSignal);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  sourceRef.current = source;
  docRef.current = doc;
  selectedKeysRef.current = selectedKeys;
  editingRef.current = editing;
  transformRef.current = transform;

  const selectedKeySet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const selectionObjects = useMemo(
    () => collectSelection(doc, selectedKeys),
    [doc, selectedKeys],
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

  const selectOnly = useCallback(
    (key: string | null) => {
      onSelect(key ? [key] : []);
    },
    [onSelect],
  );

  const toggleSelection = useCallback(
    (key: string) => {
      const current = selectedKeysRef.current;
      onSelect(
        current.includes(key)
          ? current.filter((item) => item !== key)
          : [...current, key],
      );
    },
    [onSelect],
  );

  const fitToContent = useCallback(() => {
    const viewport = viewportRef.current;
    const { width, height } = sizeRef.current;
    if (!viewport || width < 80 || height < 80) return;
    const bounds = docRef.current.bounds;
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
      setIssuesOpen(false);
      setDraft(object.text);
      setDraftError(null);
      setEditing({
        key: object.key,
        kind: isNode ? "node" : "label",
        title: isNode
          ? `编辑节点 · ${object.name || `#${(object as TikzNode).index + 1}`}`
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
    const error = validateNodeText(draft);
    if (error) {
      setDraftError(error);
      return;
    }
    onSourceChange(patchText(sourceRef.current, object, draft));
    closeEditor();
  }, [closeEditor, doc.labels, doc.nodes, draft, editing, onSourceChange]);

  const exportDiagram = useCallback(
    async (format: ExportFormat) => {
      const layer = layerRef.current;
      if (!layer || exporting) return;
      setExportError(null);
      setExporting(format);
      const bounds = docRef.current.bounds;
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
          ".selection-outline, .node-badge, .resize-handle, .frame-overlay, .group-selection, .frame-highlight, .marquee-box",
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
        if (moveEvent.pointerId !== pointerId) return;
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
        const step = moveEvent.altKey ? 0 : 0.1;
        onSourceChange(
          patchSelectionTranslation(source, objects, snap(dx, step), snap(dy, step)),
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
        if (!moved && clickedKey && upEvent.type !== "pointercancel") {
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
        if (moveEvent.pointerId !== pointerId) return;
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
      if (event.button !== 0) return;
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
      if (!drag || event.pointerId !== drag.pointerId) return;
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
      const step = event.altKey ? 0 : 0.1;
      const x = snap(drag.startX + dx, step);
      const y = snap(drag.startY + dy, step);
      onSourceChange(patchNodePosition(drag.source, drag.node, x, y));
    },
    [onSourceChange, transform.zoom],
  );

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
  }, []);

  const startLabelDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, label: TikzLabel) => {
      if (event.button !== 0) return;
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
    [beginGroupMove, closeEditor, editing, selectOnly, toggleSelection],
  );

  const moveLabelDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = labelDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
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
      const step = event.altKey ? 0 : 0.1;
      onSourceChange(
        patchLabelOffset(drag.source, drag.label, snap(shiftX, step), snap(shiftY, step)),
      );
    },
    [onSourceChange, transform.zoom],
  );

  const endLabelDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = labelDragRef.current;
    if (!drag || event.pointerId !== drag.pointerId) return;
    labelDragRef.current = null;
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
      if (!resize || event.pointerId !== resize.pointerId) return;
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
      if (!resize || event.pointerId !== resize.pointerId) return;
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

  const startFrameMove = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>, frame: TikzFrame) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      setIssuesOpen(false);
      selectOnly(frame.key);
      frameMoveRef.current = {
        source: sourceRef.current,
        frame,
        pointerId: event.pointerId,
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

  const moveFrameMove = useCallback(
    (event: ReactPointerEvent<HTMLSpanElement>) => {
      const move = frameMoveRef.current;
      if (!move || event.pointerId !== move.pointerId) return;
      const deltaX = event.clientX - move.startClientX;
      const deltaY = event.clientY - move.startClientY;
      if (!move.moved && Math.hypot(deltaX, deltaY) < 2) return;
      move.moved = true;
      const cmPerPixel = 1 / (transform.zoom * PX_PER_CM);
      let dx = deltaX * cmPerPixel;
      let dy = -deltaY * cmPerPixel;
      if (event.shiftKey) {
        if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const step = event.altKey ? 0 : 0.1;
      const width = move.startMaxX - move.startMinX;
      const height = move.startMaxY - move.startMinY;
      const minX = snap(move.startMinX + dx, step);
      const minY = snap(move.startMinY + dy, step);
      onSourceChange(
        patchFrameGeometry(move.source, move.frame, {
          minX,
          minY,
          maxX: minX + width,
          maxY: minY + height,
        }),
      );
    },
    [onSourceChange, transform.zoom],
  );

  const endFrameMove = useCallback((event: ReactPointerEvent<HTMLSpanElement>) => {
    const move = frameMoveRef.current;
    if (!move || event.pointerId !== move.pointerId) return;
    frameMoveRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already have been released by the browser.
    }
  }, []);

  const handleBackgroundPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 && event.button !== 2) return;
      const target = event.target as HTMLElement;
      if (target.closest("[data-canvas-ui]")) return;
      const viewport = viewportRef.current;
      if (!viewport) return;

      if (event.button === 2) {
        event.preventDefault();
        setIssuesOpen(false);
        if (editing) closeEditor();
        autoFitRef.current = false;
        setPanning(true);
        viewport.setPointerCapture(event.pointerId);
        const pointerId = event.pointerId;
        const startClientX = event.clientX;
        const startClientY = event.clientY;
        const startX = transform.x;
        const startY = transform.y;
        const handleMove = (moveEvent: PointerEvent) => {
          if (moveEvent.pointerId !== pointerId) return;
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
        };
        viewport.addEventListener("pointermove", handleMove);
        viewport.addEventListener("pointerup", finish);
        viewport.addEventListener("pointercancel", finish);
        return;
      }

      if (target.closest(".tikz-node, .edge-label, .frame-overlay, .group-selection")) {
        return;
      }

      event.preventDefault();
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
        if (moveEvent.pointerId !== pointerId) return;
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
        if (upEvent.type === "pointercancel") return;

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
          const hits: string[] = [];
          for (const node of docRef.current.nodes) {
            if (boundsIntersect(node.bounds, range)) hits.push(node.key);
          }
          for (const label of docRef.current.labels) {
            if (boundsIntersect(label.bounds, range)) hits.push(label.key);
          }
          onSelect(
            Array.from(
              new Set(additive ? [...baseSelection, ...hits] : hits),
            ),
          );
          return;
        }

        const point = modelPoint(upEvent.clientX, upEvent.clientY);
        let hit: TikzFrame | null = null;
        for (const frame of docRef.current.frames) {
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
    [closeEditor, editing, onSelect, toggleSelection, transform],
  );

  const nudgeSelection = useCallback(
    (dxScreen: number, dyScreen: number) => {
      const objects = collectSelection(docRef.current, selectedKeysRef.current);
      if (selectionSize(objects) === 0) return;
      const cmPerPixel = 1 / (transformRef.current.zoom * PX_PER_CM);
      onSourceChange(
        patchSelectionTranslation(
          sourceRef.current,
          objects,
          dxScreen * cmPerPixel,
          dyScreen * cmPerPixel,
        ),
      );
    },
    [onSourceChange],
  );

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (editingRef.current) return;
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
      const step = event.shiftKey ? 10 : 1;
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

  const empty = !doc.hasPicture || (doc.stats.nodes === 0 && doc.stats.paths === 0);
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
    return [
      counts.join(" · "),
      `${formatNumber(groupBounds.maxX - groupBounds.minX)} × ${formatNumber(groupBounds.maxY - groupBounds.minY)} cm`,
    ];
  }, [groupBounds, selectionObjects]);

  const selectionInfo: SelectionInfo | null =
    selectedCount > 1 && groupBounds
      ? {
          eyebrow: "多选",
          title: `已选择 ${selectedCount} 个组件`,
          meta: multiMeta,
          multi: true,
        }
      : selectedNode
        ? {
            eyebrow: "节点",
            title: selectedNode.name ? `(${selectedNode.name})` : "未命名节点",
            meta: [
              `x ${formatNumber(selectedNode.x)}`,
              `y ${formatNumber(selectedNode.y)}`,
              `${formatNumber(selectedNode.width)} × ${formatNumber(selectedNode.height)} cm`,
            ],
            editable: selectedNode,
          }
        : selectedLabel
          ? {
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
            }
          : selectedFrame
            ? {
                eyebrow: selectedFrame.isBackground ? "背景板" : "矩形底板",
                title: selectedFrame.isBackground ? "背景底板" : "矩形框",
                meta: [
                  `${formatNumber(selectedFrame.width)} × ${formatNumber(selectedFrame.height)} cm`,
                  `x ${formatNumber(selectedFrame.minX)} → ${formatNumber(selectedFrame.maxX)}`,
                  `y ${formatNumber(selectedFrame.minY)} → ${formatNumber(selectedFrame.maxY)}`,
                ],
                resizeHint: true,
              }
            : null;

  return (
    <section className={`canvas-pane${mobileActive ? " is-mobile-active" : ""}`}>
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
          {issueCount > 0 ? (
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
              disabled={empty || exporting != null}
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
        className={`diagram-viewport${panning ? " is-panning" : ""}`}
        onPointerDown={handleBackgroundPointerDown}
        onContextMenu={(event) => event.preventDefault()}
      >
        <div className="canvas-grid" style={gridStyle} aria-hidden="true" />
        <div className="canvas-grain" aria-hidden="true" />

        <div
          ref={layerRef}
          className="diagram-layer"
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.zoom})`,
          }}
        >
          <svg className="edge-layer" width="1" height="1" aria-hidden="true">
            {doc.paths.map((path) => (
              <EdgePath key={path.key} path={path} />
            ))}
          </svg>

          {doc.nodes.map((node) => (
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
            />
          ))}

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
                onPointerDown={(event) => startFrameMove(event, selectedFrame)}
                onPointerMove={moveFrameMove}
                onPointerUp={endFrameMove}
                onPointerCancel={endFrameMove}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
              >
                {selectedFrame.isBackground ? "背景板" : "矩形底板"}
              </span>
              {(["top", "right", "bottom", "left"] as const).map((edge) => (
                <span
                  key={edge}
                  className={`frame-move-edge edge-${edge}`}
                  title="拖拽移动底板"
                  onPointerDown={(event) => startFrameMove(event, selectedFrame)}
                  onPointerMove={moveFrameMove}
                  onPointerUp={endFrameMove}
                  onPointerCancel={endFrameMove}
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

          {selectedCount > 1 && groupBounds ? (
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
        </div>

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

        {empty ? (
          <div className="canvas-empty" data-canvas-ui="true">
            <div className="empty-mark" aria-hidden="true">
              <Crosshair size={22} />
            </div>
            <h3>{doc.hasPicture ? "这张图还没有元素" : "还没有 TikZ 图形"}</h3>
            <p>
              {doc.hasPicture
                ? "在源码里添加 \\node、\\draw 或 \\path，右侧会立即出现图形。"
                : "在左侧粘贴包含 \\begin{tikzpicture} … \\end{tikzpicture} 的源码，画布会自动渲染。"}
            </p>
            <button type="button" className="button button-ink button-small" onClick={onLoadExample}>
              载入示例
            </button>
          </div>
        ) : null}

        <div className="canvas-hint" data-canvas-ui="true">
          <span>拖拽移动 / 双击改字</span>
          <i />
          <span>左键框选</span>
          <i />
          <span>Shift 多选</span>
          <i />
          <span>右键平移</span>
          <i />
          <span>方向键微调</span>
          <i />
          <span>滚轮缩放</span>
        </div>

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
          <aside className="selection-panel" data-canvas-ui="true">
            <div className="selection-top">
              <span className="selection-eyebrow">{selectionInfo.eyebrow}</span>
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
            <strong>{selectionInfo.title}</strong>
            <div className="selection-meta">
              {selectionInfo.meta.map((item) => (
                <span key={item}>{item}</span>
              ))}
            </div>
            {selectionInfo.editable ? (
              <button
                type="button"
                className="selection-edit"
                onClick={() => openEditor(selectionInfo.editable!)}
              >
                编辑文字
              </button>
            ) : selectionInfo.multi ? (
              <p className="selection-resize-hint selection-multi-hint">
                <Scaling size={12} />
                <span>
                  拖动任一组件移动全部，四角调整整体大小
                  <br />
                  方向键微调 1px，Shift + 方向键 10px
                </span>
              </p>
            ) : selectionInfo.resizeHint ? (
              <p className="selection-resize-hint">
                <Scaling size={12} />
                拖拽边框移动，四角调整大小
              </p>
            ) : null}
          </aside>
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
              {draftError ?? "直接编辑 TikZ 文本，支持 $公式$、\\textbf{} 与 \\\\ 换行。"}
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
          </aside>
        ) : null}
      </div>
    </section>
  );
}
