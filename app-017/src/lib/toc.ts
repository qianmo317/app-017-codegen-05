/**
 * 可触摸目录（教材盲文目录页）。
 *
 * 功能：
 * - 识别原文中的章/节标题（如「第一章 …」「1.2 …」「三、…」），按出现先后统一编号；
 * - 目录条目：盲文数字序号 + 标题 + 引导方 + 标题所在页的盲文页码；
 * - 目录本身占页并插在正文之前，正文顺延；页码变化后目录必须按新页码重新排版，
 *   迭代到「目录页数 / 各条目页码」都不再变化（不动点）为止；
 * - 若迭代不能收敛（页码来回跳），报告具体是哪几个条目、在哪些页码间振荡；
 * - 长标题排成多行时，续行缩进 2 方后接着排完整个标题，页码挂在标题最后一行末尾。
 */
import type { BrailleCell, PageSetup } from '../types';
import { convertText, type ConvertOptions, type ConvertResult, type ParagraphResult } from './convert';
import {
  brailleNumberCells,
  buildGroups,
  collectLines,
  pageNumberLine,
  paginateLines,
  type Group,
  type LayoutPage,
  type LayoutResult,
  type LayoutViolation,
  type TableOfContents,
  type TocEntry,
  type TocOscillation,
} from './layout';

export type HeadingLevel = 'chapter' | 'section';

export interface Heading {
  /** 对应 convertText 输出的段落下标（每个原文行一个段落） */
  paraIndex: number;
  level: HeadingLevel;
  /** 整行标题原文（去掉首尾空白） */
  title: string;
}

const SECTION_INDENT = 2;
const CONTINUATION_INDENT = 2;
const TOC_TITLE = '目录';
/** 引导点：盲文方第 5 点（通行的目录引导点形） */
const LEADER_DOTS = [5];
const MIN_LEADERS = 2;
const MAX_ITERATIONS = 1000;

const CHAPTER_UNIT_RE = /^第[一二三四五六七八九十百千零〇两0-9]+[章单元课部分篇]/;
const CHAPTER_JIE_RE = /^第[一二三四五六七八九十百千零〇两0-9]+节(?=[ 　、，。：:！？]|$)/;
const SECTION_NUMBERED_RE = /^\d+\.\d+(?:\.\d+)*/;
const SECTION_INDEX_RE = /^(?:\d+|[一二三四五六七八九十]+)[ 　]*[、.．](?![0-9.])/;

/** 在原文行中识别章/节标题；段落下标与 convertText 的 paragraphs 一一对应 */
export function detectHeadings(rawLines: string[]): Heading[] {
  const headings: Heading[] = [];
  rawLines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line) return;
    let level: HeadingLevel | null = null;
    if (CHAPTER_UNIT_RE.test(line) || CHAPTER_JIE_RE.test(line)) level = 'chapter';
    else if (SECTION_NUMBERED_RE.test(line) || SECTION_INDEX_RE.test(line)) level = 'section';
    if (level) headings.push({ paraIndex: i, level, title: line });
  });
  return headings;
}

const SPACE: BrailleCell = { dots: [], kind: 'space' };
const spaces = (n: number): BrailleCell[] => Array.from({ length: n }, () => ({ ...SPACE }));
const leaders = (n: number): BrailleCell[] =>
  Array.from({ length: n }, () => ({ dots: [...LEADER_DOTS], kind: 'punct', source: '·' }));

interface PackedEntry {
  ordinal: number;
  level: HeadingLevel;
  lines: BrailleCell[][];
}

/**
 * 单个目录条目 → 行。
 * 首行：[节缩进 2] 序号 + 空方 + 标题… 空方 引导点… 空方 页码（页码贴右）；
 * 标题按词（不可拆分组）边界换行，续行缩进 2 方并继续排完整个标题；
 * 页码永远挂在标题最后一行；该行放不下 2 个引导点时整条页码挪到下一续行。
 */
