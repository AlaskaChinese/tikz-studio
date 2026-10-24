import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Braces,
  Check,
  ChevronDown,
  Copy,
  LayoutTemplate,
  Redo2,
  Scan,
  Undo2,
} from "lucide-react";
import { DiagramCanvas } from "@/src/components/DiagramCanvas";
import { SourceEditor } from "@/src/components/SourceEditor";
import {
  BLANK_TIKZ_SOURCE,
  DEFAULT_TIKZ_SOURCE,
  TIKZ_EXAMPLES,
} from "@/src/lib/tikz/examples";
import { parseTikz } from "@/src/lib/tikz/parser";

type ViewMode = "source" | "canvas";

interface HistoryState {
  past: string[];
  future: string[];
}

const HISTORY_LIMIT = 120;
const EDIT_GROUP_MS = 520;

function BrandMark() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M7.5 22.5 L14.8 10.8 L24.4 18.6"
        fill="none"
        stroke="#f2ecdf"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="7.5" cy="22.5" r="3.3" fill="#d85c3a" stroke="#191f1a" strokeWidth="1.2" />
      <circle cx="14.8" cy="10.8" r="2.5" fill="#f2ecdf" />
      <circle cx="24.4" cy="18.6" r="2.5" fill="none" stroke="#f2ecdf" strokeWidth="1.5" />
    </svg>
  );
}

