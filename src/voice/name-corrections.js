// Keep aliases separate from ASR transport so new homophones can be added here.
export const NAME_CORRECTIONS = Object.freeze({
  沈志威:'沈知微', 沈知威:'沈知微', 沈志微:'沈知微', 沈芝薇:'沈知微',
  知威:'知微', 知薇:'知微', 志威:'知微', 志微:'知微', 志薇:'知微',
  芝微:'知微', 芝薇:'知微', 芝威:'知微', 芷微:'知微', 芷薇:'知微',
  智微:'知微', 智威:'知微', 智薇:'知微', 之微:'知微', 之威:'知微', 之薇:'知微',
});

// Deliberately exclude ambiguous/common words (认位、智慧、只为、知道).
// Only a leading direct address with an explicit request may carry a command.
const request = /^(?:请|帮我|帮忙|打开|关闭|停止|你(?:好|在吗|能|帮)|在吗)/u;
const separatedRequest = /^(?:新建|创建|搜索|查找|删除|整理|移动|取消|停下|别做了|告诉我|解释|记住|忘记|播放|能不能|可以|你觉得|你认为|今天.*[吗么?？])/u;
const separators = /^[，。！？,.!?、\s：:]+/u;
export function parseAssistantAddress(text, names) {
  const textValue = String(text).normalize('NFKC').trim();
  for (const value of [textValue, textValue.replace(/^(?:你好|嘿|嗨)[，,、\s]*/u, '')]) {
    for (const name of [...names].sort((a, b) => b.length - a.length)) {
      if (!value.toLowerCase().startsWith(name)) continue;
      const suffix = value.slice(name.length);
      const addressed = suffix.replace(separators, '');
      const greeting = /^你好(?=$|[，。！？,.!?、\s：:])/u;
      const command = addressed.replace(greeting, '').replace(separators, '').trim();
      if (!command || request.test(command) || ((separators.test(suffix) || greeting.test(addressed)) && separatedRequest.test(command))) return { name, command };
    }
  }
  return null;
}

// Only direct addresses at the start of a sentence: standalone names, greetings,
// or a name followed by an explicit request. Do not rewrite embedded/quoted names.
const address = new RegExp(
  `(^|[。！？!?\\n])([\\t ]*(?:(?:你好|嘿|嗨)[，,、\\s]*)?)(${Object.keys(NAME_CORRECTIONS).join('|')})(?=[，。！？,.!?\\s]*$|[。！？!?]|[，,、\\s]*(?:请|帮我|帮忙|打开|关闭|停止|你(?:好|在吗|能|帮)|在吗))`, 'gu',
);

export function correctAssistantName(text) {
  return text.replace(address, (match, boundary, greeting, name, offset) => {
    // Conservatively leave text after an opening quote alone, including multi-sentence quotes.
    if (/[“「『"']/.test(text.slice(0, offset))) return match;
    return boundary + greeting + NAME_CORRECTIONS[name];
  });
}
