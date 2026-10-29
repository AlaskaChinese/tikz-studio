import { useEffect, useRef } from "react";
import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { tags } from "@lezer/highlight";
import { EditorView } from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { Decoration } from "@codemirror/view";
import type { Span } from "@/src/lib/tikz/types";

const tikzLanguage = StreamLanguage.define({
  ...stex,
  tokenTable: {
    tag: tags.macroName,
    atom: tags.labelName,
    bracket: tags.bracket,
    string: tags.string,
    keyword: tags.keyword,
    comment: tags.lineComment,
    builtin: tags.atom,
  },
});

const studioHighlight = HighlightStyle.define([
  { tag: tags.macroName, color: "#e9a178" },
  { tag: tags.labelName, color: "#a8c6a4" },
  { tag: tags.bracket, color: "#829083" },
  { tag: tags.string, color: "#d7b985" },
  { tag: tags.keyword, color: "#d7b985" },
  { tag: tags.atom, color: "#b7ccb3" },
  { tag: tags.comment, color: "#637366", fontStyle: "italic" },
  { tag: tags.variableName, color: "#c9d6c6" },
]);

const setSourceHighlight = StateEffect.define<Span | null>();

const sourceHighlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setSourceHighlight)) {
        if (!effect.value) {
          next = Decoration.none;
        } else {
          const max = transaction.newDoc.length;
          const from = Math.max(0, Math.min(max, effect.value.start));
          const to = Math.max(from, Math.min(max, effect.value.end));
          next = to > from
            ? Decoration.set([
                Decoration.mark({ class: "cm-source-highlight" }).range(from, to),
              ])
            : Decoration.none;
        }
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "#191f1a",
    color: "#dbe3d7",
    fontSize: "12.5px",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily:
      '"Cascadia Code", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", monospace',
    lineHeight: "1.75",
    padding: "16px 0 40px",
  },
  ".cm-content": {
    caretColor: "#f1a17d",
    paddingRight: "20px",
  },
  ".cm-line": { padding: "0 8px 0 12px" },
  ".cm-gutters": {
    backgroundColor: "#191f1a",
    color: "#4e5c51",
    border: "none",
    paddingLeft: "12px",
    fontSize: "10.5px",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 4px" },
  ".cm-activeLine": { backgroundColor: "rgba(255, 253, 246, 0.035)" },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "#aebcaa",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#f1a17d" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "rgba(220, 108, 70, 0.3)" },
  ".cm-source-highlight": {
    backgroundColor: "rgba(220, 108, 70, 0.14)",
    boxShadow: "inset 2px 0 0 #d96a45",
    borderRadius: "2px",
  },
  ".cm-matchingBracket": {
    backgroundColor: "rgba(168, 198, 164, 0.16)",
    outline: "1px solid rgba(168, 198, 164, 0.3)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-panels": { backgroundColor: "#20271f", color: "#dbe3d7" },
  ".cm-searchMatch": { backgroundColor: "rgba(215, 185, 133, 0.24)" },
  ".cm-tooltip": {
    backgroundColor: "#232b24",
    border: "1px solid #3a463b",
    color: "#dbe3d7",
  },
});

interface SourceEditorProps {
  value: string;
  onChange: (value: string) => void;
  highlight?: Span | null;
  highlightKey?: string | null;
  active: boolean;
  resetSignal: number;
  focusSignal: number;
}

export function SourceEditor({
  value,
  onChange,
  highlight,
  highlightKey,
  active,
  resetSignal,
  focusSignal,
}: SourceEditorProps) {
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const lastScrollKey = useRef<string | null>(null);
  const lastReset = useRef(resetSignal);

  useEffect(() => {
    const view = editorRef.current?.view;
    if (!view) return;
    const effects: StateEffect<unknown>[] = [
      setSourceHighlight.of(highlight ?? null),
    ];
    if (highlight && highlightKey !== lastScrollKey.current) {
      effects.push(EditorView.scrollIntoView(highlight.start, { y: "nearest" }));
    }
    lastScrollKey.current = highlightKey ?? null;
    view.dispatch({ effects });
  }, [highlight, highlightKey]);

  useEffect(() => {
    if (lastReset.current === resetSignal) return;
    lastReset.current = resetSignal;
    const view = editorRef.current?.view;
    if (!view) return;
    view.dispatch({
      effects: EditorView.scrollIntoView(0, { y: "start" }),
      selection: { anchor: 0 },
    });
  }, [resetSignal]);

  useEffect(() => {
    if (focusSignal === 0) return;
    editorRef.current?.view?.focus();
  }, [focusSignal]);

  useEffect(() => {
    if (!active) return;
    const view = editorRef.current?.view;
    const frame = requestAnimationFrame(() => view?.requestMeasure());
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <div className="source-editor">
      <CodeMirror
        ref={editorRef}
        value={value}
        onChange={onChange}
        height="100%"
        theme={editorTheme}
        extensions={[
          tikzLanguage,
          syntaxHighlighting(studioHighlight),
          sourceHighlightField,
          EditorView.lineWrapping,
        ]}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          dropCursor: false,
          allowMultipleSelections: false,
          indentOnInput: false,
          bracketMatching: true,
          closeBrackets: false,
          autocompletion: false,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          highlightSelectionMatches: false,
          searchKeymap: true,
          history: false,
          tabSize: 2,
        }}
      />
    </div>
  );
}
