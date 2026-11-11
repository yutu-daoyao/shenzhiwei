export function speechText(text = '') {
  return String(text)
    .replace(/```[\s\S]*?(?:```|$)/g, '代码已显示在界面。')
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+\)/g, '$1')
    .replace(/https?:\/\/[^\s<>，。！？）]+|www\.[^\s<>，。！？）]+/gi, '')
    .replace(/\[[^\]\n]*\]\(\s*\)/g, '')
    .replace(/[*#`]/g, '')
    .replace(/[（(]\s*[)）]/g, '')
    .replace(/[ \t]+/g, ' ').trim();
}