export default function App() {
  const [source, setSource] = useState(DEFAULT_TIKZ_SOURCE);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [fitSignal, setFitSignal] = useState(0);
  const [resetSignal, setResetSignal] = useState(0);
  const [examplesOpen, setExamplesOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("canvas");

  const exampleWrapRef = useRef<HTMLDivElement>(null);
  const toastTimerRef = useRef<number | null>(null);
  const sourceRef = useRef(source);
  const historyRef = useRef<HistoryState>({ past: [], future: [] });
  const pendingBaseRef = useRef<string | null>(null);
  const historyTimerRef = useRef<number | null>(null);
  const [historyFlags, setHistoryFlags] = useState({ canUndo: false, canRedo: false });

  sourceRef.current = source;
  const doc = useMemo(() => parseTikz(source), [source]);
  const activeExampleId = useMemo(() => {
    const trimmed = source.trim();
    if (trimmed === BLANK_TIKZ_SOURCE.trim()) return "blank";
    return TIKZ_EXAMPLES.find((example) => example.code.trim() === trimmed)?.id ?? null;
  }, [source]);

  const primaryKey = selectedKeys.length > 0 ? selectedKeys[selectedKeys.length - 1] : null;
  const selectedSpan = useMemo(() => {
    if (!primaryKey) return null;
    const node = doc.nodes.find((item) => item.key === primaryKey);
    if (node) return node.commandSpan;
    const label = doc.labels.find((item) => item.key === primaryKey);
    if (label) return label.textSpan;
    const frame = doc.frames.find((item) => item.key === primaryKey);
    return frame?.commandSpan ?? null;
  }, [doc, primaryKey]);

  useEffect(() => {
    setSelectedKeys((current) => {
      const next = current.filter(
        (key) =>
          doc.nodes.some((node) => node.key === key) ||
          doc.labels.some((label) => label.key === key) ||
          doc.frames.some((frame) => frame.key === key),
      );
      return next.length === current.length ? current : next;
    });
  }, [doc]);

  const syncHistoryFlags = useCallback(() => {
    setHistoryFlags({
      canUndo: historyRef.current.past.length > 0 || pendingBaseRef.current != null,
      canRedo: historyRef.current.future.length > 0,
    });
  }, []);

  const commitPending = useCallback(() => {
    if (historyTimerRef.current != null) {
      window.clearTimeout(historyTimerRef.current);
      historyTimerRef.current = null;
    }
    const base = pendingBaseRef.current;
    pendingBaseRef.current = null;
    if (base == null || base === sourceRef.current) return;
    const history = historyRef.current;
    history.past.push(base);
    if (history.past.length > HISTORY_LIMIT) history.past.shift();
    history.future = [];
    syncHistoryFlags();
  }, [syncHistoryFlags]);

  const applySource = useCallback(
    (next: string) => {
      if (next === sourceRef.current) return;
      if (pendingBaseRef.current == null) pendingBaseRef.current = sourceRef.current;
      historyRef.current.future = [];
      sourceRef.current = next;
      setSource(next);
      syncHistoryFlags();
      if (historyTimerRef.current != null) window.clearTimeout(historyTimerRef.current);
      historyTimerRef.current = window.setTimeout(() => {
        historyTimerRef.current = null;
        commitPending();
      }, EDIT_GROUP_MS);
    },
    [commitPending, syncHistoryFlags],
  );

  const undo = useCallback(() => {
    commitPending();
    const history = historyRef.current;
    const previous = history.past.pop();
    if (previous == null) return;
    history.future.push(sourceRef.current);
    sourceRef.current = previous;
    setSource(previous);
    syncHistoryFlags();
  }, [commitPending, syncHistoryFlags]);

  const redo = useCallback(() => {
    commitPending();
    const history = historyRef.current;
    const next = history.future.pop();
    if (next == null) return;
    history.past.push(sourceRef.current);
    sourceRef.current = next;
    setSource(next);
    syncHistoryFlags();
  }, [commitPending, syncHistoryFlags]);

  useEffect(() => {
    return () => {
      if (historyTimerRef.current != null) window.clearTimeout(historyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const isUndo = key === "z" && !event.shiftKey;
      const isRedo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
      if (!isUndo && !isRedo) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        if (target.closest("input, textarea, select")) return;
        if (!target.closest(".cm-editor")) {
          if (target.isContentEditable) return;
        }
      }
      event.preventDefault();
      event.stopPropagation();
      if (isUndo) undo();
      else redo();
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [redo, undo]);

  useEffect(() => {
    if (!examplesOpen) return;
    const handlePointer = (event: PointerEvent) => {
      if (!exampleWrapRef.current?.contains(event.target as Node)) setExamplesOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExamplesOpen(false);
    };
    document.addEventListener("pointerdown", handlePointer);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("pointerdown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [examplesOpen]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const showToast = useCallback((message: string) => {
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
    setToast(message);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2400);
  }, []);

  const loadSource = useCallback(
    (next: string) => {
      commitPending();
      applySource(next);
      commitPending();
      setSelectedKeys([]);
      setFitSignal((value) => value + 1);
      setResetSignal((value) => value + 1);
      setExamplesOpen(false);
      setViewMode("canvas");
    },
    [applySource, commitPending],
  );

  const copySource = useCallback(async () => {
    let success = true;
    try {
      await navigator.clipboard.writeText(source);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = source;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      textarea.style.pointerEvents = "none";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      try {
        success = document.execCommand("copy");
      } catch {
        success = false;
      } finally {
        textarea.remove();
      }
    }
    if (!success) {
      showToast("复制失败，请在源码框中手动选择");
      return;
    }
    setCopied(true);
    showToast("TikZ 源码已复制到剪贴板");
  }, [showToast, source]);

  const warningCount = doc.issues.length;

  return (
    <div className="studio">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <BrandMark />
          </span>
          <span className="brand-copy">
            <span className="brand-name">TikZ Studio</span>
            <span className="brand-tag">从源码到画布，所见即所得</span>
          </span>
        </div>

        <div className="topbar-note" aria-hidden="true">
          <span>PASTE</span>
          <i />
          <span>RENDER</span>
          <i />
          <span>EDIT</span>
        </div>

        <div className="view-switch" role="tablist" aria-label="切换工作区">
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "source"}
            onClick={() => setViewMode("source")}
          >
            <Braces size={13} />
            源码
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={viewMode === "canvas"}
            onClick={() => setViewMode("canvas")}
          >
            <Scan size={13} />
            画布
          </button>
        </div>

        <div className="topbar-actions">
          <div className="history-controls" role="group" aria-label="编辑历史">
            <button
              type="button"
              className="history-button"
              onClick={undo}
              disabled={!historyFlags.canUndo}
              aria-label="撤销上一步"
              title="撤销 (Ctrl/⌘ + Z)"
            >
              <Undo2 size={15} />
            </button>
            <button
              type="button"
              className="history-button"
              onClick={redo}
              disabled={!historyFlags.canRedo}
              aria-label="重做下一步"
              title="重做 (Ctrl/⌘ + Shift + Z)"
            >
              <Redo2 size={15} />
            </button>
          </div>

          <div className="example-wrap" ref={exampleWrapRef}>
            <button
              type="button"
              className={`button button-outline${examplesOpen ? " is-open" : ""}`}
              onClick={() => setExamplesOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={examplesOpen}
              title="示例图库"
            >
              <LayoutTemplate size={14} />
              <span className="button-label">示例</span>
              <ChevronDown
                size={12}
                className={`chevron${examplesOpen ? " is-open" : ""}`}
              />
            </button>
            {examplesOpen ? (
              <div className="example-menu" role="menu">
                <div className="example-menu-head">
                  <span>示例图库</span>
                  <span className="example-count">{TIKZ_EXAMPLES.length + 1} 张</span>
                </div>
                {TIKZ_EXAMPLES.map((example, index) => (
                  <button
                    key={example.id}
                    type="button"
                    role="menuitem"
                    className={`example-item${activeExampleId === example.id ? " is-active" : ""}`}
                    onClick={() => loadSource(example.code)}
                  >
                    <span className="example-index">{String(index + 1).padStart(2, "0")}</span>
                    <span className="example-text">
                      <span className="example-name">{example.name}</span>
                      <span className="example-eyebrow">{example.eyebrow}</span>
                    </span>
                    {activeExampleId === example.id ? (
                      <Check size={14} className="example-check" />
                    ) : (
                      <span className="example-arrow">→</span>
                    )}
                  </button>
                ))}
                <div className="example-rule" />
                <button
                  type="button"
                  role="menuitem"
                  className={`example-item${activeExampleId === "blank" ? " is-active" : ""}`}
                  onClick={() => loadSource(BLANK_TIKZ_SOURCE)}
                >
                  <span className="example-index">{String(TIKZ_EXAMPLES.length + 1).padStart(2, "0")}</span>
                  <span className="example-text">
                    <span className="example-name">空白起点</span>
                    <span className="example-eyebrow">从一张卡片开始</span>
                  </span>
                  {activeExampleId === "blank" ? (
                    <Check size={14} className="example-check" />
                  ) : (
                    <span className="example-arrow">→</span>
                  )}
                </button>
                <p className="example-menu-foot">
                  支持常用 TikZ 子集与 KaTeX 公式，未知命令会跳过并提示。
                </p>
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className={`button button-ink copy-button${copied ? " is-copied" : ""}`}
            onClick={copySource}
            title="复制全部源码"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            <span className="button-label">{copied ? "已复制" : "复制源码"}</span>
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className={`source-pane${viewMode === "source" ? " is-mobile-active" : ""}`}>
          <header className="pane-head source-head">
            <div className="pane-title">
              <span className="pane-index">01</span>
              <span className="pane-name">源码</span>
              <span className="file-chip">diagram.tikz</span>
            </div>
            <span className="source-lang">TIKZ / LATEX</span>
          </header>

          <SourceEditor
            value={source}
            onChange={applySource}
            highlight={selectedSpan}
            highlightKey={primaryKey}
            active={viewMode === "source"}
            resetSignal={resetSignal}
          />

          <footer className="source-foot">
            <span className={`source-status${warningCount > 0 ? " has-warning" : ""}`}>
              <i />
              {warningCount > 0 ? `${warningCount} 条兼容提示` : "解析正常"}
            </span>
            <span className="source-stats">
              <span>{doc.stats.nodes} 节点</span>
              <span>{doc.stats.paths} 路径</span>
              <span>{doc.stats.labels} 标签</span>
              <span>{doc.stats.lines} 行</span>
            </span>
            <span className="source-privacy">本地解析 · 源码不会上传</span>
          </footer>
        </section>

        <DiagramCanvas
          doc={doc}
          source={source}
          selectedKeys={selectedKeys}
          onSelect={setSelectedKeys}
          onSourceChange={applySource}
          fitSignal={fitSignal}
          onLoadExample={() => loadSource(DEFAULT_TIKZ_SOURCE)}
          mobileActive={viewMode === "canvas"}
        />
      </main>

      {toast ? (
        <div className="toast" role="status">
          <Check size={13} />
          {toast}
        </div>
      ) : null}
    </div>
  );
}
