/**
 * 分页排版：段落 → 行 → 页。
 * 规则（需求文档 §4.3 / §8）：
 * - 页面 32方 × 25行（可自定义）；
 * - 词不跨行（只在词边界换行），数字/字母串不可拆分；
 * - 段首缩进 2 方；空行分段；页码（盲文数字）位于每页第一行右端；
 * - 超过整行宽度的词强制拆分并标记违规，绝不静默；
 * - 教材目录插入正文前，并迭代到目录页码与正文新页码一致。
 */
import digitsJson from '../rules/zh-digits.json';
import type { BrailleCell, PageSetup } from '../types';
import type { ParagraphResult } from './convert';

export interface LayoutLine {
  cells: BrailleCell[];
}

export interface LayoutPage {
  number: number;
  lines: LayoutLine[];
  kind?: 'toc' | 'body';
}

export interface WordTooLongViolation {
  type: 'word-too-long';
  word: string;
  cells: number;
}

export interface TocUnstableViolation {
  type: 'toc-unstable';
  titles: string[];
  pageNumbers: number[][];
}

export type LayoutViolation = WordTooLongViolation | TocUnstableViolation;

export interface TocEntryInfo {
  headingIndex: number;
  level: 1 | 2;
  title: string;
  page: number;
}

export interface TocLayoutInfo {
  pageCount: number;
  stable: boolean;
  iterations: number;
  entries: TocEntryInfo[];
  oscillations: { headingIndex: number; title: string; pageNumbers: number[] }[];
}

/** 已经转换好的目录标题和条目段落；由 buildTocLayoutInput 生成 */
export interface TocLayoutInput {
  title: ParagraphResult;
  entries: ParagraphResult[];
}

export interface LayoutResult {
  pages: LayoutPage[];
  violations: LayoutViolation[];
  toc?: TocLayoutInfo;
}

const PARAGRAPH_INDENT = 2;
const TOC_ENTRY_INDENT = 2;
const MAX_TOC_ITERATIONS = 100;
const DIGITS = digitsJson.digits as Record<string, string>;
const NUMBER_SIGN = digitsJson.numberSign;
const NUMBER_SIGN_DOTS = NUMBER_SIGN.split('').map(Number);

const SPACE_CELL: BrailleCell = { dots: [], kind: 'space' };
const INDENT_CELLS: BrailleCell[] = Array.from({ length: PARAGRAPH_INDENT }, () => ({ ...SPACE_CELL }));

interface Group {
  cells: BrailleCell[];
  word: string;
  /** 组首缩进的方数（不计入违规词宽统计） */
  indent?: number;
}

