/**
 * 教材标题识别：支持 Markdown 标题与教材常用的“第x章 / 第x节”写法。
 * 这里只负责结构识别；标题文字仍由转换引擎正常分词和转盲文。
 */

export interface HeadingInfo {
  /** 章=1，节=2 */
  level: 1 | 2;
  /** 目录中使用的完整标题（保留教材原文中的“第一章”等编号） */
  title: string;
}

const CHINESE_CHAPTER_TITLE =
  /^第(?:[0-9０-９]+|[一二三四五六七八九十百千零两]+)[章节回篇部课].*$/;
const CHINESE_SECTION_TITLE = /^[0-9０-９]+(?:[.．、][0-9０-９]+)*\s+\S.*$/;

/** 识别一行原文是否为章/节标题。 */
export function parseHeading(line: string): HeadingInfo | null {
  const text = line.trim();
  if (!text) return null;

  const md = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(text);
  if (md) {
    const level = md[1].length === 1 ? 1 : 2;
    return { level, title: md[2].trim() };
  }

  // 目录页自身的标题不能再被收进目录，避免自引用。
  if (text === '目录') return null;

  if (CHINESE_CHAPTER_TITLE.test(text)) return { level: 1, title: text };
  if (CHINESE_SECTION_TITLE.test(text)) return { level: 2, title: text };
  return null;
}
