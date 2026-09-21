/**
 * 分页排版：段落 → 行 → 页。
 * 规则（需求文档 §4.3 / §8）：
 * - 页面 32方 × 25行（可自定义）；
 * - 词不跨行（只在词边界换行），数字/字母串不可分割；
 * - 段首缩进 2 方；空行分段；页码（盲文数字）位于每页第一行右端；
 * - 超过整行宽度的词强制拆分并标记违规，绝不静默。
 *
 * 另供目录（toc.ts）复用的两个原语：
 * - collectLines：段落 → 行序列，并标出每段起始行（目录需要按段定位标题）；
 * - paginateLines：行序列 → 页，可指定起始物理页号（目录占页后正文页号顺延）。
 */
import digitsJson from '../rules/zh-digits.json';
import type { BrailleCell, PageSetup } from '../types';
import type { ParagraphResult, WordCells } from './convert';

export interface LayoutLine {
  cells: BrailleCell[];
  /** 该行是某个段落（含空段）的起始行 */
  paraStart?: boolean;
}

export interface LayoutPage {
  number: number;
  lines: LayoutLine[];
  /** 目录页标记（正文页无此字段） */
  role?: 'toc';
}

export interface LayoutViolation {
  type: 'word-too-long';
  word: string;
  cells: number;
}

export interface LayoutResult {
  pages: LayoutPage[];
  violations: LayoutViolation[];
  /** 目录信息（未启用目录或无标题时为 null） */
  toc: TableOfContents | null;
}

/** 目录条目（目录页排版结果，供界面/测试使用） */
export interface TocEntry {
  /** 出现先后序号（从 1 开始） */
  ordinal: number;
  /** 章节级别：chapter=章/单元，section=节 */
  level: 'chapter' | 'section';
  /** 标题原文 */
  title: string;
  /** 该标题正文起始页的物理页号（盲文页码的数字含义） */
  page: number;
  /** 条目占用的目录行（0=目录首页第一行内容行，不含页码行） */
  lineStart: number;
  lineEnd: number;
}

/** 页码迭代无法收敛时的抖动记录 */
export interface TocOscillation {
  ordinal: number;
  title: string;
  /** 历次迭代中该条目页码的取值序列（去重保序） */
  pages: number[];
}

export interface TableOfContents {
  entries: TocEntry[];
  /** 目录占用的物理页数 */
  pageCount: number;
  /** 页码迭代轮数 */
  iterations: number;
  /** 达到不动点（目录页号与条目页码均不再变化） */
  stable: boolean;
  /** 未收敛时，哪些条目在哪些页码间来回跳 */
  oscillations: TocOscillation[];
}

const PARAGRAPH_INDENT = 2;
const DIGITS = digitsJson.digits as Record<string, string>;
const NUMBER_SIGN = digitsJson.numberSign;
const NUMBER_SIGN_DOTS = NUMBER_SIGN.split('').map(Number);

const SPACE_CELL: BrailleCell = { dots: [], kind: 'space' };
const INDENT_CELLS: BrailleCell[] = Array.from({ length: PARAGRAPH_INDENT }, () => ({ ...SPACE_CELL }));

export interface Group {
  cells: BrailleCell[];
  word: string;
  /** 组首段落缩进的方数（不计入违规词宽统计） */
  indent?: number;
}

/** 词序列 → 不可拆分组：标点并入前词（标点前不空方），其余词独立成组 */
export function buildGroups(paragraph: { words: WordCells[] }): Group[] {
  const groups: Group[] = [];
  for (const w of paragraph.words) {
    if (w.cells.length === 0) continue;
    const isPunctRun = w.cells.length > 0 && w.cells.every((c) => c.kind === 'punct');
    if (isPunctRun && groups.length > 0) {
      groups[groups.length - 1].cells.push(...w.cells);
    } else {
      groups.push({ cells: [...w.cells], word: w.source });
    }
  }
  return groups;
}

class LineWriter {
  cur: BrailleCell[] = [];
  lines: BrailleCell[][] = [];

  constructor(private width: number) {}

  newline() {
    this.lines.push(this.cur);
    this.cur = [];
  }

  /** 写入一个不可拆分组；超行宽时强制拆分并记录违规 */
  write(g: Group, violations: LayoutViolation[]) {
    if (g.cells.length > this.width) {
      violations.push({ type: 'word-too-long', word: g.word, cells: g.cells.length - (g.indent ?? 0) });
      if (this.cur.length) this.newline();
      for (let i = 0; i < g.cells.length; i += this.width) {
        this.lines.push(g.cells.slice(i, i + this.width));
      }
      return;
    }
    if (this.cur.length > 0 && this.cur.length + 1 + g.cells.length > this.width) {
      this.newline();
    }
    if (this.cur.length > 0) this.cur.push({ ...SPACE_CELL });
    this.cur.push(...g.cells);
  }

