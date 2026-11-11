export const appNames={browser:'Microsoft Edge 浏览器',notepad:'Windows 记事本',calculator:'计算器',explorer:'文件资源管理器'};
export const operationNames={open_app:'打开应用',open_path:'打开文件或文件夹',search_files:'搜索文件',organize_folder:'整理文件夹',move_path:'移动或重命名',clipboard_read:'读取剪贴板',clipboard_write:'写入剪贴板',volume:'系统音量',get_desktop_status:'检查桌面状态',list_windows:'查看窗口',launch_app:'打开应用',browser_search:'浏览器搜索',get_window:'检查窗口',focus_window:'聚焦窗口',get_ui_tree:'读取控件',find_element:'查找控件',read_text:'读取界面',click_element:'点击控件',select_element:'选择条目',set_text:'输入文字',send_keys:'发送快捷键',mouse:'鼠标操作',save_notepad:'保存测试文件',capture_window:'窗口截图',close_window:'关闭窗口',restore_window:'恢复窗口'};

// Presentation only. Actual validation, risk decisions and approval remain in the host.
export function approvalView(approval, workspace) {
  if(!approval.windows) return {
    title:approval.agent?`${approval.agent} 请求操作授权`:approval.method?.includes('fileChange')?'Codex 请求修改文件':'Codex 请求运行命令',
    description:approval.reason||'请核对本次操作，允许后由 Codex 继续执行。',
    facts:[['工作目录',approval.cwd],['网络目标',approval.network]].filter(([,value])=>value),
    inputText:null,details:[approval.command,approval.cwd,approval.network].filter(Boolean).join('\n'),
  };
  const p=approval.params||{},target=approval.target,op=approval.tool.replace(/^windows_/,''),facts=[];
  const descriptions={
    browser_search:'在专用浏览器窗口中打开 Bing 搜索。',
    launch_app:'启动允许的应用，并验证本次专用测试窗口。',
    focus_window:'将这个测试窗口切换到前台。',
    click_element:'点击下面核验过的控件，请核对按钮含义和所在窗口。',
    select_element:'选择下面核验过的列表项或控件。',
    set_text:'替换目标文档中的现有文字，请核对目标和完整输入内容。',
    send_keys:'聚焦并验证这个测试窗口后，发送下面的按键。',
    mouse:'根据最近一次已授权截图，在测试窗口内执行一个鼠标动作。',
    save_notepad:'通过记事本另存为到专用工作区，已有文件会被拒绝覆盖。',
    capture_window:'截取此测试窗口，图像将发送给当前 Codex 模型。请核对窗口中是否含有敏感内容。',
    close_window:'请求关闭这个窗口，请先核对是否有未保存内容。应用可能弹出保存提示，工具不会自动丢弃内容。',
    restore_window:'恢复这个既有测试窗口的本次控制权限，后续输入、点击和关闭仍需分别授权。',
  };
  if(p.name)facts.push(['应用',p.name]);
  if(p.path)facts.push(['路径',p.path]);
  if(p.folder)facts.push(['文件夹',`${p.folder}${p.by?' · '+p.by+' · '+(p.apply?'执行移动':'仅预览'):''}`]);
  if(p.from)facts.push(['移动',`${p.from} → ${p.to}`]);
  if(op==='clipboard_write')facts.push(['文本长度',`${p.text.length} 字符`]);
  if(op==='volume')facts.push(['音量',`${p.action}${p.level!==undefined?' · '+p.level+'%':''}`]);
  if(p.query)facts.push(['搜索内容',p.query]);
  if(p.url)facts.push(['网址',p.url]);
  if(p.app)facts.push(['应用',appNames[p.app]||p.app]);
  const window=target?.window;
  if(window)facts.push(['窗口',window.title||`窗口 ${window.id}`],['窗口身份',`PID ${window.pid??'未知'} · HWND ${window.id}`]);
  else if(p.windowId)facts.push(['窗口编号',p.windowId]);
  if(target&&target.type!=='Window')facts.push(['实际控件',`${target.name||'未命名控件'} · ${target.type||'未知类型'}`]);
  if(target?.observedAt)facts.push(['核验时间',new Date(target.observedAt).toLocaleTimeString()]);
  if(p.filename)facts.push(['保存位置',`${workspace?workspace.replace(/[\\/]+$/,''):'test-workspace'}\\${p.filename}`]);
  if(p.key)facts.push(['按键',p.key]);
  if(p.kind)facts.push(['鼠标动作',`${{click:'单击',doubleClick:'双击',scroll:'滚动'}[p.kind]||p.kind} · 窗口内 (${p.x}, ${p.y})${p.delta!==undefined?' · 滚动量 '+p.delta:''}`]);
  return {
    title:op==='launch_app'?`打开${appNames[p.app]||'应用'}`:operationNames[op]||'Windows 操作',
    description:op==='send_keys'?(p.key==='Escape'&&window?.enabled===false?'请求取消本测试窗口的另存为弹窗，保留文档内容；其他弹窗拒绝自动处理。':descriptions.send_keys+({Enter:'回车可能激活当前按钮。','Ctrl+C':'所选内容将复制到 Windows 剪贴板。','Ctrl+A':'将选中当前控件中的全部内容。'}[p.key]||'')):descriptions[op]||'请核对下面的完整参数后决定本次授权。',facts,
    inputText:op==='set_text'?p.text:null,
    details:JSON.stringify({tool:approval.tool,params:op==='clipboard_write'?{textLength:p.text.length}:p,target:target||null},null,2),
  };
}
