export interface TikzExample {
  id: string;
  name: string;
  eyebrow: string;
  code: string;
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
    id: "architecture",
    name: "系统架构",
    eyebrow: "架构图",
    code: String.raw`\definecolor{ink}{HTML}{1D2421}
\definecolor{paper}{HTML}{FFFCF5}
\definecolor{signal}{HTML}{D85C3A}
\definecolor{sea}{HTML}{356B6B}

\begin{tikzpicture}[
  node distance=0.9cm and 1.15cm,
  every node/.style={font=\small},
  comp/.style={
    draw=ink!70,
    fill=paper,
    rounded corners=3pt,
    minimum width=2.45cm,
    minimum height=0.95cm,
    inner sep=6pt
  },
  data/.style={comp, draw=sea, fill=sea!8},
  arrow/.style={-{Stealth[length=2.2mm]}, draw=ink!65, thick},
  guide/.style={draw=sea!70, thick}
]
  \node[comp] (gateway) at (0,2.2) {API 网关};
  \node[comp] (auth) at (-2.6,0) {身份鉴权};
  \node[comp] (agent) at (0,0) {Agent 编排};
  \node[data] (memory) at (2.8,0) {长期记忆};

  \draw[arrow] (gateway) -- (auth);
  \draw[arrow] (gateway) -- (agent);
  \draw[arrow] (gateway) -- node[right, font=\scriptsize, text=sea] {上下文} (memory);
  \draw[guide, bend left=24] (auth) to node[above, font=\scriptsize, text=sea] {token} (agent);
  \draw[guide, bend left=26] (memory) to node[above, font=\scriptsize, text=signal] {检索} (agent);
\end{tikzpicture}`,
  },
  {
    id: "geometry",
    name: "几何与公式",
    eyebrow: "示意图",
    code: String.raw`\definecolor{ink}{HTML}{202520}
\definecolor{paper}{HTML}{FFFCF5}
\definecolor{accent}{HTML}{D85C3A}
\definecolor{moss}{HTML}{3F6B57}

\begin{tikzpicture}[
  every node/.style={font=\small},
  point/.style={
    circle,
    draw=accent,
    fill=accent!14,
    minimum size=0.66cm,
    inner sep=0pt
  },
  arrow/.style={-{Stealth[length=2.2mm]}, draw=ink!70, thick}
]
  \coordinate (center) at (0,0);
  \draw[draw=moss!80, fill=moss!7] (0,0) circle (1.65cm);
  \draw[draw=ink!22, dashed] (-2.5,0) -- (2.5,0);
  \draw[draw=ink!22, dashed] (0,-2.2) -- (0,2.2);

  \node[point] (p) at (35:1.65) {};
  \node[align=center, text=ink] at (-1.25,1.9) {单位圆\\[-1pt]{\scriptsize $r=1.65$}};
  \draw[arrow] (0.35,0.18) -- (35:1.55) node[midway, above right, font=\scriptsize] {$r$};
  \node[draw=ink!70, fill=paper, rounded corners=4pt, align=center, inner sep=7pt]
    at (2.35,-1.6) {$\theta=35^\circ$\\[-1pt]{\scriptsize 极坐标}};
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
];

export const DEFAULT_TIKZ_SOURCE = TIKZ_EXAMPLES[0].code;

export const BLANK_TIKZ_SOURCE = String.raw`\begin{tikzpicture}
  \node[draw, rounded corners=3pt, minimum width=2.4cm, minimum height=1cm]
    (start) at (0,0) {在这里开始};
\end{tikzpicture}`;
