const string = { type: 'string', minLength: 1, maxLength: 200 };
const windowId = { ...string, pattern: '^[0-9]+$' };
const element = { windowId, snapshot: string, elementId: string };
const filePath = { type:'string', minLength:1, maxLength:32767 };
const definitions = [
  ['open_app', '打开常用应用或开始菜单应用；不授予该窗口的UIA控制权，禁止终端和shell。', { name:string }],
  ['open_path', '用资源管理器打开文件夹或用默认应用打开文件；拒绝程序和脚本。', { path:filePath }],
  ['search_files', '只读搜索文件名，支持包含匹配和简单星号通配符；默认搜索桌面、文档、下载和工作目录。', { query:string, folder:filePath, limit:{type:'integer',minimum:1,maximum:100} }],
  ['organize_folder', '按类型或月份整理顶层文件；默认只返回预览，apply=true才移动，不覆盖或删除。', { folder:filePath, by:{type:'string',enum:['type','date']}, apply:{type:'boolean'} }],
  ['move_path', '移动或重命名一个文件或文件夹，禁止覆盖。', { from:filePath, to:filePath }],
  ['clipboard_read', '读取系统剪贴板文本，需要本次授权。', {}],
  ['clipboard_write', '写入系统剪贴板文本，需要本次授权。', {text:{type:'string',maxLength:100000}}],
  ['volume', '获取或调节系统音量；升降每次10，set需要0-100的level。', {action:{type:'string',enum:['get','set','up','down','mute','unmute']},level:{type:'integer',minimum:0,maximum:100}}],
  ['get_desktop_status', '只检查Windows是否锁屏/处于安全桌面。锁屏时必须等待本人解锁，不得继续桌面观察或操作。', {}],
  ['list_saved_windows', '查看知微此前创建的可恢复窗口记录，只读本地元数据，不扫描桌面。重启后必须用restore_window申请本次恢复授权。', {}],
  ['restore_window', '恢复此前由知微创建的窗口绑定。只能使用list_saved_windows返回的绑定编号，须额外用户确认；校验HWND、PID、进程启动时间和所选标签页，绝不接管任意已有窗口。', {bindingId:string}],
  ['list_windows', '查看当前可见窗口的标题、PID和状态。仅新启动的测试窗口可被控制。', {}],
  ['launch_app', '启动允许的测试应用；记事本创建隔离的空白测试窗口，资源管理器仅打开测试目录；browser打开Edge专用窗口，可选url。打开后用windows_read_text读取网页，用windows_find_element/get_ui_tree找链接，再windows_click_element（InvokePattern）打开结果并再次read_text。需要本次动作授权。', { app: { type: 'string', enum: ['notepad', 'calculator', 'explorer', 'browser'] }, url: { type: 'string', minLength: 1, maxLength: 2000, pattern: '^https?://' } }],
  ['browser_search', '用Edge专用窗口打开Bing搜索。打开后用windows_read_text读取结果，用windows_find_element/get_ui_tree查找链接、windows_click_element通过InvokePattern打开，再read_text读取正文。一次动作授权。', { query: string }],
  ['get_window', '重新查询指定已授权窗口的身份和状态。', { windowId }],
  ['focus_window', '聚焦一个知微新启动的测试窗口。', { windowId }],
  ['get_ui_tree', '获取最多180个控件、6层的真实UIA树及快照标识，包含可读文本。不读取密码控件。', { windowId }],
  ['find_element', '在新的UIA树中按名称/类型/AutomationId过滤，返回快照与控件ID。', { windowId, query: string }],
  ['read_text', '通过真实UIA TextPattern/ValuePattern读取窗口文本，附观察时间，不能用对话记忆替代。', { windowId }],
  ['click_element', '重新验证快照控件身份后，通过UIA InvokePattern点击。不支持时明确失败。', element],
  ['select_element', '通过UIA SelectionItemPattern选择列表项。', element],
  ['set_text', '向指定新鲜快照中的编辑控件写文字并重新读取验证。优先ValuePattern，必要时Unicode SendInput，不使用剪贴板。', { ...element, text: { type: 'string', maxLength: 10000 } }],
  ['send_keys', '向已验证的测试窗口发送单个白名单快捷键。窗口被另存为弹窗阻塞时，Escape仅取消同一窗口的另存为弹窗，保留文档；其他模态弹窗拒绝处理。保存必须使用save_notepad。副作用需授权，不自动重放。', { windowId, key: { type: 'string', enum: ['Ctrl+A', 'Ctrl+C', 'Enter', 'Escape', 'Tab', 'Down', 'Up'] } }],
  ['mouse', '仅在先取得的真实截图仍新鲜、窗口矩形未变化且坐标未遮挡时进行一次鼠标动作。', { windowId, captureId: string, x: { type: 'integer', minimum: 0, maximum: 10000 }, y: { type: 'integer', minimum: 0, maximum: 10000 }, kind: { type: 'string', enum: ['click', 'doubleClick', 'scroll'] }, delta: { type: 'integer', minimum: -1200, maximum: 1200 } }],
  ['save_notepad', '通过UIA读取归属已核验的记事本窗口原文，由Node写入test-workspace并回读核验。仅文件名，禁止覆盖；不打开另存为对话框，记事本窗口本身仍未保存。', { windowId, filename: { type: 'string', pattern: '^[A-Za-z0-9_-]+\\.txt$', maxLength: 80 } }],
  ['capture_window', '仅在用户本次明确允许截图传给Codex后，按需截取知微测试窗口。返回真实PNG图像；不采集全屏，不自动保存。', { windowId }],
  ['close_window', '高风险：每次必须由用户额外确认。只请求关闭知微新启动窗口，不自动丢弃未保存内容。', { windowId }],
  ['get_action_status', '读取指定操作的真实状态；unknown表示副作用结果未知，禁止自动重放。', { actionId: string }],
];
export const tools = definitions.map(([op, description, properties]) => ({ name: `windows_${op}`, description, inputSchema: { type: 'object', properties, required: Object.keys(properties).filter(k => !['delta', 'url', 'folder', 'limit', 'apply', 'level'].includes(k) || (op === 'organize_folder' && k === 'folder')), additionalProperties: false }, annotations: { readOnlyHint: ['search_files', 'get_desktop_status', 'list_saved_windows', 'list_windows', 'get_window', 'get_ui_tree', 'find_element', 'read_text', 'get_action_status'].includes(op), destructiveHint: op === 'close_window', idempotentHint: false, openWorldHint: false } }));
export const readOnly = new Set(tools.filter(t => t.annotations.readOnlyHint).map(t => t.name));
export function validate(name, params) {
  const definition = tools.find(t => t.name === name);
  if (!definition || !params || typeof params !== 'object' || Array.isArray(params)) throw new Error('无效的 Windows 工具或参数');
  const schema = definition.inputSchema;
  for (const key of Object.keys(params)) if (!Object.hasOwn(schema.properties, key)) throw new Error(`不允许的参数：${key}`);
  for (const key of schema.required) if (!Object.hasOwn(params, key)) throw new Error(`缺少参数：${key}`);
  for (const [key, value] of Object.entries(params)) {
    const s = schema.properties[key];
    if (s.type === 'string' && (typeof value !== 'string' || value.length < (s.minLength ?? 0) || value.length > (s.maxLength ?? 10000) || (s.pattern && !new RegExp(s.pattern).test(value)))) throw new Error(`参数 ${key} 无效`);
    if (s.type === 'integer' && (!Number.isInteger(value) || value < s.minimum || value > s.maximum)) throw new Error(`参数 ${key} 超出范围`);
    if (s.type === 'boolean' && typeof value !== 'boolean') throw new Error(`参数 ${key} 无效`);
    if (s.enum && !s.enum.includes(value)) throw new Error(`参数 ${key} 不在白名单中`);
  }
  if (name === 'windows_volume' && params.action === 'set' && params.level === undefined) throw new Error('参数 level 是设置音量必需的');
  if (name === 'windows_launch_app' && params.url !== undefined) {
    let url;
    try { url = new URL(params.url); } catch { throw new Error('参数 url 无效'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('参数 url 无效');
  }
  if (name === 'windows_mouse' && params.kind === 'scroll' && (!Number.isInteger(params.delta) || params.delta === 0)) throw new Error('滚动需要非零 delta');
  if (name === 'windows_save_notepad' && /^(con|prn|aux|nul|com[0-9]|lpt[0-9])\./i.test(params.filename)) throw new Error('不允许使用 Windows 保留设备名作为文件名');
}
