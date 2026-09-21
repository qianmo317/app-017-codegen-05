/**
 * 可触摸目录测试：
 * - 章/节标题识别与按出现先后编号；
 * - 目录占页后正文顺延、目录页码为盲文数字、页码随插入重新计算直到不动点；
 * - 振荡（页码来回跳）要能报出具体条目；
 * - 长标题排成两行时续行接着写，页码挂在标题最后一行。
 */
import { describe, expect, it } from 'vitest';
import type { BrailleCell, PageSetup } from '../src/types';
import { convertText } from '../src/lib/convert';
import { brailleNumberCells, collectLines, layoutDocument } from '../src/lib/layout';
import { pagesToBRF, validateBRF } from '../src/lib/brf';
import { collectOscillations, detectHeadings, layoutWithToc, settleTocPages } from '../src/lib/toc';

const OPTS = { toneMode: 'all' as const, autoDetectPinyin: true, profile: 'zh-current' as const };
const SETUP: PageSetup = {
  cellsPerLine: 32,
  linesPerPage: 25,
  doubleSided: false,
  marginMm: { top: 20, left: 15, right: 15 },
};
const TINY: PageSetup = { ...SETUP, cellsPerLine: 12, linesPerPage: 8 };

function layout(raw: string, setup: PageSetup = SETUP, showPageNumbers = true) {
  const conv = convertText(raw, OPTS);
  return { conv, result: layoutWithToc(conv, raw, setup, showPageNumbers, OPTS) };
}

/** 与排版引擎一致：取每个段落起始行下标 */
function collectLinesForTest(conv: ReturnType<typeof convertText>) {
  return collectLines(conv.paragraphs, SETUP);
}

const NUMBER_SIGN = '3456';
const DIGIT_DOTS: Record<string, string> = {
  '1': '1', '2': '12', '3': '14', '4': '145', '5': '15',
  '6': '124', '7': '1245', '8': '125', '9': '24', '0': '245',
};
const DOTS_TO_DIGIT: Record<string, string> = {};
for (const [d, s] of Object.entries(DIGIT_DOTS)) DOTS_TO_DIGIT[s] = d;

/** 读取一行中第一个「数符+数字方」块表示的十进制数 */
function firstNumber(line: BrailleCell[]): number | null {
  let out = '';
  let active = false;
  for (const c of line) {
    const key = c.dots.join('');
    if (key === NUMBER_SIGN) {
      active = true;
      continue;
    }
    if (active && c.kind === 'digit' && DOTS_TO_DIGIT[key]) {
      out += DOTS_TO_DIGIT[key];
    } else if (active) {
      if (out) return Number(out);
      active = false;
    }
  }
  return out ? Number(out) : null;
}

/** 行中所有数字块（数符+数字方） */
function numbersInLine(line: BrailleCell[]): number[] {
  const out: number[] = [];
  let cur = '';
  let active = false;
  const flush = () => {
    if (cur) out.push(Number(cur));
    cur = '';
  };
  for (const c of line) {
    const key = c.dots.join('');
    if (key === NUMBER_SIGN) {
      flush();
      active = true;
    } else if (active && c.kind === 'digit' && DOTS_TO_DIGIT[key]) {
      cur += DOTS_TO_DIGIT[key];
    } else if (active) {
      flush();
      active = false;
    }
  }
  flush();
  return out;
}

const TEXTBOOK = `第一章 盲文基础
1.1 点符结构
盲文由六个凸点组成，每个方块有左右两列各三个点。
1.2 点位编号
第一节的内容很短。
第二章 拼音规则
2.1 声母韵母
本章讲解声母和韵母的拼合方法。
三、练习与应用
请反复摸读以上内容。`;

describe('标题识别', () => {
  it('识别「第X章/单元/课」为章，「x.y」「一、」为节', () => {
    const raw = [
      '第一章 概述', '第一单元 入门', '第三课 练习', '第十二节 附录',
      '1.1 点符', '2.10 综合', '三、练习', '1、题目一', '普通段落不是标题。', '12个学生',
    ];
    const h = detectHeadings(raw);
    expect(h.map((x) => x.level)).toEqual([
      'chapter', 'chapter', 'chapter', 'chapter',
      'section', 'section', 'section', 'section',
    ]);
  });

  it('标题按出现先后统一编号（章、节连续不分级）', () => {
    const { result } = layout(TEXTBOOK);
    expect(result.toc).not.toBeNull();
    expect(result.toc!.entries.map((e) => e.ordinal)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.toc!.entries.map((e) => e.level)).toEqual([
      'chapter', 'section', 'section', 'chapter', 'section', 'section',
    ]);
    expect(result.toc!.entries.map((e) => e.title)).toContain('三、练习与应用');
  });

  it('没有标题时不生成目录，结果与普通排版一致', () => {
    const raw = '这是一段没有任何标题的普通课文内容。';
    const { result } = layout(raw);
    expect(result.toc).toBeNull();
    expect(result.pages[0].role).toBeUndefined();
  });
});

