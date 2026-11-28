/**
 * Population-norm framing, zh-CN.
 *
 * The English bank catches a reply that leans on "the normal range is", "most
 * people", "the guidelines say". The Chinese equivalents are what a model
 * reaches for when it writes fluent Chinese instead of reading the reader's
 * data, so each English pattern has a Chinese sibling rather than a
 * transliteration of the English word order.
 */
export const patterns: readonly RegExp[] = [
  /正常范围(?:是|为|通常|一般)/,
  /(?:健康|多数|一般)(?:成年人|人群|人)(?:通常|一般|往往)?/,
  /(?:普通|一般|健康)人群/,
  /(?:指南|医生|专家)(?:建议|推荐|认为|主张|指出)/,
  /(?:成人|人们|大多数人)(?:通常|一般|往往)(?:需要|应达到|应该有)/,
  /(?:一般|参考|正常|典型|健康)(?:参考)?范围/,
  /(?:推荐|典型|正常|健康)(?:摄入量|水平|范围|目标)(?:是|为|在)/,
];
