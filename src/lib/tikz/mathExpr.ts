type Values = Record<string, number>;
type Evaluator = (values: Values) => number;

const TRIG: Record<string, (value: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
};

const FUNCTIONS: Record<string, (value: number) => number> = {
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  sqrt: Math.sqrt,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
};

class ExpressionError extends Error {}

export function compileMathExpression(
  input: string,
  variables: string[],
): ((values: Values) => number) | null {
  const text = input.trim();
  if (!text) return null;
  const allowed = new Set(variables);
  let index = 0;

  const skip = () => {
    while (index < text.length && /\s/.test(text[index])) index += 1;
  };

  const readName = (): string => {
    if (text[index] === "\\") {
      index += 1;
      const start = index;
      while (index < text.length && /[A-Za-z]/.test(text[index])) index += 1;
      return text.slice(start, index);
    }
    const start = index;
    while (index < text.length && /[A-Za-z]/.test(text[index])) index += 1;
    return text.slice(start, index);
  };

  function parsePrimary(): Evaluator {
    skip();
    if (index >= text.length) throw new ExpressionError("empty");
    if (text[index] === "(" || text[index] === "{") {
      const open = text[index];
      const close = open === "(" ? ")" : "}";
      index += 1;
      const value = parseAdditive();
      skip();
      if (text[index] !== close) throw new ExpressionError("unclosed");
      index += 1;
      return value;
    }
    if (/\d|\./.test(text[index])) {
      const match = text.slice(index).match(/^(?:\d+\.?\d*|\.\d+)/);
      if (!match) throw new ExpressionError("number");
      index += match[0].length;
      const number = Number.parseFloat(match[0]);
      return () => number;
    }
    if (/[A-Za-z\\]/.test(text[index])) {
      const name = readName();
      const normalized = name.toLowerCase();
      skip();
      if (text[index] === "(" && (TRIG[normalized] || FUNCTIONS[normalized])) {
        index += 1;
        const argument = parseAdditive();
        skip();
        let radians = false;
        if (normalized in TRIG && text[index] === "r") {
          index += 1;
          radians = true;
          skip();
        }
        if (text[index] !== ")") throw new ExpressionError("function");
        index += 1;
        if (normalized in TRIG) {
          const fn = TRIG[normalized];
          return radians
            ? (values) => fn(argument(values))
            : (values) => fn((argument(values) * Math.PI) / 180);
        }
        const fn = FUNCTIONS[normalized];
        return (values) => fn(argument(values));
      }
      if (normalized === "pi") return () => Math.PI;
      if (normalized === "e") return () => Math.E;
      if (allowed.has(normalized)) return (values) => values[normalized] ?? Number.NaN;
      throw new ExpressionError(`unknown ${name}`);
    }
    throw new ExpressionError("unexpected");
  }

  function parseUnary(): Evaluator {
    skip();
    if (text[index] === "-") {
      index += 1;
      const value = parseUnary();
      return (values) => -value(values);
    }
    if (text[index] === "+") {
      index += 1;
      return parseUnary();
    }
    return parsePower();
  }

  function parsePower(): Evaluator {
    const base = parsePrimary();
    skip();
    if (text[index] === "^") {
      index += 1;
      const exponent = parseUnary();
      return (values) => base(values) ** exponent(values);
    }
    return base;
  }

  function parseMultiplicative(): Evaluator {
    let value = parseUnary();
    while (true) {
      skip();
      const operator = text[index];
      if (operator !== "*" && operator !== "/") break;
      index += 1;
      const left = value;
      const right = parseUnary();
      value =
        operator === "*"
          ? (values) => left(values) * right(values)
          : (values) => left(values) / right(values);
    }
    return value;
  }

  function parseAdditive(): Evaluator {
    let value = parseMultiplicative();
    while (true) {
      skip();
      const operator = text[index];
      if (operator !== "+" && operator !== "-") break;
      index += 1;
      const left = value;
      const right = parseMultiplicative();
      value =
        operator === "+"
          ? (values) => left(values) + right(values)
          : (values) => left(values) - right(values);
    }
    return value;
  }

  try {
    const evaluator = parseAdditive();
    skip();
    if (index !== text.length) return null;
    return (values) => {
      const result = evaluator(values);
      return Number.isFinite(result) ? result : Number.NaN;
    };
  } catch {
    return null;
  }
}

export function compileSingleVariable(
  input: string,
  variable = "x",
): ((value: number) => number) | null {
  const compiled = compileMathExpression(input, [variable]);
  if (!compiled) return null;
  return (value) => compiled({ [variable]: value });
}
