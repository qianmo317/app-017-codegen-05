/**
 * 构造教材可触摸目录所需的已转换内容。
 * 目录条目复用正文标题对应的 ParagraphResult，避免标题文字在正文与目录中转换不一致。
 */
import type { ConvertOptions, ConvertResult, ParagraphResult } from './convert';
import { convertText } from './convert';
import type { TocLayoutInput } from './layout';

export const TOC_TITLE = '目录';

export function buildTocLayoutInput(converted: ConvertResult, options: ConvertOptions): TocLayoutInput | null {
  const entries = converted.paragraphs.filter((p): p is ParagraphResult & { heading: NonNullable<ParagraphResult['heading']> } => !!p.heading);
  if (entries.length === 0) return null;
  return {
    title: convertText(TOC_TITLE, options).paragraphs[0],
    entries,
  };
}