describe('目录占页与盲文页码', () => {
  it('目录页在最前并标记为 toc，正文页号顺延', () => {
    const { result } = layout(TEXTBOOK);
    expect(result.toc!.stable).toBe(true);
    expect(result.toc!.pageCount).toBe(1);
    expect(result.pages[0].role).toBe('toc');
    expect(result.pages[1].role).toBeUndefined();
    // 物理页号：目录=1，正文从 2 起
    expect(result.pages.map((p) => p.number)).toEqual(
      Array.from({ length: result.pages.length }, (_, i) => i + 1),
    );
  });

  it('目录条目页码用盲文数字（数符 3456 + a-j 点位）写出，且与正文实际页一致', () => {
    const { result } = layout(TEXTBOOK);
    const tocPage = result.pages[0];
    const entryPages: number[] = [];
    for (const line of tocPage.lines) {
      const nums = numbersInLine(line.cells);
      if (nums.length >= 2) entryPages.push(nums[nums.length - 1]);
    }
    expect(entryPages).toEqual(result.toc!.entries.map((e) => e.page));
    // 目录中每个页码方前必须有数符：直接验证条目行末页码块
    const blocks = tocPage.lines.flatMap((l) => l.cells)
      .filter((c) => c.kind === 'digit')
      .map((c) => c.dots.join(''));
    for (const d of blocks) expect(DOTS_TO_DIGIT[d]).toBeDefined();
    // 正文首页（物理页 2）页码行是盲文 2
    const bodyFirst = result.pages.find((p) => p.role !== 'toc')!;
    expect(firstNumber(bodyFirst.lines[0].cells)).toBe(2);
  });

  it('目录插入后页码重新算过，不是插入前的旧页码', () => {
    // 构造正文本身跨页的教材：关掉目录时第一章在第 1 页；开目录后必须顺延
    const filler = '盲文课文内容需要反复触摸朗读。'.repeat(40);
    const raw = `第一章 盲文基础
1.1 入门
${filler}
第二章 进阶
2.1 提高
${filler}`;
    const { result } = layout(raw);
    const chapter1 = result.toc!.entries.find((e) => e.title.startsWith('第一章'))!;
    const chapter2 = result.toc!.entries.find((e) => e.title.startsWith('第二章'))!;
    expect(chapter1.page).toBe(2); // 目录占第 1 页，正文最早只能从 2 开始
    expect(chapter2.page).toBeGreaterThan(chapter1.page);
    // 页码与正文页内实际盲文页码一致
    for (const e of result.toc!.entries) {
      const page = result.pages.find((p) => p.number === e.page)!;
      expect(page.role).toBeUndefined();
      expect(firstNumber(page.lines[0].cells)).toBe(e.page);
    }
  });

  it('逐条对照：目录号码 = 无目录时旧页码 + 目录页数，且目录里写的不是旧值', () => {
    // 让若干章节标题自然落在正文不同页（无目录布局）
    const parts: string[] = [];
    for (let ch = 1; ch <= 6; ch++) {
      parts.push(`第${ch}章 第${ch}章标题`);
      parts.push(`${ch}.1 小节`);
      parts.push('盲文课文内容需要反复触摸朗读并书写练习。'.repeat(20));
    }
    const raw = parts.join('\n');
    const conv = convertText(raw, OPTS);
    const showPageNumbers = true;

    const pre = layoutDocument(conv.paragraphs, SETUP, showPageNumbers);
    const post = layoutWithToc(conv, raw, SETUP, showPageNumbers, OPTS);
    expect(post.toc!.stable).toBe(true);
    const tocPageCount = post.toc!.pageCount;

    // 无目录时每个标题的物理页（按 collectLines 行位置推算，与布局一致）
    const headings = detectHeadings(raw.split('\n'));
    const capacity = SETUP.linesPerPage - 1;
    const { paraStartLines } = collectLinesForTest(conv);
    headings.forEach((h, i) => {
      const stalePage = 1 + Math.floor(paraStartLines[h.paraIndex] / capacity);
      const fresh = post.toc!.entries[i].page;
      expect(fresh).toBe(stalePage + tocPageCount);
      // 旧号码（插入前那一版）绝不能还写在目录里
      expect(fresh).not.toBe(stalePage);
      // 目录条目末行实际写出的盲文数字 == fresh（内容流不含每页页码行）
      const r = post.toc!.entries[i];
      const tocPages = post.pages.filter((p) => p.role === 'toc');
      const tocFlow = tocPages.flatMap((p) => p.lines.slice(showPageNumbers ? 1 : 0));
      const lastEntryLine = tocFlow[r.lineEnd].cells;
      expect(numbersInLine(lastEntryLine).at(-1)).toBe(fresh);
    });
    void pre;
  });
});