function packEntry(
  ordinal: number,
  level: HeadingLevel,
  titleGroups: Group[],
  pageBlock: BrailleCell[],
  width: number,
): { entry: PackedEntry; violations: LayoutViolation[] } {
  const violations: LayoutViolation[] = [];
  const lines: BrailleCell[][] = [];
  const cur: BrailleCell[] = [
    ...(level === 'section' ? spaces(SECTION_INDENT) : []),
    ...brailleNumberCells(ordinal),
  ];

  const wrap = (g: Group) => {
    lines.push([...cur]);
    cur.length = 0;
    cur.push(...spaces(CONTINUATION_INDENT));
    if (g.cells.length <= width - CONTINUATION_INDENT) {
      cur.push(...g.cells);
      return;
    }
    // 单词比整行可用宽度还长：硬拆并报告（与正文超长词一致，绝不静默）
    violations.push({ type: 'word-too-long', word: g.word, cells: g.cells.length - (g.indent ?? 0) });
    let rest = g.cells;
    while (rest.length > 0) {
      const cap = width - cur.length;
      cur.push(...rest.slice(0, cap));
      rest = rest.slice(cap);
      if (rest.length > 0) {
        lines.push([...cur]);
        cur.length = 0;
        cur.push(...spaces(CONTINUATION_INDENT));
      }
    }
  };

  for (const g of titleGroups) {
    if (cur.length + 1 + g.cells.length <= width) {
      cur.push({ ...SPACE }, ...g.cells);
    } else {
      wrap(g);
    }
  }

  // 标题最后一行接：空方 + 引导点×N + 空方 + 页码；N < 2 时挪到下一续行
  const finishLine = (line: BrailleCell[], used: number): boolean => {
    const n = width - used - 2 - pageBlock.length;
    if (n < MIN_LEADERS) return false;
    line.push({ ...SPACE }, ...leaders(n), { ...SPACE }, ...pageBlock);
    return true;
  };

  if (!finishLine(cur, cur.length)) {
    lines.push([...cur]);
    const cont = spaces(CONTINUATION_INDENT);
    const n = width - CONTINUATION_INDENT - 2 - pageBlock.length;
    if (n >= MIN_LEADERS) {
      cont.push({ ...SPACE }, ...leaders(n), { ...SPACE }, ...pageBlock);
    } else if (pageBlock.length <= width) {
      // 极端窄行宽：续行也放不下引导点 → 页码单独成行右对齐（号码仍然写出，不截断）
      cont.push(...spaces(width - pageBlock.length), ...pageBlock);
    } else {
      violations.push({ type: 'word-too-long', word: `页码${ordinal}`, cells: pageBlock.length });
      cont.push(...pageBlock.slice(0, width));
    }
    lines.push(cont);
  } else {
    lines.push([...cur]);
  }

  return { entry: { ordinal, level, lines }, violations };
}

interface TocRender {
  pages: LayoutPage[];
  /** ordinal → 目录内容流（不含页码行、跨页连续编号）的行区间 */
  ranges: Map<number, { lineStart: number; lineEnd: number }>;
  violations: LayoutViolation[];
}

/** 目录条目分页：同一条目不跨页；条目比整页还长时才允许拆到多页 */
function paginateEntries(
  packed: PackedEntry[],
  headerCells: BrailleCell[],
  setup: PageSetup,
  showPageNumbers: boolean,
): TocRender {
  const capacity = showPageNumbers ? setup.linesPerPage - 1 : setup.linesPerPage;
  const header: BrailleCell[][] = [
    centerLine(headerCells, setup.cellsPerLine),
    [], // 标题后空一行
  ];

  const pageContents: BrailleCell[][][] = [[...header]];
  const ranges = new Map<number, { lineStart: number; lineEnd: number }>();
  let flowPos = header.length;

  const newPage = () => pageContents.push([]);

  for (const e of packed) {
    const start = flowPos;
    let rows = e.lines;
    let page = pageContents.length - 1;
    let used = pageContents[page].length;

    // 当前页剩余空间放不下、但整条能放进一整页 → 另起一页（条目不跨页）；
    // 整条比整页还长时只能拆分，留在原地按行填
    const freeNow = capacity - used;
    if (rows.length > freeNow && rows.length <= capacity) {
      newPage();
      page++;
      used = 0;
    }

    while (rows.length > 0) {
      if (used >= capacity) {
        // 当前页真的满了（条目比整页长才会走到）：续到新页
        newPage();
        page++;
        used = 0;
      }
      const free = capacity - used;
      const take = Math.min(rows.length, free);
      pageContents[page].push(...rows.slice(0, take));
      flowPos += take;
      rows = rows.slice(take);
      used += take;
    }
    ranges.set(e.ordinal, { lineStart: start, lineEnd: flowPos - 1 });
  }

  const pages: LayoutPage[] = pageContents.map((content, pi) => {
    const page: LayoutPage = { number: pi + 1, lines: [], role: 'toc' };
    if (showPageNumbers) page.lines.push(pageNumberLine(pi + 1, setup.cellsPerLine));
    for (const cells of content) page.lines.push({ cells });
    return page;
  });
  return { pages, ranges, violations: [] };
}

function centerLine(cells: BrailleCell[], width: number): BrailleCell[] {
  if (cells.length >= width) return [...cells.slice(0, width)];
  const left = Math.floor((width - cells.length) / 2);
  return [...spaces(left), ...cells, ...spaces(width - left - cells.length)];
}

/** 「目录」标题的盲文方（转换选项与正文一致） */
function tocTitleCells(opts: ConvertOptions): BrailleCell[] {
  const conv = convertText(TOC_TITLE, opts);
  const p = conv.paragraphs.find((x) => !x.blank);
  return p ? buildGroups(p).flatMap((g) => g.cells) : [];
}

/** 给定每个标题的物理页码，渲染一次目录 */
function renderToc(
  headings: Heading[],
  paragraphs: ParagraphResult[],
  pageOf: number[],
  setup: PageSetup,
  showPageNumbers: boolean,
  opts: ConvertOptions,
): TocRender {
  const packed: PackedEntry[] = [];
  let violations: LayoutViolation[] = [];
  headings.forEach((h, i) => {
    const { entry, violations: v } = packEntry(
      i + 1,
      h.level,
      buildGroups(paragraphs[h.paraIndex]),
      brailleNumberCells(pageOf[i]),
      setup.cellsPerLine,
    );
    packed.push(entry);
    violations = violations.concat(v);
  });
  const rendered = paginateEntries(packed, tocTitleCells(opts), setup, showPageNumbers);
  return { ...rendered, violations: violations.concat(rendered.violations) };
}

