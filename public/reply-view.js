// Small Markdown subset, built with DOM nodes. Model output is never HTML.
export function renderReply(document, target, text = '') {
  if (target.dataset.source === text) return;
  target.dataset.source = text;
  target.replaceChildren();
  function inline(parent, value) {
    const pattern = /\[([^\]\n]+)\]\(([^)\n]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|https?:\/\/[^\s<>\[\]（）。，！？]+/g;
    let start = 0;
    for (const match of value.matchAll(pattern)) {
      parent.append(document.createTextNode(value.slice(start, match.index)));
      let link = match[2] || (match[0].startsWith('http') ? match[0].replace(/[).,;!?]+$/, '') : null);
      if(link&&!/^https?:\/\//i.test(link)){parent.append(document.createTextNode(match[1]||match[0]));start=match.index+match[0].length;continue;}
      if(link){try{new URL(link);}catch{parent.append(document.createTextNode(match[0]));start=match.index+match[0].length;continue;}}
      const node = document.createElement(link ? 'a' : match[3] ? 'strong' : 'code');
      if (link) {
        node.href = link; node.target = '_blank'; node.rel = 'noopener noreferrer';
        node.textContent = match[1] || new URL(link).hostname + ' ↗'; node.title = link;
      } else node.textContent = match[3] || match[4];
      parent.append(node);
      if (link && !match[2]) parent.append(document.createTextNode(match[0].slice(link.length)));
      start = match.index + match[0].length;
    }
    parent.append(document.createTextNode(value.slice(start)));
  }
  let list, paragraph, code;
  const lines=String(text).split('\n');
  const cells=line=>line.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
  for (let i=0;i<lines.length;i++) {
    const line=lines[i];
    if (/^\s*```/.test(line)) {
      if (code) code = null;
      else { const pre = document.createElement('pre'); code = document.createElement('code'); pre.append(code); target.append(pre); }
      list = paragraph = null; continue;
    }
    if (code) { code.textContent += line + '\n'; continue; }
    if (!line.trim()) { list = paragraph = null; continue; }
    if(line.includes('|')&&/^\s*\|?\s*:?-{3,}/.test(lines[i+1]||'')&&cells(lines[i+1]).every(c=>/^:?-{3,}:?$/.test(c))){
      const wrap=document.createElement('div');wrap.className='reply-table';const table=document.createElement('table');wrap.append(table);target.append(wrap);
      const row=(value,tag)=>{const tr=document.createElement('tr');for(const cell of cells(value)){const td=document.createElement(tag);inline(td,cell);tr.append(td);}table.append(tr);};
      row(line,'th');i++;while(i+1<lines.length&&lines[i+1].includes('|')&&lines[i+1].trim())row(lines[++i],'td');list=paragraph=null;continue;
    }
    const heading = line.match(/^#{1,6}\s+(.+)/), bullet = line.match(/^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)/);
    if (heading) { const h = document.createElement('h4'); inline(h, heading[1]); target.append(h); list = paragraph = null; }
    else if (bullet) {
      const tag = /^\s*\d/.test(line) ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== tag) { list = document.createElement(tag); target.append(list); }
      const li = document.createElement('li'); inline(li, bullet[1]); list.append(li); paragraph = null;
    } else {
      list = null;
      if (!paragraph) { paragraph = document.createElement('p'); target.append(paragraph); }
      else paragraph.append(document.createElement('br'));
      inline(paragraph, line);
    }
  }
}