describe('不动点迭代', () => {
  it('目录条目多到需要多页时，迭代到目录页数与页码都不再变化', () => {
    // 12×8 的小纸 + 大量章节，目录自身必然超过 1 页
    const parts: string[] = [];
    for (let i = 1; i <= 20; i++) parts.push(`第${i}章 第${i}章的标题内容`);
    parts.push('课文内容。');
    const { result } = layout(parts.join('\n'), TINY);
    expect(result.toc).not.toBeNull();
    expect(result.toc!.stable).toBe(true);
    expect(result.toc!.pageCount).toBeGreaterThan(1);
    expect(result.toc!.iterations).toBeGreaterThanOrEqual(2); // 从 1 页起步，至少重算过一次
    // 自洽性：目录写的页码 = 标题实际落在的物理页
    for (const e of result.toc!.entries) {
      const page = result.pages.find((p) => p.number === e.page)!;
      expect(page.role).toBeUndefined();
      expect(firstNumber(page.lines[0].cells)).toBe(e.page);
    }
    // 全部正文页号紧接目录页号
    const bodyStart = result.toc!.pageCount + 1;
    expect(result.pages.find((p) => p.role !== 'toc')!.number).toBe(bodyStart);
  });

  it('收敛结果对同输入确定性（重复计算一致）', () => {
    const a = layout(TEXTBOOK).result;
    const b = layout(TEXTBOOK).result;
    expect(b.toc!.entries.map((e) => e.page)).toEqual(a.toc!.entries.map((e) => e.page));
    expect(b.toc!.pageCount).toBe(a.toc!.pageCount);
  });

  it('转移函数本身振荡（目录页数在两档间来回跳）时报出不稳定与振荡条目', () => {
    // 注入 1→2→1 周期：1 页渲染出 2 页，2 页渲染成 1 页
    const settlement = settleTocPages((t) => ({
      tocPageCount: t === 1 ? 2 : 1,
      entryPages: t === 1 ? [10, 10, 11] : [11, 10, 12],
    }));
    expect(settlement.stable).toBe(false);
    expect(settlement.cycleStates.length).toBe(2);
    // 用同参数重跑 layoutWithToc 的上报逻辑：条目 1 在 10↔11，条目 3 在 11↔12
    const vals0 = [...new Set(settlement.cycleStates.map((s) => s.entryPages[0]))];
    const vals1 = [...new Set(settlement.cycleStates.map((s) => s.entryPages[1]))];
    const vals2 = [...new Set(settlement.cycleStates.map((s) => s.entryPages[2]))];
    expect(vals0).toEqual([10, 11]);
    expect(vals1).toEqual([10]); // 始终 10 → 不报告
    expect(vals2).toEqual([11, 12]);

    // 上报逻辑：只列页码真的在跳的条目，并给出标题与页码集合
    const headings = detectHeadings(['第一章 总则', '第一节 范围', '第二节 定义']);
    const report = collectOscillations(headings, settlement.cycleStates);
    expect(report).toEqual([
      { ordinal: 1, title: '第一章 总则', pages: [10, 11] },
      { ordinal: 3, title: '第二节 定义', pages: [11, 12] },
    ]);
  });

  it('不动点立即命中（1 页就装下）时只迭代 1 轮', () => {
    const { result } = layout(TEXTBOOK);
    expect(result.toc!.iterations).toBe(1);
  });
});

