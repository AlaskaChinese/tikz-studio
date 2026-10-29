import type { Span } from "./types";

interface ScreenRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface GlyphBox {
  code: number;
  char: string;
  rect: ScreenRect;
}

interface TextGroup {
  signature: string;
  rect: ScreenRect;
  target: SourceTarget | null;
}

interface CellRef {
  row: number;
  col: number;
}

interface SourceTarget {
  span: Span;
  signature: string;
  envIndex: number;
  kind: "node" | "label" | "arrow" | "token";
}

interface TikzCdArrow {
  span: Span;
  from: CellRef;
  to: CellRef | null;
  labels: { span: Span; signature: string }[];
}

interface TikzCdCell {
  row: number;
  col: number;
  nodeSpan: Span | null;
  nodeSignature: string;
}

interface TikzCdEnv {
  begin: Span;
  cells: TikzCdCell[];
  arrows: TikzCdArrow[];
}

function normalizeText(raw: string): string {
  return raw
    .replace(/%[^\n]*/g, " ")
    .replace(/\\[A-Za-z@]+\*?/g, " ")
    .replace(/[^A-Za-z0-9]+/g, "")
    .toLowerCase();
}

function trimSpan(source: string, start: number, end: number): Span | null {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(source[from])) from += 1;
  while (to > from && /\s/.test(source[to - 1])) to -= 1;
  return to > from ? { start: from, end: to } : null;
}

function rectUnion(rects: ScreenRect[]): ScreenRect {
  return {
    left: Math.min(...rects.map((rect) => rect.left)),
    top: Math.min(...rects.map((rect) => rect.top)),
    right: Math.max(...rects.map((rect) => rect.right)),
    bottom: Math.max(...rects.map((rect) => rect.bottom)),
  };
}

function rectContains(rect: ScreenRect, x: number, y: number, padding: number): boolean {
  return (
    x >= rect.left - padding &&
    x <= rect.right + padding &&
    y >= rect.top - padding &&
    y <= rect.bottom + padding
  );
}

function rectCenter(rect: ScreenRect): { x: number; y: number } {
  return { x: (rect.left + rect.right) / 2, y: (rect.top + rect.bottom) / 2 };
}

function rectDistance(rect: ScreenRect, x: number, y: number): number {
  const dx = Math.max(rect.left - x, 0, x - rect.right);
  const dy = Math.max(rect.top - y, 0, y - rect.bottom);
  return Math.hypot(dx, dy);
}

function prepareGlyphs(parent: Element): GlyphBox[] {
  const glyphs: GlyphBox[] = [];
  for (const use of Array.from(parent.children)) {
    if (use.tagName.toLowerCase() !== "use") continue;
    const href =
      use.getAttribute("xlink:href") ?? use.getAttribute("href") ?? "";
    const match = /#g\d+-(\d+)$/.exec(href);
    if (!match) continue;
    const code = Number(match[1]);
    const rect = use.getBoundingClientRect();
    if (rect.width <= 0 && rect.height <= 0) continue;
    glyphs.push({
      code,
      char: code >= 32 && code <= 126 ? String.fromCodePoint(code) : "",
      rect,
    });
  }
  const letters = glyphs.filter((glyph) => /[A-Za-z]/.test(glyph.char));
  if (!letters.length) return glyphs;
  const tallest = letters.reduce((a, b) =>
    b.rect.bottom - b.rect.top > a.rect.bottom - a.rect.top ? b : a,
  );
  const tallestHeight = tallest.rect.bottom - tallest.rect.top;
  return glyphs.filter((glyph) => {
    if (glyph.code !== 48) return true;
    const height = glyph.rect.bottom - glyph.rect.top;
    const raised =
      glyph.rect.bottom < tallest.rect.bottom - tallestHeight * 0.18;
    return !(height < tallestHeight * 0.78 && raised);
  });
}

function clusterGlyphs(glyphs: GlyphBox[]): GlyphBox[][] {
  const sorted = [...glyphs].sort((a, b) => a.rect.left - b.rect.left);
  const clusters: GlyphBox[][] = [];
  for (const glyph of sorted) {
    const last = clusters[clusters.length - 1];
    if (!last) {
      clusters.push([glyph]);
      continue;
    }
    const previous = last[last.length - 1];
    const gap = glyph.rect.left - previous.rect.right;
    const maxHeight = Math.max(
      previous.rect.bottom - previous.rect.top,
      glyph.rect.bottom - glyph.rect.top,
    );
    const verticalGap = Math.max(
      glyph.rect.top - previous.rect.bottom,
      previous.rect.top - glyph.rect.bottom,
      0,
    );
    if (gap < maxHeight * 0.95 && verticalGap < maxHeight * 0.4) {
      last.push(glyph);
    } else {
      clusters.push([glyph]);
    }
  }
  return clusters;
}