/** 词序列 → 不可拆分组：标点并入前词（标点前不空方），其余词独立成组 */
function buildGroups(paragraph: ParagraphResult): Group[] {
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

  /** 写入一个不可拆分组；超行宽时强制拆分并记录违规。reserved 为行尾必须保留的页码后缀宽度。 */
  write(g: Group, violations: LayoutViolation[], reserved = 0) {
    if (g.cells.length - (g.indent ?? 0) > this.width) {
      violations.push({ type: 'word-too-long', word: g.word, cells: g.cells.length - (g.indent ?? 0) });
      if (this.cur.length) this.newline();
      for (let i = 0; i < g.cells.length; i += this.width) {
        this.lines.push(g.cells.slice(i, i + this.width));
      }
      return;
    }
    let effectiveReserved = reserved;
    let available = this.width - effectiveReserved;
    if (this.cur.length === 0 && g.cells.length > available && effectiveReserved > 0) {
      // 页码后缀无法和当前标题组放在同一行：后缀随本组分到续行。
      effectiveReserved = 0;
      available = this.width;
    }
    if (this.cur.length > 0 && this.cur.length + 1 + g.cells.length > available) {
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

  blankLine() {
    this.breakBefore();
    this.lines.push([]);
  }
}

/** 盲文数字方：数符 + 阿拉伯数字（目录条目中的页码也使用同一规则） */
export function brailleNumberCells(n: number, source = String(n)): BrailleCell[] {
  const cells: BrailleCell[] = [{ dots: [...NUMBER_SIGN_DOTS], kind: 'prefix', source }];
  for (const ch of String(n)) {
    const d = DIGITS[ch];
    cells.push({ dots: d.split('').map(Number), kind: 'digit', source: ch });
  }
  return cells;
}

/** 盲文页码行：数符 + 数字方，右对齐（页码独占每页第一行） */
function pageNumberLine(n: number, width: number): LayoutLine {
  const cells = brailleNumberCells(n);
  const pad = Math.max(0, width - cells.length);
  const line: BrailleCell[] = Array.from({ length: pad }, () => ({ ...SPACE_CELL }));
  line.push(...cells);
  return { cells: line };
}

interface BodyLayout {
  lines: BrailleCell[][];
  paragraphStarts: number[];
  violations: LayoutViolation[];
}

/** 正文段落 → 连续内容行，并记录每段首行序号，供反查标题页码 */
function layoutBodyLines(paragraphs: ParagraphResult[], width: number): BodyLayout {
  const writer = new LineWriter(width);
  const violations: LayoutViolation[] = [];
  const paragraphStarts: number[] = [];

  paragraphs.forEach((p) => {
    writer.breakBefore();
    if (p.blank) {
      paragraphStarts.push(writer.lines.length);
      writer.lines.push([]);
      return;
    }
    const groups = buildGroups(p);
    paragraphStarts.push(writer.lines.length);
    if (groups.length === 0) {
      writer.lines.push([]);
      return;
    }
    groups[0] = { word: groups[0].word, indent: PARAGRAPH_INDENT, cells: [...INDENT_CELLS, ...groups[0].cells] };
    for (const g of groups) writer.write(g, violations);
  });
  writer.finish();

  return {
    lines: writer.lines.length > 0 ? writer.lines : [[]],
    paragraphStarts,
    violations,
  };
}

type BrailleLine = BrailleCell[];

interface TocLineBlock {
  lines: BrailleLine[];
}

/** 目录条目：顺序编号 + 完整标题 + 盲文页码；页码作为不可拆分后缀跟在标题最后一行 */
function layoutTocBlocks(
  toc: TocLayoutInput,
  pageRefs: number[],
  width: number,
  suffixWidths?: number[],
): {
  blocks: TocLineBlock[];
  violations: LayoutViolation[];
} {
  const violations: LayoutViolation[] = [];
  let tocWordId = 0;
  const withTocWordId = (g: Group): Group => ({
    ...g,
    cells: g.cells.map((c) => ({ ...c, wordId: tocWordId })),
  });

  const titleWriter = new LineWriter(width);
  for (const g of buildGroups(toc.title)) {
    titleWriter.write(withTocWordId(g), violations);
    tocWordId++;
  }
  titleWriter.blankLine();
  titleWriter.finish();
  const blocks: TocLineBlock[] = [{ lines: titleWriter.lines }];

  toc.entries.forEach((entry, i) => {
    const heading = entry.heading;
    if (!heading) return;

    const writer = new LineWriter(width);
    const groups = buildGroups(entry);
    const numberCells = brailleNumberCells(i + 1, `目录序号 ${i + 1}`);
    const indentCount = (heading.level - 1) * TOC_ENTRY_INDENT;
    const indentCells = Array.from({ length: indentCount }, () => ({ ...SPACE_CELL }));
    const firstWord = groups[0]?.word ?? heading.title;

    const pageGroup: Group = {
      cells: brailleNumberCells(pageRefs[i] ?? 1, `目录页码 ${pageRefs[i] ?? 1}`),
      word: `页码 ${pageRefs[i] ?? 1}`,
    };

    groups.unshift({
      word: firstWord,
      indent: indentCount,
      cells: [...indentCells, ...numberCells],
    });
    const suffixWidth = suffixWidths?.[i] ?? pageGroup.cells.length;
    groups.forEach((g) => {
      // 每个标题组都为页码后缀预留宽度，保证标题无论在何处折行，页码都接在最后一行末尾。
      writer.write(withTocWordId(g), violations, suffixWidth + 1);
      tocWordId++;
    });
    writer.write(withTocWordId(pageGroup), violations);
    tocWordId++;
    writer.finish();
    blocks.push({ lines: writer.lines });
  });
  return { blocks, violations };
}

function paginateTocBlocks(
  blocks: TocLineBlock[],
  setup: PageSetup,
  showPageNumbers: boolean,
  firstPageNumber: number,
): LayoutPage[] {
  const contentPerPage = showPageNumbers ? Math.max(1, setup.linesPerPage - 1) : setup.linesPerPage;
  const groups: BrailleLine[][][] = [];

  const canFit = (pageBlocks: BrailleLine[][], block: BrailleLine[]) => {
    const used = pageBlocks.reduce((sum, b) => sum + b.length, 0);
    return used === 0 || used + block.length <= contentPerPage;
  };

  for (const block of blocks.map((b) => b.lines)) {
    if (block.length > contentPerPage) {
      // 极端窄页导致整条目录超过一页：保留逐行分页，违规词已另行报告。
      for (let i = 0; i < block.length; i += contentPerPage) {
        groups.push([block.slice(i, i + contentPerPage)]);
      }
      continue;
    }
    if (groups.length === 0 || !canFit(groups[groups.length - 1], block)) groups.push([]);
    groups[groups.length - 1].push(block);
  }

  return groups
    .map((pageBlocks, i) => pageBlocks.flat())
    .filter((lines) => lines.length > 0)
    .map((lines, i) => {
      const page: LayoutPage = { number: firstPageNumber + i, lines: [], kind: 'toc' };
      if (showPageNumbers) page.lines.push(pageNumberLine(page.number, setup.cellsPerLine));
      for (const line of lines) page.lines.push({ cells: line });
      return page;
    });
}

function paginate(
  contentLines: BrailleCell[][],
  setup: PageSetup,
  showPageNumbers: boolean,
  firstPageNumber: number,
  kind: LayoutPage['kind'],
): LayoutPage[] {
  const pages: LayoutPage[] = [];
  const contentPerPage = showPageNumbers ? Math.max(1, setup.linesPerPage - 1) : setup.linesPerPage;
  const lines = contentLines.length > 0 ? contentLines : [[]];

  let pageNum = firstPageNumber;
  let i = 0;
  while (i < lines.length) {
    const chunk = lines.slice(i, i + contentPerPage);
    const page: LayoutPage = { number: pageNum, lines: [], kind };
    if (showPageNumbers) page.lines.push(pageNumberLine(pageNum, setup.cellsPerLine));
    for (const l of chunk) page.lines.push({ cells: l });
    pages.push(page);
    i += chunk.length;
    pageNum++;
  }
  return pages;
}

/** 段落序列 → 分页排版结果 */
export function layoutDocument(
  paragraphs: ParagraphResult[],
  setup: PageSetup,
  showPageNumbers: boolean,
  tocInput?: TocLayoutInput | null,
): LayoutResult {
  const body = layoutBodyLines(paragraphs, setup.cellsPerLine);
  const contentPerPage = showPageNumbers ? Math.max(1, setup.linesPerPage - 1) : setup.linesPerPage;

  if (!tocInput || tocInput.entries.length === 0) {
    return { pages: paginate(body.lines, setup, showPageNumbers, 1, 'body'), violations: body.violations };
  }

  const headingParagraphIndexes = tocInput.entries
    .map((entry) => paragraphs.indexOf(entry))
    .filter((index): index is number => index >= 0);

  let tocPageCount = 1;
  let stable = false;
  let lastTocPages: LayoutPage[] = [];
  let lastRefs: number[] = [];
  let lastViolations = body.violations;
  const history: { tocPageCount: number; refs: number[] }[] = [];
  const seen = new Set<string>();

  for (let iteration = 0; iteration < MAX_TOC_ITERATIONS; iteration++) {
    const provisionalRefs = headingParagraphIndexes.map(
      (paragraphIndex) =>
        tocPageCount + Math.floor(body.paragraphStarts[paragraphIndex] / contentPerPage) + 1,
    );
    const suffixWidths = provisionalRefs.map((page) => brailleNumberCells(page).length);
    const firstTocLayout = layoutTocBlocks(tocInput, provisionalRefs, setup.cellsPerLine, suffixWidths);
    const firstCandidatePages = paginateTocBlocks(firstTocLayout.blocks, setup, showPageNumbers, 1);
    const effectiveTocPageCount = firstCandidatePages.length;

    const pageRefs = headingParagraphIndexes.map(
      (paragraphIndex) =>
        effectiveTocPageCount + Math.floor(body.paragraphStarts[paragraphIndex] / contentPerPage) + 1,
    );
    const stateKey = `${effectiveTocPageCount}:${pageRefs.join(',')}`;
    history.push({ tocPageCount: effectiveTocPageCount, refs: [...pageRefs] });

    const effectiveSuffixWidths = pageRefs.map((page) => brailleNumberCells(page).length);
    const tocLayout = layoutTocBlocks(tocInput, pageRefs, setup.cellsPerLine, effectiveSuffixWidths);
    const candidateTocPages = paginateTocBlocks(tocLayout.blocks, setup, showPageNumbers, 1);
    const actualTocPageCount = candidateTocPages.length;
    lastTocPages = candidateTocPages;
    lastRefs = pageRefs;
    lastViolations = [...body.violations, ...tocLayout.violations];

    if (actualTocPageCount === effectiveTocPageCount) {
      stable = true;
      break;
    }
    if (seen.has(stateKey)) break;
    seen.add(stateKey);
    tocPageCount = actualTocPageCount;
  }

  const tocPages = lastTocPages;
  const bodyPages = paginate(body.lines, setup, showPageNumbers, tocPages.length + 1, 'body');
  const pages = [...tocPages, ...bodyPages];

  const oscillations = stable
    ? []
    : tocInput.entries
        .map((entry, i) => {
          const pageNumbers = [...new Set(history.map((h) => h.refs[i]))];
          return pageNumbers.length > 1 && entry.heading
            ? { headingIndex: entry.heading.index, title: entry.heading.title, pageNumbers }
            : null;
        })
        .filter((v): v is TocLayoutInfo['oscillations'][number] => v !== null);

  if (!stable) {
    lastViolations = [
      ...lastViolations,
      {
        type: 'toc-unstable',
        titles: oscillations.map((o) => o.title),
        pageNumbers: oscillations.map((o) => o.pageNumbers),
      },
    ];
  }

  return {
    pages,
    violations: lastViolations,
    toc: {
      pageCount: tocPages.length,
      stable,
      iterations: history.length,
      entries: tocInput.entries.map((entry, i) => ({
        headingIndex: entry.heading?.index ?? i,
        level: entry.heading?.level ?? 1,
        title: entry.heading?.title ?? '',
        page: lastRefs[i] ?? 0,
      })),
      oscillations,
    },
  };
}
