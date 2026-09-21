/**
 * 教材可触摸目录测试：标题编号、盲文页码、插入后重排、迭代到稳定、长标题续行。
 */
import { describe, expect, it } from 'vitest';
import { convertText } from '../src/lib/convert';
import { layoutDocument, type LayoutPage } from '../src/lib/layout';
import { buildTocLayoutInput } from '../src/lib/toc';

const OPTS = { toneMode: 'all' as const, autoDetectPinyin: true, profile: 'zh-current' as const };
const SETUP = {
  cellsPerLine: 32,
  linesPerPage: 25,
  doubleSided: false,
  marginMm: { top: 20, left: 15, right: 15 },
};

function layoutWithToc(raw: string, setup = SETUP) {
  const conv = convertText(raw, OPTS);
  const toc = buildTocLayoutInput(conv, OPTS);
  const layout = layoutDocument(conv.paragraphs, setup, true, toc);
  return { conv, toc, layout };
}

function contentLines(page: LayoutPage) {
  return page.lines.slice(1);
}

function hasNumberSign(cell: { dots: number[] }) {
  return cell.dots.join('') === '3456';
}

function expectWordsDoNotCrossLines(layout: ReturnType<typeof layoutWithToc>['layout']) {
  layout.pages.forEach((page) => {
    const wordLines = new Map<number, Set<number>>();
    page.lines.forEach((line, li) => {
      line.cells.forEach((c) => {
        if (c.wordId === undefined) return;
        if (!wordLines.has(c.wordId)) wordLines.set(c.wordId, new Set());
        wordLines.get(c.wordId)!.add(li);
      });
    });
    for (const [wordId, lines] of wordLines) {
      if (lines.size > 1) {
        const source = page.lines.flatMap((line) => line.cells).find((c) => c.wordId === wordId)?.source;
        throw new Error(`${page.kind} page ${page.number}: word ${wordId}「${source}」跨 ${[...lines].join(',')} 行`);
      }
    }
  });
}

