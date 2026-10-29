import { maskComments } from "./options";
import type { TikzDocument } from "./types";

const ENGINE_SCRIPT = "tikzjax/tikzjax-engine.js";
const ENGINE_FONTS = "tikzjax/fonts.css";
const PT_TO_CM = 2.54 / 72;
const ENGINE_SCALE = 1.8;
const BOOT_TIMEOUT = 90000;
const COMPILE_TIMEOUT = 45000;
const ERROR_GRACE = 350;
const CACHE_LIMIT = 24;

export interface EnginePayload {
  tex: string;
  pictures: number;
}

export interface EngineResult {
  svg: string;
  widthCm: number;
  heightCm: number;
  widthPt: number;
  heightPt: number;
  log: string;
}

export type EngineErrorKind = "no-picture" | "engine-load" | "compile" | "timeout" | "empty";

export class EngineError extends Error {
  kind: EngineErrorKind;
  detail: string | null;

  constructor(kind: EngineErrorKind, message: string, detail: string | null = null) {
    super(message);
    this.name = "EngineError";
    this.kind = kind;
    this.detail = detail;
  }
}

interface PictureBlock {
  start: number;
  end: number;
}

const PREAMBLE_COMMANDS = new Set([
  "usetikzlibrary",
  "usepgfplotslibrary",
  "pgfplotsset",
  "tikzset",
  "tikzstyle",
  "colorlet",
  "definecolor",
  "def",
  "edef",
  "gdef",
  "xdef",
  "newcommand",
  "renewcommand",
  "providecommand",
  "newenvironment",
  "renewenvironment",
  "pgfmathsetmacro",
  "pgfmathdeclarefunction",
  "pgfdeclarelayer",
  "pgfsetlayers",
]);

const MACRO_COMMANDS = new Set([
  "def",
  "edef",
  "gdef",
  "xdef",
  "newcommand",
  "renewcommand",
  "providecommand",
  "newenvironment",
  "renewenvironment",
]);

const ISSUE_REASONS: Record<string, string> = {
  foreach: "包含 \\foreach 循环",
  scope: "包含 scope 局部变换",
  arc: "包含圆弧路径",
  "multiple-pictures": "包含多个 tikzpicture",
  "command-matrix": "包含 \\matrix 矩阵",
  "command-pic": "包含 \\pic 图形",
  "command-clip": "包含裁剪区域",
  "command-useasboundingbox": "包含自定义边界",
  "plot-coordinates": "包含 plot 坐标组",
  "plot-expression": "包含复杂 plot 表达式",
  "plot-empty": "包含无法采样的 plot",
};

const SOURCE_CONSTRUCTS: Array<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /\\(?:def|edef|gdef|xdef|newcommand|renewcommand|providecommand|newenvironment)\b/,
    reason: "包含 TeX 宏定义",
  },
  { pattern: /\\pgfmath(?:setmacro|parse|declarefunction)?\b/, reason: "包含 PGF 数学计算" },
  { pattern: /\\pgfextra\b|\\let\b/, reason: "包含 TeX 编程命令" },
  { pattern: /\\(?:shade|shadedraw|pattern)\b/, reason: "包含阴影或图案填充" },
  { pattern: /\bdecorate\b|decoration\s*=/, reason: "包含路径装饰" },
  { pattern: /\beven odd rule\b/, reason: "包含奇偶填充规则" },
  { pattern: /\(\s*\$[^;]{0,240}\$\s*\)/, reason: "包含 calc 坐标表达式" },
  { pattern: /\\tikz(?![A-Za-z])/, reason: "包含内联 \\tikz 命令" },
];

export function detectEngineReasons(source: string, doc: TikzDocument): string[] {
  const reasons = new Set<string>();
  for (const issue of doc.issues) {
    if (issue.id.startsWith("tikzcd-")) continue;
    const reason = ISSUE_REASONS[issue.id];
    if (reason) {
      reasons.add(reason);
      continue;
    }
    if (issue.id.startsWith("env-")) {
      reasons.add(`包含 ${issue.id.slice(4)} 环境`);
      continue;
    }
    if (issue.id.startsWith("unresolved-coordinate-") || issue.id.startsWith("unresolved-node-")) {
      reasons.add("包含计算或未解析的坐标引用");
    }
  }
  const masked = maskComments(source);
  for (const construct of SOURCE_CONSTRUCTS) {
    if (construct.pattern.test(masked)) reasons.add(construct.reason);
  }
  for (const match of masked.matchAll(/\\begin\s*\{tikzpicture\}\s*\[([\s\S]*?)\]/g)) {
    if (/\b(?:scale|xscale|yscale|rotate|shift|transform canvas)\s*=/.test(match[1])) {
      reasons.add("包含图形整体变换");
      break;
    }
  }
  return [...reasons];
}