describe('长标题续行', () => {
  it('标题排成多行时续行缩进接着写，页码只出现在标题最后一行末尾', () => {
    const longTitle = '第一章 特殊教育学校盲文教材触觉阅读与点位辨别的基础教学方法研究';
    const { result } = layout(longTitle, TINY, false);
    expect(result.toc!.stable).toBe(true);
    const range = result.toc!.entries[0];
    expect(range.lineEnd - range.lineStart).toBeGreaterThan(0);

    // 目录内容流（去掉每页页码行；本用例关闭了页码行，直接拼接所有目录页内容行）
    const tocFlow = result.pages.filter((p) => p.role === 'toc').flatMap((p) => p.lines);
    const entryFlow = tocFlow.slice(range.lineStart, range.lineEnd + 1);

    // 标题原文的盲文方必须完整出现（接续行不能只剩前半截）：
    // 统计标题段落里有来源字符的实点方，与目录流中来源属于标题汉字的实点方逐一对照
    const conv = convertText(longTitle, OPTS);
    const h0 = detectHeadings([longTitle])[0];
    const titlePara = conv.paragraphs[h0.paraIndex];
    const titleChars = [...new Set(h0.title)].filter((ch) => /[一-鿿]/.test(ch));
    const countByChar = (cells: BrailleCell[]) => {
      const m = new Map<string, number>();
      for (const c of cells) {
        if (c.dots.length > 0 && c.source && titleChars.includes(c.source)) {
          m.set(c.source, (m.get(c.source) ?? 0) + 1);
        }
      }
      return m;
    };
    const expected = countByChar(titlePara.words.flatMap((w) => w.cells));
    const actual = countByChar(tocFlow.flatMap((l) => l.cells));
    for (const [ch, n] of expected) {
      expect(actual.get(ch), `标题字「${ch}」在目录中应出现 ${n} 次（续行不能丢字）`).toBe(n);
    }

    // 页码块只应出现在条目最后一行
    const linesWithPage = entryFlow
      .map((l) => numbersInLine(l.cells))
      .filter((ns) => ns.some((n) => n === range.page));
    expect(linesWithPage).toHaveLength(1);
    // 且页码在行末
    const lastLine = [...entryFlow[entryFlow.length - 1].cells];
    while (lastLine.length && lastLine[lastLine.length - 1].dots.length === 0) lastLine.pop();
    expect(firstNumber(lastLine)).not.toBeNull();
    // 末行最后一个实点方是数字方（页码贴右）
    expect(lastLine[lastLine.length - 1].kind).toBe('digit');
    // 引导点（5 点）只允许出现在最后一行
    for (let i = 0; i < entryFlow.length - 1; i++) {
      expect(entryFlow[i].cells.some((c) => c.dots.join('') === '5')).toBe(false);
    }
  });

  it('续行前两格为缩进空方，且所有目录行不超行宽', () => {
    const longTitle = '1.1 特殊教育学校视障学生触觉分辨能力培养的课堂教学设计与实施要点';
    const { result } = layout(longTitle, TINY, false);
    const range = result.toc!.entries[0];
    const tocFlow = result.pages.filter((p) => p.role === 'toc').flatMap((p) => p.lines);
    const entry = tocFlow.slice(range.lineStart, range.lineEnd + 1);
    for (let i = 1; i < entry.length; i++) {
      expect(entry[i].cells.slice(0, 2).every((c) => c.dots.length === 0)).toBe(true);
    }
    result.pages.forEach((p) =>
      p.lines.forEach((l) => expect(l.cells.length).toBeLessThanOrEqual(TINY.cellsPerLine)),
    );
  });

  it('引导点至少 2 个，否则页码整块挪到下一续行', () => {
    const { result } = layout('第一章 标题特别特别特别特别长', TINY, false);
    for (const p of result.pages) {
      for (const l of p.lines) {
        const run = l.cells;
        let i = 0;
        while (i < run.length) {
          if (run[i].dots.join('') === '5') {
            let j = i;
            while (j < run.length && run[j].dots.join('') === '5') j++;
            expect(j - i).toBeGreaterThanOrEqual(2);
            i = j;
          } else i++;
        }
      }
    }
  });
});

describe('盲文数字方构造', () => {
  it('数符 + 与十进制数字一致的点位', () => {
    const cells = brailleNumberCells(2026);
    expect(cells[0].dots.join('')).toBe(NUMBER_SIGN);
    expect(cells.slice(1).map((c) => c.dots.join(''))).toEqual(['12', '245', '12', '124']);
  });
});

describe('目录 BRF 导出', () => {
  it('目录页 + 正文页整体通过 BRF 结构校验（行宽/行尾空格/换页）', () => {
    const parts: string[] = [];
    for (let i = 1; i <= 12; i++) parts.push(`第${i}章 第${i}章标题`, `${i}.1 小节标题`, '课文内容。');
    const raw = parts.join('\n');
    const { result } = layout(raw);
    const brf = pagesToBRF(result.pages);
    const v = validateBRF(brf, SETUP.cellsPerLine, SETUP.linesPerPage);
    expect(v.ok, v.issues.join('；')).toBe(true);
    expect(brf.split('\f').length - 1).toBe(result.pages.length);
  });

  it('多页目录（小纸）也通过 BRF 校验', () => {
    const parts: string[] = [];
    for (let i = 1; i <= 20; i++) parts.push(`第${i}章 第${i}章的标题内容`);
    const raw = parts.join('\n');
    const { result } = layout(raw, TINY, false);
    expect(result.toc!.stable).toBe(true);
    const brf = pagesToBRF(result.pages);
    const v = validateBRF(brf, TINY.cellsPerLine, TINY.linesPerPage);
    expect(v.ok, v.issues.join('；')).toBe(true);
  });
});
