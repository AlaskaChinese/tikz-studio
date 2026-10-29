import type { Bounds, TikzDocument } from "./types";

export interface AlignmentTargets {
  vertical: number[];
  horizontal: number[];
}

export interface AlignmentGuides {
  vertical: number[];
  horizontal: number[];
}

export interface AlignmentSnap {
  dx: number;
  dy: number;
  snappedX: boolean;
  snappedY: boolean;
  guides: AlignmentGuides;
}

export interface SnapPoint {
  x: number;
  y: number;
}

const GUIDE_EPSILON = 0.02;

export const EMPTY_GUIDES: AlignmentGuides = { vertical: [], horizontal: [] };

export function shiftedBounds(bounds: Bounds, dx: number, dy: number): Bounds {
  return {
    minX: bounds.minX + dx,
    minY: bounds.minY + dy,
    maxX: bounds.maxX + dx,
    maxY: bounds.maxY + dy,
  };
}

export function collectAlignmentTargets(
  doc: TikzDocument,
  excludedKeys: Set<string>,
): AlignmentTargets {
  const vertical = new Map<number, number>();
  const horizontal = new Map<number, number>();
  const add = (value: number, map: Map<number, number>) => {
    const key = Math.round(value * 1000);
    if (!map.has(key)) map.set(key, value);
  };
  const addBounds = (bounds: Bounds) => {
    add(bounds.minX, vertical);
    add((bounds.minX + bounds.maxX) / 2, vertical);
    add(bounds.maxX, vertical);
    add(bounds.minY, horizontal);
    add((bounds.minY + bounds.maxY) / 2, horizontal);
    add(bounds.maxY, horizontal);
  };
  for (const node of doc.nodes) {
    if (!excludedKeys.has(node.key)) addBounds(node.bounds);
  }
  for (const label of doc.labels) {
    if (!excludedKeys.has(label.key)) addBounds(label.bounds);
  }
  for (const frame of doc.frames) {
    if (excludedKeys.has(frame.key)) continue;
    addBounds({
      minX: frame.minX,
      minY: frame.minY,
      maxX: frame.maxX,
      maxY: frame.maxY,
    });
  }
  return {
    vertical: Array.from(vertical.values()),
    horizontal: Array.from(horizontal.values()),
  };
}

function closestLine(moving: number[], targets: number[], threshold: number) {
  let delta = 0;
  let distance = threshold;
  let found = false;
  for (const value of moving) {
    for (const target of targets) {
      const next = target - value;
      const nextDistance = Math.abs(next);
      if (nextDistance <= distance + 1e-9 && (!found || nextDistance < distance - 1e-9)) {
        delta = next;
        distance = nextDistance;
        found = true;
      }
    }
  }
  return found ? delta : null;
}

function matchingLines(moving: number[], delta: number, targets: number[]): number[] {
  const shifted = moving.map((value) => value + delta);
  const matches = new Map<number, number>();
  for (const target of targets) {
    if (!shifted.some((value) => Math.abs(value - target) <= GUIDE_EPSILON)) continue;
    const key = Math.round(target * 1000);
    if (!matches.has(key)) matches.set(key, target);
  }
  return Array.from(matches.values()).sort((a, b) => a - b).slice(0, 3);
}

export function findAlignmentSnap(
  bounds: Bounds,
  targets: AlignmentTargets,
  threshold: number,
): AlignmentSnap {
  return findFeatureAlignmentSnap(bounds, [], targets, threshold);
}

export function findFeatureAlignmentSnap(
  bounds: Bounds,
  points: SnapPoint[],
  targets: AlignmentTargets,
  threshold: number,
): AlignmentSnap {
  const xFeatures = [
    bounds.minX,
    (bounds.minX + bounds.maxX) / 2,
    bounds.maxX,
    ...points.map((point) => point.x),
  ];
  const yFeatures = [
    bounds.minY,
    (bounds.minY + bounds.maxY) / 2,
    bounds.maxY,
    ...points.map((point) => point.y),
  ];
  const deltaX = closestLine(xFeatures, targets.vertical, threshold);
  const deltaY = closestLine(yFeatures, targets.horizontal, threshold);
  return {
    dx: deltaX ?? 0,
    dy: deltaY ?? 0,
    snappedX: deltaX !== null,
    snappedY: deltaY !== null,
    guides: {
      vertical:
        deltaX === null
          ? []
          : matchingLines(xFeatures, deltaX, targets.vertical),
      horizontal:
        deltaY === null
          ? []
          : matchingLines(yFeatures, deltaY, targets.horizontal),
    },
  };
}