function collectTextGroups(svg: SVGSVGElement): TextGroup[] {
  const parents = new Set<Element>();
  for (const use of Array.from(svg.querySelectorAll("use"))) {
    if (use.parentElement) parents.add(use.parentElement);
  }
  const groups: TextGroup[] = [];
  for (const parent of parents) {
    const glyphs = prepareGlyphs(parent);
    if (!glyphs.length) continue;
    for (const cluster of clusterGlyphs(glyphs)) {
      const signature = cluster
        .map((glyph) => glyph.char)
        .join("")
        .replace(/[^A-Za-z0-9]+/g, "")
        .toLowerCase();
      if (!signature) continue;
      groups.push({
        signature,
        rect: rectUnion(cluster.map((glyph) => glyph.rect)),
        target: null,
      });
    }
  }
  return groups;
}

function skipComment(source: string, index: number, end: number): number {
  if (source[index] !== "%") return index;
  const newline = source.indexOf("\n", index);
  return newline < 0 || newline >= end ? end : newline;
}

function findClosingBracket(
  source: string,
  start: number,
  end: number,
): number {
  let depth = 1;
  let inQuote = false;
  for (let index = start; index < end; index += 1) {
    const char = source[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (inQuote) {
      if (char === "\"") inQuote = false;
      continue;
    }
    if (char === "\"") {
      inQuote = true;
      continue;
    }
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function scanCells(source: string, start: number, end: number): { row: number; col: number; start: number; end: number }[] {
  const cells: { row: number; col: number; start: number; end: number }[] = [];
  let row = 0;
  let col = 0;
  let cellStart = start;
  let braces = 0;
  let brackets = 0;
  let inQuote = false;
  let index = start;
  while (index < end) {
    if (!inQuote && braces === 0 && brackets === 0) {
      const skipped = skipComment(source, index, end);
      if (skipped !== index) {
        index = skipped;
        continue;
      }
    }
    const char = source[index];
    if (inQuote) {
      if (char === "\\") index += 1;
      else if (char === "\"") inQuote = false;
      index += 1;
      continue;
    }
    if (char === "\"") {
      inQuote = true;
      index += 1;
      continue;
    }
    if (char === "{") {
      braces += 1;
      index += 1;
      continue;
    }
    if (char === "}") {
      braces = Math.max(0, braces - 1);
      index += 1;
      continue;
    }
    if (char === "[") {
      brackets += 1;
      index += 1;
      continue;
    }
    if (char === "]") {
      brackets = Math.max(0, brackets - 1);
      index += 1;
      continue;
    }
    if (braces === 0 && brackets === 0) {
      if (char === "&" && source[index - 1] !== "\\") {
        cells.push({ row, col, start: cellStart, end: index });
        col += 1;
        cellStart = index + 1;
        index += 1;
        continue;
      }
      if (char === "\\" && source[index + 1] === "\\") {
        cells.push({ row, col, start: cellStart, end: index });
        row += 1;
        col = 0;
        index += 2;
        while (index < end && /\s/.test(source[index])) index += 1;
        if (source[index] === "[") {
          const close = source.indexOf("]", index);
          index = close < 0 || close >= end ? index : close + 1;
        }
        cellStart = index;
        continue;
      }
    }
    index += 1;
  }
  cells.push({ row, col, start: cellStart, end });
  return cells;
}

function scanArrowCommands(
  source: string,
  start: number,
  end: number,
): { span: Span; options: Span | null }[] {
  const arrows: { span: Span; options: Span | null }[] = [];
  let braces = 0;
  let brackets = 0;
  let inQuote = false;
  let index = start;
  while (index < end) {
    if (!inQuote && braces === 0 && brackets === 0) {
      const skipped = skipComment(source, index, end);
      if (skipped !== index) {
        index = skipped;
        continue;
      }
    }
    const char = source[index];
    if (inQuote) {
      if (char === "\\") index += 1;
      else if (char === "\"") inQuote = false;
      index += 1;
      continue;
    }
    if (char === "\"") {
      inQuote = true;
      index += 1;
      continue;
    }
    if (char === "{") {
      braces += 1;
      index += 1;
      continue;
    }
    if (char === "}") {
      braces = Math.max(0, braces - 1);
      index += 1;
      continue;
    }
    if (char === "[") {
      brackets += 1;
      index += 1;
      continue;
    }
    if (char === "]") {
      brackets = Math.max(0, brackets - 1);
      index += 1;
      continue;
    }
    if (
      braces === 0 &&
      source.startsWith("\\arrow", index) &&
      !/[A-Za-z]/.test(source[index + 6] ?? "")
    ) {
      let cursor = index + "\\arrow".length;
      while (cursor < end && /\s/.test(source[cursor])) cursor += 1;
      let options: Span | null = null;
      if (source[cursor] === "[") {
        const close = findClosingBracket(source, cursor + 1, end);
        if (close >= 0) {
          options = { start: cursor + 1, end: close };
          cursor = close + 1;
        }
      }
      arrows.push({ span: { start: index, end: cursor }, options });
      index = cursor;
      continue;
    }
    index += 1;
  }
  return arrows;
}

function extractLabels(source: string, span: Span | null): { span: Span; signature: string }[] {
  if (!span) return [];
  const labels: { span: Span; signature: string }[] = [];
  let index = span.start;
  while (index < span.end) {
    if (source[index] !== "\"") {
      index += 1;
      continue;
    }
    let cursor = index + 1;
    while (cursor < span.end && source[cursor] !== "\"") {
      if (source[cursor] === "\\") cursor += 1;
      cursor += 1;
    }
    if (cursor >= span.end) break;
    const signature = normalizeText(source.slice(index + 1, cursor));
    if (signature) {
      labels.push({
        span: { start: index, end: cursor + 1 },
        signature,
      });
    }
    index = cursor + 1;
  }
  return labels;
}

function arrowDirection(
  source: string,
  span: Span | null,
): { right: number; left: number; up: number; down: number } | null {
  if (!span) return null;
  let braces = 0;
  let inQuote = false;
  let tokenStart = span.start;
  for (let index = span.start; index <= span.end; index += 1) {
    const char = source[index];
    const boundary = index === span.end;
    if (!boundary && inQuote) {
      if (char === "\\") index += 1;
      else if (char === "\"") inQuote = false;
      continue;
    }
    if (!boundary && char === "\"") {
      inQuote = true;
      continue;
    }
    if (!boundary && char === "{") {
      braces += 1;
      continue;
    }
    if (!boundary && char === "}") {
      braces = Math.max(0, braces - 1);
      continue;
    }
    if (boundary || (char === "," && braces === 0)) {
      const token = source.slice(tokenStart, index).trim();
      if (/^[rldu]+$/.test(token)) {
        const counts = { right: 0, left: 0, up: 0, down: 0 };
        for (const step of token) {
          if (step === "r") counts.right += 1;
          else if (step === "l") counts.left += 1;
          else if (step === "u") counts.up += 1;
          else counts.down += 1;
        }
        return counts;
      }
      tokenStart = index + 1;
    }
  }
  return null;
}

function parseTikzCdEnvironments(source: string): TikzCdEnv[] {
  const envs: TikzCdEnv[] = [];
  const beginPattern = /\\begin\s*\{tikzcd\}/g;
  let match: RegExpExecArray | null;
  while ((match = beginPattern.exec(source))) {
    const endPattern = /\\end\s*\{tikzcd\}/g;
    endPattern.lastIndex = match.index + match[0].length;
    const end = endPattern.exec(source);
    if (!end) break;
    let bodyStart = match.index + match[0].length;
    const bodyEnd = end.index;
    beginPattern.lastIndex = end.index + end[0].length;
    let cursor = bodyStart;
    while (cursor < bodyEnd && /\s/.test(source[cursor])) cursor += 1;
    if (source[cursor] === "[") {
      const close = findClosingBracket(source, cursor + 1, bodyEnd);
      if (close >= 0) bodyStart = close + 1;
    }
    const cells: TikzCdCell[] = [];
    const arrows: TikzCdArrow[] = [];
    for (const cell of scanCells(source, bodyStart, bodyEnd)) {
      const commands = scanArrowCommands(source, cell.start, cell.end);
      const nodeEnd = commands.length ? commands[0].span.start : cell.end;
      const nodeSpan = trimSpan(source, cell.start, nodeEnd);
      cells.push({
        row: cell.row,
        col: cell.col,
        nodeSpan,
        nodeSignature: nodeSpan
          ? normalizeText(source.slice(nodeSpan.start, nodeSpan.end))
          : "",
      });
      for (const command of commands) {
        const direction = arrowDirection(source, command.options);
        arrows.push({
          span: command.span,
          from: { row: cell.row, col: cell.col },
          to: direction
            ? {
                row: cell.row + direction.down - direction.up,
                col: cell.col + direction.right - direction.left,
              }
            : null,
          labels: extractLabels(source, command.options),
        });
      }
    }
    envs.push({
      begin: {
        start: match.index,
        end: match.index + match[0].length,
      },
      cells,
      arrows,
    });
  }
  return envs;
}

function readingOrder(groups: TextGroup[]): TextGroup[] {
  return [...groups].sort(
    (a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left,
  );
}

function splitEnvironments(
  groups: TextGroup[],
  count: number,
): TextGroup[][] | null {
  if (count <= 1) return [groups];
  const attempt = (axis: "x" | "y"): TextGroup[][] | null => {
    const sorted = [...groups].sort((a, b) =>
      axis === "x" ? a.rect.left - b.rect.left : a.rect.top - b.rect.top,
    );
    let runningEnd = Number.NEGATIVE_INFINITY;
    const gaps: { index: number; gap: number }[] = [];
    sorted.forEach((group, index) => {
      const start = axis === "x" ? group.rect.left : group.rect.top;
      const end = axis === "x" ? group.rect.right : group.rect.bottom;
      if (index > 0) gaps.push({ index, gap: start - runningEnd });
      runningEnd = Math.max(runningEnd, end);
    });
    const separators = gaps
      .filter((entry) => entry.gap > 4)
      .sort((a, b) => b.gap - a.gap)
      .slice(0, count - 1)
      .map((entry) => entry.index);
    if (separators.length < count - 1) return null;
    const separatorSet = new Set(separators);
    const parts: TextGroup[][] = [];
    let current: TextGroup[] = [];
    sorted.forEach((group, index) => {
      if (separatorSet.has(index) && current.length) {
        parts.push(current);
        current = [];
      }
      current.push(group);
    });
    if (current.length) parts.push(current);
    if (parts.length !== count) return null;
    return parts.sort(
      (a, b) =>
        Math.min(...a.map((group) => group.rect.left)) -
        Math.min(...b.map((group) => group.rect.left)),
    );
  };
  return attempt("x") ?? attempt("y");
}

function assignTikzCdTargets(
  groups: TextGroup[],
  envs: TikzCdEnv[],
): TextGroup[][] | null {
  const parts = splitEnvironments(groups, envs.length);
  if (!parts) return null;
  for (let envIndex = 0; envIndex < envs.length; envIndex += 1) {
    const targets: SourceTarget[] = [];
    for (const cell of envs[envIndex].cells) {
      if (!cell.nodeSpan || !cell.nodeSignature) continue;
      targets.push({
        span: cell.nodeSpan,
        signature: cell.nodeSignature,
        envIndex,
        kind: "node",
      });
    }
    for (const arrow of envs[envIndex].arrows) {
      for (const label of arrow.labels) {
        targets.push({
          span: label.span,
          signature: label.signature,
          envIndex,
          kind: "label",
        });
      }
    }
    targets.sort((a, b) => a.span.start - b.span.start);
    const bySignature = new Map<string, SourceTarget[]>();
    for (const target of targets) {
      const list = bySignature.get(target.signature) ?? [];
      list.push(target);
      bySignature.set(target.signature, list);
    }
    const candidates = readingOrder(parts[envIndex]);
    const paired = new Map<string, number>();
    let matched = 0;
    let eligible = 0;
    for (const group of candidates) {
      const list = bySignature.get(group.signature);
      if (!list) continue;
      eligible += 1;
      const index = paired.get(group.signature) ?? 0;
      paired.set(group.signature, index + 1);
      if (index < list.length) {
        group.target = list[index];
        matched += 1;
      }
    }
    if (eligible > 0 && matched / eligible < 0.6) return null;
  }
  return parts;
}

function collectShafts(
  svg: SVGSVGElement,
  envs: TikzCdEnv[],
): { path: SVGPathElement; span: Span; envIndex: number }[] | null {
  const totalArrows = envs.reduce((sum, env) => sum + env.arrows.length, 0);
  if (totalArrows === 0) return null;
  const shafts: SVGPathElement[] = [];
  for (const path of Array.from(svg.querySelectorAll("path"))) {
    const stroke = (path.getAttribute("stroke") ?? "").toLowerCase();
    const fill = (path.getAttribute("fill") ?? "").toLowerCase();
    if (stroke !== "#000" && stroke !== "black") continue;
    if (fill !== "none") continue;
    let length = 0;
    try {
      length = path.getTotalLength();
    } catch {
      continue;
    }
    if (length <= 12) continue;
    shafts.push(path);
  }
  if (shafts.length !== totalArrows) return null;
  const mapped: { path: SVGPathElement; span: Span; envIndex: number }[] = [];
  let cursor = 0;
  envs.forEach((env, envIndex) => {
    for (const arrow of env.arrows) {
      mapped.push({ path: shafts[cursor], span: arrow.span, envIndex });
      cursor += 1;
    }
  });
  return mapped;
}

function distanceToPath(
  path: SVGPathElement,
  fallbackMatrix: DOMMatrix,
  x: number,
  y: number,
): number {
  const matrix = path.getScreenCTM() ?? fallbackMatrix;
  let length = 0;
  try {
    length = path.getTotalLength();
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(length) || length <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  const steps = Math.max(12, Math.min(90, Math.ceil(length / 3)));
  let best = Number.POSITIVE_INFINITY;
  for (let step = 0; step <= steps; step += 1) {
    const point = path.getPointAtLength((length * step) / steps);
    const screen = point.matrixTransform(matrix);
    const distance = Math.hypot(screen.x - x, screen.y - y);
    if (distance < best) best = distance;
  }
  return best;
}

function collectGenericTargets(source: string): SourceTarget[] {
  const targets: SourceTarget[] = [];
  const patterns = [/\$([^$\n]+)\$/g, /"([^"\n]*)"/g];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const signature = normalizeText(match[1] ?? "");
      if (!signature || match.index == null) continue;
      targets.push({
        span: { start: match.index, end: match.index + match[0].length },
        signature,
        envIndex: 0,
        kind: "token",
      });
    }
  }
  return targets;
}

function hitTestGroup(
  groups: TextGroup[],
  x: number,
  y: number,
  padding: number,
): TextGroup | null {
  let best: TextGroup | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const group of groups) {
    if (!group.target) continue;
    if (!rectContains(group.rect, x, y, padding)) continue;
    const center = rectCenter(group.rect);
    const distance = Math.hypot(center.x - x, center.y - y);
    if (distance < bestDistance) {
      best = group;
      bestDistance = distance;
    }
  }
  return best;
}

export function previewClickSpan(
  preview: HTMLElement,
  clientX: number,
  clientY: number,
  source: string,
  pointerType = "mouse",
): Span | null {
  const svg = preview.querySelector("svg");
  if (!svg) return null;
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  const groups = collectTextGroups(svg);
  const padding = pointerType === "touch" ? 10 : 5;
  const envs = parseTikzCdEnvironments(source);

  if (envs.length > 0) {
    const parts = assignTikzCdTargets(groups, envs);
    const direct = hitTestGroup(groups, clientX, clientY, padding);
    if (direct?.target) return direct.target.span;

    const shafts = collectShafts(svg, envs);
    if (shafts) {
      let best: { span: Span; envIndex: number; distance: number } | null = null;
      for (const shaft of shafts) {
        const distance = distanceToPath(shaft.path, matrix, clientX, clientY);
        if (!best || distance < best.distance) {
          best = { span: shaft.span, envIndex: shaft.envIndex, distance };
        }
      }
      const tolerance = pointerType === "touch" ? 22 : 14;
      if (best && best.distance <= tolerance) return best.span;
    }

    if (parts) {
      let bestIndex = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      parts.forEach((part, index) => {
        const rect = rectUnion(part.map((group) => group.rect));
        const distance = rectDistance(rect, clientX, clientY);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });
      return envs[Math.min(bestIndex, envs.length - 1)].begin;
    }
    return null;
  }

  const targets = collectGenericTargets(source);
  const targetCount = new Map<string, number>();
  for (const target of targets) {
    targetCount.set(target.signature, (targetCount.get(target.signature) ?? 0) + 1);
  }
  const groupCount = new Map<string, TextGroup[]>();
  for (const group of groups) {
    const list = groupCount.get(group.signature) ?? [];
    list.push(group);
    groupCount.set(group.signature, list);
  }
  for (const target of targets) {
    if (targetCount.get(target.signature) !== 1) continue;
    const candidates = groupCount.get(target.signature);
    if (!candidates || candidates.length !== 1) continue;
    candidates[0].target = target;
  }
  const direct = hitTestGroup(groups, clientX, clientY, padding);
  return direct?.target?.span ?? null;
}
