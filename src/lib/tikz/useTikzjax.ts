import { useEffect, useRef, useState } from "react";
import {
  compileTikz,
  EngineError,
  engineHint,
  type EngineResult,
} from "./tikzjax";

export type EngineStatus = "idle" | "loading" | "ready" | "error";

export interface EngineState {
  status: EngineStatus;
  result: EngineResult | null;
  error: string | null;
  detail: string | null;
  hint: string | null;
}

export interface EngineCanvasInfo {
  active: boolean;
  status: EngineStatus;
  reasons: string[];
  error: string | null;
  detail: string | null;
  hint: string | null;
  available: boolean;
  unavailableHint: string | null;
}

const IDLE: EngineState = {
  status: "idle",
  result: null,
  error: null,
  detail: null,
  hint: null,
};

const DEBOUNCE_MS = 420;

export function useTikzjax(
  source: string,
  active: boolean,
  retryToken: number,
): EngineState {
  const [state, setState] = useState<EngineState>(IDLE);
  const lastTokenRef = useRef(retryToken);

  useEffect(() => {
    const fresh = lastTokenRef.current !== retryToken;
    lastTokenRef.current = retryToken;
    if (!active) {
      setState(IDLE);
      return;
    }
    let cancelled = false;
    setState({ ...IDLE, status: "loading" });
    const timer = window.setTimeout(() => {
      compileTikz(source, fresh)
        .then((result) => {
          if (cancelled) return;
          setState({
            status: "ready",
            result,
            error: null,
            detail: null,
            hint: null,
          });
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          const failure = cause instanceof EngineError ? cause : null;
          setState({
            status: "error",
            result: null,
            error: failure?.message ?? "TeX 引擎渲染失败，请重试。",
            detail: failure?.detail ?? null,
            hint: engineHint(source),
          });
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [source, active, retryToken]);

  return state;
}
