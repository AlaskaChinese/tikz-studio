export interface TikzExample {
  id: string;
  name: string;
  eyebrow: string;
  code: string;
  preview?: "circuitikz" | "pgfplots" | "tikz-cd" | "chemfig" | "chemfig-fragment";
  native?: boolean;
}

export const TIKZ_EXAMPLES: TikzExample[] = [
  {
    id: "pipeline",
    name: "智能制图流程",
    eyebrow: "流程图",
    code: String.raw`% 将这段源码替换为 AI 生成的 TikZ
\definecolor{ink}{HTML}{202520}
\definecolor{paper}{HTML}{FFFCF5}
\definecolor{accent}{HTML}{D85C3A}
\definecolor{moss}{HTML}{3F6B57}

\begin{tikzpicture}[
  node distance=1.2cm and 1.3cm,
  every node/.style={font=\small},
  box/.style={
    draw=ink!75,
    rounded corners=4pt,
    fill=paper,
    minimum height=1.05cm,
    inner sep=7pt,
    text=ink
  },
  hot/.style={box, draw=accent, fill=accent!9},
  arrow/.style={-{Stealth[length=2.4mm]}, draw=ink!72, thick}
]
  \node[hot] (prompt) at (0,0) {输入需求};
  \node[box, right=of prompt] (ai) {AI 生成 TikZ};
  \node[box, right=of ai] (canvas) {画布渲染};

  \node[box, below=of canvas] (edit) {拖动与编辑};
  \node[hot, left=of edit] (code) {回写源码};

  \draw[arrow] (prompt) -- (ai);
  \draw[arrow] (ai) -- (canvas);
  \draw[arrow] (canvas) -- (edit);
  \draw[arrow] (edit) -- (code);
  \draw[arrow, draw=accent] (code) -- node[above, font=\scriptsize, text=accent] {实时同步} (prompt);
\end{tikzpicture}`,
  },
  {
    id: "factor-graph",
    name: "滑动窗口因子图",
    eyebrow: "复杂示例",
    code: String.raw`% 滑动窗口时空因子图：先验、里程计、相对观测与 GPS 因子
\definecolor{ink}{HTML}{20261F}
\definecolor{mint}{HTML}{3F7A63}
\definecolor{amber}{HTML}{D9822B}
\definecolor{signal}{HTML}{C94C3B}
\definecolor{violet}{HTML}{6A5AA8}
\definecolor{steel}{HTML}{477A8C}

\begin{tikzpicture}[
  every node/.style={font=\small},
  board/.style={draw=ink!12, fill=white, thick},
  column/.style={draw=mint!35, dashed, fill=mint!4},
  pose/.style={
    circle,
    draw=mint!85,
    fill=mint!8,
    minimum size=0.92cm,
    inner sep=0pt,
    text=ink,
    thick
  },
  landmark/.style={
    circle,
    draw=steel!85,
    fill=steel!8,
    minimum size=0.86cm,
    inner sep=0pt,
    text=ink,
    thick
  },
  motion/.style={
    draw=mint,
    fill=mint!12,
    rounded corners=2pt,
    minimum width=0.72cm,
    minimum height=0.5cm,
    inner sep=1pt,
    font=\scriptsize,
    text=mint!35!ink
  },
  relative/.style={
    diamond,
    draw=amber!90,
    fill=amber!14,
    minimum size=0.72cm,
    inner sep=0pt,
    font=\scriptsize,
    text=amber!35!ink
  },
  gps/.style={
    draw=signal!90,
    fill=signal!10,
    rounded corners=2pt,
    minimum width=0.72cm,
    minimum height=0.46cm,
    inner sep=1pt,
    font=\tiny,
    text=signal!25!ink
  },
  prior/.style={
    draw=violet!90,
    fill=violet!10,
    rounded corners=2pt,
    minimum width=0.62cm,
    minimum height=0.52cm,
    inner sep=1pt,
    font=\scriptsize,
    text=violet!25!ink
  },
  assoc/.style={
    draw=steel!80,
    fill=steel!8,
    rounded corners=2pt,
    minimum width=0.58cm,
    minimum height=0.44cm,
    inner sep=1pt,
    font=\scriptsize,
    text=steel!25!ink
  },
  edge/.style={-{Stealth[length=2.2mm]}, draw=ink!60, thick},
  motionedge/.style={-{Stealth[length=2.1mm]}, draw=mint!85, thick},
  meas/.style={draw=amber!85, thick},
  gpsedge/.style={draw=signal!85, thick},
  prioredge/.style={draw=violet!85, thick},
  assocedge/.style={draw=steel!70, thick, dashed},
  columnlabel/.style={font=\scriptsize, text=mint!60!ink}
]
  % 背景白板与三个滑动时间窗口
  \draw[board] (-8.6,-5.15) rectangle (8.6,5.15);
  \draw[column] (-7.9,-4.5) rectangle (-2.9,3.7);
  \draw[column] (-2.45,-4.5) rectangle (2.45,3.7);
  \draw[column] (2.9,-4.5) rectangle (7.9,3.7);

  \node[align=center, text=ink, font=\Large] at (0,4.62) {滑动窗口时空因子图};
  \node[text=ink!55, font=\scriptsize] at (0,4.18) {滑动窗口优化 · 里程计 / 相对观测 / GPS / 先验约束};

  \node[columnlabel] at (-5.4,3.38) {窗口 t-1};
  \node[columnlabel] at (0,3.38) {窗口 t};
  \node[columnlabel] at (5.4,3.38) {窗口 t+1};

  % 位姿与路标变量
  \node[pose] (x0) at (-5.4,2.0) {$x_0$};
  \node[pose] (x1) at (0,2.0) {$x_1$};
  \node[pose] (x2) at (5.4,2.0) {$x_2$};

  \node[landmark] (l0) at (-5.4,-1.9) {$\ell_0$};
  \node[landmark] (l1) at (0,-1.9) {$\ell_1$};
  \node[landmark] (l2) at (5.4,-1.9) {$\ell_2$};

  % 先验、里程计、相对观测、GPS 与数据关联因子
  \node[prior] (p0) at (-6.85,2.0) {$p_0$};
  \node[motion] (o0) at (-2.7,2.0) {$\Delta$};
  \node[motion] (o1) at (2.7,2.0) {$\Delta$};
  \node[relative] (r0) at (-5.4,0.05) {$r_0$};
  \node[relative] (r1) at (0,0.05) {$r_1$};
  \node[relative] (r2) at (5.4,0.05) {$r_2$};
  \node[gps] (g0) at (-5.4,-3.45) {GPS};
  \node[gps] (g1) at (0,-3.45) {GPS};
  \node[gps] (g2) at (5.4,-3.45) {GPS};
  \node[assoc] (a0) at (-2.7,-1.9) {$a$};
  \node[assoc] (a1) at (2.7,-1.9) {$a$};

  \draw[prioredge] (p0) -- (x0);
  \draw[motionedge] (x0) -- (o0);
  \draw[motionedge] (o0) -- (x1);
  \draw[motionedge] (x1) -- (o1);
  \draw[motionedge] (o1) -- (x2);

  \draw[meas] (x0) -- node[right, font=\scriptsize, text=amber!75] {相对观测} (r0);
  \draw[meas] (r0) -- (l0);
  \draw[meas] (x1) -- (r1);
  \draw[meas] (r1) -- (l1);
  \draw[meas] (x2) -- (r2);
  \draw[meas] (r2) -- (l2);

  \draw[gpsedge] (l0) -- (g0);
  \draw[gpsedge] (l1) -- (g1);
  \draw[gpsedge] (l2) -- node[right, font=\scriptsize, text=signal!75] {GPS 观测} (g2);

  \draw[assocedge] (l0) -- (a0);
  \draw[assocedge] (a0) -- (l1);
  \draw[assocedge] (l1) -- (a1);
  \draw[assocedge] (a1) -- (l2);

  \draw[edge, bend left=18] (x0) to node[above, pos=0.16, font=\scriptsize, text=signal!75] {回环检测} (x2);
  \draw[edge, draw=ink!35] (-7.9,-3.98) -- (7.9,-3.98) node[midway, below, font=\scriptsize, text=ink!45] {滑动窗口时间轴};
\end{tikzpicture}`,
  },
  {
    id: "function-plot",
    name: "函数曲线与网格",
    eyebrow: "函数图",
    code: String.raw`\begin{document}
  \begin{tikzpicture}[domain=0:4]
    \draw[very thin,color=gray] (-0.1,-1.1) grid (3.9,3.9);
    \draw[->] (-0.2,0) -- (4.2,0) node[right] {$x$};
    \draw[->] (0,-1.2) -- (0,4.2) node[above] {$f(x)$};
    \draw[color=red]    plot (\x,\x)             node[right] {$f(x) =x$};
    \draw[color=blue]   plot (\x,{sin(\x r)})    node[right] {$f(x) = \sin x$};
    \draw[color=orange] plot (\x,{0.05*exp(\x)}) node[right] {$f(x) = \frac{1}{20} \mathrm e^x$};
  \end{tikzpicture}
\end{document}`,
  },
  {
    id: "circuit",
    name: "电流源电路",
    eyebrow: "电路图",
    code: String.raw`\usepackage{circuitikz}
\begin{document}

\begin{circuitikz}[american, voltage shift=0.5]
\draw (0,0)
to[isource, l=$I_0$, v=$V_0$] (0,3)
to[short, -*, i=$I_0$] (2,3)
to[R=$R_1$, i>_=$i_1$] (2,0) -- (0,0);
\draw (2,3) -- (4,3)
to[R=$R_2$, i>_=$i_2$]
(4,0) to[short, -*] (2,0);
\end{circuitikz}

\end{document}`,
    preview: "circuitikz",
  },
  {
    id: "surface-3d",
    name: "三维高斯曲面",
    eyebrow: "三维曲面",
    code: String.raw`\usepackage{pgfplots}
\pgfplotsset{compat=1.16}

\begin{document}

\begin{tikzpicture}
\begin{axis}[colormap/viridis]
\addplot3[
	surf,
	samples=18,
	domain=-3:3
]
{exp(-x^2-y^2)*x};
\end{axis}
\end{tikzpicture}

\end{document}`,
    preview: "pgfplots",
  },
  {
    id: "commutative-diagram",
    name: "交换图表",
    eyebrow: "范畴图",
    code: String.raw`\usepackage{tikz-cd}

\begin{document}
\begin{tikzcd}

    T
    \arrow[drr, bend left, "x"]
    \arrow[ddr, bend right, "y"]
    \arrow[dr, dotted, "{(x,y)}" description] & & \\
    K & X \times_Z Y \arrow[r, "p"] \arrow[d, "q"]
    & X \arrow[d, "f"] \\
    & Y \arrow[r, "g"]
    & Z

\end{tikzcd}

\quad \quad

\begin{tikzcd}[row sep=2.5em]

A' \arrow[rr,"f'"] \arrow[dr,swap,"a"] \arrow[dd,swap,"g'"] &&
  B' \arrow[dd,swap,"h'" near start] \arrow[dr,"b"] \\
& A \arrow[rr,crossing over,"f" near start] &&
  B \arrow[dd,"h"] \\
C' \arrow[rr,"k'" near end] \arrow[dr,swap,"c"] && D' \arrow[dr,swap,"d"] \\
& C \arrow[rr,"k"] \arrow[uu,<-,crossing over,"g" near end]&& D

\end{tikzcd}

\end{document}`,
    preview: "tikz-cd",
    native: true,
  },
  {
    id: "chemfig-lactam",
    name: "β-内酰胺骨架",
    eyebrow: "化学结构",
    code: String.raw`\usepackage{chemfig}
\begin{document}

\chemfig{[:-90]HN(-[::-45](-[::-45]R)=[::+45]O)>[::+45]*4(-(=O)-N*5(-(<:(=[::-60]O)-[::+60]OH)-(<[::+0])(<:[::-108])-S>)--)}

\end{document}`,
    preview: "chemfig",
  },
  {
    id: "chemfig-cage",
    name: "笼状分子",
    eyebrow: "化学结构",
    code: String.raw`\usepackage{chemfig}
\begin{document}

\definesubmol\fragment1{

    (-[:#1,0.85,,,draw=none]
    -[::126]-[::-54](=_#(2pt,2pt)[::180])
    -[::-70](-[::-56.2,1.07]=^#(2pt,2pt)[::180,1.07])
    -[::110,0.6](-[::-148,0.60](=^[::180,0.35])-[::-18,1.1])
    -[::50,1.1](-[::18,0.60]=_[::180,0.35])
    -[::50,0.6]
    -[::110])
    }

\chemfig{
!\fragment{18}
!\fragment{90}
!\fragment{162}
!\fragment{234}
!\fragment{306}
}

\end{document}`,
    preview: "chemfig-fragment",
  },
];

export const DEFAULT_TIKZ_SOURCE = TIKZ_EXAMPLES[0].code;

export const BLANK_TIKZ_SOURCE = String.raw`\begin{tikzpicture}
  \node[draw, rounded corners=3pt, minimum width=2.4cm, minimum height=1cm]
    (start) at (0,0) {在这里开始};
\end{tikzpicture}`;
