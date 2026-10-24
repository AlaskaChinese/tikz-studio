import katex from "katex";
import { splitTextLines } from "./measure";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function findGroupEnd(text: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

const sizeMap: Record<string, string> = {
  tiny: "0.58em",
  scriptsize: "0.72em",
  footnotesize: "0.82em",
  small: "0.9em",
  normalsize: "1em",
  large: "1.15em",
  Large: "1.3em",
  LARGE: "1.45em",
  huge: "1.6em",
  Huge: "1.8em",
};

const greekMap: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  theta: "θ",
  lambda: "λ",
  mu: "μ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  phi: "φ",
  omega: "ω",
  Delta: "Δ",
  Gamma: "Γ",
  Lambda: "Λ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Omega: "Ω",
};

function renderMath(expression: string): string {
  try {
    return katex.renderToString(expression, {
      throwOnError: false,
      displayMode: false,
      output: "html",
      strict: false,
      trust: false,
    });
  } catch {
    return `<span class="tikz-math-fallback">${escapeHtml(expression)}</span>`;
  }
}

function renderInline(text: string): string {
  let output = "";
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (char === "$") {
      let end = index + 1;
      let escaped = false;
      while (end < text.length) {
        if (text[end] === "\\" && !escaped) {
          escaped = true;
          end += 1;
          continue;
        }
        if (text[end] === "$" && !escaped) break;
        escaped = false;
        end += 1;
      }
      if (end < text.length) {
        output += renderMath(text.slice(index + 1, end));
        index = end + 1;
      } else {
        output += escapeHtml("$");
        index += 1;
      }
      continue;
    }

    if (char === "\\") {
      if (text[index + 1] === "\\") {
        output += "<br/>";
        index += 2;
        continue;
      }

      const commandMatch = text.slice(index + 1).match(/^([A-Za-z]+)\*?/);
      if (commandMatch) {
        const command = commandMatch[1];
        let next = index + 1 + commandMatch[0].length;
        while (next < text.length && /\s/.test(text[next])) next += 1;

        if (next < text.length && text[next] === "{") {
          const end = findGroupEnd(text, next);
          if (end > 0) {
            const inner = text.slice(next + 1, end);
            if (command === "textbf" || command === "bfseries") {
              output += `<strong>${renderInline(inner)}</strong>`;
            } else if (command === "textit" || command === "emph" || command === "itshape") {
              output += `<em>${renderInline(inner)}</em>`;
            } else if (command === "underline") {
              output += `<u>${renderInline(inner)}</u>`;
            } else if (command === "texttt") {
              output += `<span class="tikz-monotext">${renderInline(inner)}</span>`;
            } else if (command === "textcolor") {
              const colorMatch = inner.match(/^\{?([A-Za-z]+)\}?\s*\{/);
              if (colorMatch) {
                const colorEnd = findGroupEnd(inner, inner.indexOf("{", colorMatch[0].length - 1));
                if (colorEnd > 0) {
                  const color = colorMatch[1].toLowerCase();
                  const body = inner.slice(colorEnd + 1);
                  output += `<span style="color:${escapeHtml(color)}">${renderInline(body)}</span>`;
                } else {
                  output += renderInline(inner);
                }
              } else {
                output += renderInline(inner);
              }
            } else if (command === "text" || command === "mathrm" || command === "textnormal" || command === "mbox") {
              output += renderInline(inner);
            } else if (sizeMap[command]) {
              output += `<span style="font-size:${sizeMap[command]}">${renderInline(inner)}</span>`;
            } else {
              output += renderInline(inner);
            }
            index = end + 1;
            continue;
          }
        }

        const symbol = greekMap[command];
        if (symbol) output += escapeHtml(symbol);
        else if (command === "LaTeX") output += "LaTeX";
        else if (command === "TeX") output += "TeX";
        else if (command === "cdots") output += "⋯";
        else if (command === "ldots" || command === "dots") output += "…";
        else if (command === "quad" || command === "qquad") output += "&nbsp;&nbsp;";
        else if (command === ",") output += " ";
        index = next;
        continue;
      }

      const escapedChar = text[index + 1];
      if (escapedChar && "%&#_{}$".includes(escapedChar)) {
        output += escapeHtml(escapedChar);
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (char === "{") {
      const end = findGroupEnd(text, index);
      if (end > 0) {
        const inner = text.slice(index + 1, end);
        const sizeLead = inner.match(/^\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b/);
        if (sizeLead) {
          output += `<span style="font-size:${sizeMap[sizeLead[1]]}">${renderInline(inner.slice(sizeLead[0].length))}</span>`;
        } else {
          output += renderInline(inner);
        }
        index = end + 1;
        continue;
      }
      index += 1;
      continue;
    }

    if (char === "}") {
      index += 1;
      continue;
    }

    if (char === "~") {
      output += "&nbsp;";
      index += 1;
      continue;
    }

    let end = index + 1;
    while (end < text.length && !"\\${}~".includes(text[end])) end += 1;
    output += escapeHtml(text.slice(index, end));
    index = end;
  }

  return output;
}

export function latexToHtml(raw: string, lineHeight = 1.32): string {
  return splitTextLines(raw)
    .map(
      (line) =>
        `<span class="tikz-text-line" style="line-height:${lineHeight}">${renderInline(line.trim())}</span>`,
    )
    .join("");
}