export function unsupportedEnginePackage(source: string): string | null {
  const masked = maskComments(source);
  const usepackage = /\\usepackage(?:\[[^\]]*\])?\s*\{(circuitikz|pgfplots|chemfig)\}/.exec(masked);
  if (usepackage) return usepackage[1];
  if (/\\begin\s*\{circuitikz\}/.test(masked)) return "circuitikz";
  if (/\\begin\s*\{(?:axis|semilogxaxis|semilogyaxis|loglogaxis)\}/.test(masked)) return "pgfplots";
  if (/\\chemfig\b/.test(masked)) return "chemfig";
  return null;
}

function findPictures(source: string, masked: string): PictureBlock[] {
  const pattern = /\\(begin|end)\s*\{tikzpicture\}/g;
  const blocks: PictureBlock[] = [];
  let depth = 0;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked))) {
    if (match[1] === "begin") {
      if (depth === 0) start = match.index;
      depth += 1;
      continue;
    }
    if (depth === 0) continue;
    depth -= 1;
    if (depth === 0) blocks.push({ start, end: pattern.lastIndex });
  }
  if (depth > 0) blocks.push({ start, end: source.length });
  return blocks;
}

function insideBlocks(index: number, blocks: PictureBlock[]): boolean {
  return blocks.some((block) => index >= block.start && index < block.end);
}

function skipWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function consumeGroup(text: string, index: number, open: string, close: string): number {
  if (text[index] !== open) return -1;
  let depth = 0;
  let quote = false;
  for (let cursor = index; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === "\\") {
      cursor += 1;
      continue;
    }
    if (quote) {
      if (char === '"') quote = false;
      continue;
    }
    if (char === '"') {
      quote = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return -1;
}

function consumeGroups(text: string, index: number): number {
  let cursor = skipWhitespace(text, index);
  for (;;) {
    const char = text[cursor];
    if (char === "[") {
      const end = consumeGroup(text, cursor, "[", "]");
      if (end < 0) return cursor;
      cursor = skipWhitespace(text, end);
      continue;
    }
    if (char === "{") {
      const end = consumeGroup(text, cursor, "{", "}");
      if (end < 0) return cursor;
      cursor = skipWhitespace(text, end);
      continue;
    }
    return cursor;
  }
}

function skipCommandName(text: string, index: number): number {
  if (text[index] !== "\\") return index;
  let cursor = index + 1;
  while (cursor < text.length && /[A-Za-z@]/.test(text[cursor])) cursor += 1;
  return cursor;
}

function consumePreambleCommand(text: string, name: string, end: number): number {
  if (name === "def" || name === "edef" || name === "gdef" || name === "xdef") {
    let cursor = skipWhitespace(text, end);
    cursor = skipCommandName(text, cursor);
    const brace = text.indexOf("{", cursor);
    if (brace < 0 || brace - cursor > 240) return end;
    const close = consumeGroup(text, brace, "{", "}");
    return close < 0 ? end : close;
  }
  let cursor = skipWhitespace(text, end);
  if (MACRO_COMMANDS.has(name) && text[cursor] === "\\") {
    cursor = skipWhitespace(text, skipCommandName(text, cursor));
  }
  const groups = consumeGroups(text, cursor);
  return groups > cursor ? groups : end;
}

function collectPreamble(source: string, masked: string, blocks: PictureBlock[]): string[] {
  const pattern = /\\([A-Za-z@]+)\*?/g;
  const collected: { start: number; text: string }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked))) {
    const name = match[1];
    if (!PREAMBLE_COMMANDS.has(name)) continue;
    if (insideBlocks(match.index, blocks)) continue;
    if (collected.some((entry) => match!.index >= entry.start && match!.index < entry.start + entry.text.length)) {
      continue;
    }
    const end = consumePreambleCommand(source, name, match.index + match[0].length);
    if (end <= match.index) continue;
    collected.push({ start: match.index, text: source.slice(match.index, end) });
    pattern.lastIndex = end;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of collected.sort((a, b) => a.start - b.start)) {
    const text = entry.text.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

export function buildEnginePayload(source: string): EnginePayload | null {
  const masked = maskComments(source);
  const pictures = findPictures(source, masked);
  if (!pictures.length) return null;
  const preamble = collectPreamble(source, masked, pictures);
  const parts = [...preamble];
  for (const block of pictures) parts.push(source.slice(block.start, block.end));
  return { tex: parts.join("\n"), pictures: pictures.length };
}

type EngineWindow = Window & typeof globalThis;

interface FrameContext {
  iframe: HTMLIFrameElement;
  win: EngineWindow;
  run: (event: Event) => unknown;
  logs: string[];
  errors: string[];
  queue: Promise<void>;
}

let framePromise: Promise<FrameContext> | null = null;
let fontLink: Promise<void> | null = null;
const cache = new Map<string, EngineResult>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function ensureEngineFonts(): Promise<void> {
  if (fontLink) return fontLink;
  if (typeof document === "undefined") return Promise.resolve();
  fontLink = new Promise((resolve) => {
    if (document.querySelector("link[data-tikzjax-fonts]")) {
      resolve();
      return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = ENGINE_FONTS;
    link.dataset.tikzjaxFonts = "true";
    const timer = window.setTimeout(resolve, 2500);
    const done = () => {
      window.clearTimeout(timer);
      resolve();
    };
    link.addEventListener("load", done, { once: true });
    link.addEventListener("error", done, { once: true });
    document.head.appendChild(link);
  });
  return fontLink;
}

function patchConsole(win: EngineWindow, logs: string[], errors: string[]): void {
  const consoleObject = win.console;
  for (const method of ["log", "warn", "error"] as const) {
    const original = consoleObject[method].bind(consoleObject);
    consoleObject[method] = (...args: unknown[]) => {
      const line = args.map((arg) => String(arg)).join(" ");
      if (method === "error") errors.push(line);
      logs.push(line);
      original(...args);
    };
  }
  // TeX aborts via a wasm trap; record it for diagnosis but keep it inside the iframe
  // so a failed compile does not surface as an uncaught page error.
  win.addEventListener("error", (event) => {
    errors.push(String(event.message || event.error || "script error"));
    event.preventDefault();
  });
  win.addEventListener("unhandledrejection", (event) => {
    errors.push(String(event.reason ?? "unhandled rejection"));
    event.preventDefault();
  });
}

async function createFrame(): Promise<FrameContext> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.tabIndex = -1;
  iframe.title = "TikZ 编译引擎";
  iframe.style.cssText =
    "position:fixed;left:-10000px;top:0;width:640px;height:640px;visibility:hidden;border:0";
  iframe.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><script src="${ENGINE_SCRIPT}"><\/script><script>window.__tikzjaxBundled=true;<\/script></head><body></body></html>`;
  document.body.appendChild(iframe);
  const logs: string[] = [];
  const errors: string[] = [];
  const started = Date.now();
  for (;;) {
    if (!iframe.isConnected) throw new EngineError("engine-load", "TeX 引擎被移除，请重试。");
    const win = iframe.contentWindow as EngineWindow | null;
    if (win && (win as EngineWindow & { __tikzjaxBundled?: boolean }).__tikzjaxBundled) {
      const handler = win.onload;
      if (typeof handler === "function") {
        win.onload = null;
        patchConsole(win, logs, errors);
        return { iframe, win, run: handler, logs, errors, queue: Promise.resolve() };
      }
      if (win.document.readyState === "complete") {
        iframe.remove();
        throw new EngineError("engine-load", "TeX 引擎脚本加载失败，请检查网络后重试。");
      }
    }
    if (Date.now() - started > BOOT_TIMEOUT) {
      iframe.remove();
      throw new EngineError("engine-load", "TeX 引擎资源加载失败或超时，请检查网络后重试。");
    }
    await sleep(120);
  }
}

function getFrame(): Promise<FrameContext> {
  if (!framePromise) {
    framePromise = createFrame().catch((error) => {
      framePromise = null;
      throw error;
    });
  }
  return framePromise;
}

function isTexError(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("! ") || trimmed === "! " || trimmed.includes("No pages of output.");
}

function describeTexError(line: string): string {
  const trimmed = line.replace(/^!\s*/, "").trim();
  return trimmed || "TeX 编译失败";
}

function readDimension(root: Element, name: "width" | "height"): number {
  const raw = root.getAttribute(name) ?? "";
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function sanitizeEngineSvg(raw: string): { svg: string; widthPt: number; heightPt: number } {
  const parsed = new DOMParser().parseFromString(raw, "image/svg+xml");
  const root = parsed.documentElement;
  if (!root || root.localName !== "svg" || parsed.querySelector("parsererror")) {
    throw new EngineError("empty", "TeX 输出不是有效的 SVG。");
  }
  const widthPt = readDimension(root, "width");
  const heightPt = readDimension(root, "height");
  root.querySelectorAll("script, foreignObject, iframe, object, embed, audio, video, canvas").forEach((node) => {
    node.remove();
  });
  for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if ((name === "href" || name === "xlink:href") && !/^(#|data:image\/)/i.test(value)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (/javascript:/i.test(value)) element.removeAttribute(attribute.name);
    }
  }
  root.removeAttribute("style");
  root.setAttribute("width", "100%");
  root.setAttribute("height", "100%");
  root.setAttribute("preserveAspectRatio", "xMidYMid meet");
  root.setAttribute("aria-hidden", "true");
  root.setAttribute("focusable", "false");
  return { svg: root.outerHTML, widthPt, heightPt };
}

async function runCompile(frame: FrameContext, tex: string): Promise<EngineResult> {
  const doc = frame.iframe.contentDocument;
  const win = frame.iframe.contentWindow;
  if (!doc || !win) throw new EngineError("engine-load", "TeX 引擎已断开，请重试。");
  frame.logs.length = 0;
  frame.errors.length = 0;
  const marker = doc.createComment("tikz-engine-job");
  doc.body.appendChild(marker);
  const script = doc.createElement("script");
  script.setAttribute("type", "text/tikz");
  script.textContent = tex;
  doc.body.appendChild(script);
  const started = performance.now();
  try {
    if (!frame.iframe.isConnected) {
      throw new EngineError("engine-load", "TeX 引擎已断开，请重试。");
    }
    frame.run.call(win, new Event("load"));
    let done = false;
    let failure: string | null = null;
    while (performance.now() - started < COMPILE_TIMEOUT) {
      await sleep(80);
      if (!doc.body.contains(script)) {
        done = true;
        break;
      }
      const texError = frame.logs.find(isTexError);
      if (texError) {
        failure = texError;
        await sleep(ERROR_GRACE);
        done = !doc.body.contains(script);
        break;
      }
      const runtimeError = frame.errors.find((line) => /RuntimeError|Aborted/i.test(line));
      if (runtimeError) {
        failure = runtimeError;
        break;
      }
    }
    if (failure) {
      throw new EngineError(
        "compile",
        `TeX 编译失败：${describeTexError(failure)}`,
        frame.logs.slice(-6).join("\n"),
      );
    }
    if (!done) {
      throw new EngineError(
        "timeout",
        "TeX 编译超时，源码可能包含引擎未支持的宏包或循环。",
        frame.logs.slice(-6).join("\n"),
      );
    }
    const holder = marker.nextElementSibling;
    const svgElement =
      holder?.tagName?.toLowerCase() === "svg"
        ? holder
        : (holder?.querySelector?.("svg") ?? null);
    if (!svgElement) {
      throw new EngineError(
        "empty",
        "TeX 没有生成可显示的内容。",
        frame.logs.slice(-6).join("\n"),
      );
    }
    const cleaned = sanitizeEngineSvg(svgElement.outerHTML);
    if (!cleaned.widthPt || !cleaned.heightPt) {
      throw new EngineError("empty", "TeX 输出缺少尺寸信息。");
    }
    return {
      svg: cleaned.svg,
      widthPt: cleaned.widthPt,
      heightPt: cleaned.heightPt,
      widthCm: cleaned.widthPt * PT_TO_CM * ENGINE_SCALE,
      heightCm: cleaned.heightPt * PT_TO_CM * ENGINE_SCALE,
      log: frame.logs.slice(-8).join("\n"),
    };
  } finally {
    if (doc.body.contains(script)) script.remove();
    const output = marker.nextElementSibling;
    if (output && output.parentNode === doc.body) output.remove();
    marker.remove();
  }
}

function enqueue(frame: FrameContext, tex: string): Promise<EngineResult> {
  const run = frame.queue.then(
    () => runCompile(frame, tex),
    () => runCompile(frame, tex),
  );
  frame.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function compileTikz(source: string, fresh = false): Promise<EngineResult> {
  const payload = buildEnginePayload(source);
  if (!payload) {
    throw new EngineError("no-picture", "没有找到可编译的 tikzpicture。");
  }
  const cached = fresh ? undefined : cache.get(payload.tex);
  if (cached) return cached;
  void ensureEngineFonts();
  const frame = await getFrame();
  const result = await enqueue(frame, payload.tex);
  cache.set(payload.tex, result);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest != null) cache.delete(oldest);
  }
  return result;
}

export function engineHint(source: string): string | null {
  const pkg = unsupportedEnginePackage(source);
  if (!pkg) return null;
  return `内置 TeX 引擎不包含 ${pkg}，这段源码会保留原生渲染；如需完整排版，可改用对应的预编译示例。`;
}