/** 目录页码迭代状态转移：给定目录页数 → 实际目录页数 + 各条目页码 */
export interface TocStateTransition {
  (tocPages: number): { tocPageCount: number; entryPages: number[] };
}

export interface TocSettlement {
  tocPages: number;
  entryPages: number[];
  iterations: number;
  stable: boolean;
  /** 振荡环覆盖的状态下标（稳定时为空） */
  cycleStates: { tocPages: number; entryPages: number[] }[];
}

/**
 * 不动点迭代（通用形式，便于单测注入振荡的转移函数）。
 * 从 start 起反复应用 next，直到 next(T).tocPageCount === T；
 * 若 T 重复出现（周期 ≥2），判定为振荡，返回环内全部状态。
 */
export function settleTocPages(next: TocStateTransition, start = 1): TocSettlement {
  const states: { tocPages: number; entryPages: number[] }[] = [];
  const seen = new Map<number, number>();
  let t = start;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (seen.has(t)) {
      const at = seen.get(t)!;
      return {
        tocPages: t,
        entryPages: states[states.length - 1].entryPages,
        iterations: i,
        stable: false,
        cycleStates: states.slice(at),
      };
    }
    seen.set(t, i);
    const r = next(t);
    states.push({ tocPages: t, entryPages: r.entryPages });
    if (r.tocPageCount === t) {
      return { tocPages: t, entryPages: r.entryPages, iterations: i + 1, stable: true, cycleStates: [] };
    }
    t = r.tocPageCount;
  }

  // 理论兜底：超过迭代上限仍未稳定
  return {
    tocPages: t,
    entryPages: states[states.length - 1].entryPages,
    iterations: MAX_ITERATIONS,
    stable: false,
    cycleStates: [states[states.length - 1]],
  };
}

/** 振荡环内页码取过多个值的条目（报告“哪几处来回跳、在哪些页码之间跳”） */
export function collectOscillations(
  headings: Heading[],
  cycleStates: { entryPages: number[] }[],
): TocOscillation[] {
  const out: TocOscillation[] = [];
  headings.forEach((h, i) => {
    const vals = [...new Set(cycleStates.map((s) => s.entryPages[i]))];
    if (vals.length > 1) out.push({ ordinal: i + 1, title: h.title, pages: vals });
  });
  return out;
}

/**
 * 带目录的完整排版。
 * 目录占 T 页 → 正文从第 T+1 页开始 → 各标题页码决定目录行数/页数 T′；
 * 迭代至 T′ = T（从 T=1 起 T 单调不减，必有界收敛），不能收敛时报告振荡条目。
 */
export function layoutWithToc(
  converted: ConvertResult,
  raw: string,
  setup: PageSetup,
  showPageNumbers: boolean,
  convertOptions: ConvertOptions,
): LayoutResult {
  const headings = detectHeadings(raw.split('\n'));
  const { lines: bodyLines, paraStartLines, violations } = collectLines(converted.paragraphs, setup);
  const capacity = showPageNumbers ? setup.linesPerPage - 1 : setup.linesPerPage;

  if (headings.length === 0) {
    return { pages: paginateLines(bodyLines, setup, showPageNumbers, 1), violations, toc: null };
  }

  /** 目录占 tocPages 页时，每个标题正文起始行所在的物理页号 */
  const assignPages = (tocPages: number): number[] =>
    headings.map((h) => tocPages + 1 + Math.floor(paraStartLines[h.paraIndex] / capacity));

  const settlement = settleTocPages((t) => {
    const entryPages = assignPages(t);
    const rendered = renderToc(headings, converted.paragraphs, entryPages, setup, showPageNumbers, convertOptions);
    return { tocPageCount: rendered.pages.length, entryPages };
  });

  const finalPages = assignPages(settlement.tocPages);
  const finalToc = renderToc(headings, converted.paragraphs, finalPages, setup, showPageNumbers, convertOptions);
  const bodyPages = paginateLines(bodyLines, setup, showPageNumbers, settlement.tocPages + 1);

  // 振荡条目：环内页码取过多个值的条目
  const oscillations = settlement.stable ? [] : collectOscillations(headings, settlement.cycleStates);

  const entries: TocEntry[] = headings.map((h, i) => ({
    ordinal: i + 1,
    level: h.level,
    title: h.title,
    page: finalPages[i],
    lineStart: finalToc.ranges.get(i + 1)!.lineStart,
    lineEnd: finalToc.ranges.get(i + 1)!.lineEnd,
  }));

  const toc: TableOfContents = {
    entries,
    pageCount: finalToc.pages.length,
    iterations: settlement.iterations,
    stable: settlement.stable,
    oscillations,
  };

  return {
    pages: [...finalToc.pages, ...bodyPages],
    violations: [...violations, ...finalToc.violations],
    toc,
  };
}