  finish() {
    if (this.cur.length > 0 || this.lines.length === 0) this.newline();
  }

  /** 段落边界：当前行未满也强制换行 */
  breakBefore() {
    if (this.cur.length > 0) this.newline();
  }
}

/** 盲文页码行：数符 + 数字方，右对齐（页码独占每页第一行） */
export function pageNumberLine(n: number, width: number): LayoutLine {
  const cells: BrailleCell[] = [{ dots: [...NUMBER_SIGN_DOTS], kind: 'prefix', source: String(n) }];
  for (const ch of String(n)) {
    const d = DIGITS[ch];
    cells.push({ dots: d.split('').map(Number), kind: 'digit', source: ch });
  }
  const pad = Math.max(0, width - cells.length);
  const line: BrailleCell[] = Array.from({ length: pad }, () => ({ ...SPACE_CELL }));
  line.push(...cells);
  return { cells: line };
}

/** 数符 + 一串十进制数字 → 盲文方（目录序号/页码共用） */
export function brailleNumberCells(n: number, kind: BrailleCell['kind'] = 'digit'): BrailleCell[] {
  const cells: BrailleCell[] = [{ dots: [...NUMBER_SIGN_DOTS], kind: 'prefix', source: String(n) }];
  for (const ch of String(n)) {
    cells.push({ dots: DIGITS[ch].split('').map(Number), kind, source: ch });
  }
  return cells;
}

export interface CollectedLines {
  lines: LayoutLine[];
  /** 每个原始段落（含空段）的起始行下标；-1 表示无可放置行（不会出现，保留语义） */
  paraStartLines: number[];
  violations: LayoutViolation[];
}

/** 段落序列 → 行序列（不跨页），同时记录每段起始行 */
export function collectLines(paragraphs: ParagraphResult[], setup: PageSetup): CollectedLines {
  const writer = new LineWriter(setup.cellsPerLine);
  const violations: LayoutViolation[] = [];
  const paraStartLines: number[] = [];

  for (const p of paragraphs) {
    writer.breakBefore();
    const startLine = writer.lines.length;
    paraStartLines.push(startLine);
    if (p.blank) {
      writer.lines.push([]);
      continue;
    }
    const groups = buildGroups(p);
    if (groups.length === 0) {
      writer.lines.push([]);
      continue;
    }
    groups[0] = { word: groups[0].word, indent: PARAGRAPH_INDENT, cells: [...INDENT_CELLS, ...groups[0].cells] };
    for (const g of groups) writer.write(g, violations);
  }
  writer.finish();

  const lines: LayoutLine[] = (writer.lines.length > 0 ? writer.lines : [[]]).map((cells) => ({ cells }));
  for (const start of paraStartLines) {
    if (start >= 0 && lines[start]) lines[start].paraStart = true;
  }
  return { lines, paraStartLines, violations };
}

/** 行序列 → 分页（纯机械切分；不改动行内容） */
export function paginateLines(
  contentLines: LayoutLine[],
  setup: PageSetup,
  showPageNumbers: boolean,
  startPageNum = 1,
): LayoutPage[] {
  const pages: LayoutPage[] = [];
  const contentPerPage = showPageNumbers ? Math.max(1, setup.linesPerPage - 1) : setup.linesPerPage;

  let pageNum = startPageNum;
  let i = 0;
  while (i < contentLines.length) {
    const chunk = contentLines.slice(i, i + contentPerPage);
    const page: LayoutPage = { number: pageNum, lines: [] };
    if (showPageNumbers) page.lines.push(pageNumberLine(pageNum, setup.cellsPerLine));
    for (const l of chunk) page.lines.push(l);
    pages.push(page);
    i += chunk.length;
    pageNum++;
  }
  return pages;
}

/** 段落序列 → 分页排版结果（不插目录；目录见 toc.ts layoutWithToc） */
export function layoutDocument(
  paragraphs: ParagraphResult[],
  setup: PageSetup,
  showPageNumbers: boolean,
): LayoutResult {
  const { lines, violations } = collectLines(paragraphs, setup);
  const pages = paginateLines(lines, setup, showPageNumbers, 1);
  return { pages, violations, toc: null };
}