describe('教材可触摸目录', () => {
  it('章和节按出现先后连续编号，并在目录后接盲文页码', () => {
    const raw = '第一章 入门\n\n第一节 盲文\n\n正文内容。\n\n第二节 页码\n\n更多内容。';
    const { layout } = layoutWithToc(raw);

    expect(layout.toc?.stable).toBe(true);
    expect(layout.toc?.entries.map((e) => e.title)).toEqual(['第一章 入门', '第一节 盲文', '第二节 页码']);
    expect(layout.toc?.entries.map((e) => e.page)).toEqual([2, 2, 2]);

    const tocPage = layout.pages[0];
    expect(tocPage.kind).toBe('toc');
    expect(tocPage.number).toBe(1);
    expectWordsDoNotCrossLines(layout);
    const lines = contentLines(tocPage);
    const entryLines = lines.slice(2);

    [1, 2, 3].forEach((serial, i) => {
      const cells = entryLines[i].cells;
      expect(hasNumberSign(cells.find((c) => c.source === `目录序号 ${serial}`)!)).toBe(true);
      expect(cells.find((c) => c.source === String(serial))).toBeTruthy();
      const pagePrefix = cells.find((c) => c.source === `目录页码 2`);
      expect(pagePrefix && hasNumberSign(pagePrefix)).toBe(true);
      expect(cells.filter((c) => c.kind === 'digit').map((c) => c.source).join('')).toContain(String(serial));
    });
  });

  it('目录占用页后正文后移，目录中的页码按插入后的新版本计算', () => {
    // 每条标题和正文各占一行；5 内容行/页，目录约需 7 页。
    const raw = Array.from({ length: 30 }, (_, i) =>
      i % 2 === 0 ? `第${i / 2 + 1}章 教材标题${i / 2 + 1}` : `第${i / 2 + 1}章的正文内容。`,
    ).join('\n');
    const { layout } = layoutWithToc(raw, { ...SETUP, linesPerPage: 6 });
    const toc = layout.toc!;

    expect(toc.stable).toBe(true);
    expect(toc.pageCount).toBeGreaterThan(1);
    expect(toc.iterations).toBeGreaterThanOrEqual(1);
    expect(toc.entries[0].page).toBe(toc.pageCount + 1);
    expect(layout.pages[toc.pageCount - 1].kind).toBe('toc');
    expect(layout.pages[toc.pageCount].kind).toBe('body');
    expect(layout.pages[toc.pageCount].number).toBe(toc.pageCount + 1);
  });

  it('标题排成两行时，页码接在第二行末尾，第二行保留标题剩余的方', () => {
    const raw = '第一章 特殊教育学校教材目录超长标题连续排列\n\n正文。';
    const { layout } = layoutWithToc(raw, { ...SETUP, cellsPerLine: 12 });
    const tocLines = contentLines(layout.pages[0]);

    const suffixLineIndex = tocLines.findIndex((line) =>
      line.cells.some((c) => c.source?.startsWith('目录页码 ')),
    );
    expect(suffixLineIndex).toBeGreaterThanOrEqual(3);
    const firstEntryLine = tocLines[2];
    const suffixLine = tocLines[suffixLineIndex];

    expect(firstEntryLine.cells.some((c) => c.kind === 'hanzi')).toBe(true);
    expect(suffixLine.cells.some((c) => c.kind === 'hanzi')).toBe(true);
    expect(suffixLine.cells.some((c) => c.source?.startsWith('目录页码 '))).toBe(true);
    // 页码后缀与标题最后若干方在同一行，而不是单独悬空一行。
    let lastTitleIndex = -1;
    suffixLine.cells.forEach((c, i) => {
      if (c.kind === 'hanzi') lastTitleIndex = i;
    });
    const pageIndex = suffixLine.cells.findIndex((c) => c.source?.startsWith('目录页码 '));
    expect(lastTitleIndex).toBeGreaterThanOrEqual(0);
    expect(pageIndex).toBeGreaterThan(lastTitleIndex);
  });

  it('若最后一个标题词本可占满行尾，也会为页码预留位置，不让页码单独悬到下一行', () => {
    // 行宽 12：序号组占 3 方，两个 4 方标题词各占 4 方；无预留时第二个标题词会占满第二行。
    const raw = '第一章 特殊 教育\n\n正文。';
    const { layout } = layoutWithToc(raw, { ...SETUP, cellsPerLine: 12 });
    const tocLines = contentLines(layout.pages[0]);
    const suffixLineIndex = tocLines.findIndex((line) =>
      line.cells.some((c) => c.source?.startsWith('目录页码 ')),
    );

    expect(suffixLineIndex).toBeGreaterThanOrEqual(2);
    expect(tocLines[suffixLineIndex].cells.some((c) => c.kind === 'hanzi')).toBe(true);
  });

  it('识别 Markdown 标题且正文中不保留 # 标记', () => {
    const raw = '# 第一章 入门\n\n正文\n\n## 第一节 开始\n\n后续';
    const { conv, layout } = layoutWithToc(raw);

    expect(layout.toc?.entries.map((e) => e.title)).toEqual(['第一章 入门', '第一节 开始']);
    expect(conv.cells.some((c) => c.uncertain && c.source === '#')).toBe(false);
  });

  it('识别标题编号后不空格的教材写法', () => {
    const raw = '第一章入门\n\n正文';
    const { layout } = layoutWithToc(raw);
    expect(layout.toc?.entries.map((e) => e.title)).toEqual(['第一章入门']);
  });

  it('目录页自身标题“目录”不会成为目录条目', () => {
    const raw = '目录\n\n第一章 正文\n\n内容';
    const { layout } = layoutWithToc(raw);
    expect(layout.toc?.entries.map((e) => e.title)).toEqual(['第一章 正文']);
  });
});
