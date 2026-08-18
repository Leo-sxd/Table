/* ============================================================
 * Table - 逻辑脚本（script.js）
 * ------------------------------------------------------------
 * 功能：
 *  1. 大学生课程表：手动录入 / 教务系统网页(HTML)导入 /
 *     CSV 模板导入 / 粘贴导入；周次导航、今日课程高亮。
 *     重要：开学第一天(上课)日期必须准确，否则当前周与
 *     当日课程会计算错误。
 *  2. Edge 收藏夹：一键导入（本地 Bookmarks JSON 或
 *     导出的 HTML）、分类管理、搜索、点击跳转。
 *  3. 网页智能体：DeepSeek API（function calling 工具调用），
 *     可让智能体执行：查周次、查课表、打开收藏网站、
 *     添加课程/收藏、分类、切换页面等。
 * ------------------------------------------------------------
 * 数据全部保存在浏览器 localStorage。
 * ============================================================ */
'use strict';

/* ==================== 工具函数 ==================== */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, m => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
));
const round2 = n => Math.round(n * 100) / 100;
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const PALETTE = ['#4f6ef7', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1'];

function todayMidnight() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function dateStr(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function parseDate(str) {
  if (!str) return null;
  const [y, m, d] = String(str).split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}
function colorOf(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

let toastTimer = null;
function toast(msg, type = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ==================== 存储 ==================== */
const LS = {
  courses: 'td_courses_v1',
  bookmarks: 'td_bookmarks_v1',
  categories: 'td_categories_v1',
  settings: 'td_settings_v1',
  agent: 'td_agent_v1',
  sessions: 'td_sessions_v1',
  sessCurrent: 'td_sessions_v1_current',
  tasks: 'td_tasks_v1',
  reminders: 'td_reminders_v1',
  events: 'td_events_v1',
  usage: 'td_usage_v1',
  balance: 'td_balance_v1',
  map: 'td_map_v1',
  fences: 'td_fences_v1',
};
function load(key, def) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : def;
  } catch (e) { return def; }
}
function save(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

let settings = load(LS.settings, { semesterStart: '', maxSection: 12 });
let courses = load(LS.courses, []);
let bookmarks = load(LS.bookmarks, []);
let categories = load(LS.categories, ['学习', '工具', '娱乐', '资讯', '生活']);
let agentCfg = load(LS.agent, { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', voiceFix: true });
let sessions = load(LS.sessions, []);   // 保存的对话列表
let currentSid = '';                    // 当前对话 id（空=新对话）
let tasks = load(LS.tasks, []);         // 待办任务 [{id,title,note,due,done,reminded,createdAt}]
let reminders = load(LS.reminders, []); // 提醒记录 [{id,taskId,title,due,time,read}]
let events = load(LS.events, []);       // 规划事件 [{id,name,start,end,color}] start/end 为 YYYY-MM-DD
let usageStats = load(LS.usage, { byDay: {} }); // 本地用量统计 { byDay: { 'YYYY-MM-DD': {requests,promptTokens,completionTokens,totalTokens,hours,models} } }
let balance = load(LS.balance, null);   // 官方余额快照 {ok,total,granted,topped,currency,time} 或 {ok:false,error}
let usRange = 'today';                  // 用量中心当前范围 today/7d/30d/all
let mapCfg = load(LS.map, { key: '', securityCode: '' }); // 高德地图配置（用户手动填写）
let fences = load(LS.fences, []);        // 电子围栏 [{id,name,type:polygon|circle,polygon:{path},circle:{center,radius},createdAt,updatedAt}]

/* ==================== 周次计算 ==================== */
function weekInfo() {
  const start = parseDate(settings.semesterStart);
  const today = todayMidnight();
  const weekday = (today.getDay() + 6) % 7 + 1; // 1=周一 … 7=周日
  if (!start || isNaN(start.getTime())) return { week: null, weekday, today, start: null, isHoliday: false };
  const diff = Math.round((today.getTime() - start.getTime()) / 86400000);
  const week = diff < 0 ? 0 : Math.floor(diff / 7) + 1;
  // 安全逻辑：尚未开学(week=0) 或 该周没有任何课程卡片 → 视为假期
  const isHoliday = week === 0 || weekHoliday(week);
  return { week, weekday, today, start, isHoliday };
}
/* 安全逻辑：某周没有任何课程卡片 → 视为假期 */
function weekHoliday(w) {
  return w >= 1 && !courses.some(c => c.weeks.includes(w));
}
function getMondayOfWeek(w) {
  const start = parseDate(settings.semesterStart);
  if (!start) return null;
  const d = new Date(start);
  d.setDate(d.getDate() + (w - 1) * 7);
  return d;
}
function maxWeek() {
  const wi = weekInfo();
  let m = 30;
  if (wi.week) m = Math.max(m, wi.week);
  courses.forEach(c => c.weeks.forEach(w => { if (w > m) m = w; }));
  return m;
}

/* ==================== 节次时间 ==================== */
/* 常见默认时间表：第1节 08:00-08:45，第2节 08:55-09:40 … */
const DEFAULT_TIMES = [
  '08:00', '08:45', '08:55', '09:40', '10:00', '10:45', '10:55', '11:40',
  '14:00', '14:45', '14:55', '15:40', '16:00', '16:45', '16:55', '17:40',
  '19:00', '19:45', '19:55', '20:40', '20:50', '21:35', '21:45', '22:30',
];
/* 读取某一节的时间 {s, e}；未设置返回 null */
function secTime(sec) {
  const arr = settings.secTimes || [];
  const raw = arr[sec];
  if (!raw) return null;
  const parts = String(raw).split('|');
  return parts[0] && parts[1] ? { s: parts[0], e: parts[1] } : null;
}
/* 课程整体时间段，如 08:00-09:40；缺任一节时间返回空串 */
function courseTime(c) {
  const st = secTime(c.startSec);
  const en = secTime(c.endSec);
  if (!st || !en) return '';
  return st.s + '-' + en.e;
}

/* ==================== 周次文本解析 ==================== */
function parseWeeks(text) {
  const t = String(text || '').replace(/\s/g, '');
  if (!t) return [];
  const out = [];
  const odd = /单/.test(t);
  const even = /双/.test(t);
  const range = t.match(/(\d+)-(\d+)/);
  if (range) {
    const a = +range[1], b = +range[2];
    for (let w = a; w <= b; w++) {
      if (odd && w % 2 === 0) continue;
      if (even && w % 2 === 1) continue;
      out.push(w);
    }
  } else {
    (t.match(/\d+/g) || []).forEach(n => out.push(+n));
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/* ==================== 课程对象 ==================== */
function mkCourse(o) {
  return Object.assign({
    id: uid(), name: '', teacher: '', location: '',
    day: 1, startSec: 1, endSec: 2,
    weeks: [], weeksText: '', color: '', note: '',
  }, o);
}
/* 从导入/表单字段构建课程；无效返回 null */
function buildCourse(partial) {
  const name = (partial.name || '').trim();
  const weeks = parseWeeks(partial.weeksText);
  if (!name) return null;
  if (!weeks.length) return null;
  const day = +partial.day;
  const startSec = +partial.startSec;
  const endSec = +partial.endSec;
  if (!(day >= 1 && day <= 7)) return null;
  if (!(startSec >= 1 && endSec >= startSec)) return null;
  return mkCourse({
    name,
    teacher: (partial.teacher || '').trim(),
    location: (partial.location || '').trim(),
    day, startSec, endSec,
    weeks,
    weeksText: (partial.weeksText || '').trim() || '1-16周',
    color: colorOf(name),
    note: (partial.note || '').trim(),
  });
}

/* ==================== 课程表渲染 ==================== */
let viewWeek = null; // 当前查看的周
function ensureViewWeek() {
  if (viewWeek == null) {
    const wi = weekInfo();
    viewWeek = (wi.week && wi.week >= 1) ? wi.week : 1;
  }
}

function renderWeekBadge() {
  const wi = weekInfo();
  if (wi.week === null) $('#cur-week-label').textContent = '第 — 周';
  else if (wi.week === 0) $('#cur-week-label').textContent = '未开学 · 🎉 假期';
  else $('#cur-week-label').textContent = `第 ${wi.week} 周${wi.isHoliday ? ' · 🎉 假期' : ''}`;
  $('#today-label').textContent = `今天是 ${WEEKDAYS[wi.weekday - 1]} · ${dateStr(wi.today)}`;
}

function renderWeekNav() {
  const sel = $('#wk-select');
  const mw = maxWeek();
  const cur = weekInfo().week;
  ensureViewWeek();
  viewWeek = Math.min(Math.max(1, viewWeek), mw);
  sel.innerHTML = Array.from({ length: mw }, (_, i) => {
    const w = i + 1;
    const mark = cur === w ? '（当前）' : '';
    return `<option value="${w}">第${w}周${mark}</option>`;
  }).join('');
  sel.value = viewWeek;
}

function renderSchedule() {
  const grid = $('#schedule-grid');
  const maxSec = +settings.maxSection || 12;
  const monday = getMondayOfWeek(viewWeek);
  const wi = weekInfo();
  const isCurWeek = !!(monday && wi.week && viewWeek === wi.week);

  if (!courses.length) {
    grid.innerHTML = '<div class="sch-empty">还没有课程<br/>点击右上角「＋ 添加课程」或「⬇ 导入课表」开始</div>';
    return;
  }

  let head = '<div class="sch-head"><div class="sch-day-head" style="width:64px;flex:none"></div>';
  for (let d = 1; d <= 7; d++) {
    const date = monday ? new Date(monday.getTime() + (d - 1) * 86400000) : null;
    const todayCls = (isCurWeek && wi.weekday === d) ? ' today' : '';
    head += `<div class="sch-day-head${todayCls}">${WEEKDAYS[d - 1]}<b>${date ? `${date.getMonth() + 1}/${date.getDate()}` : '—'}</b></div>`;
  }
  head += '</div>';

  let body = '<div class="sch-body">';
  body += '<div class="sch-time">' + Array.from({ length: maxSec }, (_, i) => {
    const t = secTime(i + 1);
    return `<div><b>${i + 1}</b>${t ? `<span>${t.s}</span>` : ''}</div>`;
  }).join('') + '</div>';
  for (let d = 1; d <= 7; d++) {
    const todayCls = (isCurWeek && wi.weekday === d) ? ' today' : '';
    const list = courses
      .filter(c => c.day === d && c.weeks.includes(viewWeek))
      .sort((a, b) => a.startSec - b.startSec);
    // 按时间段分组：同格多课 → 同名合并 / 异名并排
    const groups = new Map();
    for (const c of list) {
      const key = c.startSec + '-' + c.endSec;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(c);
    }
    let blocks = '';
    for (const arr of groups.values()) {
      const c0 = arr[0];
      const top = (c0.startSec - 1) * 48 + 2;
      const h = (c0.endSec - c0.startSec + 1) * 48 - 4;
      if (arr.length === 1) {
        const c = c0;
        const col = c.color || colorOf(c.name);
        const meta = [c.teacher, c.location].filter(Boolean).join(' @ ');
        const tStr = courseTime(c);
        blocks += `<div class="sch-block" data-id="${c.id}" title="${esc(c.name + ' ' + meta + ' ' + c.weeksText + (tStr ? ' ' + tStr : ''))}"
          style="top:${top}px;height:${h}px;background:${col}1a;border-left:4px solid ${col};">
          <div class="blk-name" style="color:${col}">${esc(c.name)}</div>
          ${meta ? `<div class="blk-meta">${esc(meta)}</div>` : ''}</div>`;
      } else if (arr.every(c => c.name === c0.name)) {
        // 同名同时间段（理论/实验拆分、双教师）→ 合并为一个块
        const col = c0.color || colorOf(c0.name);
        const teachers = [...new Set(arr.map(c => c.teacher).filter(Boolean))].join('、');
        const locations = [...new Set(arr.map(c => c.location).filter(Boolean))].join('、');
        const weeksT = [...new Set(arr.map(c => c.weeksText).filter(Boolean))].join('、');
        const meta = [teachers, locations].filter(Boolean).join(' @ ');
        const tStr = courseTime(c0);
        blocks += `<div class="sch-block" data-ids="${arr.map(c => c.id).join(',')}" title="${esc(c0.name + ' | ' + meta + ' | ' + weeksT + (tStr ? ' | ' + tStr : ''))}"
          style="top:${top}px;height:${h}px;background:${col}1a;border-left:4px solid ${col};">
          <div class="blk-name" style="color:${col}">${esc(c0.name)}</div>
          ${meta ? `<div class="blk-meta">${esc(meta)}</div>` : ''}
          <div class="blk-meta">${esc(weeksT)}</div></div>`;
      } else {
        // 不同课程挤在同一时间段 → 并排显示
        blocks += `<div class="sch-slot" style="top:${top}px;height:${h}px">` + arr.map(c => {
          const col = c.color || colorOf(c.name);
          const meta = [c.teacher, c.location].filter(Boolean).join(' @ ');
          const tStr = courseTime(c);
          return `<div class="sch-block" data-id="${c.id}" title="${esc(c.name + ' ' + meta + ' ' + c.weeksText + (tStr ? ' ' + tStr : ''))}"
            style="background:${col}1a;border-left:4px solid ${col};">
            <div class="blk-name" style="color:${col}">${esc(c.name)}</div>
            ${meta ? `<div class="blk-meta">${esc(meta)}</div>` : ''}</div>`;
        }).join('') + '</div>';
      }
    }
    body += `<div class="sch-day${todayCls}" style="height:${maxSec * 48}px">${blocks}</div>`;
  }
  body += '</div>';
  grid.innerHTML = head + body;
}

function renderToday() {
  const wi = weekInfo();
  const box = $('#today-panel');
  if (wi.week === null) {
    box.innerHTML = '<h3>📌 今日课程</h3><div class="tp-empty">请先准确设置「开学第一天（上课）日期」，才能计算今天属于第几周、该上什么课。</div>';
    return;
  }
  if (wi.week === 0) {
    box.innerHTML = `<h3>📌 今日课程</h3><div class="tp-empty">🎉 尚未开学（开学日期 ${esc(settings.semesterStart)}），假期中</div>`;
    return;
  }
  if (wi.isHoliday) {
    box.innerHTML = `<h3>📌 今日课程 · 第 ${wi.week} 周 · ${WEEKDAYS[wi.weekday - 1]}</h3><div class="tp-empty">🎉 本周为假期（本周无课程安排）</div>`;
    return;
  }
  const list = mergeSameSlotCourses(courses
    .filter(c => c.day === wi.weekday && c.weeks.includes(wi.week)))
    .sort((a, b) => a.startSec - b.startSec);
  const secTxt = c => c.startSec === c.endSec ? `第${c.startSec}节` : `第${c.startSec}-${c.endSec}节`;
  const meta = c => [c.teacher, c.location].filter(Boolean).join(' @ ');
  box.innerHTML = `<h3>📌 今日课程 · 第 ${wi.week} 周 · ${WEEKDAYS[wi.weekday - 1]}</h3>` + (
    list.length
      ? list.map(c => {
          const tStr = courseTime(c);
          return `<div class="tp-item" style="border-left:4px solid ${c.color}">
          ${tStr ? `<span class="tp-time">${tStr}</span>` : ''}
          <span class="tp-sec">${secTxt(c)}</span><b>${esc(c.name)}</b>
          <span style="color:var(--ink2)">${esc(meta(c))}</span>
          <span class="badge">${esc(c.weeksText)}</span></div>`;
        }).join('')
      : '<div class="tp-empty">今天没有课 🎉</div>'
  );
}

function updateBanner() {
  const wi = weekInfo();
  // 仅当开学日期未设置时显示警示（尚未开学属正常假期，不再提示）
  $('#banner-warn').classList.toggle('hidden', wi.week !== null);
}

/* ==================== 课程增删改 ==================== */
let editingCourseId = null;
function openCourseModal(id) {
  editingCourseId = id || null;
  const c = id ? courses.find(x => x.id === id) : null;
  $('#c-title').textContent = c ? '编辑课程' : '添加课程';
  $('#c-name').value = c ? c.name : '';
  $('#c-teacher').value = c ? c.teacher : '';
  $('#c-location').value = c ? c.location : '';
  $('#c-day').value = c ? c.day : 1;
  $('#c-start').value = c ? c.startSec : 1;
  $('#c-end').value = c ? c.endSec : 2;
  $('#c-weeks').value = c ? c.weeksText : '1-16周';
  $('#c-note').value = c ? c.note : '';
  $('#c-delete').classList.toggle('hidden', !c);
  $('#modal-course').classList.remove('hidden');
  $('#c-name').focus();
}
function closeModal(id) { $('#' + id).classList.add('hidden'); }

function saveCourseFromForm() {
  const partial = {
    name: $('#c-name').value,
    teacher: $('#c-teacher').value,
    location: $('#c-location').value,
    day: $('#c-day').value,
    startSec: $('#c-start').value,
    endSec: $('#c-end').value,
    weeksText: $('#c-weeks').value,
    note: $('#c-note').value,
  };
  if (+partial.startSec > +partial.endSec) return toast('开始节次不能大于结束节次', 'warn');
  const built = buildCourse(partial);
  if (!built) return toast('请正确填写：课程名称、星期、节次和有效周次（如 1-16周）', 'warn');

  if (editingCourseId) {
    const idx = courses.findIndex(x => x.id === editingCourseId);
    if (idx >= 0) courses[idx] = Object.assign({}, courses[idx], built, { id: editingCourseId });
    toast('课程已更新');
  } else {
    courses.push(built);
    toast('课程已添加');
  }
  save(LS.courses, courses);
  closeModal('modal-course');
  renderAll();
}
function deleteCourseFromModal() {
  if (!editingCourseId) return;
  if (!confirm('确定删除这门课程吗？')) return;
  courses = courses.filter(x => x.id !== editingCourseId);
  save(LS.courses, courses);
  closeModal('modal-course');
  renderAll();
  toast('已删除');
}

/* ==================== 节次时间设置 ==================== */
function openTimesModal() {
  const maxSec = +settings.maxSection || 12;
  const box = $('#times-table');
  let html = '<div class="tt-row tt-head"><span>节次</span><span>开始时间</span><span>结束时间</span></div>';
  for (let i = 1; i <= maxSec; i++) {
    const t = secTime(i);
    html += `<div class="tt-row"><span>第${i}节</span>
      <input type="time" class="tt-s" data-sec="${i}" value="${t ? t.s : ''}" />
      <input type="time" class="tt-e" data-sec="${i}" value="${t ? t.e : ''}" /></div>`;
  }
  box.innerHTML = html;
  $('#modal-times').classList.remove('hidden');
}
function fillDefaultTimes() {
  $$('#times-table .tt-row:not(.tt-head)').forEach(row => {
    const sec = +row.querySelector('.tt-s').dataset.sec;
    if (sec >= 1 && (sec - 1) * 2 + 1 < DEFAULT_TIMES.length) {
      row.querySelector('.tt-s').value = DEFAULT_TIMES[(sec - 1) * 2];
      row.querySelector('.tt-e').value = DEFAULT_TIMES[(sec - 1) * 2 + 1];
    }
  });
  toast('已填充默认时间表，可再手动调整');
}
function saveTimes() {
  const arr = [null];
  $$('#times-table .tt-row:not(.tt-head)').forEach(row => {
    const sec = +row.querySelector('.tt-s').dataset.sec;
    const s = row.querySelector('.tt-s').value;
    const e = row.querySelector('.tt-e').value;
    arr[sec] = (s && e) ? s + '|' + e : '';
  });
  settings.secTimes = arr;
  save(LS.settings, settings);
  closeModal('modal-times');
  renderAll();
  toast('节次时间已保存');
}

/* ==================== 导入：HTML / CSV / 粘贴 ==================== */
let importMode = 'html';
let pendingCourses = [];

function openImport(mode) {
  importMode = mode;
  const guide = $('#im-guide');
  const pasteBox = $('#im-paste');
  const preview = $('#im-preview');
  const confirmBtn = $('#im-confirm');
  preview.classList.add('hidden');
  confirmBtn.classList.add('hidden');

  if (mode === 'paste') {
    $('#im-title').textContent = '粘贴文本导入';
    guide.classList.add('hidden');
    pasteBox.classList.remove('hidden');
  } else if (mode === 'html') {
    $('#im-title').textContent = '教务系统网页(HTML)导入';
    pasteBox.classList.add('hidden');
    guide.classList.remove('hidden');
    guide.innerHTML = `
      <div class="guide">
        <b>📄 从正方教务系统导入步骤：</b><br/>
        1. 用浏览器登录教务系统 <code>https://cloud.zfsoft.com:6143</code><br/>
        2. 打开「我的课表 / 学生课表查询」页面（<b>在显示课表的那个页面上操作</b>）<br/>
        3. 按 <code>Ctrl+S</code> 保存：选「网页，仅HTML」或「网页，完整」均可；MHTML 单文件也支持<br/>
        4. 点击下方按钮选择刚保存的文件<br/>
        5. 核对下方预览无误后点「确认导入」<br/>
        <b>说明：</b>自动识别 UTF-8 / GBK 编码、表格与网格两种页面结构，无需手动转码。
        若解析仍失败，请把保存的 HTML 文件发给开发者适配。
        导入前请确认上方「开学第一天」日期已准确设置。
      </div>
      <button class="btn primary" id="im-file-btn">📂 选择 HTML 文件</button>`;
  } else {
    $('#im-title').textContent = 'CSV 模板导入';
    pasteBox.classList.add('hidden');
    guide.classList.remove('hidden');
    guide.innerHTML = `
      <div class="guide">
        <b>📊 CSV 模板列：</b>课程名称,教师,教室,星期(1-7),开始节次,结束节次,周次,备注<br/>
        周次支持 <code>1-16周</code>、<code>1-8周(单)</code>、<code>2-16周(双)</code>。
        Excel 编辑后请「另存为 CSV」。<br/>
        若教务系统支持导出课表 Excel，可整理成该模板后导入。
      </div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn primary" id="im-file-btn">📂 选择 CSV 文件</button>
        <button class="btn ghost" data-act="template">⬇ 下载 CSV 模板</button>
      </div>`;
  }
  $('#modal-import').classList.remove('hidden');
  bindGuideButtons();
}

function bindGuideButtons() {
  const fb = $('#im-file-btn');
  if (fb) fb.addEventListener('click', () => {
    const fi = $('#file-import');
    fi.accept = importMode === 'html' ? '.html,.htm,.mhtml,.mht' : '.csv,.txt';
    fi.value = '';
    fi.click();
  });
  const tb = $('#im-guide').querySelector('[data-act="template"]');
  if (tb) tb.addEventListener('click', downloadTemplate);
}

function downloadTemplate() {
  const csv = '\uFEFF' + [
    '课程名称,教师,教室,星期(1-7),开始节次,结束节次,周次,备注',
    '高等数学,张老师,教101,1,1,2,1-16周,',
    '大学英语,李老师,教202,3,3,4,2-16周(双),',
  ].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = '课程表导入模板.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('模板已下载');
}

function readTextSmart(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsText(file, 'UTF-8');
  });
}

async function handleImportFile(file) {
  if (!file) return;
  try {
    if (importMode === 'csv') {
      const text = await readTextSmart(file);
      const { parsed, skipped } = parseCSV(text);
      showPreview(parsed, skipped, null);
      return;
    }
    // HTML 模式：按字节读取 → 自动识别编码 → 处理 MHTML
    const buf = await file.arrayBuffer();
    const { text, enc } = decodeBytes(buf);
    const head = text.slice(0, 4000);
    const isMh = /MIME-Version:\s*1\.0/i.test(head) && /multipart\//i.test(head);
    let html = text;
    if (isMh) {
      const part = extractMhtmlHtml(text);
      if (part) html = part;
    }
    const { parsed, skipped, diag } = parseJwHtml(html);
    diag.enc = enc;
    diag.mhtml = isMh;
    showPreview(parsed, skipped, diag);
  } catch (err) {
    toast('解析失败：' + (err.message || err), 'err');
  }
}

function showPreview(list, skipped, diag) {
  pendingCourses = list.map(c => Object.assign({}, c));
  $('#im-guide').classList.add('hidden');
  $('#im-paste').classList.add('hidden');
  $('#im-preview').classList.remove('hidden');
  $('#im-confirm').classList.toggle('hidden', !list.length);
  let summary = `识别到 ${list.length} 门课程${skipped ? `，跳过 ${skipped} 条无法识别的记录` : ''}。<b>若个别行的星期 / 节次 / 周次识别有误，可直接在表格中修改</b>，核对后确认导入：`;
  if (!list.length && diag) {
    summary += `<br/><span style="color:#b45309">🔎 诊断信息：检测到表格 ${diag.tables} 个（最优表格得分 ${diag.bestTableScore}）· 含「周」的单元格 ${diag.cellsWithWeek} 个 · 疑似课程块元素 ${diag.divCandidates} 个 · 文件编码 ${diag.enc}${diag.mhtml ? ' · MHTML 单文件' : ''}。</span>
    <br/><span style="color:#b45309">请检查：① 保存的是否为打开课表后的页面；② 若课表在新窗口或子页面中显示，请直接在课表页按 Ctrl+S；③ 若课表是图片或 Flash，需改用「粘贴导入」手动整理；④ 仍失败请把该 HTML 文件发给开发者适配。</span>`;
  }
  $('#im-summary').innerHTML = summary;
  const body = $('#im-preview-body');
  const shown = pendingCourses.slice(0, 200);
  body.innerHTML = shown.map(c => `<tr>
    <td>${esc(c.name)}</td><td>${esc(c.teacher)}</td><td>${esc(c.location)}</td>
    <td><select class="pv-day" data-id="${c.id}">${[1, 2, 3, 4, 5, 6, 7].map(d => `<option value="${d}" ${c.day === d ? 'selected' : ''}>${WEEKDAYS[d - 1]}</option>`).join('')}</select></td>
    <td><input class="pv-ss" type="number" min="1" max="14" value="${c.startSec}" data-id="${c.id}" style="width:46px" /> - <input class="pv-es" type="number" min="1" max="14" value="${c.endSec}" data-id="${c.id}" style="width:46px" /></td>
    <td><input class="pv-weeks" type="text" value="${esc(c.weeksText)}" data-id="${c.id}" style="width:88px" /></td>
  </tr>`).join('') || '<tr><td colspan="6">无有效记录</td></tr>';
}

function confirmImport() {
  // 用户可能在预览中修改过，重新校验一次
  const raw = pendingCourses.map(c => buildCourse(c)).filter(Boolean);
  if (!raw.length) return toast('没有可导入的课程', 'warn');
  if (raw.length < pendingCourses.length) {
    toast(`有 ${pendingCourses.length - raw.length} 行数据无效（如周次格式错误）已被跳过`, 'warn');
  }
  // 合并同位置同名课程（理论/实验拆分、双教师）
  const valid = mergeSameSlotCourses(raw);
  courses.push(...valid);
  save(LS.courses, courses);
  closeModal('modal-import');
  renderAll();
  const merged = raw.length - valid.length;
  toast(`成功导入 ${valid.length} 门课程${merged ? `（已自动合并 ${merged} 组重叠课程）` : ''}`);
  if (!parseDate(settings.semesterStart)) {
    toast('别忘了设置「开学第一天」日期，否则当前周/今日课程无法计算', 'warn');
  }
}

/* ---- 教务系统 HTML 解析（多策略） ---- */
const LOC_RE = /楼|室|馆|场|区|院|中心|实训|教[A-Za-z0-9]|教室/;

/* 编码自动识别：UTF-8 严格解码失败则回退 GBK */
function decodeBytes(buf) {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), enc: 'UTF-8' };
  } catch (e) {
    try {
      return { text: new TextDecoder('gbk').decode(buf), enc: 'GBK' };
    } catch (e2) {
      return { text: new TextDecoder('utf-8').decode(buf), enc: 'UTF-8(容错)' };
    }
  }
}

/* MHTML 单文件：提取其中的 HTML 片段 */
function extractMhtmlHtml(text) {
  const bm = text.match(/boundary\s*=\s*"?([^"\r\n;]+)/i);
  if (!bm) return null;
  const boundary = bm[1].trim();
  const parts = text.split('--' + boundary);
  for (const part of parts) {
    if (!/Content-Type:[^\r\n]*text\/html/i.test(part)) continue;
    let body = part.replace(/^[\s\S]*?\r?\n\r?\n/, '');
    if (/Content-Transfer-Encoding:\s*base64/i.test(part)) {
      body = atob(body.replace(/\s+/g, ''));
    } else if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(part)) {
      body = body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
    }
    body = body.replace(/\r?\n--\s*$/, '');
    return body;
  }
  return null;
}

/* 节次文本解析：优先取独占一行的节次行，支持 1-2节 / 第1-2节 / 3、4节 / 第5节 / 上午1-2节 */
function parseSecText(t) {
  const src = String(t || '');
  const lines = src.split('\n').map(s => s.trim()).filter(Boolean);
  const lineHit = lines.find(s => /^(?:上午|下午|晚上)?\s*(?:第)?\s*\d{1,2}\s*(?:[-—,、~至]\s*\d{1,2})?\s*节$/.test(s));
  const base = lineHit || src;
  const m = base.match(/(?:上午|下午|晚上)?\s*(?:第)?\s*(\d{1,2})\s*(?:[-—,、~至]\s*(\d{1,2}))?\s*节/);
  if (!m) return null;
  return { start: +m[1], end: m[2] ? +m[2] : +m[1] };
}

/* 解析单个课程块文本（td 内 div 或网格块） */
function parseBlockText(chunk, fallbackSec) {
  const lines = chunk.split('\n').map(s => s.trim()).filter(Boolean);
  const joined = chunk.replace(/\s+/g, ' ').trim();
  if (!joined) return null;
  const weekM = joined.match(/\d+(?:-\d+)?周(?:\([单双]周?\))?/);
  if (!weekM) return null;
  const weekText = weekM[0];
  let sec = parseSecText(joined);
  if (!sec) sec = fallbackSec;
  if (!sec) return null;
  const cleanName = s => (s || '').replace(/[【】\[\]].*$/g, '').replace(/[【】\[\]]/g, ' ').trim();

  let name = '', teacher = '', location = '';
  if (lines.length >= 2) {
    // 名称取第一条「非周次/非节次/非地点」的内容行，兼容名称行位置不固定的格式
    const metaRe = l => /\d+(?:-\d+)?周/.test(l) || /节/.test(l) || LOC_RE.test(l);
    const contentLines = lines.filter(l => !metaRe(l));
    name = cleanName(contentLines[0] || '');
    teacher = contentLines.length > 1 ? contentLines[1] : '';
    teacher = teacher.replace(/^(教师|老师|任课教师)[:：]?/, '').replace(/[【】\[].*?[】\]]/g, '').replace(/\d+$/, '').trim();
    const lLine = lines.find(l => LOC_RE.test(l));
    location = lLine ? lLine.replace(/^(地点|教室|场地)[:：]?/, '').trim() : '';
  } else {
    // 单行：优先按空格拆分
    const parts = joined.split(/\s+/).filter(Boolean);
    if (parts.length >= 3) {
      name = cleanName(parts[0]);
      teacher = (parts[1] && parts[1].length <= 14 && !/周|节/.test(parts[1])) ? parts[1] : '';
      location = parts.find(p => LOC_RE.test(p)) || '';
    } else {
      // 无空格单行：以周次位置粗切
      const wi = joined.indexOf(weekText);
      const prefix = joined.slice(0, wi).replace(/[【】\[\]]/g, '').trim();
      if (!prefix || prefix.length > 20) return null;
      const mm = prefix.match(/^(.{2,12}?)([\u4e00-\u9fa5]{2,3})$/);
      if (mm && prefix.length >= 5) { name = mm[1]; teacher = mm[2]; }
      else name = prefix;
      const secM = joined.match(/(?:第)?\s*\d{1,2}\s*(?:[-—,、~至]\s*\d{1,2})?\s*节/);
      if (secM) {
        const tail = joined.slice(secM.index + secM[0].length);
        const lm = tail.match(/(教[A-Za-z0-9]+|[A-Za-z0-9]{1,4}楼[A-Za-z0-9]{0,6}|[\u4e00-\u9fa5]{2,12}(?:楼|馆|室|场|区|院|中心|实训))/);
        if (lm) location = lm[1];
      }
    }
  }
  name = cleanName(name);
  teacher = teacher.replace(/[【】\[].*?[】\]]/g, '').replace(/\d+$/, '').trim();
  if (!name || name.length < 2 || name.length > 20) return null;
  return { name, teacher, location, weekText, start: sec.start, end: sec.end };
}

/* 策略1：页面内嵌的 API 数据（kkbList 等 JSON） */
function tryParseEmbedded(doc) {
  const out = [];
  for (const sc of doc.querySelectorAll('script')) {
    const txt = sc.textContent || '';
    if (!/kcmc|kkbList|kbData|zcd/.test(txt)) continue;
    let m;
    const re = /(?:kkbList|kbData|courseList|xsgrkb)\s*[:=]\s*(\[[\s\S]*?\])/g;
    while ((m = re.exec(txt))) {
      try {
        const arr = JSON.parse(m[1]);
        if (Array.isArray(arr)) {
          arr.forEach(o => { const c = mapApiCourse(o); if (c) out.push(c); });
        }
      } catch (e) { /* 继续尝试其他匹配 */ }
    }
    if (out.length) break;
  }
  return out;
}
function mapApiCourse(o) {
  if (!o || typeof o !== 'object') return null;
  const name = (o.kcmc || o.kcm || o.courseName || '').toString().trim();
  const weeksText = (o.zcd || o.zcs || o.weeks || '').toString().trim();
  const sec = parseSecText((o.jcs || o.jc || '').toString());
  const day = +o.xqj || +o.day || 0;
  if (!name || !weeksText || !sec || !(day >= 1 && day <= 7)) return null;
  const teacher = (o.xm || o.jsm || o.jsxm || o.js || '').toString().trim();
  const location = (o.cdmc || o.classroom || o.jxdd || '').toString().trim();
  return buildCourse({ name, teacher, location, day, startSec: sec.start, endSec: sec.end, weeksText });
}

/* 从表头文本解析星期：星期一/周一/1（仅取第一行，忽略日期行） */
function dayFromHeaderText(t) {
  const s = (t || '').split('\n')[0].trim();
  const map = { '一': 1, '二': 2, '三': 3, '四': 4, '五': 5, '六': 6, '日': 7, '天': 7 };
  if (/^周[一二三四五六日天]/.test(s) || /^星期[一二三四五六日天]/.test(s)) {
    return map[s.replace(/^星期?/, '')[0]] || null;
  }
  const m = s.match(/^([1-7])$/);
  if (m) return +m[1];
  return null;
}

/* 策略0：新版正方教务「个人课表查询」专用解析
   真实结构（已按用户样本文件验证）：
   - 网格表 #kbgrid_table_0：9 列（时间段/节次/星期一~日），课程单元格
     td.td_wrap 的 id = "星期-节次"（如 id="1-3" = 周一第3节），rowspan 表示跨节数；
     课程块 div.timetable_con 内含 span.title（课程名）、span[title="节/周"]
     （文本如 "(1-2节)1-12周"、"1-7周(单)"）、span[title="上课地点"]、span[title="教师"]。
   - 列表表 #kblist_table：tbody id="xq_N"（N=星期），td[id^="jc_"] 内
     span.festival 为节次（如 1-2），课程块文本含「周数：」「上课地点：」「教师 ：」标签。
   两者内容相同，合并解析后去重。 */
function stripCourseName(s) {
  return (s || '').replace(/[★☆〇■◆]+/g, '').replace(/[【】\[\]].*$/g, '').trim();
}

/* 解析单个 timetable_con 课程块（网格表与列表表通用） */
function parseZfsoftCon(con, day, fallbackSec) {
  const text = (con.innerText || '').trim();
  if (!text) return null;
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);

  // 名称：.title 元素，去掉 ★☆〇■◆ 等标记
  const titleEl = con.querySelector('.title');
  const name = titleEl ? stripCourseName(titleEl.innerText) : stripCourseName(lines[0] || '');
  if (!name || name.length < 2 || name.length > 30) return null;

  // 周次 + 节次：优先图标 span[title="节/周"] 所在 <p> 文本
  let weekText = '';
  let sec = null;
  const iz = con.querySelector('span[title="节/周"]');
  if (iz) {
    const p = iz.closest('p');
    const t = p ? p.innerText : '';
    weekText = (t.match(/\d+(?:-\d+)?周(?:\([单双]周?\))?/) || [])[0] || '';
    sec = parseSecText(t);
  }
  if (!weekText) weekText = (text.match(/\d+(?:-\d+)?周(?:\([单双]周?\))?/) || [])[0] || '';
  if (!sec) sec = parseSecText(text);
  if (!sec) sec = fallbackSec;
  if (!sec) return null;

  // 地点 / 教师：优先图标 span，回退「上课地点：」「教师 ：」文本标签
  let location = '';
  let teacher = '';
  const locSpan = con.querySelector('span[title^="上课地点"]');
  if (locSpan) {
    const p = locSpan.closest('p');
    location = p ? p.innerText.trim() : '';
  }
  const tchSpan = con.querySelector('span[title^="教师"]');
  if (tchSpan) {
    const p = tchSpan.closest('p');
    teacher = p ? p.innerText.trim() : '';
  }
  if (!location) {
    const lm = text.match(/上课地点[：:]\s*([^\s<]+)/);
    if (lm) location = lm[1];
  }
  if (!location) {
    location = lines.find(l => /^[\dA-Za-z-]{3,12}$/.test(l) || LOC_RE.test(l)) || '';
  }
  if (!teacher) {
    const tm = text.match(/教师\s*[：:]\s*([^\s<]+)/);
    if (tm) teacher = tm[1];
  }
  if (!teacher) {
    // 教师 = 地点行的下一行（排除教学班/学时等杂项行）
    const li = lines.findIndex(l => l === location);
    if (li >= 0 && lines[li + 1]) {
      const cand = lines[li + 1];
      if (cand.length <= 14 && !/教学班|考核|学时|学分|考试|考查|理论|实验|上机|实践|选课|周/.test(cand)) teacher = cand;
    }
  }
  teacher = teacher.replace(/[★☆〇■◆]+/g, '').trim();

  return { name, teacher, location, weekText, start: sec.start, end: sec.end };
}

function parseZfsoftTimetable(doc) {
  const parsed = [];
  let attempts = 0;
  const addCon = (con, day, fallbackSec) => {
    attempts++;
    const info = parseZfsoftCon(con, day, fallbackSec);
    if (!info) return;
    const built = buildCourse({ name: info.name, teacher: info.teacher, location: info.location, day, startSec: info.start, endSec: info.end, weeksText: info.weekText });
    if (built) parsed.push(built);
  };

  // ---- 网格课表 #kbgrid_table_0 ----
  const gridTb = doc.getElementById('kbgrid_table_0');
  if (gridTb) {
    // 表头行 → 列号→星期 映射（兜底用）
    const colDay = {};
    for (const row of gridTb.rows) {
      const hits = [...row.cells].map((c, i) => ({ i, d: dayFromHeaderText(c.innerText) })).filter(x => x.d);
      if (hits.length >= 5) { hits.forEach(h => { colDay[h.i] = h.d; }); break; }
    }
    for (const td of gridTb.querySelectorAll('td.td_wrap')) {
      const cons = td.querySelectorAll('.timetable_con');
      if (!cons.length) continue;
      // day：td.id = "星期-节次"，第一段即星期
      let day = null;
      const idm = (td.id || '').match(/^(\d+)-(\d+)$/);
      if (idm) day = +idm[1];
      if (!(day >= 1 && day <= 7)) {
        for (const row of gridTb.rows) {
          const idx = [...row.cells].indexOf(td);
          if (idx >= 0 && colDay[idx]) { day = colDay[idx]; break; }
        }
      }
      if (!(day >= 1 && day <= 7)) continue;
      // 节次兜底：id 第二段 + rowspan 跨节数
      let fallbackSec = null;
      if (idm) fallbackSec = { start: +idm[2], end: +idm[2] + (td.rowSpan > 1 ? td.rowSpan - 1 : 0) };
      cons.forEach(con => addCon(con, day, fallbackSec));
    }
  }

  // ---- 列表课表 #kblist_table ----
  const listTb = doc.getElementById('kblist_table');
  if (listTb) {
    for (const tb of listTb.querySelectorAll('tbody[id^="xq_"]')) {
      const day = +(tb.id.split('_')[1] || 0);
      if (!(day >= 1 && day <= 7)) continue;
      for (const row of tb.rows) {
        let fallbackSec = null;
        const jcTd = row.querySelector('td[id^="jc_"]');
        if (jcTd) {
          const ft = ((jcTd.querySelector('.festival') || {}).innerText || '').trim();
          const mm = ft.match(/^(\d{1,2})(?:\s*-\s*(\d{1,2}))?$/);
          if (mm) fallbackSec = { start: +mm[1], end: mm[2] ? +mm[2] : +mm[1] };
        }
        row.querySelectorAll('.timetable_con').forEach(con => addCon(con, day, fallbackSec));
      }
    }
  }
  return { parsed, attempts };
}

/* 策略2：传统 <table> 结构 */
function parseFromTables(doc, diag) {
  const tables = [...doc.querySelectorAll('table')];
  diag.tables = tables.length;
  let best = null, bestScore = 0;
  for (const tb of tables) {
    let score = 0;
    for (const cell of tb.querySelectorAll('td,th')) {
      const t = cell.innerText || '';
      if (/周/.test(t) && /\d/.test(t)) score += 2;
      if (/节/.test(t)) score += 1;
      if (/星期/.test(t)) score += 3;
    }
    if (score > bestScore) { best = tb; bestScore = score; }
  }
  if (!best) return { parsed: [], attempts: 0 };
  diag.bestTableScore = bestScore;

  // 1) 通过表头行建立「列号 → 星期」精确映射
  const colDay = {};
  for (const row of best.rows) {
    const hits = [...row.cells]
      .map((c, i) => ({ i, d: dayFromHeaderText(c.innerText) }))
      .filter(x => x.d);
    if (hits.length >= 5) { hits.forEach(h => { colDay[h.i] = h.d; }); break; }
  }
  const hasMap = Object.keys(colDay).length >= 5;

  // 2) 无表头时：判断第 0 列是否为节次标签列
  let offset = 0;
  if (!hasMap) {
    let labelCol0 = false, checked = 0;
    for (const row of best.rows) {
      const c = row.cells[0];
      if (c) {
        checked++;
        if (/节|上午|下午|晚上/.test(c.innerText || '')) labelCol0 = true;
      }
      if (checked > 3) break;
    }
    offset = labelCol0 ? 1 : 0;
  }

  const parsed = [];
  let attempts = 0;
  const seenCells = new Set(); // 防止 rowspan 单元格被重复统计
  for (const row of best.rows) {
    const cells = [...row.cells];
    const headerLike = cells.filter(c => /星期/.test(c.innerText || '')).length >= 5;
    if (headerLike) continue;
    // 行首标签（节次列）→ 作为节次回退来源
    const labelSec = cells[0] ? parseSecText(cells[0].innerText || '') : null;
    for (let ci = 0; ci < cells.length; ci++) {
      let day = null;
      if (hasMap) day = colDay[ci] || null;
      else day = ci - offset + 1;
      if (!day || day < 1 || day > 7) continue;
      const cell = cells[ci];
      if (seenCells.has(cell)) continue;
      seenCells.add(cell);
      const full = (cell.innerText || '').trim();
      if (!full) continue;
      // 每个课程块是 td 内的子元素；无子元素则整体处理
      const children = [...cell.children].filter(el => /周/.test(el.innerText || ''));
      const chunks = children.length ? children.map(el => el.innerText.trim()) : [full];
      for (const chunk of chunks) {
        attempts++;
        // 节次回退：行标签 + rowspan 推算跨节数
        let fallback = labelSec;
        if (fallback && cell.rowSpan > 1) fallback = { start: fallback.start, end: fallback.start + cell.rowSpan - 1 };
        const info = parseBlockText(chunk, fallback);
        if (!info) continue;
        const built = buildCourse({ name: info.name, teacher: info.teacher, location: info.location, day, startSec: info.start, endSec: info.end, weeksText: info.weekText });
        if (built) parsed.push(built);
      }
    }
  }
  return { parsed, attempts };
}

/* 策略3：div 网格结构（无 table 时） */
function isLabelText(t) {
  const s = (t || '').trim();
  return s.length <= 12 && /节|上午|下午|晚上|时间/.test(s);
}
function detectGridDay(el, doc) {
  // 优先：inline style 的 grid-column
  const st = el.getAttribute('style') || '';
  const gm = st.match(/grid-column(?:-start)?\s*:\s*(\d+)/);
  if (gm) {
    const c = +gm[1];
    // 同容器内第一列是否存在节次标签，决定是否 -1
    const container = el.parentElement;
    let hasLabel = false;
    if (container) {
      hasLabel = [...container.children].some(s => {
        const sst = s.getAttribute('style') || '';
        const m2 = sst.match(/grid-column(?:-start)?\s*:\s*1\b/);
        return m2 && isLabelText(s.innerText);
      });
    }
    const day = hasLabel ? c - 1 : c;
    if (day >= 1 && day <= 7) return day;
  }
  // 沿祖先找「7/8 个子元素构成的行」，推算列号
  let node = el.parentElement;
  let depth = 0;
  while (node && node !== doc.body && node !== doc.documentElement && depth < 6) {
    const children = [...node.children].filter(c => !['STYLE', 'SCRIPT', 'LINK', 'META'].includes(c.tagName));
    if (children.length === 7 || children.length === 8) {
      const tags = new Set(children.map(c => c.tagName));
      if (tags.size === 1 || [...tags].every(t => t === 'TD' || t === 'TH')) {
        const holder = children.filter(c => c.contains(el));
        if (holder.length === 1) {
          let idx = children.indexOf(holder[0]);
          if (children.length === 8) {
            // 仅当第一列确认为节次标签时才 -1，否则放弃
            if (!isLabelText(children[0].innerText)) return null;
            idx -= 1;
          }
          if (idx >= 0 && idx < 7) return idx + 1;
        }
        return null;
      }
    }
    node = node.parentElement;
    depth++;
  }
  return null;
}

function parseFromDivGrid(doc, diag) {
  const candidates = [];
  for (const el of doc.querySelectorAll('div,td,li,section,span')) {
    const t = (el.innerText || '').trim();
    if (t.length < 4 || t.length > 300) continue;
    if (!/周/.test(t) || !/节/.test(t)) continue;
    // 取最内层：子元素已含周+节则跳过
    const childHas = [...el.children].some(ch => {
      const ct = ch.innerText || '';
      return /周/.test(ct) && /节/.test(ct);
    });
    if (childHas) continue;
    candidates.push(el);
  }
  diag.divCandidates = candidates.length;
  const parsed = [];
  let attempts = 0;
  for (const el of candidates) {
    attempts++;
    const info = parseBlockText(el.innerText, null);
    if (!info) continue;
    const day = detectGridDay(el, doc);
    if (!day) continue;
    const built = buildCourse({ name: info.name, teacher: info.teacher, location: info.location, day, startSec: info.start, endSec: info.end, weeksText: info.weekText });
    if (built) parsed.push(built);
  }
  return { parsed, attempts };
}

/* 按 名称+星期+节次+周次 去重（rowspan 会导致同一单元格被重复读取） */
function dedupeCourses(list) {
  const seen = new Set();
  const out = [];
  for (const c of list) {
    const sig = c.name + '|' + c.day + '|' + c.startSec + '-' + c.endSec + '|' + c.weeksText;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(c);
  }
  return out;
}

/* 合并同名称+同星期+同节次的多条课程（理论/实验拆分、双教师等），
   周次取并集，教师/教室去重拼接 */
function mergeSameSlotCourses(list) {
  const map = new Map();
  for (const c of list) {
    const key = c.name + '|' + c.day + '|' + c.startSec + '-' + c.endSec;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(c);
  }
  const out = [];
  for (const group of map.values()) {
    if (group.length === 1) { out.push(group[0]); continue; }
    const weeks = [...new Set(group.flatMap(c => c.weeks))].sort((a, b) => a - b);
    const teachers = [...new Set(group.map(c => c.teacher).filter(Boolean))].join('、');
    const locations = [...new Set(group.map(c => c.location).filter(Boolean))].join('、');
    const weeksText = [...new Set(group.map(c => c.weeksText).filter(Boolean))].join('、');
    out.push(Object.assign({}, group[0], {
      weeks,
      weeksText: weeksText || group[0].weeksText,
      teacher: teachers || group[0].teacher,
      location: locations || group[0].location,
    }));
  }
  return out;
}

/* 解析总入口 */
function parseJwHtml(text) {
  const diag = { tables: 0, bestTableScore: 0, cellsWithWeek: 0, divCandidates: 0, enc: '', mhtml: false, apiHit: false, zfsoft: false };
  const doc = new DOMParser().parseFromString(text, 'text/html');
  diag.cellsWithWeek = [...doc.querySelectorAll('td,th')].filter(c => /周/.test(c.innerText || '')).length;

  // 策略0：新版正方教务「个人课表查询」专用解析
  const zf = parseZfsoftTimetable(doc);
  const zfParsed = dedupeCourses(zf.parsed);
  if (zfParsed.length) {
    diag.zfsoft = true;
    return { parsed: zfParsed, skipped: Math.max(0, zf.attempts - zfParsed.length), diag };
  }

  // 策略1：内嵌 API JSON
  const api = dedupeCourses(tryParseEmbedded(doc));
  if (api.length) {
    diag.apiHit = true;
    return { parsed: api, skipped: 0, diag };
  }
  // 策略2：表格
  const tb = parseFromTables(doc, diag);
  const tbParsed = dedupeCourses(tb.parsed);
  if (tbParsed.length) {
    return { parsed: tbParsed, skipped: Math.max(0, tb.attempts - tbParsed.length), diag };
  }
  // 策略3：div 网格
  const dg = parseFromDivGrid(doc, diag);
  const dgParsed = dedupeCourses(dg.parsed);
  return { parsed: dgParsed, skipped: Math.max(0, tb.attempts + dg.attempts - dgParsed.length), diag };
}

/* ---- CSV 解析 ---- */
function parseCSVLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function parseDay(str) {
  const s = String(str || '').trim();
  if (/^[1-7]$/.test(s)) return +s;
  const idx = WEEKDAYS.indexOf(s);
  if (idx >= 0) return idx + 1;
  return null;
}
function parseSec(str) {
  const m = String(str || '').match(/(\d+)(?:\s*-\s*(\d+))?/);
  if (!m) return null;
  return { startSec: +m[1], endSec: m[2] ? +m[2] : +m[1] };
}
function parseCSV(text) {
  const lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) return { parsed: [], skipped: 0 };
  const parsed = [];
  let skipped = 0;
  let hasHeader = /课程|名称/.test(lines[0]);
  let idx = { name: 0, teacher: 1, location: 2, day: 3, start: 4, end: 5, weeks: 6, note: 7 };
  let start = 0;
  if (hasHeader) {
    const head = parseCSVLine(lines[0]);
    const find = re => head.findIndex(h => re.test(h));
    idx.name = find(/课程|名称/); if (idx.name < 0) idx.name = 0;
    idx.teacher = find(/教师/);
    idx.location = find(/教室|地点|场地/);
    idx.day = find(/星期|周几/);
    idx.start = find(/开始|起始/);
    idx.end = find(/结束|截止/);
    const sec = find(/^节次$/);
    if (sec >= 0 && idx.start < 0) { idx.start = sec; idx.end = sec; }
    idx.weeks = find(/周次|周数/);
    idx.note = find(/备注/);
    start = 1;
  }
  for (let i = start; i < lines.length; i++) {
    const cells = parseCSVLine(lines[i]);
    const g = n => (n >= 0 && n < cells.length) ? cells[n].trim() : '';
    let startSec, endSec;
    if (idx.start >= 0 && idx.end >= 0 && idx.start !== idx.end) {
      const a = +g(idx.start), b = +g(idx.end);
      if (a && b) { startSec = a; endSec = b; }
    } else if (idx.start >= 0) {
      const r = parseSec(g(idx.start));
      if (r) { startSec = r.startSec; endSec = r.endSec; }
    } else {
      const r = parseSec(g(4));
      if (r) { startSec = r.startSec; endSec = r.endSec; }
    }
    if (!startSec) { skipped++; continue; }
    const day = parseDay(g(idx.day >= 0 ? idx.day : 3));
    const built = buildCourse({
      name: g(idx.name), teacher: g(idx.teacher), location: g(idx.location),
      day, startSec, endSec, weeksText: g(idx.weeks) || '1-16周', note: g(idx.note),
    });
    if (built) parsed.push(built); else skipped++;
  }
  return { parsed, skipped };
}

/* ---- 粘贴解析 ---- */
function parsePaste(text) {
  const parsed = [];
  let skipped = 0;
  String(text).split(/\r?\n/).forEach(line => {
    line = line.trim();
    if (!line) return;
    const parts = line.split(/\||\t/).map(s => s.trim());
    if (parts.length < 6) { skipped++; return; }
    const [name, teacher, location, dayStr, secStr, weeksText] = parts;
    const sec = parseSec(secStr);
    const day = parseDay(dayStr);
    const built = buildCourse({ name, teacher, location, day, startSec: sec && sec.startSec, endSec: sec && sec.endSec, weeksText, note: parts[6] || '' });
    if (built) parsed.push(built); else skipped++;
  });
  return { parsed, skipped };
}

/* ==================== 收藏夹 ==================== */
function walkEdgeTree(node, folder, out) {
  if (!node) return;
  if (node.type === 'url' && node.url) {
    out.push({ id: uid(), name: node.name || node.url, url: node.url, folder: folder || '未分组', category: '', date: node.date_added || '' });
  } else if (node.children) {
    node.children.forEach(c => walkEdgeTree(c, node.name || folder, out));
  }
}
function parseEdgeJSON(text) {
  const j = JSON.parse(text);
  const out = [];
  const roots = j.roots || {};
  const names = { bookmark_bar: '收藏夹栏', other: '其他收藏夹', synced: '同步收藏夹' };
  for (const [k, v] of Object.entries(roots)) walkEdgeTree(v, names[k] || k, out);
  return out;
}
function stripTags(s) {
  return String(s ?? '').replace(/<[^>]*>/g, '');
}
/* 解析 Edge 导出的收藏夹 HTML（Netscape Bookmark 格式）
   采用正则顺序扫描：H3 开启文件夹，A 提取链接，不依赖 DOMParser 的结构容错 */
function parseNetscapeHTML(text) {
  const out = [];
  let folder = '导入收藏夹';
  let curCategory = '';
  const re = /<H3([^>]*)>([\s\S]*?)<\/H3>|<A[^>]*HREF="([^"]*)"[^>]*>([\s\S]*?)<\/A>/gi;
  let m;
  while ((m = re.exec(text))) {
    if (m[1] !== undefined) {
      const f = stripTags(m[2]).trim();
      if (f) folder = f;
      const cm = m[1].match(/CATEGORY="([^"]*)"/i);
      curCategory = cm ? cm[1] : '';
    } else if (m[3] !== undefined) {
      const href = m[3].trim();
      if (/^https?:/i.test(href)) {
        const name = stripTags(m[4]).trim() || href;
        const date = ((m[0].match(/ADD_DATE="(\d+)"/i) || [])[1]) || '';
        out.push({ id: uid(), name, url: href, folder, category: curCategory || '', date });
      }
    }
  }
  return out;
}
async function importBookmarksFile(file) {
  if (!file) return;
  try {
    // 字节读取 + 编码自动识别（UTF-8 / GBK），去掉 BOM
    const buf = await file.arrayBuffer();
    const { text, enc } = decodeBytes(buf);
    const t = text.replace(/^\uFEFF/, '').trim();
    let list;
    if (t.startsWith('{')) list = parseEdgeJSON(t);
    else list = parseNetscapeHTML(t);
    if (!list.length) {
      const hrefCount = (t.match(/<A\s/i) || []).length;
      toast(`未识别到收藏内容（检测到 ${hrefCount} 个链接标签，文件编码 ${enc}）。请确认文件为 Edge「导出收藏夹」的 HTML 或本地 Bookmarks 文件`, 'warn');
      return;
    }
    // 自动创建导入携带的分类（Table 导出→导入 分类无损互通）
    let newCats = 0;
    list.forEach(b => {
      if (b.category && !categories.includes(b.category)) {
        categories.push(b.category);
        newCats++;
      }
    });
    if (newCats) save(LS.categories, categories);
    const seen = new Set(bookmarks.map(b => normalizeUrl(b.url)));
    let added = 0;
    list.forEach(b => {
      const key = normalizeUrl(b.url);
      if (!seen.has(key)) { bookmarks.push(b); seen.add(key); added++; }
    });
    save(LS.bookmarks, bookmarks);
    renderBookmarks();
    toast(`导入成功：新增 ${added} 个网站（跳过重复 ${list.length - added} 个）`);
  } catch (err) {
    toast('解析失败：' + (err.message || err), 'err');
  }
}

let bmSearch = '';
let bmCat = 'all'; // all | none | 分类名
function renderBookmarks() {
  // 统计
  const total = bookmarks.length;
  const catCount = categories.length;
  $('#bm-stats').textContent = `共 ${total} 个网站 · ${catCount} 个分类 · 数据保存在本地浏览器`;

  // 分类 chips
  const chipsBox = $('#bm-chips');
  const countOf = c => bookmarks.filter(b => b.category === c).length;
  const chips = [
    `<button class="chip ${bmCat === 'all' ? 'active' : ''}" data-cat="all">全部 ${total}</button>`,
    `<button class="chip ${bmCat === 'none' ? 'active' : ''}" data-cat="none">未分类 ${bookmarks.filter(b => !b.category).length}</button>`,
    ...categories.map(c => `<button class="chip ${bmCat === c ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)} ${countOf(c)}</button>`),
    `<button class="chip" data-cat="__new">＋ 新分类</button>`,
  ];
  chipsBox.innerHTML = chips.join('');

  // 过滤
  const q = bmSearch.trim().toLowerCase();
  let list = bookmarks.filter(b => {
    if (bmCat === 'none' && b.category) return false;
    if (bmCat !== 'all' && bmCat !== 'none' && b.category !== bmCat) return false;
    if (q) {
      const hay = (b.name + ' ' + b.url + ' ' + b.category + ' ' + b.folder).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  // 所有卡片按名称 A-Z 排列（中文按拼音 A-Z，忽略大小写，数字自然排序）
  list.sort((a, b) => a.name.localeCompare(b.name, 'zh', { sensitivity: 'base', numeric: true }));

  const grid = $('#bm-grid');
  if (!bookmarks.length) {
    grid.innerHTML = '<div class="bm-empty">还没有收藏网站<br/>点击右上角「一键导入 Edge 收藏夹」开始</div>';
    return;
  }
  if (!list.length) {
    grid.innerHTML = '<div class="bm-empty">没有匹配的收藏（搜索或分类过滤无结果）</div>';
    return;
  }
  grid.innerHTML = list.slice(0, 300).map(b => {
    const col = colorOf(b.name || b.url);
    const host = (() => { try { return new URL(b.url).hostname; } catch (e) { return b.url; } })();
    return `<div class="bm-card" data-id="${b.id}">
      <div class="bm-top">
        <div class="bm-ava" style="background:${col}">${esc((b.name || '?').slice(0, 1))}</div>
        <div class="bm-info">
          <div class="bm-name" data-act="open" title="${esc(b.url)}">${esc(b.name)}</div>
          <div class="bm-url">${esc(host)}</div>
        </div>
      </div>
      <div class="bm-meta">
        <span class="badge" title="${esc(b.folder)}">📁 ${esc(b.folder)}</span>
        ${b.category ? `<span class="badge">🏷 ${esc(b.category)}</span>` : ''}
      </div>
      <div class="bm-actions">
        <select class="bm-cat" data-act="cat">
          <option value="">未分类</option>
          ${categories.map(c => `<option value="${esc(c)}" ${b.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
          <option value="__new">＋ 新分类…</option>
        </select>
        <button class="btn ghost btn-open" data-act="open">↗ 打开</button>
        <button class="btn ghost btn-rename" data-act="rename" title="修改名称">✏️</button>
        <button class="btn ghost danger" data-act="del">✕</button>
      </div>
    </div>`;
  }).join('') + (list.length > 300 ? `<div class="bm-empty" style="grid-column:1/-1;padding:16px">仅显示前 300 个，请用搜索缩小范围</div>` : '');
}

function openBookmark(b) {
  if (!b || !b.url) return false;
  const w = window.open(b.url, '_blank', 'noopener');
  return !!w; // 被弹窗拦截时返回 false
}
/* 聊天内兜底按钮：自动打开被拦截时，用户一键打开（真实手势，必然成功） */
function appendOpenAction(name, url) {
  const box = $('#chat-msgs');
  const div = document.createElement('div');
  div.className = 'msg sys';
  div.innerHTML = `🔗 「${esc(name)}」<button class="btn btn-sm primary open-fallback" data-url="${esc(url)}">↗ 打开网站</button>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

/* 卡片名称内联编辑 */
function startRename(card, b) {
  const nameEl = card.querySelector('.bm-name');
  nameEl.innerHTML = `<input class="bm-name-input" value="${esc(b.name)}" maxlength="60" />`;
  const inp = nameEl.querySelector('input');
  inp.focus();
  inp.select();
}

/* ---- 分类管理 ---- */
function renderCatsList() {
  const box = $('#cats-list');
  const countOf = c => bookmarks.filter(b => b.category === c).length;
  if (!categories.length) {
    box.innerHTML = '<div class="tp-empty">暂无自定义分类，可在下方添加</div>';
    return;
  }
  box.innerHTML = categories.map(c => `<div class="cat-row" data-cat="${esc(c)}">
    <input class="cat-name" type="text" value="${esc(c)}" maxlength="12" />
    <span class="cat-count">${countOf(c)} 个收藏</span>
    <button class="btn ghost btn-sm cat-rename" data-act="rename">保存改名</button>
    <button class="btn ghost danger btn-sm cat-del" data-act="del">删除</button>
  </div>`).join('');
}
function openCatsModal() {
  renderCatsList();
  $('#modal-cats').classList.remove('hidden');
}

/* ---- 手动收藏 ---- */
function openBmAddModal() {
  $('#bma-name').value = '';
  $('#bma-url').value = '';
  $('#bma-cat').innerHTML = '<option value="">未分类</option>' +
    categories.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('') +
    '<option value="__new">＋ 新分类…</option>';
  $('#modal-bm-add').classList.remove('hidden');
  $('#bma-name').focus();
}
function saveBmAdd() {
  const name = $('#bma-name').value.trim();
  let url = $('#bma-url').value.trim();
  if (!name) return toast('请输入网站名称', 'warn');
  if (!url) return toast('请输入网址', 'warn');
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch (e) { return toast('网址格式不正确，请检查', 'warn'); }
  if (bookmarks.some(b => normalizeUrl(b.url) === normalizeUrl(url))) return toast('该网址已在收藏夹中（按同站判定）', 'warn');

  let cat = $('#bma-cat').value;
  if (cat === '__new') {
    const n = prompt('输入新分类名称：');
    if (n && n.trim()) {
      cat = n.trim();
      if (!categories.includes(cat)) { categories.push(cat); save(LS.categories, categories); }
    } else cat = '';
  }
  bookmarks.push({ id: uid(), name, url, folder: '手动添加', category: cat || '', date: '' });
  save(LS.bookmarks, bookmarks);
  closeModal('modal-bm-add');
  renderBookmarks();
  toast(`已收藏「${name}」`);
}

/* ---- 网址规范化与去重 ---- */
/* 同一网站的多种写法统一：忽略大小写、www. 前缀、末尾斜杠、#锚点 */
function normalizeUrl(url) {
  try {
    const u = new URL(String(url).trim());
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    u.hostname = host;
    u.protocol = u.protocol.toLowerCase();
    u.hash = '';
    let path = u.pathname;
    if (path.length > 1 && path.endsWith('/')) u.pathname = path.slice(0, -1);
    return u.toString();
  } catch (e) {
    return String(url).trim().toLowerCase();
  }
}
/* 一键去重：按规范化网址合并，保留最早一条，缺失分类从重复项继承 */
function countDupes() {
  const seen = new Set();
  let removed = 0;
  for (const b of bookmarks) {
    const key = normalizeUrl(b.url);
    if (seen.has(key)) removed++;
    else seen.add(key);
  }
  return removed;
}
function dedupeBookmarksNow() {
  const seen = new Map();
  const kept = [];
  let removed = 0;
  for (const b of bookmarks) {
    const key = normalizeUrl(b.url);
    if (seen.has(key)) removed++;
    else { seen.set(key, b); kept.push(b); }
  }
  if (removed) {
    for (const b of bookmarks) {
      const first = seen.get(normalizeUrl(b.url));
      if (first !== b && b.category && !first.category) first.category = b.category;
    }
    bookmarks = kept;
    save(LS.bookmarks, bookmarks);
    renderBookmarks();
  }
  return removed;
}
function dedupeBookmarks() {
  const removed = countDupes();
  if (!removed) return toast('未发现重复收藏 👍');
  if (!confirm(`发现 ${removed} 条重复收藏（同一网址多次收藏）。\n将保留最早一条并清除其余，保留项的缺失分类会从重复项继承。是否继续？`)) return;
  const n = dedupeBookmarksNow();
  toast(`去重完成：清除 ${n} 条重复收藏`);
}

/* ---- 导出 Edge 可导入的 Netscape Bookmark HTML ---- */
function escapeHtmlAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
/* Edge Bookmarks JSON 的 date_added 是自 1601-01-01 起的微秒数 → 转为 Unix 秒 */
function edgeTimestamp(dateVal) {
  const n = Number(dateVal);
  if (n > 1e15) return Math.round(n / 1e6) - 11644473600;
  if (n > 1e11) return Math.round(n / 1000);
  return Math.floor(Date.now() / 1000);
}
function exportEdgeHtml() {
  if (!bookmarks.length) return toast('收藏夹为空', 'warn');
  const now = Math.floor(Date.now() / 1000);
  const rowA = b => `                <DT><A HREF="${escapeHtmlAttr(b.url)}" ADD_DATE="${b.date ? edgeTimestamp(b.date) : now}">${escapeHtmlAttr(b.name)}</A>`;

  // 按分类分组 → Edge 文件夹；未分类归入「未分类」文件夹
  const groups = new Map();
  bookmarks.forEach(b => {
    const key = b.category || '未分类';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  });
  const folderHtml = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], 'zh'))
    .map(([cat, list]) => {
      list.sort((a, b) => a.name.localeCompare(b.name, 'zh', { sensitivity: 'base', numeric: true }));
      return `        <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}" CATEGORY="${escapeHtmlAttr(cat)}">${escapeHtmlAttr(cat)}</H3>
        <DL><p>
${list.map(rowA).join('\n')}
        </DL><p>`;
    }).join('\n');

  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<!-- 由「Table」导出，可直接在 Edge 导入：edge://favorites → ⋯ → 导入收藏夹。
     顶层文件夹带 PERSONAL_TOOLBAR_FOLDER="true"，导入后所有分类直接出现在 Edge 收藏夹栏 -->
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="${now}" LAST_MODIFIED="${now}" PERSONAL_TOOLBAR_FOLDER="true">收藏夹栏</H3>
    <DL><p>
${folderHtml}
    </DL><p>
</DL><p>
`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'Table收藏.html';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('已导出，可在 Edge「导入收藏夹」中批量导入');
}

/* ==================== 任务待办 ==================== */
let editingTaskId = null;

function fmtTaskTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtTaskDateTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${fmtTaskTime(ts)}`;
}
function toLocalInput(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function parseTaskDue(s) {
  const t = String(s || '').trim();
  if (!t) return null;
  const d = new Date(t.replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d.getTime();
}
function findTask(keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return null;
  return tasks.find(t => t.title.toLowerCase().includes(kw)) || null;
}
function taskDueInfo(t) {
  const now = Date.now();
  const diff = t.due - now;
  if (diff < 0) return { text: '已超期 · ' + fmtTaskDateTime(t.due), cls: 'overdue' };
  if (diff <= 3600000) return { text: '1小时内到期 · ' + fmtTaskTime(t.due), cls: 'soon' };
  if (diff <= 86400000) return { text: '今天 ' + fmtTaskTime(t.due), cls: 'soon' };
  if (diff <= 2 * 86400000) return { text: '明天 ' + fmtTaskTime(t.due), cls: '' };
  return { text: fmtTaskDateTime(t.due), cls: '' };
}
/* 按截止时间优先度排序：未完成按 due 升序在前，已完成沉底 */
function renderTasks() {
  const box = $('#tk-list');
  const stats = $('#tk-stats');
  const pending = tasks.filter(t => !t.done).sort((a, b) => a.due - b.due);
  const done = tasks.filter(t => t.done).sort((a, b) => b.due - a.due);
  const overdue = pending.filter(t => t.due < Date.now()).length;
  stats.textContent = `待办 ${pending.length} 项 · 已超期 ${overdue} 项 · 已完成 ${done.length} 项 · 截止前 1 小时自动提醒`;
  if (!tasks.length) {
    box.innerHTML = '<div class="bm-empty">暂无任务，点击右上角「＋ 添加任务」开始（截止前 1 小时智能体会自动提醒）</div>';
    return;
  }
  const item = t => {
    const info = t.done ? { text: '已完成', cls: '' } : taskDueInfo(t);
    return `<div class="tk-item ${t.done ? 'done' : ''}" data-id="${t.id}">
      <input type="checkbox" class="tk-check" data-act="toggle" ${t.done ? 'checked' : ''} title="标记完成/取消完成" />
      <div class="tk-main">
        <div class="tk-title">${esc(t.title)}</div>
        ${t.note ? `<div class="tk-note">${esc(t.note)}</div>` : ''}
      </div>
      <span class="tk-due ${info.cls}">${info.text}</span>
      <div class="tk-ops">
        <button class="btn ghost btn-sm" data-act="edit">✏️</button>
        <button class="btn ghost danger btn-sm" data-act="del">✕</button>
      </div>
    </div>`;
  };
  box.innerHTML = pending.map(item).join('') + done.map(item).join('');
}
function openTaskModal(id) {
  editingTaskId = id || null;
  const t = id ? tasks.find(x => x.id === id) : null;
  $('#tk-modal-title').textContent = t ? '编辑任务' : '添加任务';
  $('#tk-title').value = t ? t.title : '';
  $('#tk-note').value = t ? t.note : '';
  $('#tk-due').value = t ? toLocalInput(t.due) : '';
  $('#tk-delete').classList.toggle('hidden', !t);
  $('#modal-task').classList.remove('hidden');
  $('#tk-title').focus();
}
function saveTaskFromForm() {
  const title = $('#tk-title').value.trim();
  const dueVal = $('#tk-due').value;
  const note = $('#tk-note').value.trim();
  if (!title) return toast('请输入任务名称', 'warn');
  if (!dueVal) return toast('请设置任务结束时间', 'warn');
  const due = new Date(dueVal).getTime();
  if (isNaN(due)) return toast('结束时间格式无效', 'warn');
  if (editingTaskId) {
    const t = tasks.find(x => x.id === editingTaskId);
    if (t) {
      const dueChanged = t.due !== due;
      Object.assign(t, { title, note, due, reminded: dueChanged ? false : t.reminded });
    }
    toast('任务已更新');
  } else {
    tasks.push({ id: uid(), title, note, due, done: false, reminded: false, createdAt: Date.now() });
    toast('任务已添加');
  }
  save(LS.tasks, tasks);
  closeModal('modal-task');
  renderTasks();
  checkTaskReminders(); // 新任务可能 1 小时内到期，立即检查
}
/* 截止前 1 小时提醒：写入提醒记录 + 红圈角标 + 全局 toast */
function checkTaskReminders() {
  const now = Date.now();
  let fired = false;
  tasks.forEach(t => {
    if (t.done || t.reminded) return;
    if (now >= t.due) return;
    if (t.due - now <= 3600000) {
      t.reminded = true;
      reminders.unshift({ id: uid(), taskId: t.id, title: t.title, due: t.due, time: now, read: false });
      fired = true;
      toast(`⏰ 任务「${t.title}」将于 ${fmtTaskTime(t.due)} 到期（1 小时内）`);
    }
  });
  if (fired) {
    save(LS.tasks, tasks);
    save(LS.reminders, reminders);
    updateRemindBadge();
    renderReminders();
  }
}
function updateRemindBadge() {
  const n = reminders.filter(r => !r.read).length;
  [$('#remind-badge'), $('#nav-remind-badge')].forEach(b => {
    if (!b) return;
    b.textContent = n > 99 ? '99+' : n;
    b.classList.toggle('hidden', n === 0);
  });
}
function renderReminders() {
  const box = $('#remind-msgs');
  if (!reminders.length) {
    box.innerHTML = '<div class="remind-empty">暂无提醒<br>任务截止前 1 小时会自动出现在这里</div>';
    return;
  }
  box.innerHTML = reminders.map(r => `<div class="remind-item ${r.read ? '' : 'unread'}">
    <span class="remind-icon">⏰</span>
    <div class="remind-body">
      <div class="remind-title">任务「${esc(r.title)}」将于 <b>${fmtTaskTime(r.due)}</b> 到期（1 小时内）</div>
      <div class="remind-meta">${fmtSessTime(r.time)} 提醒 · 截止 ${fmtTaskDateTime(r.due)}</div>
    </div>
    <div class="remind-actions">
      <button class="btn ghost btn-sm" data-act="goto" data-id="${r.taskId}">查看任务</button>
      <button class="btn ghost danger btn-sm" data-act="delrem" data-id="${r.id}">✕</button>
    </div>
  </div>`).join('');
}
function openRemindTab() {
  let changed = false;
  reminders.forEach(r => { if (!r.read) { r.read = true; changed = true; } });
  if (changed) {
    save(LS.reminders, reminders);
    updateRemindBadge();
    renderReminders();
  }
}

/* ==================== 未来规划（甘特图） ==================== */
let editingEventId = null;

function findEvent(keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return null;
  return events.find(e => e.name.toLowerCase().includes(kw)) || null;
}
function eventStatus(e) {
  const today = todayMidnight().getTime();
  const s = parseDate(e.start).getTime();
  const en = parseDate(e.end).getTime() + 86400000 - 1;
  if (today < s) return '未开始';
  if (today > en) return '已结束';
  return '进行中';
}
function renderGantt() {
  const box = $('#gantt-chart');
  const stats = $('#gt-stats');
  if (!events.length) {
    stats.textContent = '';
    box.innerHTML = '<div class="bm-empty">暂无规划事件，点击右上角「＋ 添加事件」开始规划未来（事件名称 - 开始日期 - 结束日期）</div>';
    return;
  }
  const zoom = +$('#gt-zoom').value || 16;
  const today = todayMidnight().getTime();
  const starts = events.map(e => parseDate(e.start).getTime());
  const ends = events.map(e => parseDate(e.end).getTime());
  const s = Math.min(...starts, today - 7 * 86400000);
  const en = Math.max(...ends, today + 7 * 86400000);
  const days = Math.round((en - s) / 86400000) + 1;
  const dayW = zoom;
  const totalW = days * dayW;
  const sorted = events.slice().sort((a, b) => parseDate(a.start) - parseDate(b.start));

  // 月份段
  const months = [];
  let cur = new Date(s);
  while (cur.getTime() <= en) {
    const m = new Date(cur.getFullYear(), cur.getMonth(), 1);
    const mEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    const segStart = Math.max(m.getTime(), s);
    const segEnd = Math.min(mEnd.getTime(), en);
    months.push({
      label: `${m.getFullYear()}年${m.getMonth() + 1}月`,
      w: (Math.round((segEnd - segStart) / 86400000) + 1) * dayW,
    });
    cur = new Date(mEnd.getTime() + 86400000);
  }
  // 日期单元格
  let dayCells = '';
  for (let i = 0; i < days; i++) {
    const d = new Date(s + i * 86400000);
    const wknd = (d.getDay() === 0 || d.getDay() === 6) ? ' wknd' : '';
    dayCells += `<div class="gt-day${wknd}" style="width:${dayW}px">${d.getDate()}</div>`;
  }
  const todayPos = Math.round((today - s) / 86400000 * dayW);

  const row = e => {
    const st = parseDate(e.start).getTime();
    const en2 = parseDate(e.end).getTime() + 86400000; // 含结束日
    const left = Math.round((st - s) / 86400000 * dayW);
    const width = Math.max(dayW, Math.round((en2 - st) / 86400000 * dayW));
    const col = e.color || colorOf(e.name);
    const status = eventStatus(e);
    const dayCount = Math.round((en2 - st) / 86400000);
    const title = `${e.name}｜${e.start} ~ ${e.end}｜${dayCount}天｜${status}`;
    return `<div class="gt-row" data-id="${e.id}">
      <div class="gt-name" title="${esc(title)}">
        <div class="gt-name-t">${esc(e.name)}</div>
        <div class="gt-name-d">${e.start} ~ ${e.end}</div>
      </div>
      <div class="gt-cell" style="width:${totalW}px;--gdw:${dayW}px">
        <div class="gt-bar ${status === '已结束' ? 'done' : ''} ${status === '进行中' ? 'now' : ''}" data-id="${e.id}" title="${esc(title)}"
          style="left:${left}px;width:${width}px;background:${col}">${esc(e.name)} · ${dayCount}天</div>
        ${today >= s && today <= en ? `<div class="gt-today" style="left:${todayPos}px" title="今天"><span class="gt-today-label">今天</span></div>` : ''}
      </div>
    </div>`;
  };

  box.innerHTML = `<div class="gt-scroll"><div class="gt-inner">
    <div class="gt-row gt-head">
      <div class="gt-name">事件</div>
      <div class="gt-months" style="width:${totalW}px">${months.map(m => `<div class="gt-month" style="width:${m.w}px">${m.label}</div>`).join('')}</div>
    </div>
    <div class="gt-row gt-days">
      <div class="gt-name"></div>
      <div class="gt-days-inner" style="width:${totalW}px">${dayCells}</div>
    </div>
    ${sorted.map(row).join('')}
  </div></div>`;
  const now = events.filter(e => eventStatus(e) === '进行中').length;
  stats.textContent = `共 ${events.length} 个事件 · 进行中 ${now} 个 · 红色竖线为今天 · 点击色块可编辑`;
}
function openEventModal(id) {
  editingEventId = id || null;
  const e = id ? events.find(x => x.id === id) : null;
  $('#ev-modal-title').textContent = e ? '编辑事件' : '添加事件';
  $('#ev-name').value = e ? e.name : '';
  $('#ev-start').value = e ? e.start : dateStr(todayMidnight());
  $('#ev-end').value = e ? e.end : dateStr(new Date(todayMidnight().getTime() + 6 * 86400000));
  $('#ev-delete').classList.toggle('hidden', !e);
  $('#modal-event').classList.remove('hidden');
  $('#ev-name').focus();
}
function saveEventFromForm() {
  const name = $('#ev-name').value.trim();
  const start = $('#ev-start').value;
  const end = $('#ev-end').value;
  if (!name) return toast('请输入事件名称', 'warn');
  if (!start || !end) return toast('请选择开始与结束日期', 'warn');
  if (end < start) return toast('结束日期不能早于开始日期', 'warn');
  if (editingEventId) {
    const e = events.find(x => x.id === editingEventId);
    if (e) Object.assign(e, { name, start, end, color: colorOf(name) });
    toast('事件已更新');
  } else {
    events.push({ id: uid(), name, start, end, color: colorOf(name) });
    toast('事件已添加');
  }
  save(LS.events, events);
  closeModal('modal-event');
  renderGantt();
}
function deleteEventFromForm() {
  if (!editingEventId) return;
  const e = events.find(x => x.id === editingEventId);
  if (e && confirm(`删除事件「${e.name}」？`)) {
    events = events.filter(x => x.id !== editingEventId);
    save(LS.events, events);
    closeModal('modal-event');
    renderGantt();
    toast('事件已删除');
  }
}

/* ==================== 用量中心 ==================== */
const fmtNum = n => Number(n || 0).toLocaleString('zh-CN');

/* 时段判定：高峰时段为北京时间 9:00-12:00、14:00-18:00，其余为空闲时段 */
function pricePeriodOf(date) {
  const h = date.getHours();
  return ((h >= 9 && h < 12) || (h >= 14 && h < 18)) ? 'peak' : 'off';
}
/* 模型名归一化 */
function normModel(m) {
  if (m.indexOf('deepseek-v4-flash') === 0) return 'deepseek-v4-flash';
  if (m.indexOf('deepseek-v4-pro') === 0) return 'deepseek-v4-pro';
  if (m.indexOf('deepseek-chat') === 0) return 'deepseek-chat';
  if (m.indexOf('deepseek-reasoner') === 0) return 'deepseek-reasoner';
  return m;
}
const PRICE_MODELS = [
  { key: 'flash', name: 'deepseek-v4-flash', label: '⚡ deepseek-v4-flash' },
  { key: 'pro', name: 'deepseek-v4-pro', label: '🚀 deepseek-v4-pro' },
];
const DEFAULT_MODEL_PRICE = () => ({ off: { hit: 0.25, miss: 1, out: 4 }, peak: { hit: 0.5, miss: 2, out: 8 } });
/* 每模型独立单价：settings.prices.models[模型名] = { off:{hit,miss,out}, peak:{hit,miss,out} } */
function modelPrices(model) {
  const p = (settings.prices || {}).models || {};
  return p[normModel(model)] || DEFAULT_MODEL_PRICE();
}
function costOfPeriod(model, hit, miss, out, period) {
  const pr = modelPrices(model)[period] || {};
  return (hit || 0) / 1e6 * (pr.hit || 0) + (miss || 0) / 1e6 * (pr.miss || 0) + (out || 0) / 1e6 * (pr.out || 0);
}
function costOfSplit(model, peak, off) {
  const a = peak || {}, b = off || {};
  return costOfPeriod(model, a.hit, a.miss, a.out, 'peak') + costOfPeriod(model, b.hit, b.miss, b.out, 'off');
}
/* 旧全局单价结构 → 每模型独立单价（迁移；V4 默认值为占位，请按官方文档修改） */
function migratePrices() {
  const p = settings.prices || {};
  if (p.models) return;
  const off = p.off || { hit: 0.25, miss: 1, out: 4 };
  const peak = p.peak || { hit: 0.5, miss: 2, out: 8 };
  settings.prices = {
    models: {
      'deepseek-v4-flash': { off: { ...off }, peak: { ...peak } },
      'deepseek-v4-pro': { off: { hit: 0.5, miss: 2, out: 8 }, peak: { hit: 1, miss: 4, out: 16 } },
    },
  };
  save(LS.settings, settings);
}
/* 已下线模型迁移：chat/reasoner → v4-flash；单价配置中删除对应条目 */
function migrateAgentModel() {
  let changed = false;
  if (agentCfg.model === 'deepseek-chat' || agentCfg.model === 'deepseek-reasoner') {
    agentCfg.model = 'deepseek-v4-flash';
    changed = true;
  }
  const models = (settings.prices || {}).models;
  if (models) {
    if (models['deepseek-chat']) { delete models['deepseek-chat']; changed = true; }
    if (models['deepseek-reasoner']) { delete models['deepseek-reasoner']; changed = true; }
  }
  if (changed) {
    save(LS.agent, agentCfg);
    save(LS.settings, settings);
  }
}
/* 动态渲染每模型六项单价面板 */
function renderUsPrices() {
  const box = $('#us-price-groups');
  if (!box) return;
  const models = (settings.prices || {}).models || {};
  box.innerHTML = PRICE_MODELS.map(pm => {
    const pr = models[pm.name] || DEFAULT_MODEL_PRICE();
    const row = (period, label) => `<div class="us-price-row">
      <span class="us-price-period">${label}</span>
      <label class="inline-field">命中缓存 <input id="pr-${pm.key}-${period}-hit" type="number" min="0" step="0.1" style="width:64px" value="${(pr[period] || {}).hit ?? ''}" /></label>
      <label class="inline-field">未命中 <input id="pr-${pm.key}-${period}-miss" type="number" min="0" step="0.1" style="width:64px" value="${(pr[period] || {}).miss ?? ''}" /></label>
      <label class="inline-field">输出 <input id="pr-${pm.key}-${period}-out" type="number" min="0" step="0.1" style="width:64px" value="${(pr[period] || {}).out ?? ''}" /></label>
    </div>`;
    return `<div class="us-price-group"><div class="us-price-title">${pm.label}</div>${row('off', '🌙 空闲')}${row('peak', '☀️ 高峰')}</div>`;
  }).join('');
}
/* 旧版统计数据结构迁移：旧 promptTokens 视作未命中输入、completionTokens 视作输出、全归高峰时段 */
function migrateUsage() {
  let changed = false;
  Object.values(usageStats.byDay || {}).forEach(d => {
    if (d.peak === undefined) {
      d.peak = { hit: 0, miss: d.promptTokens || 0, out: d.completionTokens || 0 };
      d.off = { hit: 0, miss: 0, out: 0 };
      changed = true;
    }
    Object.values(d.hours || {}).forEach(h => {
      if (!h.models) {
        // 旧结构：{hit,miss,out,period} 或 {promptTokens,completionTokens} → 归入 deepseek-chat
        const hh = (h.hit !== undefined)
          ? { hit: h.hit || 0, miss: h.miss || 0, out: h.out || 0 }
          : { hit: 0, miss: h.promptTokens || 0, out: h.completionTokens || 0 };
        h.models = { 'deepseek-chat': hh };
        if (!h.period) h.period = 'peak';
        changed = true;
      }
    });
    Object.entries(d.models || {}).forEach(([m, v]) => {
      if (v.peak === undefined) {
        v.peak = { hit: 0, miss: v.promptTokens || 0, out: v.completionTokens || 0 };
        v.off = { hit: 0, miss: 0, out: 0 };
        changed = true;
      }
    });
  });
  if (changed) save(LS.usage, usageStats);
}
/* 记录一次 API 调用用量：缓存命中/未命中/输出 × 高峰/空闲 双维度聚合 */
function recordUsage(model, usage) {
  if (!usage) return;
  const now = new Date();
  const day = dateStr(now);
  const hour = String(now.getHours()).padStart(2, '0');
  const period = pricePeriodOf(now);
  if (!usageStats.byDay) usageStats.byDay = {};
  if (!usageStats.byDay[day]) {
    usageStats.byDay[day] = {
      requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0,
      peak: { hit: 0, miss: 0, out: 0 }, off: { hit: 0, miss: 0, out: 0 },
      hours: {}, models: {},
    };
  }
  const d = usageStats.byDay[day];
  const pt = usage.prompt_tokens || 0;
  const ct = usage.completion_tokens || 0;
  const hit = usage.prompt_cache_hit_tokens || 0;
  const miss = usage.prompt_cache_miss_tokens || Math.max(0, pt - hit);
  const m = model || 'deepseek-chat';
  d.requests++;
  d.promptTokens += pt;
  d.completionTokens += ct;
  d.totalTokens += usage.total_tokens || pt + ct;
  const seg = d[period];
  seg.hit += hit;
  seg.miss += miss;
  seg.out += ct;
  if (!d.hours[hour]) d.hours[hour] = { period, models: {} };
  const hb = d.hours[hour];
  if (!hb.period) hb.period = period;
  if (!hb.models) hb.models = {};
  if (!hb.models[m]) hb.models[m] = { hit: 0, miss: 0, out: 0 };
  hb.models[m].hit += hit;
  hb.models[m].miss += miss;
  hb.models[m].out += ct;
  if (!d.models[m]) d.models[m] = { requests: 0, peak: { hit: 0, miss: 0, out: 0 }, off: { hit: 0, miss: 0, out: 0 } };
  const mb = d.models[m];
  mb.requests++;
  mb[period].hit += hit;
  mb[period].miss += miss;
  mb[period].out += ct;
  save(LS.usage, usageStats);
}
function rangeDays(range) {
  if (range === 'today') return [dateStr(new Date())];
  if (range === 'all') return Object.keys(usageStats.byDay || {}).sort();
  const n = range === '7d' ? 7 : 30;
  const out = [];
  for (let i = 0; i < n; i++) out.push(dateStr(new Date(Date.now() - i * 86400000)));
  return out.sort();
}
function aggregateRange(range) {
  const models = {};
  let requests = 0, hit = 0, miss = 0, out = 0, cost = 0;
  rangeDays(range).forEach(day => {
    const d = (usageStats.byDay || {})[day];
    if (!d) return;
    const pk = d.peak || {}, of = d.off || {};
    hit += (pk.hit || 0) + (of.hit || 0);
    miss += (pk.miss || 0) + (of.miss || 0);
    out += (pk.out || 0) + (of.out || 0);
    Object.entries(d.models || {}).forEach(([m, v]) => {
      const mn = normModel(m);
      if (!models[mn]) models[mn] = { requests: 0, peak: { hit: 0, miss: 0, out: 0 }, off: { hit: 0, miss: 0, out: 0 } };
      const mb = models[mn];
      mb.requests += v.requests || 0;
      const mp = v.peak || {}, mo = v.off || {};
      mb.peak.hit += mp.hit || 0; mb.peak.miss += mp.miss || 0; mb.peak.out += mp.out || 0;
      mb.off.hit += mo.hit || 0; mb.off.miss += mo.miss || 0; mb.off.out += mo.out || 0;
      cost += costOfSplit(mn, mp, mo); // 按各模型独立单价计价
      requests += v.requests || 0;
    });
  });
  const modelsOut = {};
  Object.entries(models).forEach(([m, v]) => {
    modelsOut[m] = {
      requests: v.requests,
      hit: v.peak.hit + v.off.hit,
      miss: v.peak.miss + v.off.miss,
      out: v.peak.out + v.off.out,
      cost: costOfSplit(m, v.peak, v.off),
    };
  });
  return { requests, hit, miss, out, totalTokens: hit + miss + out, cost, models: modelsOut };
}
/* 官方余额接口（api.deepseek.com/user/balance，Bearer Key） */
async function fetchBalance() {
  if (!agentCfg.apiKey) return toast('请先在智能体页配置 DeepSeek API Key', 'warn');
  try {
    const resp = await fetch(agentCfg.baseUrl.replace(/\/+$/, '') + '/user/balance', {
      headers: { Authorization: 'Bearer ' + agentCfg.apiKey },
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const info = (data.balance_infos || [])[0] || {};
    balance = {
      ok: true,
      total: info.total_balance || '0',
      granted: info.granted_balance || '0',
      topped: info.topped_up_balance || '0',
      currency: info.currency || 'CNY',
      time: Date.now(),
    };
    save(LS.balance, balance);
    renderBalance();
    toast('余额已刷新');
  } catch (err) {
    balance = { ok: false, error: String(err.message || err), time: Date.now() };
    save(LS.balance, balance);
    renderBalance();
    toast('余额获取失败：' + (err.message || err), 'warn');
  }
}
function renderBalance() {
  const box = $('#us-balance');
  const b = balance;
  if (!b || !b.ok) {
    box.innerHTML = `<div class="card us-bal-err">
      <span>${b && b.error
        ? '余额获取失败：' + esc(b.error) + '（可能为跨域限制；不影响本地消耗统计）'
        : '尚未获取官方余额，点击右侧按钮查询'}</span>
      <button class="btn primary" data-act="refresh">🔄 刷新余额</button>
    </div>`;
    return;
  }
  const cur = b.currency === 'USD' ? '$' : '¥';
  const fmtBal = v => cur + fmtNum(Number(v || 0));
  const upd = b.time ? `更新于 ${fmtSessTime(b.time)}` : '';
  box.innerHTML = `<div class="us-bal-cards">
    <div class="card stat"><div class="stat-icon bg-green">💰</div><div class="stat-info">
      <div class="stat-label">总余额</div><div class="stat-value">${fmtBal(b.total)}</div>
      <div class="stat-sub">DeepSeek 官方账户</div></div></div>
    <div class="card stat"><div class="stat-icon bg-blue">🎁</div><div class="stat-info">
      <div class="stat-label">赠送余额</div><div class="stat-value">${fmtBal(b.granted)}</div>
      <div class="stat-sub">平台赠送额度</div></div></div>
    <div class="card stat"><div class="stat-icon bg-orange">💳</div><div class="stat-info">
      <div class="stat-label">充值余额</div><div class="stat-value">${fmtBal(b.topped)}</div>
      <div class="stat-sub">充值金额</div></div></div>
    <button class="btn ghost us-bal-refresh" data-act="refresh">🔄 刷新</button>
    <span class="us-bal-time">${upd}</span>
  </div>`;
}
function renderUsChart() {
  const box = $('#us-chart');
  const hint = $('#us-chart-hint');
  const range = usRange;
  let series = [];
  if (range === 'today') {
    const d = (usageStats.byDay || {})[dateStr(new Date())];
    series = Array.from({ length: 24 }, (_, h) => {
      const hb = (d && d.hours[String(h).padStart(2, '0')]) || { period: 'peak', models: {} };
      const period = hb.period || 'peak';
      let hit = 0, miss = 0, out = 0, cost = 0;
      Object.entries(hb.models || {}).forEach(([m, v]) => {
        hit += v.hit || 0; miss += v.miss || 0; out += v.out || 0;
        cost += costOfPeriod(m, v.hit, v.miss, v.out, period);
      });
      return {
        label: h + '时',
        pt: hit + miss,
        ct: out,
        tip: `输入·命中 ${fmtNum(hit)} / 未命中 ${fmtNum(miss)} · 输出 ${fmtNum(out)} · 约 ¥${cost.toFixed(4)}`,
      };
    });
  } else {
    series = rangeDays(range).map(day => {
      const d = (usageStats.byDay || {})[day];
      if (!d) return { label: day.slice(5), pt: 0, ct: 0, tip: day + '：无记录' };
      const pk = d.peak || {}, of = d.off || {};
      const pt = (pk.hit || 0) + (pk.miss || 0) + (of.hit || 0) + (of.miss || 0);
      const ct = (pk.out || 0) + (of.out || 0);
      let dayCost = 0;
      Object.entries(d.models || {}).forEach(([m, v]) => {
        dayCost += costOfSplit(m, v.peak, v.off);
      });
      return {
        label: day.slice(5),
        pt, ct,
        tip: `${day}：输入(命中 ${fmtNum((pk.hit || 0) + (of.hit || 0))} / 未命中 ${fmtNum((pk.miss || 0) + (of.miss || 0))}) · 输出 ${fmtNum(ct)} · 约 ¥${dayCost.toFixed(3)}`,
      };
    });
  }
  const agg = aggregateRange(range);
  hint.textContent = `${agg.requests} 次请求 · 输入(命中 ${fmtNum(agg.hit)} / 未命中 ${fmtNum(agg.miss)}) · 输出 ${fmtNum(agg.out)} · 约 ¥${agg.cost.toFixed(3)}`;
  const maxV = Math.max(1, ...series.map(s => s.pt + s.ct));
  const anyData = series.some(s => s.pt || s.ct);
  if (!anyData) {
    box.innerHTML = '<div class="tp-empty">该时间段暂无调用记录</div>';
    return;
  }
  box.innerHTML = `<div class="us-bars">${series.map(s => {
    const hIn = Math.round(s.pt / maxV * 100);
    const hOut = Math.round(s.ct / maxV * 100);
    return `<div class="us-bar-col" title="${esc(s.tip)}">
      <div class="us-bar-stack"><div class="us-bar-in" style="height:${hIn}%"></div><div class="us-bar-out" style="height:${hOut}%"></div></div>
      <div class="us-bar-label">${s.label}</div>
    </div>`;
  }).join('')}</div>
  <div class="us-legend"><span><span class="dot in"></span>输入 tokens</span><span><span class="dot out"></span>输出 tokens</span><span class="us-bal-time">（悬停查看缓存命中/未命中明细）</span></div>`;
}
function renderUsTable() {
  const body = $('#us-table-body');
  const hint = $('#us-table-hint');
  const names = { today: '今日', '7d': '近7天', '30d': '近30天', all: '全部' };
  hint.textContent = '范围：' + (names[usRange] || usRange) + ' · 费用按空闲/高峰时段分别计价';
  const agg = aggregateRange(usRange);
  const rows = Object.entries(agg.models)
    .sort((a, b) => (b[1].hit + b[1].miss + b[1].out) - (a[1].hit + a[1].miss + a[1].out))
    .map(([m, v]) => `<tr><td>${esc(m)}</td><td>${v.requests}</td><td>${fmtNum(v.hit)}</td><td>${fmtNum(v.miss)}</td><td>${fmtNum(v.out)}</td><td>¥${v.cost.toFixed(3)}</td></tr>`)
    .join('');
  body.innerHTML = rows || '<tr><td colspan="6" class="empty">该时间段暂无记录</td></tr>';
  if (rows) {
    body.innerHTML += `<tr><td><b>合计</b></td><td>${agg.requests}</td><td>${fmtNum(agg.hit)}</td><td>${fmtNum(agg.miss)}</td><td>${fmtNum(agg.out)}</td><td>¥${agg.cost.toFixed(3)}</td></tr>`;
  }
}
function renderUsage() {
  renderBalance();
  renderUsChart();
  renderUsTable();
  renderUsPrices();
}

/* ==================== 高德地图 ==================== */
let amapMap = null;      // AMap 地图实例
let amapMarkers = [];    // 当前标记集合
let amapInfoWindow = null; // 信息窗体
let amapCurrentPois = [];  // 当前搜索结果
let amapHighlight = null;  // 建筑位置高亮框（虚线+淡蓝透明）
let amapFenceOverlays = []; // 围栏地图覆盖物
let amapFenceFlags = [];     // 围栏定位标志（🚩）
let mouseToolInstance = null; // 围栏绘制工具
let editingFenceId = null;    // 重绘的围栏 id（空=新建）
let fenceDraftName = '';      // 绘制中的围栏名
let fenceDrawType = 'polygon'; // 当前绘制形状
let fenceCircleMode = 'drag';  // 圆形围栏半径设定方式 drag/input
let centerPickHandler = null;  // 点选圆心的地图点击监听
let pickConstraintFenceId = null; // 选点绘制：约束用旧围栏 id
let pickedFencePoints = [];    // 选点绘制：已选点集合
let pickFenceHandler = null;   // 选点绘制：地图点击监听
let fencesInteractive = true;  // 旧围栏覆盖物是否可点击（绘制模式下关闭，让点击穿透到地图）
let rangingToolInstance = null; // 测距工具实例
let rangingActive = false;      // 测距是否激活
let amapRouteOverlays = [];     // 路径规划覆盖物（起终点标注）
let amapRouteLines = [];        // 路线折线（与标注分开，便于切换主方案样式）
let plannedRoutes = [];         // 当前规划的全部方案
let plannedMainIdx = 0;         // 当前主方案索引
let lastRouteMeta = null;       // 最近一次规划元信息 {modeName,oName,dName}
let routeOriginSel = null;      // 已选起点 {lng,lat,name,address}
let routeDestSel = null;        // 已选终点
let routePickStage = null;      // 选点阶段 'origin' | 'dest' | null（对照地图选点）

function updateMapStatus(text) {
  const el = $('#map-status');
  if (el) el.textContent = text;
}
/* 高德 Web服务 API 通用请求（CORS 受限时给出提示） */
async function amapGet(path, params, version = 'v3') {
  if (!mapCfg.key) return { error: '未配置高德 API Key，请先在地图页「⚙️ Key 配置」填写并测试' };
  const qs = new URLSearchParams(Object.assign({ key: mapCfg.key }, params)).toString();
  let resp;
  try {
    resp = await fetch('https://restapi.amap.com/' + version + '/' + path + '?' + qs);
  } catch (e) {
    return { error: '网络请求失败：' + (e.message || e) + '。若为跨域(CORS)问题，请通过 HTTPS（GitHub Pages）访问本页' };
  }
  try { return await resp.json(); } catch (e) { return { error: '响应解析失败 HTTP ' + resp.status }; }
}
/* 加载 JS API 2.0（需 Key + 安全密钥；_AMapSecurityConfig 必须在脚本前设置） */
function loadAMap() {
  return new Promise((resolve, reject) => {
    if (window.AMap) { resolve(window.AMap); return; }
    if (!mapCfg.key) { reject(new Error('未配置 API Key')); return; }
    window._AMapSecurityConfig = { securityJsCode: mapCfg.securityCode || '' };
    const s = document.createElement('script');
    s.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(mapCfg.key) + '&plugin=AMap.Geolocation,AMap.PlaceSearch';
    s.onload = () => resolve(window.AMap);
    s.onerror = () => reject(new Error('JS SDK 加载失败，请检查 Key 与安全密钥是否匹配'));
    document.head.appendChild(s);
  });
}
/* 确保地图实例就绪（供页面与 Agent 共用） */
async function ensureMapReady() {
  if (!mapCfg.key) throw new Error('未配置 API Key');
  await loadAMap();
  if (!amapMap) {
    const el = $('#map-container');
    el.innerHTML = '';
    amapMap = new AMap.Map(el, { center: [108.939621, 34.343147], zoom: 4, viewMode: '2D' });
  }
  return amapMap;
}
function renderMapEmpty(text) {
  const el = $('#map-container');
  el.innerHTML = `<div class="map-empty">${esc(text)}<br /><button class="btn primary" data-act="config" style="margin-top:10px">⚙️ 配置 Key</button></div>`;
}
function clearMarkers() {
  if (!amapMap) return;
  amapMarkers.forEach(m => amapMap.remove(m));
  amapMarkers = [];
  if (amapInfoWindow) amapInfoWindow.close();
  clearHighlight();
  clearRoute();
}
/* 建筑位置高亮框：虚线描边 + 淡蓝半透明填充（约150米见方近似轮廓） */
function clearHighlight() {
  if (amapHighlight && amapMap) {
    try { amapMap.remove(amapHighlight); } catch (e) { /* 忽略 */ }
    amapHighlight = null;
  }
}
function highlightArea(lnglat, sizeDeg) {
  if (!amapMap) return;
  clearHighlight();
  const [lng, lat] = lnglat;
  const d = (sizeDeg || 0.0016) / 2; // 0.0016° ≈ 150 米
  const path = [
    [lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d],
  ];
  amapHighlight = new AMap.Polygon({
    path,
    strokeColor: '#4f6ef7',
    strokeWeight: 2,
    strokeStyle: 'dashed',
    strokeOpacity: 0.95,
    fillColor: '#4f6ef7',
    fillOpacity: 0.12,
    zIndex: 110,
  });
  amapMap.add(amapHighlight);
}

/* ==================== 电子围栏 ==================== */
function centerOfPath(path) {
  if (!path || !path.length) return null;
  const n = path.length;
  const s = path.reduce((a, p) => [a[0] + p[0], a[1] + p[1]], [0, 0]);
  return [s[0] / n, s[1] / n];
}
/* ==================== 嵌套围栏辅助（点在圆/多边形内判断） ==================== */
function metersBetween(a, b) {
  const R = 6371000;
  const dLat = (b[1] - a[1]) * Math.PI / 180;
  const dLng = (b[0] - a[0]) * Math.PI / 180;
  const la1 = a[1] * Math.PI / 180, la2 = b[1] * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function pointInPolygon(p, path) {
  let inside = false;
  for (let i = 0, j = path.length - 1; i < path.length; j = i++) {
    const xi = path[i][0], yi = path[i][1], xj = path[j][0], yj = path[j][1];
    if (((yi > p[1]) !== (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
/* 判断点是否在某围栏内（旧围栏作为新围栏选点的约束区域） */
function pointInsideFence(fence, p) {
  if (!fence) return true;
  if (fence.type === 'circle') {
    return metersBetween(p, fence.circle.center) <= fence.circle.radius;
  }
  if (fence.polygon && fence.polygon.path.length >= 3) {
    return pointInPolygon(p, fence.polygon.path);
  }
  return true;
}
/* 绘制模式下关闭旧围栏点击，让点击穿透到地图；结束后恢复 */
function setFencesInteractive(on) {
  fencesInteractive = on;
  renderFences();
}
/* 地图上渲染全部围栏（橙色虚线 + 半透明填充） */
function renderFences() {
  if (!amapMap) { renderFenceList(); return; }
  amapFenceOverlays.forEach(o => { try { amapMap.remove(o); } catch (e) { /* 忽略 */ } });
  amapFenceOverlays = [];
  amapFenceFlags.forEach(o => { try { amapMap.remove(o); } catch (e) { /* 忽略 */ } });
  amapFenceFlags = [];
  const style = {
    strokeColor: '#f59e0b', strokeWeight: 2, strokeStyle: 'dashed', strokeOpacity: 0.95,
    fillColor: '#f59e0b', fillOpacity: 0.14, zIndex: 105,
    clickable: fencesInteractive, // 绘制模式关闭点击，避免吞掉地图点击
  };
  fences.forEach(f => {
    let o;
    if (f.type === 'circle') {
      o = new AMap.Circle(Object.assign({ center: f.circle.center, radius: f.circle.radius }, style));
    } else if (f.polygon && f.polygon.path && f.polygon.path.length >= 3) {
      o = new AMap.Polygon(Object.assign({ path: f.polygon.path }, style));
    }
    if (o) {
      const center = f.type === 'circle' ? f.circle.center : centerOfPath(f.polygon.path);
      // 始终绑定点击：绘制模式下强制转发给选点/圆心逻辑（保证旧围栏内可点击），否则弹信息窗
      o.on('click', e => {
        if (pickFenceHandler) { pickFenceHandler(e); return; }
        if (centerPickHandler) { centerPickHandler(e); return; }
        if (fencesInteractive) {
          showInfo('<b>⛓️ ' + esc(f.name) + '</b><br />' + (f.type === 'circle' ? '圆形电子围栏' : '多边形电子围栏'), center);
        }
      });
      amapMap.add(o);
      amapFenceOverlays.push(o);
    }
  });
  renderFenceList();
}
function renderFenceList() {
  const box = $('#fence-list');
  const count = $('#fence-count');
  if (!box) return;
  if (count) count.textContent = fences.length ? `共 ${fences.length} 个电子围栏` : '';
  if (!fences.length) {
    box.innerHTML = '<div class="tp-empty">暂无电子围栏<br>点击顶部「⛓️ 电子围栏」按钮在地图上绘制</div>';
    return;
  }
  box.innerHTML = fences.map(f => `<div class="fence-item" data-id="${f.id}">
    <div class="fence-icon">${f.type === 'circle' ? '◯' : '⬠'}</div>
    <div class="fence-info">
      <div class="fence-name">${esc(f.name)}</div>
      <div class="fence-meta">${f.type === 'circle' ? '圆形 · 半径 ' + Math.round(f.circle.radius) + ' 米' : '多边形 · ' + (f.polygon ? f.polygon.path.length : 0) + ' 个顶点'}</div>
    </div>
    <div class="fence-ops">
      <button title="定位" data-act="locate">📍</button>
      <button title="改名" data-act="rename">✏️</button>
      <button title="重绘" data-act="redraw">🔄</button>
      <button title="删除" class="danger" data-act="del">🗑</button>
    </div>
  </div>`).join('');
}
function openFenceModal() {
  if (!mapCfg.key) { toast('请先配置高德 Key', 'warn'); openMapConfigModal(); return; }
  $('#fence-modal-title').textContent = '⛓️ 新建电子围栏';
  $('#fence-name').value = '';
  $('#fence-radius').value = 200;
  $('#fence-draw-mode').value = 'free';
  fenceCircleMode = 'drag';
  // 约束围栏下拉（选点绘制模式用）
  const sel = $('#fence-constraint');
  sel.innerHTML = fences.length
    ? fences.map(f => `<option value="${f.id}">${esc(f.name)}（${f.type === 'circle' ? '圆形' : '多边形'}）</option>`).join('')
    : '<option value="">暂无旧围栏</option>';
  $$('.fence-type-card').forEach(x => x.classList.toggle('active', x.dataset.type === 'polygon'));
  $$('#fence-circle-mode .seg-btn').forEach(x => x.classList.toggle('active', x.dataset.mode === 'drag'));
  $('#fence-radius-group').classList.add('hidden');
  $('#fence-pick-group').classList.remove('hidden');
  // 同步把右侧面板切到围栏标签，保存后立即可见
  const tabBtn = document.querySelector('#map-side-tabs [data-tab="fences"]');
  if (tabBtn) tabBtn.click();
  $('#modal-fence').classList.remove('hidden');
  $('#fence-name').focus();
}
/* 输入半径模式：地图单击选择圆心，按输入半径生成圆形围栏 */
async function startCenterPick(name, radius) {
  try {
    await ensureMapReady();
    setFencesInteractive(false); // 旧围栏不可点击，让点击穿透到地图
    showDrawBanner(`⛓️ 请在地图上单击选择圆心位置（半径 ${radius} 米）`, false);
    let lastPickTs = 0;
    centerPickHandler = e => {
      if (!e || !e.lnglat) return;
      const now = Date.now();
      if (now - lastPickTs < 300) return; // 防重复触发（覆盖物转发+地图点击双路径）
      lastPickTs = now;
      amapMap.off('click', centerPickHandler);
      centerPickHandler = null;
      hideDrawBanner();
      if (!fencesInteractive) setFencesInteractive(true); // 恢复旧围栏点击
      const center = [e.lnglat.getLng(), e.lnglat.getLat()];
      const fence = { id: editingFenceId || uid(), name, type: 'circle', circle: { center, radius }, createdAt: Date.now(), updatedAt: Date.now() };
      if (editingFenceId) {
        const idx = fences.findIndex(x => x.id === editingFenceId);
        if (idx >= 0) { fence.createdAt = fences[idx].createdAt; fences[idx] = fence; }
        editingFenceId = null;
        toast(`围栏「${fence.name}」已重绘保存`);
      } else {
        fences.push(fence);
        toast(`电子围栏「${fence.name}」已保存`);
      }
      save(LS.fences, fences);
      renderFences();
      updateMapStatus(`圆形围栏已保存（圆心点选，半径 ${radius} 米）`);
    };
    amapMap.on('click', centerPickHandler);
  } catch (err) {
    toast('启动圆心选择失败：' + (err.message || err), 'err');
  }
}
/* 选点绘制模式：在旧围栏内点选多个点作为新围栏顶点（新旧围栏相互独立） */
function showDrawBanner(text, showDone) {
  const banner = $('#map-draw-banner');
  if (banner) {
    banner.classList.remove('hidden');
    $('#map-draw-text').textContent = text;
    $('#map-draw-done').classList.toggle('hidden', !showDone);
  }
}
function hideDrawBanner() {
  const banner = $('#map-draw-banner');
  if (banner) banner.classList.add('hidden');
  $('#map-draw-done').classList.add('hidden');
}
async function startFencePointPick(name, fid) {
  try {
    await ensureMapReady();
    setFencesInteractive(false); // 旧围栏不可点击，让点击穿透到地图
    const cf = fences.find(x => x.id === fid);
    if (!cf) return toast('约束围栏不存在，请重新选择', 'warn');
    pickConstraintFenceId = fid;
    pickedFencePoints = [];
    zoomToFence(cf); // 定位到约束围栏，便于对照选点
    showDrawBanner(`🎯 请在「${cf.name}」内依次单击选择点（≥3 个），点「✅ 完成」生成围栏`, true);
    let lastPickTs = 0;
    pickFenceHandler = e => {
      if (!e || !e.lnglat) return;
      const now = Date.now();
      if (now - lastPickTs < 300) return; // 防重复触发（覆盖物转发+地图点击双路径）
      lastPickTs = now;
      const p = [e.lnglat.getLng(), e.lnglat.getLat()];
      if (!pointInsideFence(cf, p)) {
        toast('该点不在约束围栏内，已忽略', 'warn');
        return;
      }
      pickedFencePoints.push(p);
      const dot = new AMap.Marker({
        position: p,
        content: '<div style="width:10px;height:10px;border-radius:50%;background:#f59e0b;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.3)"></div>',
        offset: new AMap.Pixel(-5, -5),
        zIndex: 130,
      });
      amapMap.add(dot);
      amapFenceFlags.push(dot);
      $('#map-draw-text').textContent = `🎯 已选 ${pickedFencePoints.length} 个点，继续单击或点「✅ 完成」`;
    };
    amapMap.on('click', pickFenceHandler);
  } catch (err) {
    toast('启动选点绘制失败：' + (err.message || err), 'err');
  }
}
function finishFencePointPick() {
  if (!pickFenceHandler) return;
  amapMap.off('click', pickFenceHandler);
  pickFenceHandler = null;
  hideDrawBanner();
  if (!fencesInteractive) setFencesInteractive(true); // 恢复旧围栏点击
  if (pickedFencePoints.length < 3) {
    toast('至少需要 3 个点才能构成围栏', 'warn');
    updateMapStatus('选点不足（<3），请重新绘制');
    return;
  }
  const fence = {
    id: editingFenceId || uid(),
    name: fenceDraftName,
    type: 'polygon',
    polygon: { path: pickedFencePoints },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  if (editingFenceId) {
    const idx = fences.findIndex(x => x.id === editingFenceId);
    if (idx >= 0) { fence.createdAt = fences[idx].createdAt; fences[idx] = fence; }
    editingFenceId = null;
    toast(`围栏「${fence.name}」已重绘保存`);
  } else {
    fences.push(fence);
    toast(`电子围栏「${fence.name}」已保存（${pickedFencePoints.length} 个点）`);
  }
  save(LS.fences, fences);
  renderFences();
  updateMapStatus('选点围栏已保存，新旧围栏相互独立');
}
function ensureMouseTool() {
  return new Promise((resolve, reject) => {
    if (!window.AMap) return reject(new Error('地图未就绪'));
    AMap.plugin(['AMap.MouseTool'], () => resolve(AMap.MouseTool));
  });
}
function closeMouseTool() {
  if (mouseToolInstance) {
    try { mouseToolInstance.close(true); } catch (e) { /* 忽略 */ }
    mouseToolInstance = null;
  }
  hideDrawBanner();
  if (!fencesInteractive) setFencesInteractive(true); // 恢复旧围栏点击
}
async function startFenceDraw(type, name) {
  try {
    await ensureMapReady();
    setFencesInteractive(false); // 旧围栏不可点击，让点击穿透到地图
    const MouseTool = await ensureMouseTool();
    closeMouseTool();
    mouseToolInstance = new MouseTool(amapMap);
    fenceDrawType = type;
    fenceDraftName = name || '电子围栏';
    const style = {
      strokeColor: '#f59e0b', strokeWeight: 2, strokeStyle: 'dashed', strokeOpacity: 0.95,
      fillColor: '#f59e0b', fillOpacity: 0.14,
    };
    if (type === 'polygon') mouseToolInstance.polygon(style);
    else mouseToolInstance.circle(style);
    mouseToolInstance.on('draw', onFenceDrawn);
    // 顶部绘制提示浮条（无完成按钮）
    showDrawBanner(type === 'polygon'
      ? '⛓️ 正在绘制多边形围栏：单击添加顶点，双击结束'
      : '⛓️ 正在绘制圆形围栏：单击定圆心，拖动定半径', false);
    updateMapStatus('围栏绘制中，见地图顶部提示');
  } catch (err) {
    toast('启动绘制失败：' + (err.message || err), 'err');
  }
}
function onFenceDrawn(e) {
  const obj = e.obj;
  closeMouseTool();
  let fence = null;
  if (fenceDrawType === 'polygon') {
    const path = obj.getPath && obj.getPath();
    if (path && path.length >= 3) {
      fence = { id: editingFenceId || uid(), name: fenceDraftName, type: 'polygon', polygon: { path: path.map(p => [p.lng, p.lat]) }, createdAt: Date.now(), updatedAt: Date.now() };
    }
  } else {
    const center = obj.getCenter && obj.getCenter();
    const radius = obj.getRadius && obj.getRadius();
    if (center && radius) {
      fence = { id: editingFenceId || uid(), name: fenceDraftName, type: 'circle', circle: { center: [center.lng, center.lat], radius }, createdAt: Date.now(), updatedAt: Date.now() };
    }
  }
  if (!fence) { updateMapStatus('围栏绘制无效，请重试'); return; }
  if (editingFenceId) {
    const idx = fences.findIndex(x => x.id === editingFenceId);
    if (idx >= 0) { fence.createdAt = fences[idx].createdAt; fences[idx] = fence; }
    editingFenceId = null;
    toast(`围栏「${fence.name}」已重绘保存`);
  } else {
    fences.push(fence);
    toast(`电子围栏「${fence.name}」已保存`);
  }
  save(LS.fences, fences);
  renderFences();
  updateMapStatus('围栏已保存，可在右侧「⛓️ 围栏」面板管理');
}
function zoomToFence(f) {
  if (!amapMap || !f) return;
  const center = f.type === 'circle' ? f.circle.center : centerOfPath(f.polygon && f.polygon.path);
  // 清除旧标志
  amapFenceFlags.forEach(o => { try { amapMap.remove(o); } catch (e) { /* 忽略 */ } });
  amapFenceFlags = [];
  // 第一步：居中缩放（动画）
  if (f.type === 'circle') {
    amapMap.setZoomAndCenter(15, f.circle.center);
  } else if (f.polygon && f.polygon.path.length) {
    try {
      amapMap.setFitView(f.polygon.path.map(p => new AMap.LngLat(p[0], p[1])));
    } catch (e) {
      amapMap.setZoomAndCenter(15, center);
    }
  }
  if (!center) return;
  // 第二步：动画结束后（moveend）再生成 🚩 标志并弹信息窗；兜底定时器防止地图未移动不触发事件
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    try { amapMap.off('moveend', done); } catch (e) { /* 忽略 */ }
    const flag = makeLabelMarker(center, '🚩', f.name, '#10b981');
    flag.on('click', () => showInfo('<b>⛓️ ' + esc(f.name) + '</b><br />' + (f.type === 'circle' ? '圆形围栏 · 半径 ' + Math.round(f.circle.radius) + ' 米' : '多边形围栏 · ' + f.polygon.path.length + ' 个顶点'), center));
    amapMap.add(flag);
    amapFenceFlags.push(flag);
    showInfo('<b>⛓️ ' + esc(f.name) + '</b><br />' + (f.type === 'circle' ? '圆形围栏 · 半径 ' + Math.round(f.circle.radius) + ' 米' : '多边形围栏 · ' + f.polygon.path.length + ' 个顶点'), center);
  };
  amapMap.on('moveend', done);
  setTimeout(done, 900);
}

/* ==================== 测距与路径规划 ==================== */
function ensureRangingTool() {
  return new Promise((resolve, reject) => {
    if (!window.AMap) return reject(new Error('地图未就绪'));
    AMap.plugin(['AMap.RangingTool'], () => resolve(AMap.RangingTool));
  });
}
function stopRanging() {
  if (rangingToolInstance) {
    try { rangingToolInstance.turnOff(); } catch (e) { /* 忽略 */ }
    rangingToolInstance = null;
  }
  rangingActive = false;
  const b = $('#btn-map-ruler');
  if (b) { b.classList.remove('toggle-on'); b.textContent = '📏 测距'; }
}
async function toggleRanging() {
  if (!mapCfg.key) { toast('请先配置 Key', 'warn'); openMapConfigModal(); return; }
  try {
    await ensureMapReady();
    if (!rangingActive) {
      const RangingTool = await ensureRangingTool();
      rangingToolInstance = new RangingTool(amapMap, { lineOptions: { strokeColor: '#f59e0b', strokeWeight: 4 } });
      rangingToolInstance.turnOn();
      rangingActive = true;
      const b = $('#btn-map-ruler');
      b.classList.add('toggle-on');
      b.textContent = '📏 测距中…';
      updateMapStatus('测距中：单击添加测距点，双击结束');
    } else {
      stopRanging();
      updateMapStatus('测距已结束');
    }
  } catch (err) {
    toast('测距启动失败：' + (err.message || err), 'err');
  }
}
function clearRoute() {
  if (!amapMap) { amapRouteOverlays = []; amapRouteLines = []; return; }
  amapRouteOverlays.forEach(o => { try { amapMap.remove(o); } catch (e) { /* 忽略 */ } });
  amapRouteOverlays = [];
  amapRouteLines.forEach(o => { try { amapMap.remove(o); } catch (e) { /* 忽略 */ } });
  amapRouteLines = [];
}
/* 绘制全部方案：主方案蓝色实线，备选淡蓝虚线；点击备选可切换主方案 */
function drawPlannedRoutes(mainIdx) {
  if (!amapMap) return;
  amapRouteLines.forEach(o => { try { amapMap.remove(o); } catch (e) { /* 忽略 */ } });
  amapRouteLines = [];
  plannedMainIdx = mainIdx;
  plannedRoutes.forEach((rt, i) => {
    const isMain = i === mainIdx;
    const line = new AMap.Polyline({
      path: rt.points,
      strokeColor: isMain ? '#1989fa' : '#93c5fd',
      strokeWeight: isMain ? 6 : 4,
      strokeStyle: isMain ? 'solid' : 'dashed',
      strokeOpacity: isMain ? 0.95 : 0.55,
      lineJoin: 'round',
      zIndex: isMain ? 101 : 100,
    });
    amapMap.add(line);
    amapRouteLines.push(line);
  });
  const main = plannedRoutes[mainIdx];
  if (main && main.points.length) {
    try { amapMap.setFitView(main.points.map(p => new AMap.LngLat(p[0], p[1]))); } catch (e) { /* 忽略 */ }
  }
}
function rerenderRouteSummary() {
  if (lastRouteMeta && plannedRoutes.length) {
    renderRouteSummary(lastRouteMeta.modeName, lastRouteMeta.oName, lastRouteMeta.dName, plannedRoutes);
  }
}
function renderRouteSummary(modeName, oName, dName, routes) {
  $('#map-side-hint').textContent = '路径规划结果（点击方案可切换主路线）';
  const tabBtn = document.querySelector('#map-side-tabs [data-tab="results"]');
  if (tabBtn) tabBtn.click();
  const box = $('#map-results');
  const note = lastRouteMeta && lastRouteMeta.note ? `<div class="route-summary route-alt">ℹ️ ${esc(lastRouteMeta.note)}</div>` : '';
  let alt = 0;
  box.innerHTML =
    `<div class="route-edit-row"><button class="btn ghost btn-sm" data-act="edit-query">✏️ 修改查询条件</button></div>
    <div class="route-summary">🧭 <b>${esc(modeName)}</b>：${esc(oName)} → ${esc(dName)}</div>
    ${note}` +
    routes.map((rt, i) => {
      const isMain = i === plannedMainIdx;
      const label = isMain ? '🏆 <b>最优方案</b>' : '<b>备选方案 ' + (++alt) + '</b>';
      return `<div class="route-summary route-pick-card ${isMain ? '' : 'route-alt'}" data-act="pick-route" data-idx="${i}">
      ${label}：距离 <b>${fmtRouteDist(rt.distance)}</b> · 预计 <b>约 ${fmtRouteDur(rt.duration)}</b>
      ${rt.segDesc ? `<div class="route-seg">${esc(rt.segDesc)}</div>` : ''}
    </div>`;
    }).join('');
}
/* 输入解析：支持 经度,纬度 直接使用，否则地理编码 */
async function parseRouteInput(str) {
  const s = String(str || '').trim();
  if (!s) return { error: '输入不能为空' };
  const m = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return { lng: +m[1], lat: +m[2] };
  const r = await amapGet('geocode/geo', { address: s });
  if (r.status !== '1' || !r.geocodes || !r.geocodes.length) {
    return { error: `无法定位「${s}」，请换更具体的地址或直接填 经度,纬度` };
  }
  const [lng, lat] = r.geocodes[0].location.split(',').map(Number);
  return { lng, lat };
}
function pushPolyline(str, out) {
  if (!str) return;
  String(str).split(';').forEach(seg => {
    const [lng, lat] = seg.split(',').map(Number);
    if (!isNaN(lng) && !isNaN(lat)) out.push([lng, lat]);
  });
}
/* 解析全部方案（最多3条）：最优+备选。transit 为换乘方案（步行/公交/地铁段拼合） */
function parseRouteDataList(r, mode) {
  if (mode === 'transit') {
    const transits = (r.route && r.route.transits) || [];
    // 全部解析（不截断），地铁模式需先过滤再取前3
    return transits.map(t => {
      const points = [];
      const segs = [];
      let hasRailway = false, hasBus = false;
      (t.segments || []).forEach(seg => {
        if (seg.walking && seg.walking.steps) {
          seg.walking.steps.forEach(st => pushPolyline(st.polyline, points));
          if (seg.walking.distance) segs.push('🚶' + (seg.walking.distance >= 1000 ? (seg.walking.distance / 1000).toFixed(1) + 'km' : Math.round(seg.walking.distance) + 'm'));
        }
        if (seg.bus && seg.bus.buslines) {
          seg.bus.buslines.forEach(bl => pushPolyline(bl.polyline, points));
          const names = seg.bus.buslines.map(b => b.name).filter(Boolean);
          if (names.length) { segs.push('🚌' + names.join('/')); hasBus = true; }
        }
        if (seg.railway) {
          pushPolyline(seg.railway.alt_polyline, points);
          if (seg.railway.via_stops) seg.railway.via_stops.forEach(v => {
            if (v.location) { const [lng, lat] = v.location.split(',').map(Number); if (!isNaN(lng) && !isNaN(lat)) points.push([lng, lat]); }
          });
          if (seg.railway.name) segs.push('🚇' + seg.railway.name);
          hasRailway = true;
        }
      });
      return { distance: t.distance || 0, duration: t.duration || 0, points, segDesc: segs.join(' → '), hasRailway, hasBus };
    }).filter(x => x.points.length);
  }
  const root = mode === 'bicycling' ? (r.data || {}) : (r.route || {});
  return (root.paths || []).slice(0, 3).map(p => {
    const points = [];
    (p.steps || []).forEach(st => pushPolyline(st.polyline, points));
    return { distance: p.distance || 0, duration: p.duration || 0, points };
  }).filter(x => x.points.length);
}
/* 对照地图选点：收起弹窗，地图上显示编号候选标注，用户在地图上确认 */
function showRoutePickBanner(target) {
  const b = $('#map-route-banner');
  if (b) {
    b.classList.remove('hidden');
    $('#map-route-text').textContent = target === 'origin'
      ? '📍 为「起点」选点：单击卡片查看位置，双击卡片确认选择'
      : '📍 为「终点」选点：单击卡片查看位置，双击卡片确认选择';
  }
}
function hideRoutePickBanner() {
  const b = $('#map-route-banner');
  if (b) b.classList.add('hidden');
}
function cancelRoutePick() {
  routePickStage = null;
  hideRoutePickBanner();
  clearMarkers();
  renderMapResults([], '');
  showRouteEndpointMarkers();
  openRouteModal();
}
function switchMapSideTab(tab) {
  const btn = document.querySelector('#map-side-tabs [data-tab="' + tab + '"]');
  if (btn) btn.click();
}
/* 打开路径规划弹窗（不重置已填内容） */
function openRouteModal() {
  $('#modal-route').classList.remove('hidden');
}
/* 地图上显示已选 起/终 标注（绿色起 / 红色终） */
function showRouteEndpointMarkers() {
  if (!amapMap) return;
  amapRouteOverlays.forEach(o => { try { amapMap.remove(o); } catch (e) { /* 忽略 */ } });
  amapRouteOverlays = [];
  if (routeOriginSel) {
    const m = makeLabelMarker([routeOriginSel.lng, routeOriginSel.lat], '起', routeOriginSel.name, '#10b981');
    amapMap.add(m);
    amapRouteOverlays.push(m);
  }
  if (routeDestSel) {
    const m = makeLabelMarker([routeDestSel.lng, routeDestSel.lat], '终', routeDestSel.name, '#ef4444');
    amapMap.add(m);
    amapRouteOverlays.push(m);
  }
}
/* 搜索起终点候选：收起弹窗 → 地图编号标注 + 右侧列表 → 对照地图点选 */
async function searchRoutePoint(target) {
  const input = $('#route-' + target);
  const kw = input.value.trim();
  if (!kw) return toast('请输入搜索关键词', 'warn');
  const m = kw.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) {
    const lng = +m[1], lat = +m[2];
    let adcode = '';
    try {
      const rg = await amapGet('geocode/regeo', { location: lng + ',' + lat, extensions: 'base' });
      if (rg.status === '1' && rg.regeocode && rg.regeocode.addressComponent) adcode = rg.regeocode.addressComponent.adcode || '';
    } catch (e) { /* adcode 缺失时混合出行会再反查 */ }
    selectRoutePoint(target, { lng, lat, name: `坐标点 (${lng}, ${lat})`, address: '', adcode });
    return;
  }
  closeModal('modal-route');
  routePickStage = target;
  showRoutePickBanner(target);
  switchMapSideTab('results');
  $('#map-side-hint').textContent = '搜索中…';
  const r = await amapGet('place/text', { keywords: kw, offset: 10, page: 1, extensions: 'base' });
  const pois = r.pois || [];
  if (r.status !== '1' || !pois.length) {
    hideRoutePickBanner();
    routePickStage = null;
    toast('无结果，请换更具体的关键词', 'warn');
    openRouteModal();
    return;
  }
  try {
    await ensureMapReady();
    renderMapResults(pois, kw);
    $('#map-side-hint').textContent = `为「${target === 'origin' ? '起点' : '终点'}」选点：单击卡片查看位置，双击卡片确认`;
    amapMap.setZoomAndCenter(13, pois[0].location.split(',').map(Number));
    markPois(pois);
  } catch (e) {
    hideRoutePickBanner();
    routePickStage = null;
    toast('地图未就绪：' + (e.message || e), 'err');
    openRouteModal();
  }
}
function selectRoutePoint(target, p) {
  if (target === 'origin') routeOriginSel = p; else routeDestSel = p;
  routePickStage = null;
  hideRoutePickBanner();
  renderRoutePicked(target);
  $('#route-' + target + '-list').innerHTML = '';
  // 清除地图上的候选编号标注与高亮，只保留 起/终 标注
  if (amapMap) {
    amapMarkers.forEach(mm => { try { amapMap.remove(mm); } catch (e) { /* 忽略 */ } });
    amapMarkers = [];
    clearHighlight();
  }
  showRouteEndpointMarkers();
}
function renderRoutePicked(target) {
  const sel = target === 'origin' ? routeOriginSel : routeDestSel;
  const el = $('#route-' + target + '-picked');
  if (!sel) { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  el.innerHTML = `<span class="route-picked-info">✔ 已选：<b>${esc(sel.name)}</b>${sel.address ? ' · ' + esc(sel.address) : ''}</span>
    <button class="route-picked-clear" data-clear="${target}" title="清除选择">✕</button>`;
}
async function planRoute() {
  if (!mapCfg.key) { toast('请先配置 Key', 'warn'); openMapConfigModal(); return; }
  routePickStage = null;
  hideRoutePickBanner();
  if (!routeOriginSel) return toast('请先搜索并选择起点的具体位置', 'warn');
  if (!routeDestSel) return toast('请先搜索并选择终点的具体位置', 'warn');
  const mode = $('#route-mode').value;
  const o = { lng: routeOriginSel.lng, lat: routeOriginSel.lat };
  const d = { lng: routeDestSel.lng, lat: routeDestSel.lat };
  const originName = routeOriginSel.name;
  const destName = routeDestSel.name;
  updateMapStatus('路径规划中…');
  const origin = [o.lng, o.lat].join(',');
  const dest = [d.lng, d.lat].join(',');
  let r;
  if (mode === 'bicycling') {
    r = await amapGet('direction/bicycling', { origin, destination: dest }, 'v4');
  } else if (mode === 'metro' || mode === 'transit') {
    // 地铁/混合出行（公交/地铁/步行综合）需要起终点城市编码，缺失时逆地理反查
    let cityO = routeOriginSel.adcode || '';
    let cityD = routeDestSel.adcode || '';
    if (!cityO) {
      const g = await amapGet('geocode/regeo', { location: origin, extensions: 'base' });
      if (g.status === '1' && g.regeocode && g.regeocode.addressComponent) cityO = g.regeocode.addressComponent.adcode || '';
    }
    if (!cityD) {
      const g = await amapGet('geocode/regeo', { location: dest, extensions: 'base' });
      if (g.status === '1' && g.regeocode && g.regeocode.addressComponent) cityD = g.regeocode.addressComponent.adcode || '';
    }
    if (!cityO || !cityD) {
      updateMapStatus('地铁/混合出行需要起点/终点城市信息');
      return toast('地铁/混合出行需要起终点城市信息，请通过搜索选点后再试', 'warn');
    }
    r = await amapGet('direction/transit/integrated', { origin, destination: dest, city: cityO, cityd: cityD, extensions: 'base' });
  } else {
    r = await amapGet('direction/' + mode, { origin, destination: dest, extensions: 'base' });
  }
  let routes = parseRouteDataList(r, (mode === 'metro' || mode === 'transit') ? 'transit' : mode);
  let routeNote = '';
  if (mode === 'metro') {
    // 地铁模式：优先保留含地铁段的方案，过滤纯公交方案
    const rail = routes.filter(x => x.hasRailway);
    if (rail.length) {
      routeNote = `已过滤纯公交方案，共 ${rail.length} 条含地铁方案`;
      routes = rail;
    } else {
      routeNote = '未找到含地铁的方案，展示全部换乘方案';
    }
  }
  routes = routes.slice(0, 3);
  if (!routes.length) {
    updateMapStatus('路径规划失败：' + (r.info || r.infocode || '未找到可行路线'));
    return toast('未找到可行路线', 'warn');
  }
  try {
    await ensureMapReady();
    clearMarkers(); // 清除旧标注与旧路线
    plannedRoutes = routes;
    drawPlannedRoutes(0); // 最优实线 + 备选淡蓝虚线
    const sMarker = makeLabelMarker([o.lng, o.lat], '起', originName, '#10b981');
    const eMarker = makeLabelMarker([d.lng, d.lat], '终', destName, '#ef4444');
    amapMap.add(sMarker);
    amapMap.add(eMarker);
    amapRouteOverlays.push(sMarker);
    amapRouteOverlays.push(eMarker);
    const modeName = { driving: '驾车', walking: '步行', bicycling: '骑行', transit: '混合', metro: '地铁' }[mode] || mode;
    lastRouteMeta = { modeName, oName: originName, dName: destName, note: routeNote };
    renderRouteSummary(modeName, originName, destName, routes);
    updateMapStatus(`${modeName}路线规划完成：最优 ${fmtRouteDist(routes[0].distance)} · 共 ${routes.length} 条方案`);
  } catch (err) {
    updateMapStatus('路线绘制失败：' + (err.message || err));
  }
}
function fmtRouteDist(meters) {
  return meters >= 1000 ? (meters / 1000).toFixed(1) + ' 公里' : Math.round(meters) + ' 米';
}
function fmtRouteDur(sec) {
  if (!sec) return '未知';
  if (sec >= 3600) return Math.floor(sec / 3600) + ' 小时 ' + Math.round((sec % 3600) / 60) + ' 分钟';
  return Math.round(sec / 60) + ' 分钟';
}
/* 带文字标注的标记（水滴形，label 如 1/2/3 或 📍） */
function makeLabelMarker(lnglat, label, title, color) {
  const content = `<div class="map-pin" style="background:${color || '#4f6ef7'}" title="${esc(title)}"><span>${esc(label)}</span></div>`;
  return new AMap.Marker({
    position: lnglat,
    content,
    offset: new AMap.Pixel(-17, -40),
    zIndex: 120,
  });
}
/* 弹出信息窗体（名称/地址详情） */
function showInfo(html, lnglat) {
  if (!amapMap) return;
  if (!amapInfoWindow) amapInfoWindow = new AMap.InfoWindow({ offset: new AMap.Pixel(0, -38) });
  amapInfoWindow.setContent(html);
  amapInfoWindow.open(amapMap, lnglat);
}
/* 批量标注搜索结果（蓝色序号，与右侧列表编号对应） */
function markPois(pois) {
  clearMarkers();
  amapCurrentPois = pois;
  pois.forEach((p, i) => {
    const ll = p.location.split(',').map(Number);
    const m = makeLabelMarker(ll, String(i + 1), p.name + ' ' + (p.address || ''), '#4f6ef7');
    m.on('click', () => {
      highlightArea(ll);
      showInfo('<b>' + esc(p.name) + '</b><br />' + esc(p.address || ''), ll);
    });
    amapMap.add(m);
    amapMarkers.push(m);
  });
}
function centerMap(lnglat, title, isCurrent) {
  if (!amapMap) return;
  try { if (amapMap.stopMove) amapMap.stopMove(); } catch (e) { /* 2.0 可能无此方法 */ }
  amapMap.setZoomAndCenter(isCurrent ? 15 : 13, lnglat);
  clearMarkers();
  const marker = makeLabelMarker(lnglat, '📍', title, '#ef4444');
  marker.on('click', () => showInfo(esc(title), lnglat));
  amapMap.add(marker);
  amapMarkers.push(marker);
  // 等居中动画完成后再弹信息窗，防止其自动平移打断居中
  setTimeout(() => showInfo(esc(title), lnglat), 450);
}
/* 初始化地图页 */
async function initMapPage() {
  if (!mapCfg.key) {
    updateMapStatus('未配置 API Key');
    renderMapEmpty('尚未配置高德地图 API Key');
    return;
  }
  updateMapStatus('地图加载中…');
  try {
    await ensureMapReady();
    renderFences();
    updateMapStatus('地图已就绪，可搜索地点、绘制围栏或点击「📍 定位」');
  } catch (err) {
    renderMapEmpty('地图加载失败：' + (err.message || err));
    updateMapStatus('地图加载失败');
  }
}
/* 定位当前位置：优先浏览器定位（需 HTTPS），失败回退高德 IP 定位 */
async function locateMe() {
  if (!mapCfg.key) { toast('请先配置 Key', 'warn'); openMapConfigModal(); return null; }
  updateMapStatus('定位中…');
  if (navigator.geolocation) {
    try {
      const pos = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { timeout: 8000, maximumAge: 60000 }));
      const p = [pos.coords.longitude, pos.coords.latitude];
      await ensureMapReady();
      centerMap(p, '我的位置（浏览器定位）', true);
      updateMapStatus(`定位成功（精度约 ${Math.round(pos.coords.accuracy)} 米）`);
      return { lng: p[0], lat: p[1], source: 'browser' };
    } catch (e) { /* 回退 IP 定位 */ }
  }
  const r = await amapGet('ip', {});
  if (r.status === '1' && r.rectangle) {
    const [a, b] = r.rectangle.split(';').map(s => s.split(',').map(Number));
    const center = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    try {
      await ensureMapReady();
      centerMap(center, `当前位置（IP 定位：${r.city || r.province}）`, true);
    } catch (e) { /* 无 Key 时忽略显示 */ }
    updateMapStatus(`IP 定位：${r.province || ''} ${r.city || ''}（${r.adcode}）`);
    return { lng: center[0], lat: center[1], source: 'ip', province: r.province, city: r.city, adcode: r.adcode };
  }
  updateMapStatus('定位失败：' + (r.error || r.info || '未知错误'));
  return { error: r.error || r.info || '定位失败' };
}
/* 地点搜索（POI） */
async function mapSearchDo(keyword) {
  keyword = (keyword || '').trim();
  if (!keyword) return toast('请输入搜索关键词', 'warn');
  if (!mapCfg.key) { toast('请先配置 Key', 'warn'); openMapConfigModal(); return null; }
  updateMapStatus('搜索中：' + keyword);
  const r = await amapGet('place/text', { keywords: keyword, offset: 10, page: 1, extensions: 'base' });
  if (r.status !== '1') {
    updateMapStatus('搜索失败：' + (r.error || r.info || '未知错误'));
    return { error: r.error || r.info || '搜索失败' };
  }
  const pois = r.pois || [];
  renderMapResults(pois, keyword);
  try {
    await ensureMapReady();
    if (pois.length) {
      const first = pois[0];
      amapMap.setZoomAndCenter(13, first.location.split(',').map(Number));
      markPois(pois); // 搜索结果全部标注
    }
  } catch (e) { /* 地图未就绪仅返回数据 */ }
  updateMapStatus(`找到 ${pois.length} 个结果：${keyword}`);
  return pois;
}
function renderMapResults(pois, keyword) {
  const box = $('#map-results');
  $('#map-side-hint').textContent = `关键词「${esc(keyword)}」共 ${pois.length} 条`;
  if (!pois.length) { box.innerHTML = '<div class="tp-empty">无结果</div>'; return; }
  box.innerHTML = pois.map((p, i) => `<div class="map-item" data-index="${i}" data-lng="${p.location.split(',')[0]}" data-lat="${p.location.split(',')[1]}" data-name="${esc(p.name)}">
    <span class="map-item-idx">${i + 1}</span>
    <div class="map-item-body">
      <div class="map-item-name">${esc(p.name)}</div>
      <div class="map-item-addr">${esc(p.address || (p.pname + ' ' + p.cityname + ' ' + p.adname))}</div>
    </div>
  </div>`).join('');
}
/* Key 配置弹窗 */
function openMapConfigModal() {
  $('#map-key').value = mapCfg.key || '';
  $('#map-sec').value = mapCfg.securityCode || '';
  $('#modal-mapcfg').classList.remove('hidden');
  $('#map-key').focus();
}
/* 浏览器全屏切换（全屏后 AMap 需 resize） */
function toggleMapFullscreen() {
  const el = $('#page-map');
  if (!document.fullscreenElement) {
    if (el.requestFullscreen) el.requestFullscreen();
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  } else {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }
}
async function saveAndTestMapConfig() {
  const key = $('#map-key').value.trim();
  const sec = $('#map-sec').value.trim();
  if (!key) return toast('请输入 API Key', 'warn');
  mapCfg = { key, securityCode: sec };
  save(LS.map, mapCfg);
  updateMapStatus('正在测试 Key…');
  const r = await amapGet('ip', {});
  if (r.status === '1') {
    closeModal('modal-mapcfg');
    toast('Key 测试成功 ✅');
    if (window.AMap) {
      toast('地图 SDK 已用旧 Key 加载，请刷新页面（Ctrl+F5）后生效', 'warn');
    } else {
      renderMapEmpty('');
      initMapPage();
    }
    return;
  }
  const msg = r.error || r.info || '未知错误';
  updateMapStatus('Key 测试失败：' + msg);
  toast('Key 测试失败：' + msg, 'warn');
}

/* ==================== DeepSeek 智能体 ==================== */
const TOOLS = [
  { type: 'function', function: { name: 'get_current_week', description: '获取当前是第几周、今天是星期几、开学日期等信息', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'get_schedule', description: '获取某一周的课程表（week 不传则返回当前周）', parameters: { type: 'object', properties: { week: { type: 'number', description: '第几周' } } } } },
  { type: 'function', function: { name: 'get_today_courses', description: '获取今天要上的课程', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'open_bookmark', description: '打开收藏夹中的某个网站，keyword 为网站名称或网址关键词（也可直接传完整网址 http(s)://…）', parameters: { type: 'object', properties: { keyword: { type: 'string', description: '网站名称或网址关键词' } }, required: ['keyword'] } } },
  { type: 'function', function: { name: 'open_bookmarks', description: '批量打开收藏夹中的网站：keyword 按名称/网址匹配，category 按分类匹配（如 学习/未分类/全部），两者可留空（留空则全部，最多自动打开8个）', parameters: { type: 'object', properties: { keyword: { type: 'string' }, category: { type: 'string' } } } } },
  { type: 'function', function: { name: 'search_bookmarks', description: '按关键词搜索收藏的网站（匹配名称/网址/分类）', parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] } } },
  { type: 'function', function: { name: 'list_bookmark_categories', description: '列出收藏夹全部分类及数量', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'set_bookmark_category', description: '给收藏网站设置分类（keyword 为网站名称关键词，category 为分类名，不存在则自动新建）', parameters: { type: 'object', properties: { keyword: { type: 'string' }, category: { type: 'string' } }, required: ['keyword', 'category'] } } },
  { type: 'function', function: { name: 'add_bookmark', description: '添加一个收藏网站', parameters: { type: 'object', properties: { name: { type: 'string' }, url: { type: 'string' }, category: { type: 'string' } }, required: ['name', 'url'] } } },
  { type: 'function', function: { name: 'add_course', description: '添加一门课程。weeks_text 如 1-16周、1-8周(单)、2-16周(双)；day_of_week 1=周一…7=周日', parameters: { type: 'object', properties: { name: { type: 'string' }, day_of_week: { type: 'number' }, start_section: { type: 'number' }, end_section: { type: 'number' }, weeks_text: { type: 'string' }, teacher: { type: 'string' }, location: { type: 'string' } }, required: ['name', 'day_of_week', 'start_section', 'end_section', 'weeks_text'] } } },
  { type: 'function', function: { name: 'delete_course', description: '按课程名称删除课程', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'view_week', description: '跳转查看某一周的课程表（自动切换到课程表页并渲染该周）', parameters: { type: 'object', properties: { week: { type: 'number', description: '第几周' } }, required: ['week'] } } },
  { type: 'function', function: { name: 'edit_course', description: '编辑已有课程：按 name 找到课程，修改新名称/星期/节次/周次/教师/教室中的任意项', parameters: { type: 'object', properties: { name: { type: 'string', description: '原课程名称' }, new_name: { type: 'string' }, day_of_week: { type: 'number' }, start_section: { type: 'number' }, end_section: { type: 'number' }, weeks_text: { type: 'string', description: '如 1-16周' }, teacher: { type: 'string' }, location: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'clear_courses', description: '清空全部课程（慎用）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'open_course_import', description: '打开课表导入向导，mode: html=教务系统网页导入 / csv=CSV模板导入 / paste=粘贴导入', parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['html', 'csv', 'paste'] } } } } },
  { type: 'function', function: { name: 'set_semester_start', description: '设置本学期开学第一天（上课）日期，格式 YYYY-MM-DD，影响当前周计算', parameters: { type: 'object', properties: { date: { type: 'string', description: '如 2026-08-31' } }, required: ['date'] } } },
  { type: 'function', function: { name: 'set_section_time', description: '设置某一节次的上课时间，时间格式 HH:MM，如 08:00 和 08:45', parameters: { type: 'object', properties: { section: { type: 'number', description: '第几节(1-14)' }, start: { type: 'string' }, end: { type: 'string' } }, required: ['section', 'start', 'end'] } } },
  { type: 'function', function: { name: 'fill_default_section_times', description: '按常见作息表一键填充所有节次时间（8:00起）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'delete_bookmark', description: '删除收藏夹中的某个网站', parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] } } },
  { type: 'function', function: { name: 'rename_bookmark', description: '修改收藏网站的名称', parameters: { type: 'object', properties: { keyword: { type: 'string', description: '原名称或网址关键词' }, new_name: { type: 'string' } }, required: ['keyword', 'new_name'] } } },
  { type: 'function', function: { name: 'add_category', description: '新建一个收藏分类', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'rename_category', description: '重命名收藏分类（其下收藏自动跟随）', parameters: { type: 'object', properties: { old_name: { type: 'string' }, new_name: { type: 'string' } }, required: ['old_name', 'new_name'] } } },
  { type: 'function', function: { name: 'delete_category', description: '删除收藏分类（其下收藏变为未分类）', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } },
  { type: 'function', function: { name: 'dedupe_bookmarks', description: '一键去重收藏夹中重复网址（同站判定）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'import_bookmarks', description: '弹出文件选择框，导入 Edge 收藏夹文件', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'export_bookmarks', description: '导出收藏夹为 Edge 可导入的 HTML 文件', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'filter_bookmarks', description: '在收藏夹页按分类和/或关键词筛选显示（分类传 全部/未分类/具体分类名）', parameters: { type: 'object', properties: { category: { type: 'string' }, keyword: { type: 'string' } } } } },
  { type: 'function', function: { name: 'clear_chat', description: '新建一个空白对话（结束当前对话，之前的对话会保存在会话列表中）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'start_voice', description: '启动语音输入，开始聆听用户说话', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'list_tasks', description: '列出全部待办任务（按截止时间优先度升序排列，超期/快到期标注）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'add_task', description: '添加待办任务。due 为结束时间，格式如 2026-08-25 18:00 或 2026-08-25T18:00（截止前1小时会自动提醒）', parameters: { type: 'object', properties: { title: { type: 'string' }, due: { type: 'string' }, note: { type: 'string' } }, required: ['title', 'due'] } } },
  { type: 'function', function: { name: 'complete_task', description: '将待办任务标记为完成，keyword 为任务名称关键词', parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] } } },
  { type: 'function', function: { name: 'delete_task', description: '删除待办任务，keyword 为任务名称关键词', parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] } } },
  { type: 'function', function: { name: 'list_events', description: '列出全部规划事件（甘特图，按开始日期排序，含状态）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'add_event', description: '添加规划事件（甘特图），start/end 为日期 YYYY-MM-DD', parameters: { type: 'object', properties: { name: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } }, required: ['name', 'start', 'end'] } } },
  { type: 'function', function: { name: 'edit_event', description: '编辑规划事件：keyword 为事件名称关键词，可改 name/start/end', parameters: { type: 'object', properties: { keyword: { type: 'string' }, name: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' } }, required: ['keyword'] } } },
  { type: 'function', function: { name: 'delete_event', description: '删除规划事件，keyword 为事件名称关键词', parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] } } },
  { type: 'function', function: { name: 'get_usage', description: '查询本看板 DeepSeek 消耗统计（请求数/tokens/估算费用，按模型分项）与官方账户余额快照。range 可选 today/7d/30d/all，默认 today', parameters: { type: 'object', properties: { range: { type: 'string', enum: ['today', '7d', '30d', 'all'] } } } } },
  { type: 'function', function: { name: 'refresh_balance', description: '调用 DeepSeek 官方余额接口刷新账户余额', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'map_locate', description: '定位当前所在城市（高德IP定位，返回省市/编码/中心坐标，并在地图页显示）', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'map_search', description: '搜索地点（高德POI搜索），在地图页显示结果列表与标记', parameters: { type: 'object', properties: { keyword: { type: 'string', description: '地点关键词，如 西安交通大学' } }, required: ['keyword'] } } },
  { type: 'function', function: { name: 'map_geocode', description: '地址转经纬度（高德地理编码），并在地图页定位显示', parameters: { type: 'object', properties: { address: { type: 'string', description: '结构化地址，如 北京市海淀区中关村大街1号' } }, required: ['address'] } } },
  { type: 'function', function: { name: 'show_page', description: '切换看板页面', parameters: { type: 'object', properties: { page: { type: 'string', enum: ['schedule', 'bookmarks', 'agent', 'tasks', 'gantt', 'usage', 'map'] } }, required: ['page'] } } },
  { type: 'function', function: { name: 'get_settings', description: '获取看板设置（开学日期、节数等）', parameters: { type: 'object', properties: {} } } },
];
const TOOL_LABELS = {
  get_current_week: '查询当前周', get_schedule: '查询课程表', get_today_courses: '查询今日课程',
  open_bookmark: '打开收藏网站', open_bookmarks: '批量打开收藏网站', search_bookmarks: '搜索收藏夹', list_bookmark_categories: '列出分类',
  set_bookmark_category: '设置网站分类', add_bookmark: '添加收藏', add_course: '添加课程',
  delete_course: '删除课程', show_page: '切换页面', get_settings: '读取设置',
  view_week: '跳转查看周课表', edit_course: '编辑课程', clear_courses: '清空课表',
  open_course_import: '打开课表导入', set_semester_start: '设置开学日期', set_section_time: '设置节次时间',
  fill_default_section_times: '填充默认节次时间', delete_bookmark: '删除收藏', rename_bookmark: '重命名收藏',
  add_category: '新建分类', rename_category: '重命名分类', delete_category: '删除分类',
  dedupe_bookmarks: '收藏去重', import_bookmarks: '导入收藏', export_bookmarks: '导出收藏',
  filter_bookmarks: '筛选收藏', clear_chat: '新建对话', start_voice: '启动语音',
  list_tasks: '查询待办', add_task: '添加任务', complete_task: '完成任务', delete_task: '删除任务',
  list_events: '查询规划', add_event: '添加事件', edit_event: '编辑事件', delete_event: '删除事件',
  get_usage: '查询用量', refresh_balance: '刷新余额',
  map_locate: '地图定位', map_search: '地图搜索', map_geocode: '地址编码',
};

function findBookmark(keyword) {
  const kw = String(keyword || '').trim().toLowerCase();
  if (!kw) return null;
  return bookmarks.find(b => b.name.toLowerCase() === kw)
    || bookmarks.find(b => b.name.toLowerCase().includes(kw))
    || bookmarks.find(b => b.url.toLowerCase().includes(kw))
    || null;
}

async function executeTool(name, args) {
  const wi = weekInfo();
  switch (name) {
    case 'get_current_week':
      return {
        currentWeek: wi.week, today: dateStr(wi.today), weekday: WEEKDAYS[wi.weekday - 1],
        semesterStart: settings.semesterStart || '未设置',
        isHoliday: wi.isHoliday,
        note: wi.week === null
          ? '开学日期未设置，请提醒用户先在课程表页设置准确的开学第一天（上课）日期。'
          : (wi.week === 0
            ? `开学日期已设置为 ${settings.semesterStart}，当前尚未开学，处于假期。`
            : (wi.isHoliday ? '当前周没有任何课程安排，处于假期。' : '')),
      };
    case 'get_schedule': {
      let w = Number(args && args.week);
      if (!w) w = wi.week;
      if (w === 0) {
        return { week: 0, count: 0, isHoliday: true, courses: [], note: `尚未开学（开学日期 ${settings.semesterStart}），第0周处于假期。` };
      }
      if (!w || w < 1) return { error: '周数无效或当前周未知（开学日期未设置时无法确定当前周）' };
      const items = mergeSameSlotCourses(courses.filter(c => c.weeks.includes(w)))
        .sort((a, b) => a.day - b.day || a.startSec - b.startSec)
        .map(c => ({ name: c.name, day: c.day, dayName: WEEKDAYS[c.day - 1], sections: `${c.startSec}-${c.endSec}节`, time: courseTime(c) || '', teacher: c.teacher, location: c.location, weeks: c.weeksText }));
      const holiday = weekHoliday(w);
      return { week: w, count: items.length, isHoliday: holiday, courses: items, note: holiday ? `第${w}周没有课程安排，视为假期。` : '' };
    }
    case 'get_today_courses': {
      if (wi.week === null) return { error: '开学日期未设置，无法计算今日课程。请提醒用户先设置开学第一天（上课）日期。' };
      if (wi.week === 0) {
        return {
          week: 0, weekday: WEEKDAYS[wi.weekday - 1], count: 0,
          isHoliday: true, courses: [],
          note: `尚未开学（开学日期 ${settings.semesterStart}），当前处于假期。`,
        };
      }
      const items = mergeSameSlotCourses(courses.filter(c => c.day === wi.weekday && c.weeks.includes(wi.week)))
        .sort((a, b) => a.startSec - b.startSec)
        .map(c => ({ name: c.name, sections: `${c.startSec}-${c.endSec}节`, time: courseTime(c) || '', teacher: c.teacher, location: c.location }));
      return {
        week: wi.week, weekday: WEEKDAYS[wi.weekday - 1], count: items.length,
        isHoliday: wi.isHoliday, courses: items,
        note: wi.isHoliday ? '当前周没有课程安排，处于假期。' : '',
      };
    }
    case 'open_bookmark': {
      const kw = String((args && args.keyword) || '').trim();
      const direct = /^https?:\/\//i.test(kw) ? kw : '';
      const b = direct ? null : findBookmark(kw);
      if (!b && !direct) return { error: '未找到匹配的收藏网站' };
      const url = direct || b.url;
      const name = b ? b.name : url;
      const opened = openBookmark({ url, name });
      appendOpenAction(name, url);
      return {
        ok: true, opened, name, url,
        note: opened
          ? `已在浏览器新标签页打开「${name}」`
          : '浏览器拦截了自动打开，请点击聊天里的「↗ 打开网站」按钮',
      };
    }
    case 'open_bookmarks': {
      const kw = String((args && args.keyword) || '').toLowerCase();
      const cat = String((args && args.category) || '').trim();
      let list = bookmarks.slice();
      if (cat && cat !== '全部') list = list.filter(b => (cat === '未分类' ? !b.category : b.category === cat));
      if (kw) list = list.filter(b => (b.name + ' ' + b.url).toLowerCase().includes(kw));
      if (!list.length) return { error: '没有匹配的收藏网站' };
      const cap = Math.min(list.length, 8); // 防止一次开太多标签页
      let opened = 0;
      list.slice(0, cap).forEach(b => {
        if (openBookmark(b)) opened++;
        appendOpenAction(b.name, b.url);
      });
      const rest = list.length - cap;
      return {
        ok: true, total: list.length, attempted: cap, opened,
        list: list.map(b => ({ name: b.name, url: b.url })),
        note: `已请求打开 ${cap} 个网站（自动打开成功 ${opened} 个，被拦截的请点击聊天中的「↗ 打开网站」按钮）${rest ? `；其余 ${rest} 个未自动尝试，可在回复中列出让用户点击` : ''}`,
      };
    }
    case 'search_bookmarks': {
      const kw = String((args && args.keyword) || '').toLowerCase();
      const list = bookmarks.filter(b => (b.name + ' ' + b.url + ' ' + b.category + ' ' + b.folder).toLowerCase().includes(kw))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh', { sensitivity: 'base', numeric: true }))
        .slice(0, 10).map(b => ({ name: b.name, url: b.url, category: b.category || '未分类' }));
      return { count: list.length, results: list };
    }
    case 'list_bookmark_categories': {
      const counts = {};
      bookmarks.forEach(b => { const k = b.category || '未分类'; counts[k] = (counts[k] || 0) + 1; });
      return { categories: counts, total: bookmarks.length };
    }
    case 'set_bookmark_category': {
      const b = findBookmark(args && args.keyword);
      const cat = String((args && args.category) || '').trim();
      if (!b) return { error: '未找到匹配的收藏网站' };
      if (!cat) return { error: '分类名不能为空' };
      if (!categories.includes(cat)) { categories.push(cat); save(LS.categories, categories); }
      b.category = cat;
      save(LS.bookmarks, bookmarks);
      renderBookmarks();
      return { ok: true, name: b.name, category: cat };
    }
    case 'add_bookmark': {
      const name = String((args && args.name) || '').trim();
      let url = String((args && args.url) || '').trim();
      if (!name || !url) return { error: '名称和网址不能为空' };
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      if (bookmarks.some(b => normalizeUrl(b.url) === normalizeUrl(url))) return { error: '该网址已在收藏夹中' };
      bookmarks.push({ id: uid(), name, url, folder: '智能体添加', category: (args && args.category) || '', date: '' });
      save(LS.bookmarks, bookmarks);
      renderBookmarks();
      return { ok: true, name, url };
    }
    case 'add_course': {
      const built = buildCourse({
        name: args && args.name, day: args && args.day_of_week,
        startSec: args && args.start_section, endSec: args && args.end_section,
        weeksText: args && args.weeks_text, teacher: args && args.teacher, location: args && args.location,
      });
      if (!built) return { error: '课程信息无效：请检查名称、星期(1-7)、节次、周次（如 1-16周）' };
      courses.push(built);
      save(LS.courses, courses);
      renderAll();
      return { ok: true, course: { name: built.name, day: WEEKDAYS[built.day - 1], sections: `${built.startSec}-${built.endSec}节`, weeks: built.weeksText } };
    }
    case 'delete_course': {
      const nm = String((args && args.name) || '').trim();
      const idx = courses.findIndex(c => c.name === nm);
      if (idx < 0) return { error: `未找到课程「${nm}」` };
      const removed = courses.splice(idx, 1)[0];
      save(LS.courses, courses);
      renderAll();
      return { ok: true, removed: removed.name };
    }
    case 'show_page': {
      const page = args && args.page;
      if (['schedule', 'bookmarks', 'agent', 'tasks', 'gantt', 'usage', 'map'].includes(page)) { switchPage(page); return { ok: true, page }; }
      return { error: '无效页面' };
    }
    case 'map_locate': {
      if (!mapCfg.key) return { error: '未配置高德 API Key，请提醒用户在地图页「⚙️ Key 配置」填写并测试' };
      const r = await amapGet('ip', {});
      if (r.status !== '1') return { error: r.error || r.info || 'IP 定位失败' };
      const [a, b] = (r.rectangle || '').split(';').map(s => s.split(',').map(Number));
      const center = (a && b && a.length === 2 && b.length === 2) ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : null;
      switchPage('map');
      try {
        await ensureMapReady();
        if (center) centerMap(center, `IP定位：${r.city || r.province}`, true);
      } catch (e) { /* 仅返回数据 */ }
      return { ok: true, province: r.province, city: r.city, adcode: r.adcode, center };
    }
    case 'map_search': {
      const kw = String((args && args.keyword) || '').trim();
      if (!kw) return { error: '请提供搜索关键词' };
      if (!mapCfg.key) return { error: '未配置高德 API Key，请提醒用户在地图页「⚙️ Key 配置」填写并测试' };
      const r = await amapGet('place/text', { keywords: kw, offset: 10, page: 1, extensions: 'base' });
      if (r.status !== '1') return { error: r.error || r.info || 'POI 搜索失败' };
      const pois = r.pois || [];
      const results = pois.map(p => ({ name: p.name, address: p.address || '', location: p.location, city: p.cityname }));
      switchPage('map');
      try {
        await ensureMapReady();
        renderMapResults(pois, kw);
        if (pois.length) {
          const first = pois[0];
          amapMap.setZoomAndCenter(13, first.location.split(',').map(Number));
          markPois(pois);
        }
      } catch (e) { /* 仅返回数据 */ }
      return { ok: true, count: results.length, results: results.slice(0, 10) };
    }
    case 'map_geocode': {
      const addr = String((args && args.address) || '').trim();
      if (!addr) return { error: '请提供地址' };
      if (!mapCfg.key) return { error: '未配置高德 API Key，请提醒用户在地图页「⚙️ Key 配置」填写并测试' };
      const r = await amapGet('geocode/geo', { address: addr });
      if (r.status !== '1' || !r.geocodes || !r.geocodes.length) return { error: r.error || r.info || '未找到该地址' };
      const g = r.geocodes[0];
      const ll = g.location.split(',').map(Number);
      switchPage('map');
      try {
        await ensureMapReady();
        centerMap(ll, g.formatted_address || addr, false);
      } catch (e) { /* 仅返回数据 */ }
      return { ok: true, address: g.formatted_address, location: g.location, lng: ll[0], lat: ll[1], level: g.level, province: g.province, city: g.city, adcode: g.adcode };
    }
    case 'get_usage': {
      const range = ['today', '7d', '30d', 'all'].includes(args && args.range) ? args.range : 'today';
      const agg = aggregateRange(range);
      const bal = balance && balance.ok
        ? { total: balance.total, granted: balance.granted, topped: balance.topped, currency: balance.currency }
        : null;
      return {
        range,
        requests: agg.requests,
        tokens: { inputCacheHit: agg.hit, inputCacheMiss: agg.miss, output: agg.out, total: agg.totalTokens },
        costEstimate: round2(agg.cost),
        currency: 'CNY',
        models: agg.models,
        balance: bal,
        note: '费用为估算值：输入按缓存命中/未命中、输出按空闲/高峰时段单价分别计价；余额来自官方接口快照（可能未刷新，可用 refresh_balance 更新）',
      };
    }
    case 'refresh_balance': {
      await fetchBalance();
      return balance && balance.ok
        ? { ok: true, balance: { total: balance.total, granted: balance.granted, topped: balance.topped, currency: balance.currency } }
        : { ok: false, error: balance ? balance.error : '未获取到余额' };
    }
    case 'list_events': {
      const list = events.slice().sort((a, b) => parseDate(a.start) - parseDate(b.start)).map(e => ({
        name: e.name, start: e.start, end: e.end,
        days: Math.round((parseDate(e.end) - parseDate(e.start)) / 86400000) + 1,
        status: eventStatus(e),
      }));
      return { count: list.length, events: list };
    }
    case 'add_event': {
      const name = String((args && args.name) || '').trim();
      const start = String((args && args.start) || '').trim();
      const end = String((args && args.end) || '').trim();
      if (!name) return { error: '事件名称不能为空' };
      if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || !parseDate(start) || !parseDate(end)) {
        return { error: '日期格式应为 YYYY-MM-DD' };
      }
      if (end < start) return { error: '结束日期不能早于开始日期' };
      const e = { id: uid(), name, start, end, color: colorOf(name) };
      events.push(e);
      save(LS.events, events);
      renderGantt();
      switchPage('gantt');
      return {
        ok: true,
        event: { name, start, end, days: Math.round((parseDate(end) - parseDate(start)) / 86400000) + 1 },
        note: '事件已添加到甘特图',
      };
    }
    case 'edit_event': {
      const e = findEvent(args && args.keyword);
      if (!e) return { error: '未找到匹配的事件' };
      if (args && args.name && String(args.name).trim()) e.name = String(args.name).trim();
      if (args && args.start) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(args.start) || !parseDate(args.start)) return { error: '日期格式应为 YYYY-MM-DD' };
        e.start = String(args.start).trim();
      }
      if (args && args.end) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(args.end) || !parseDate(args.end)) return { error: '日期格式应为 YYYY-MM-DD' };
        e.end = String(args.end).trim();
      }
      if (e.end < e.start) return { error: '结束日期不能早于开始日期' };
      e.color = colorOf(e.name);
      save(LS.events, events);
      renderGantt();
      return { ok: true, event: { name: e.name, start: e.start, end: e.end } };
    }
    case 'delete_event': {
      const e = findEvent(args && args.keyword);
      if (!e) return { error: '未找到匹配的事件' };
      events = events.filter(x => x.id !== e.id);
      save(LS.events, events);
      renderGantt();
      return { ok: true, removed: e.name };
    }
    case 'list_tasks': {
      const list = tasks.slice().sort((a, b) => a.due - b.due).map(t => ({
        title: t.title,
        note: t.note || '',
        due: fmtTaskDateTime(t.due),
        done: t.done,
        overdue: !t.done && t.due < Date.now(),
      }));
      return { count: list.length, pending: list.filter(t => !t.done).length, tasks: list };
    }
    case 'add_task': {
      const title = String((args && args.title) || '').trim();
      const due = parseTaskDue(args && args.due);
      if (!title) return { error: '任务名称不能为空' };
      if (!due) return { error: '结束时间格式无效，请用 2026-08-25 18:00 或 2026-08-25T18:00' };
      const t = { id: uid(), title, note: String((args && args.note) || '').trim(), due, done: false, reminded: false, createdAt: Date.now() };
      tasks.push(t);
      save(LS.tasks, tasks);
      renderTasks();
      checkTaskReminders();
      return { ok: true, task: { title: t.title, due: fmtTaskDateTime(t.due) }, note: '任务已添加，截止前 1 小时会自动提醒' };
    }
    case 'complete_task': {
      const t = findTask(args && args.keyword);
      if (!t) return { error: '未找到匹配的任务' };
      t.done = true;
      t.reminded = true;
      save(LS.tasks, tasks);
      renderTasks();
      return { ok: true, completed: t.title };
    }
    case 'delete_task': {
      const t = findTask(args && args.keyword);
      if (!t) return { error: '未找到匹配的任务' };
      tasks = tasks.filter(x => x.id !== t.id);
      save(LS.tasks, tasks);
      renderTasks();
      return { ok: true, removed: t.title };
    }
    case 'view_week': {
      const w = Number(args && args.week);
      if (!w || w < 1) return { error: '请提供有效的周数' };
      ensureViewWeek();
      viewWeek = Math.min(w, maxWeek());
      switchPage('schedule');
      renderWeekNav();
      renderSchedule();
      return { ok: true, week: viewWeek, note: viewWeek !== w ? `第${w}周超出范围，已跳转到最近有效周` : '' };
    }
    case 'edit_course': {
      const nm = String((args && args.name) || '').trim();
      const c = courses.find(x => x.name === nm);
      if (!c) return { error: `未找到课程「${nm}」` };
      if (args && args.new_name && String(args.new_name).trim()) c.name = String(args.new_name).trim();
      if (args && args.day_of_week) {
        const d = +args.day_of_week;
        if (d >= 1 && d <= 7) c.day = d;
      }
      if (args && args.start_section) c.startSec = +args.start_section;
      if (args && args.end_section) c.endSec = +args.end_section;
      if (args && args.weeks_text) {
        const wk = parseWeeks(args.weeks_text);
        if (!wk.length) return { error: '周次格式无效（如 1-16周、1-8周(单)）' };
        c.weeks = wk;
        c.weeksText = String(args.weeks_text).trim();
      }
      if (args && args.teacher !== undefined) c.teacher = String(args.teacher).trim();
      if (args && args.location !== undefined) c.location = String(args.location).trim();
      c.color = colorOf(c.name);
      save(LS.courses, courses);
      renderAll();
      return { ok: true, course: { name: c.name, day: WEEKDAYS[c.day - 1], sections: `${c.startSec}-${c.endSec}节`, weeks: c.weeksText, teacher: c.teacher, location: c.location } };
    }
    case 'clear_courses': {
      const n = courses.length;
      if (!n) return { ok: true, cleared: 0 };
      courses = [];
      save(LS.courses, courses);
      renderAll();
      return { ok: true, cleared: n, note: '课表已清空，可重新导入' };
    }
    case 'open_course_import': {
      const mode = ['html', 'csv', 'paste'].includes(args && args.mode) ? args.mode : 'html';
      switchPage('schedule');
      openImport(mode);
      const names = { html: '教务系统网页(HTML)导入', csv: 'CSV 模板导入', paste: '粘贴文本导入' };
      return { ok: true, note: `已打开「${names[mode]}」窗口，请按窗口内指引操作` };
    }
    case 'set_semester_start': {
      const d = String((args && args.date) || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !parseDate(d)) return { error: '日期格式应为 YYYY-MM-DD' };
      settings.semesterStart = d;
      save(LS.settings, settings);
      $('#semester-start').value = d;
      renderAll();
      const w2 = weekInfo();
      return { ok: true, semesterStart: d, currentWeek: w2.week, note: '已更新开学日期；请务必确认这是本学期开学第一天（上课）的准确日期，否则当前周与今日课程会计算错误' };
    }
    case 'set_section_time': {
      const sec = +(args && args.section);
      const s = String((args && args.start) || '');
      const en = String((args && args.end) || '');
      if (!(sec >= 1 && sec <= 14)) return { error: '节次需在 1-14 之间' };
      if (!/^\d{1,2}:\d{2}$/.test(s) || !/^\d{1,2}:\d{2}$/.test(en)) return { error: '时间格式应为 HH:MM，如 08:00' };
      if (!settings.secTimes) settings.secTimes = [null];
      settings.secTimes[sec] = s + '|' + en;
      save(LS.settings, settings);
      renderSchedule();
      renderToday();
      return { ok: true, section: sec, time: s + '-' + en };
    }
    case 'fill_default_section_times': {
      const arr = [null];
      for (let i = 0; i < DEFAULT_TIMES.length; i += 2) arr.push(DEFAULT_TIMES[i] + '|' + DEFAULT_TIMES[i + 1]);
      settings.secTimes = arr;
      save(LS.settings, settings);
      renderSchedule();
      renderToday();
      return { ok: true, note: '已按常见作息表填充全部节次时间' };
    }
    case 'delete_bookmark': {
      const b = findBookmark(args && args.keyword);
      if (!b) return { error: '未找到匹配的收藏网站' };
      bookmarks = bookmarks.filter(x => x.id !== b.id);
      save(LS.bookmarks, bookmarks);
      renderBookmarks();
      return { ok: true, removed: b.name, url: b.url };
    }
    case 'rename_bookmark': {
      const b = findBookmark(args && args.keyword);
      const nn = String((args && args.new_name) || '').trim();
      if (!b) return { error: '未找到匹配的收藏网站' };
      if (!nn) return { error: '新名称不能为空' };
      b.name = nn;
      save(LS.bookmarks, bookmarks);
      renderBookmarks();
      return { ok: true, name: nn, url: b.url };
    }
    case 'add_category': {
      const n = String((args && args.name) || '').trim();
      if (!n) return { error: '分类名不能为空' };
      if (categories.includes(n)) return { error: '该分类已存在' };
      categories.push(n);
      save(LS.categories, categories);
      renderBookmarks();
      return { ok: true, category: n };
    }
    case 'rename_category': {
      const oldN = String((args && args.old_name) || '').trim();
      const newN = String((args && args.new_name) || '').trim();
      const idx = categories.indexOf(oldN);
      if (idx < 0) return { error: `未找到分类「${oldN}」` };
      if (!newN) return { error: '新分类名不能为空' };
      if (newN !== oldN && categories.includes(newN)) return { error: '该分类已存在' };
      categories[idx] = newN;
      bookmarks.forEach(b => { if (b.category === oldN) b.category = newN; });
      if (bmCat === oldN) bmCat = newN;
      save(LS.categories, categories);
      save(LS.bookmarks, bookmarks);
      renderBookmarks();
      return { ok: true, old: oldN, renamed: newN };
    }
    case 'delete_category': {
      const n = String((args && args.name) || '').trim();
      const idx = categories.indexOf(n);
      if (idx < 0) return { error: `未找到分类「${n}」` };
      const cnt = bookmarks.filter(b => b.category === n).length;
      categories.splice(idx, 1);
      bookmarks.forEach(b => { if (b.category === n) b.category = ''; });
      if (bmCat === n) bmCat = 'all';
      save(LS.categories, categories);
      save(LS.bookmarks, bookmarks);
      renderBookmarks();
      return { ok: true, removed: n, unset: cnt };
    }
    case 'dedupe_bookmarks': {
      const removed = dedupeBookmarksNow();
      return { ok: true, removed, note: removed ? `已清除 ${removed} 条重复收藏` : '未发现重复收藏' };
    }
    case 'import_bookmarks': {
      switchPage('bookmarks');
      const fi = $('#file-bm');
      fi.accept = '.html,.htm,.json,application/json,text/*,*/*';
      fi.value = '';
      fi.click();
      return { ok: true, note: '已弹出文件选择框，请选择 Edge 导出的收藏夹 HTML 文件或本地 Bookmarks 文件' };
    }
    case 'export_bookmarks': {
      if (!bookmarks.length) return { error: '收藏夹为空，无法导出' };
      exportEdgeHtml();
      return { ok: true, note: '已生成 Edge 可导入的 HTML 文件并触发下载' };
    }
    case 'filter_bookmarks': {
      if (args && args.category !== undefined) {
        const cat = String(args.category).trim();
        bmCat = (cat === '' || cat === '全部') ? 'all' : (cat === '未分类' ? 'none' : cat);
      }
      if (args && args.keyword !== undefined) {
        bmSearch = String(args.keyword).trim();
        $('#bm-search').value = bmSearch;
      }
      switchPage('bookmarks');
      renderBookmarks();
      return { ok: true, category: bmCat, keyword: bmSearch };
    }
    case 'clear_chat': {
      newChat();
      return { ok: true, note: '已新建空白对话，之前的对话已保存到会话列表' };
    }
    case 'start_voice': {
      if (!speechSupported()) return { error: '当前浏览器不支持语音识别，请使用 Edge/Chrome' };
      if (!recognizing) {
        toggleVoice();
        return { ok: true, note: '正在聆听，请说话' };
      }
      return { ok: true, note: '已在聆听中' };
    }
    case 'get_settings':
      return {
        semesterStart: settings.semesterStart || '未设置',
        maxSection: settings.maxSection,
        currentWeek: wi.week,
        weekday: WEEKDAYS[wi.weekday - 1],
        currentWeekHoliday: wi.isHoliday,
        courseCount: courses.length,
        bookmarkCount: bookmarks.length,
        categoryCount: categories.length,
        taskCount: tasks.length,
        pendingTaskCount: tasks.filter(t => !t.done).length,
        eventCount: events.length,
        mapConfigured: !!mapCfg.key,
        sectionTimesConfigured: (settings.secTimes || []).filter(Boolean).length,
      };
    default:
      return { error: '未知工具：' + name };
  }
}

function buildSystemPrompt() {
  const wi = weekInfo();
  const wkTxt = wi.week ? `当前是第${wi.week}周` : '开学日期尚未设置（当前周未知，涉及周次的查询要提醒用户先设置开学第一天上课日期）';
  return `你是「Table」看板的智能助手，运行在用户的本地网页里。你可以用工具直接操作系统，覆盖网页内的所有页面与功能：
【课程表页】查询当前周/今日课程/某一周课程；跳转查看某周课表(view_week)；添加/编辑/删除课程；清空课表；打开课表导入向导(教务系统HTML/CSV/粘贴)；设置开学日期(影响当前周计算，须用户确认准确)；设置某一节次时间或填充默认节次时间。
【收藏夹页】搜索/打开/添加/删除/重命名收藏网站；单个或按关键词/分类批量打开网站（open_bookmark/open_bookmarks，自动打开被拦截时引导用户点聊天内按钮）；给网站设置分类；新建/重命名/删除分类；一键去重重复网址；按分类或关键词筛选显示；触发 Edge 收藏文件导入；导出 Edge 可导入的 HTML 文件。
【智能体页】清空对话；启动语音输入(start_voice)。
【待办页】查询/添加/完成/删除待办任务（按截止时间优先度排序；截止前1小时会自动通过「提醒」栏目提醒用户，红色圆圈角标提示新提醒）。
【规划页】查询/添加/编辑/删除未来规划事件（甘特图显示，任务名称-开始日期-结束日期；日期格式 YYYY-MM-DD）。
【用量中心】查询本看板 DeepSeek 消耗统计与官方账户余额（get_usage/refresh_balance；费用为估算值，单价可在用量中心页调整）。
【地图页】定位当前城市（map_locate，高德IP定位）；搜索地点（map_search，POI搜索）；地址转经纬度（map_geocode，地理编码）。需用户已在地图页「⚙️ Key 配置」填写高德 Key 并通过测试，否则提醒用户先配置。
【通用】切换页面(show_page)；读取看板设置与统计(get_settings)。
今天日期：${dateStr(new Date())}，${WEEKDAYS[wi.weekday - 1]}，${wkTxt}。
规则：
1. 用户要求做看板能做的事时，必须调用对应工具真实执行，不要凭空编造课程或收藏内容；执行后汇报实际结果。
2. 涉及"第几周/今天/本周"时先用工具确认，不要猜测；修改开学日期前要提醒用户核对准确性。工具返回 isHoliday=true 表示当前处于假期（尚未开学 week=0 或该周无课程），回答时要明确告知用户处于假期；week=0 时开学日期已设置、只是还没开学，不要误报为「未设置开学日期」。
3. 危险操作（清空课表、删除收藏/课程/分类、去重）执行前先用一句话说明影响，但可直接执行。
4. 用简体中文简洁友好地回答；多步任务依次调用工具完成。`;
}

let chatHistory = []; // 原始消息数组（不含 system）
const MAX_ROUNDS = 10;

function mdLite(text) {
  let t = esc(text);
  t = t.replace(/```([\s\S]*?)```/g, (m, c) => `<pre>${c.trim()}</pre>`);
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  t = t.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/(?<!["'>])(https?:\/\/[^\s<"']+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/^### (.*)$/gm, '<b>$1</b>');
  t = t.replace(/^## (.*)$/gm, '<b>$1</b>');
  t = t.replace(/^\s*[-*] (.*)$/gm, '<li>$1</li>');
  t = t.replace(/(<li>[\s\S]*?<\/li>)/g, m => `<ul>${m}</ul>`);
  t = t.replace(/\n/g, '<br>');
  return t;
}

function appendMsg(role, content, isHtml = false) {
  const box = $('#chat-msgs');
  const div = document.createElement('div');
  div.className = 'msg ' + role;
  if (isHtml) div.innerHTML = content;
  else div.textContent = content;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

/* ==================== 对话会话管理 ==================== */
const WELCOME_AI = '你好！我是你的看板智能助手 🤖<br>我可以帮你：查看今天/某一周的课程、搜索并打开收藏网站、添加课程或收藏、给网站分类等。先在右侧配置 DeepSeek API Key，然后直接告诉我想做什么吧～';

function titleFrom(t) {
  const x = String(t || '').trim().replace(/\s+/g, ' ');
  return (x.slice(0, 18) + (x.length > 18 ? '…' : '')) || '新对话';
}
function fmtSessTime(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  const today = todayMidnight().getTime();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`;
  if (day === today) return hm;
  if (today - day <= 86400000 * 7) return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function renderSessions() {
  const box = $('#sess-list');
  if (!sessions.length) {
    box.innerHTML = '<div class="sess-empty">暂无保存的对话<br>发送第一条消息后自动保存</div>';
    return;
  }
  box.innerHTML = sessions.map(s => `<div class="sess-item ${s.id === currentSid ? 'active' : ''}" data-id="${s.id}">
    <span class="sess-title" title="${esc(s.title)}">${esc(s.title)}</span>
    <span class="sess-time">${fmtSessTime(s.updatedAt || s.createdAt)}</span>
    <button class="sess-del" data-act="del" title="删除对话">✕</button>
  </div>`).join('');
}
function newChat() {
  currentSid = '';
  chatHistory = [];
  save(LS.sessCurrent, '');
  $('#chat-msgs').innerHTML = '<div class="msg ai">' + WELCOME_AI + '</div>';
  renderSessions();
}
function switchSession(id) {
  const s = sessions.find(x => x.id === id);
  if (!s) return;
  currentSid = id;
  save(LS.sessCurrent, id);
  chatHistory = (s.messages || []).slice();
  renderSessionMessages(s.messages || []);
  renderSessions();
}
function renderSessionMessages(msgs) {
  const box = $('#chat-msgs');
  let html = '';
  for (const m of msgs) {
    if (m.role === 'user') html += `<div class="msg user">${esc(m.content)}</div>`;
    else if (m.role === 'assistant' && m.content) html += `<div class="msg ai">${mdLite(m.content)}</div>`;
  }
  box.innerHTML = html || '<div class="msg ai">' + WELCOME_AI + '</div>';
  box.scrollTop = box.scrollHeight;
}
/* 发送完成后保存当前对话（自动以第一条消息作为标题） */
function persistSession(firstUserText) {
  if (!currentSid) {
    const s = { id: uid(), title: titleFrom(firstUserText), createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
    sessions.unshift(s);
    if (sessions.length > 100) sessions = sessions.slice(0, 100);
    currentSid = s.id;
  }
  const s = sessions.find(x => x.id === currentSid);
  if (s) {
    if (!s.title || s.title === '新对话') s.title = titleFrom(firstUserText);
    s.messages = chatHistory.slice();
    s.updatedAt = Date.now();
  }
  save(LS.sessions, sessions);
  save(LS.sessCurrent, currentSid);
  renderSessions();
}

async function runAgentLoop(history) {
  const messages = [{ role: 'system', content: buildSystemPrompt() }, ...history];
  const base = agentCfg.baseUrl.replace(/\/+$/, '');
  for (let i = 0; i < MAX_ROUNDS; i++) {
    let resp;
    try {
      resp = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + agentCfg.apiKey },
        body: JSON.stringify({ model: agentCfg.model, messages, tools: TOOLS, tool_choice: 'auto' }),
      });
    } catch (err) {
      throw new Error('网络请求失败：' + (err.message || err) +
        '。若是跨域(CORS)问题，可在右侧配置一个代理地址（如本地代理），或检查网络。');
    }
    if (!resp.ok) {
      const t = (await resp.text()).slice(0, 400);
      let hint = t;
      if (resp.status === 401) hint = 'API Key 无效或未授权，请检查 Key（platform.deepseek.com 申请）';
      else if (resp.status === 429) hint = '请求过于频繁或余额不足（429）';
      throw new Error(`DeepSeek API 错误 (${resp.status})：${hint}`);
    }
    const data = await resp.json();
    if (data.usage) recordUsage(agentCfg.model, data.usage); // 用量统计
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new Error('API 返回格式异常');
    messages.push(msg);

    if (msg.tool_calls && msg.tool_calls.length) {
      for (const tc of msg.tool_calls) {
        appendMsg('sys', '🛠️ 正在执行：' + (TOOL_LABELS[tc.function.name] || tc.function.name) + '…');
        let result;
        try {
          const args = JSON.parse(tc.function.arguments || '{}');
          result = await executeTool(tc.function.name, args);
        } catch (e) {
          result = { error: String(e && e.message || e) };
        }
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
      }
      continue;
    }
    return { messages: messages.slice(1), content: msg.content || '（无回复）' };
  }
  return { messages: messages.slice(1), content: '已达到最大工具调用次数（' + MAX_ROUNDS + ' 轮），请拆分成更简单的指令再试。' };
}

let sending = false;
async function sendChat(text) {
  text = (text || '').trim();
  if (!text) return;
  if (sending) return;
  if (!agentCfg.apiKey) { toast('请先在右侧配置 DeepSeek API Key', 'warn'); return; }
  sending = true;
  $('#btn-chat-send').textContent = '发送中…';
  $('#chat-input').value = ''; // 发送后清空输入栏
  appendMsg('user', text);
  const history = [...chatHistory, { role: 'user', content: text }];
  const thinking = appendMsg('sys', '🤔 思考中…');
  try {
    const { messages, content } = await runAgentLoop(history);
    chatHistory = messages;
    thinking.remove();
    appendMsg('ai', mdLite(content), true);
  } catch (err) {
    chatHistory = history;
    thinking.remove();
    appendMsg('sys', '❌ ' + (err.message || err));
  }
  persistSession(text);
  sending = false;
  $('#btn-chat-send').textContent = '发送 ➤';
}

/* ==================== 语音识别（Web Speech API） ==================== */
let recognizing = false;
let recognition = null;

function speechSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}
function resetVoiceUI() {
  recognizing = false;
  recognition = null;
  const btn = $('#btn-voice');
  if (btn) {
    btn.classList.remove('listening');
    btn.textContent = '🎤';
  }
}
function stopVoice() {
  if (recognition) { try { recognition.stop(); } catch (e) { /* 忽略 */ } }
}
function toggleVoice() {
  if (!speechSupported()) {
    toast('当前浏览器不支持语音识别，请使用 Edge / Chrome', 'warn');
    return;
  }
  if (recognizing) { stopVoice(); return; }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR();
  recognition.lang = 'zh-CN';
  recognition.interimResults = true;
  recognition.continuous = false;
  recognition.maxAlternatives = 3;

  const btn = $('#btn-voice');
  recognition.onstart = () => {
    recognizing = true;
    btn.classList.add('listening');
    btn.textContent = '🔴 聆听中';
  };
  recognition.onresult = e => {
    let interim = '', finalText = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      // 多个候选里取置信度最高的一条，提高准确性
      let best = res[0], bestC = res[0].confidence || 0;
      for (let j = 1; j < res.length; j++) {
        const c = res[j].confidence || 0;
        if (c > bestC) { bestC = c; best = res[j]; }
      }
      if (res.isFinal) finalText += best.transcript;
      else interim += best.transcript;
    }
    $('#chat-input').value = (finalText || interim).trim();
    if (finalText.trim()) {
      const text = $('#chat-input').value;
      $('#chat-input').value = '';
      sendVoiceText(text);
    }
  };
  recognition.onerror = e => {
    resetVoiceUI();
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      toast('麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问后重试', 'warn');
    } else if (e.error === 'no-speech') {
      toast('没有听到语音，请靠近麦克风重试', 'warn');
    } else if (e.error === 'network') {
      toast('语音识别服务网络不可用（需联网）', 'warn');
    } else if (e.error !== 'aborted') {
      toast('语音识别出错：' + e.error, 'warn');
    }
  };
  recognition.onend = resetVoiceUI;
  try {
    recognition.start();
  } catch (err) {
    resetVoiceUI();
    toast('启动语音识别失败：' + (err.message || err), 'err');
  }
}

/* 语音转写后调用 DeepSeek 校正同音字（未配 Key 或失败时原样返回） */
async function correctTranscript(text) {
  if (!agentCfg.apiKey || !agentCfg.voiceFix) return text;
  try {
    const base = agentCfg.baseUrl.replace(/\/+$/, '');
    const resp = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + agentCfg.apiKey },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: '你是语音转写校正器。纠正用户中文语音转写中的同音字、错别字，保留原意和语气，只输出校正后的句子，不要任何解释。' },
          { role: 'user', content: text },
        ],
        max_tokens: 200,
      }),
    });
    if (!resp.ok) return text;
    const data = await resp.json();
    if (data.usage) recordUsage('deepseek-v4-flash', data.usage); // 语音校正消耗也计入统计
    const fixed = ((data.choices && data.choices[0] && data.choices[0].message.content) || '').trim();
    return fixed || text;
  } catch (e) {
    return text;
  }
}
async function sendVoiceText(text) {
  const fixed = await correctTranscript(text);
  sendChat(fixed || text);
}

/* ==================== 页面切换 ==================== */
function switchPage(page) {
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  ['schedule', 'bookmarks', 'agent', 'tasks', 'gantt', 'usage', 'map'].forEach(p => {
    $('#page-' + p).classList.toggle('hidden', p !== page);
  });
  if (page === 'bookmarks') renderBookmarks();
  if (page === 'tasks') renderTasks();
  if (page === 'gantt') renderGantt();
  if (page === 'usage') renderUsage();
  if (page === 'map') initMapPage();
  if (page === 'schedule') renderAll();
}

/* ==================== 事件绑定 ==================== */
function bindAll() {
  // 导航
  $$('.nav-item').forEach(b => b.addEventListener('click', () => switchPage(b.dataset.page)));

  // 课程表
  $('#semester-start').addEventListener('change', e => {
    settings.semesterStart = e.target.value;
    save(LS.settings, settings);
    renderAll();
  });
  $('#max-sec').addEventListener('change', e => {
    settings.maxSection = +e.target.value || 12;
    save(LS.settings, settings);
    renderSchedule();
  });
  $('#btn-times').addEventListener('click', openTimesModal);
  $('#times-default').addEventListener('click', fillDefaultTimes);
  $('#times-save').addEventListener('click', saveTimes);
  $('#wk-prev').addEventListener('click', () => { ensureViewWeek(); viewWeek = Math.max(1, viewWeek - 1); renderSchedule(); renderWeekNav(); });
  $('#wk-next').addEventListener('click', () => { ensureViewWeek(); viewWeek = Math.min(maxWeek(), viewWeek + 1); renderSchedule(); renderWeekNav(); });
  $('#wk-select').addEventListener('change', e => { viewWeek = +e.target.value; renderSchedule(); });
  $('#btn-today').addEventListener('click', () => {
    const wi = weekInfo();
    viewWeek = (wi.week && wi.week >= 1) ? wi.week : 1;
    renderWeekNav(); renderSchedule();
    if (wi.week >= 1) toast(`已跳转到当前第 ${wi.week} 周`);
    else if (wi.week === 0) toast('尚未开学（假期中），已显示第 1 周', 'warn');
    else toast('请先设置开学日期', 'warn');
  });
  $('#btn-add-course').addEventListener('click', () => openCourseModal());
  $('#btn-clear-courses').addEventListener('click', () => {
    if (!courses.length) return toast('课表已经是空的', 'warn');
    if (!confirm(`确定清空全部 ${courses.length} 门课程吗？此操作不可撤销。`)) return;
    courses = [];
    save(LS.courses, courses);
    renderAll();
    toast('课表已清空，可重新导入');
  });
  $('#schedule-grid').addEventListener('click', e => {
    const blk = e.target.closest('.sch-block');
    if (!blk) return;
    // 合并块打开第一条课程；普通块打开自身
    const id = blk.dataset.ids ? blk.dataset.ids.split(',')[0] : blk.dataset.id;
    if (id) openCourseModal(id);
  });

  // 课程弹窗
  $('#c-save').addEventListener('click', saveCourseFromForm);
  $('#c-delete').addEventListener('click', deleteCourseFromModal);
  $$('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));
  $$('.modal-mask').forEach(m => m.addEventListener('click', e => {
    if (e.target === m) closeModal(m.closest('.modal').id);
  }));

  // 导入菜单
  $('#btn-import-menu').addEventListener('click', e => {
    e.stopPropagation();
    $('#import-menu').classList.toggle('hidden');
  });
  document.addEventListener('click', () => $('#import-menu').classList.add('hidden'));
  $('#import-menu').addEventListener('click', e => {
    const btn = e.target.closest('[data-import]');
    if (!btn) return;
    const mode = btn.dataset.import;
    if (mode === 'template') { downloadTemplate(); return; }
    openImport(mode);
  });
  $('#file-import').addEventListener('change', e => {
    handleImportFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#im-paste-ok').addEventListener('click', () => {
    const { parsed, skipped } = parsePaste($('#im-paste-text').value);
    showPreview(parsed, skipped);
  });
  $('#im-confirm').addEventListener('click', confirmImport);
  // 预览表格内直接修改星期/节次/周次
  $('#im-preview-body').addEventListener('change', e => {
    const t = e.target;
    const id = t.dataset && t.dataset.id;
    const c = pendingCourses.find(x => x.id === id);
    if (!c) return;
    if (t.classList.contains('pv-day')) c.day = +t.value;
    else if (t.classList.contains('pv-ss')) c.startSec = +t.value;
    else if (t.classList.contains('pv-es')) c.endSec = +t.value;
    else if (t.classList.contains('pv-weeks')) c.weeksText = t.value.trim();
  });

  // 收藏夹
  $('#btn-bm-import').addEventListener('click', () => {
    const fi = $('#file-bm');
    fi.accept = '.html,.htm,.json,application/json,text/*,*/*';
    fi.value = '';
    fi.click();
  });
  $('#file-bm').addEventListener('change', e => {
    importBookmarksFile(e.target.files[0]);
    e.target.value = '';
  });
  $('#btn-bm-export-edge').addEventListener('click', exportEdgeHtml);
  $('#btn-bm-export').addEventListener('click', () => {
    if (!bookmarks.length) return toast('收藏夹为空', 'warn');
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), bookmarks }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'edge-bookmarks-backup.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('备份已导出');
  });
  $('#btn-bm-clear').addEventListener('click', () => {
    if (!bookmarks.length) return;
    if (!confirm(`确定清空全部 ${bookmarks.length} 个收藏网站吗？（可先用「导出备份 JSON」保存）`)) return;
    bookmarks = [];
    save(LS.bookmarks, bookmarks);
    renderBookmarks();
    toast('已清空');
  });
  $('#bm-search').addEventListener('input', e => { bmSearch = e.target.value; renderBookmarks(); });
  $('#bm-chips').addEventListener('click', e => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    if (chip.dataset.cat === '__new') {
      const name = prompt('输入新分类名称：');
      if (!name || !name.trim()) return;
      const n = name.trim();
      if (categories.includes(n)) return toast('该分类已存在', 'warn');
      categories.push(n);
      save(LS.categories, categories);
      bmCat = n;
    } else {
      bmCat = chip.dataset.cat;
    }
    renderBookmarks();
  });

  // 分类管理弹窗
  $('#btn-cats').addEventListener('click', openCatsModal);
  // 手动收藏
  $('#btn-bm-add').addEventListener('click', openBmAddModal);
  $('#btn-bm-dedupe').addEventListener('click', dedupeBookmarks);
  $('#bma-save').addEventListener('click', saveBmAdd);
  $('#bma-url').addEventListener('keydown', e => { if (e.key === 'Enter') saveBmAdd(); });
  $('#bma-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('#bma-url').focus(); });
  $('#cat-add').addEventListener('click', () => {
    const name = $('#cat-new-name').value.trim();
    if (!name) return toast('请输入分类名称', 'warn');
    if (categories.includes(name)) return toast('该分类已存在', 'warn');
    categories.push(name);
    save(LS.categories, categories);
    $('#cat-new-name').value = '';
    renderCatsList();
    renderBookmarks();
    toast(`已添加分类「${name}」`);
  });
  $('#cats-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const row = btn.closest('.cat-row');
    const oldName = row.dataset.cat;
    const idx = categories.indexOf(oldName);
    if (idx < 0) return;
    if (btn.dataset.act === 'rename') {
      const name = row.querySelector('.cat-name').value.trim();
      if (!name) return toast('分类名不能为空', 'warn');
      if (name !== oldName && categories.includes(name)) return toast('该分类已存在', 'warn');
      categories[idx] = name;
      bookmarks.forEach(b => { if (b.category === oldName) b.category = name; });
      if (bmCat === oldName) bmCat = name;
      save(LS.categories, categories);
      save(LS.bookmarks, bookmarks);
      renderCatsList();
      renderBookmarks();
      toast(`分类已重命名为「${name}」`);
    } else if (btn.dataset.act === 'del') {
      const cnt = bookmarks.filter(b => b.category === oldName).length;
      if (!confirm(`删除分类「${oldName}」？其下 ${cnt} 个收藏将变为未分类。`)) return;
      categories.splice(idx, 1);
      bookmarks.forEach(b => { if (b.category === oldName) b.category = ''; });
      if (bmCat === oldName) bmCat = 'all';
      save(LS.categories, categories);
      save(LS.bookmarks, bookmarks);
      renderCatsList();
      renderBookmarks();
      toast('分类已删除');
    }
  });
  $('#bm-grid').addEventListener('click', e => {
    if (e.target.closest('.bm-name-input')) return; // 名称编辑中不触发打开
    const card = e.target.closest('.bm-card');
    if (!card) return;
    const b = bookmarks.find(x => x.id === card.dataset.id);
    if (!b) return;
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'open') openBookmark(b);
    else if (act === 'rename') startRename(card, b);
    else if (act === 'del') {
      if (confirm(`删除收藏「${b.name}」？`)) {
        bookmarks = bookmarks.filter(x => x.id !== b.id);
        save(LS.bookmarks, bookmarks);
        renderBookmarks();
        toast('已删除');
      }
    } else if (!act) {
      // 点击卡片名称区域打开（编辑输入框除外）
      if (e.target.closest('.bm-name') && !e.target.closest('.bm-name-input')) openBookmark(b);
    }
  });
  // 名称编辑：回车保存 / Esc 取消 / 失焦保存
  $('#bm-grid').addEventListener('keydown', e => {
    const inp = e.target.closest('.bm-name-input');
    if (!inp) return;
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    else if (e.key === 'Escape') { inp.dataset.cancel = '1'; inp.blur(); }
  });
  $('#bm-grid').addEventListener('focusout', e => {
    const inp = e.target.closest('.bm-name-input');
    if (!inp) return;
    const card = inp.closest('.bm-card');
    const b = card ? bookmarks.find(x => x.id === card.dataset.id) : null;
    if (inp.dataset.cancel || !b) { renderBookmarks(); return; }
    const name = inp.value.trim();
    if (name && name !== b.name) {
      b.name = name;
      save(LS.bookmarks, bookmarks);
      toast('名称已修改');
    }
    renderBookmarks();
  });
  $('#bm-grid').addEventListener('change', e => {
    const sel = e.target.closest('.bm-cat');
    if (!sel) return;
    const card = sel.closest('.bm-card');
    const b = bookmarks.find(x => x.id === card.dataset.id);
    if (!b) return;
    let v = sel.value;
    if (v === '__new') {
      const name = prompt('输入新分类名称：');
      if (!name || !name.trim()) { renderBookmarks(); return; }
      v = name.trim();
      if (!categories.includes(v)) { categories.push(v); save(LS.categories, categories); }
    }
    b.category = v;
    save(LS.bookmarks, bookmarks);
    renderBookmarks();
    toast(v ? `已归入分类「${v}」` : '已设为未分类');
  });

  // 待办任务
  $('#btn-tk-add').addEventListener('click', () => openTaskModal());
  $('#tk-save').addEventListener('click', saveTaskFromForm);
  $('#tk-delete').addEventListener('click', () => {
    if (!editingTaskId) return;
    const t = tasks.find(x => x.id === editingTaskId);
    if (t && confirm(`删除任务「${t.title}」？`)) {
      tasks = tasks.filter(x => x.id !== editingTaskId);
      save(LS.tasks, tasks);
      closeModal('modal-task');
      renderTasks();
      toast('任务已删除');
    }
  });
  $('#tk-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    const item = e.target.closest('.tk-item');
    if (!item) return;
    const t = tasks.find(x => x.id === item.dataset.id);
    if (!t) return;
    const act = btn ? btn.dataset.act : null;
    if (act === 'edit') openTaskModal(t.id);
    else if (act === 'del') {
      if (confirm(`删除任务「${t.title}」？`)) {
        tasks = tasks.filter(x => x.id !== t.id);
        save(LS.tasks, tasks);
        renderTasks();
        toast('任务已删除');
      }
    }
  });
  $('#tk-list').addEventListener('change', e => {
    const cb = e.target.closest('.tk-check');
    if (!cb) return;
    const item = cb.closest('.tk-item');
    const t = tasks.find(x => x.id === item.dataset.id);
    if (!t) return;
    t.done = cb.checked;
    if (t.done) t.reminded = true;
    save(LS.tasks, tasks);
    renderTasks();
    toast(t.done ? `已完成「${t.title}」🎉` : '已恢复为待办');
  });

  // 聊天标签页（对话 / 提醒）
  $$('.chat-tab').forEach(tb => tb.addEventListener('click', () => {
    const tab = tb.dataset.tab;
    $$('.chat-tab').forEach(x => x.classList.toggle('active', x === tb));
    $('#chat-msgs').classList.toggle('hidden', tab !== 'chat');
    $('.quick-chips').classList.toggle('hidden', tab !== 'chat');
    $('.chat-inputrow').classList.toggle('hidden', tab !== 'chat');
    $('#remind-msgs').classList.toggle('hidden', tab !== 'remind');
    if (tab === 'remind') {
      openRemindTab();
      renderReminders();
    }
  }));
  $('#remind-msgs').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    if (btn.dataset.act === 'goto') switchPage('tasks');
    else if (btn.dataset.act === 'delrem') {
      reminders = reminders.filter(r => r.id !== btn.dataset.id);
      save(LS.reminders, reminders);
      updateRemindBadge();
      renderReminders();
    }
  });

  // 甘特图（规划）
  $('#btn-gt-add').addEventListener('click', () => openEventModal());
  $('#ev-save').addEventListener('click', saveEventFromForm);
  $('#ev-delete').addEventListener('click', deleteEventFromForm);
  $('#gt-zoom').addEventListener('change', () => {
    settings.ganttZoom = +$('#gt-zoom').value || 16;
    save(LS.settings, settings);
    renderGantt();
  });
  $('#btn-gt-today').addEventListener('click', renderGantt);
  $('#gantt-chart').addEventListener('click', e => {
    const bar = e.target.closest('.gt-bar');
    if (bar && bar.dataset.id) openEventModal(bar.dataset.id);
  });

  // 用量中心
  $('#us-range').addEventListener('click', e => {
    const btn = e.target.closest('.seg-btn');
    if (!btn) return;
    $$('#us-range .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
    usRange = btn.dataset.range;
    renderUsChart();
    renderUsTable();
  });
  $('#us-balance').addEventListener('click', e => {
    if (e.target.closest('[data-act="refresh"]')) fetchBalance();
  });
  $('#us-price-save').addEventListener('click', () => {
    const models = {};
    let ok = true;
    PRICE_MODELS.forEach(pm => {
      models[pm.name] = {};
      ['off', 'peak'].forEach(period => {
        models[pm.name][period] = {};
        ['hit', 'miss', 'out'].forEach(k => {
          const v = parseFloat($('#pr-' + pm.key + '-' + period + '-' + k).value);
          if (!(v >= 0)) ok = false;
          models[pm.name][period][k] = isNaN(v) ? 0 : v;
        });
      });
    });
    if (!ok) return toast('请输入有效单价（均不能为负）', 'warn');
    settings.prices = { models };
    save(LS.settings, settings);
    renderUsage();
    toast('全部模型单价已保存，费用估算已更新');
  });

  // 地图
  $('#btn-map-config').addEventListener('click', openMapConfigModal);
  $('#map-save-test').addEventListener('click', saveAndTestMapConfig);
  $('#btn-map-search').addEventListener('click', () => mapSearchDo($('#map-search-input').value));
  $('#map-search-input').addEventListener('keydown', e => { if (e.key === 'Enter') mapSearchDo(e.target.value); });
  $('#btn-map-locate').addEventListener('click', locateMe);
  $('#btn-map-full').addEventListener('click', toggleMapFullscreen);
  // 全屏状态变化时更新按钮文字并重绘地图
  document.addEventListener('fullscreenchange', () => {
    const btn = $('#btn-map-full');
    if (btn) btn.textContent = document.fullscreenElement ? '⛶ 退出全屏' : '⛶ 全屏';
    setTimeout(() => { if (amapMap) amapMap.resize(); }, 150);
  });
  $('#map-container').addEventListener('click', e => {
    if (e.target.closest('[data-act="config"]')) openMapConfigModal();
  });
  $('#map-results').addEventListener('click', e => {
    // 结果卡上的操作按钮：修改查询条件 / 切换主方案
    const actEl = e.target.closest('[data-act]');
    if (actEl) {
      if (actEl.dataset.act === 'edit-query') {
        openRouteModal();
        toast('已回到查询条件编辑，可修改后重新规划');
        return;
      }
      if (actEl.dataset.act === 'pick-route') {
        const idx = +actEl.dataset.idx || 0;
        if (plannedRoutes[idx]) {
          drawPlannedRoutes(idx); // 点击的方案变蓝色实线主路线
          rerenderRouteSummary();
          updateMapStatus(`已切换：${idx === plannedMainIdx ? '最优方案' : '备选方案 ' + idx + ' 为主路线'}`);
        }
        return;
      }
    }
    const it = e.target.closest('.map-item');
    if (!it) return;
    try {
      const idx = +it.dataset.index || 0;
      const p = (amapCurrentPois || [])[idx];
      const ll = [+it.dataset.lng, +it.dataset.lat];
      if (!amapMap) return;
      // 单击（含选点模式）：居中缩放 + 信息窗查看位置，不选中
      if (amapMap.stopMove) { try { amapMap.stopMove(); } catch (e2) { /* 忽略 */ } }
      amapMap.setZoomAndCenter(15, ll);
      highlightArea(ll); // 虚线+淡蓝透明框出建筑位置
      if (p) setTimeout(() => showInfo('<b>' + esc(p.name) + '</b><br />' + esc(p.address || ''), ll), 450);
    } catch (err) {
      console.warn('地图结果点击处理失败：', err);
    }
  });
  // 双击卡片（选点模式）：确认选中该位置为起点/终点
  $('#map-results').addEventListener('dblclick', e => {
    const it = e.target.closest('.map-item');
    if (!it || !routePickStage) return;
    const idx = +it.dataset.index || 0;
    const p = (amapCurrentPois || [])[idx];
    if (!p) return;
    const stage = routePickStage;
    selectRoutePoint(stage, {
      lng: +it.dataset.lng, lat: +it.dataset.lat,
      name: p.name, address: p.address || (p.pname + ' ' + p.cityname + ' ' + p.adname),
      adcode: p.adcode || '',
    });
    toast(`已选择「${p.name}」作为${stage === 'origin' ? '起点' : '终点'}`);
    openRouteModal();
  });

  // 电子围栏
  $('#btn-fence-add').addEventListener('click', openFenceModal);
  $$('.fence-type-card').forEach(c => c.addEventListener('click', () => {
    $$('.fence-type-card').forEach(x => x.classList.toggle('active', x === c));
    const isCircle = c.dataset.type === 'circle';
    $('#fence-radius-group').classList.toggle('hidden', !isCircle);
    $('#fence-pick-group').classList.toggle('hidden', isCircle);
  }));
  $$('#fence-circle-mode .seg-btn').forEach(b => b.addEventListener('click', () => {
    $$('#fence-circle-mode .seg-btn').forEach(x => x.classList.toggle('active', x === b));
    fenceCircleMode = b.dataset.mode;
  }));
  $('#fence-draw-start').addEventListener('click', () => {
    const name = $('#fence-name').value.trim();
    if (!name) return toast('请输入围栏名称', 'warn');
    const card = document.querySelector('.fence-type-card.active');
    const type = card ? card.dataset.type : 'polygon';
    if (type === 'polygon' && $('#fence-draw-mode').value === 'pick') {
      const fid = $('#fence-constraint').value;
      if (!fid) return toast('选点绘制需要先有旧围栏作为约束', 'warn');
      closeModal('modal-fence');
      startFencePointPick(name, fid);
      return;
    }
    if (type === 'circle' && fenceCircleMode === 'input') {
      const radius = parseFloat($('#fence-radius').value);
      if (!(radius >= 10)) return toast('请输入有效半径（≥10 米）', 'warn');
      closeModal('modal-fence');
      startCenterPick(name, Math.round(radius));
      return;
    }
    closeModal('modal-fence');
    startFenceDraw(type, name);
  });
  $('#map-draw-done').addEventListener('click', finishFencePointPick);
  $('#map-draw-cancel').addEventListener('click', () => {
    if (pickFenceHandler) {
      if (amapMap) amapMap.off('click', pickFenceHandler);
      pickFenceHandler = null;
      pickedFencePoints = [];
      hideDrawBanner();
      if (!fencesInteractive) setFencesInteractive(true); // 恢复旧围栏点击
      updateMapStatus('已取消选点绘制');
      return;
    }
    if (centerPickHandler) {
      if (amapMap) amapMap.off('click', centerPickHandler);
      centerPickHandler = null;
      hideDrawBanner();
      if (!fencesInteractive) setFencesInteractive(true); // 恢复旧围栏点击
      updateMapStatus('已取消圆心选择');
      return;
    }
    closeMouseTool();
    updateMapStatus('已取消围栏绘制');
  });
  $$('#map-side-tabs .seg-btn').forEach(b => b.addEventListener('click', () => {
    $$('#map-side-tabs .seg-btn').forEach(x => x.classList.toggle('active', x === b));
    const tab = b.dataset.tab;
    $('#map-results').classList.toggle('hidden', tab !== 'results');
    $('#map-side-hint').classList.toggle('hidden', tab !== 'results');
    $('#map-fences').classList.toggle('hidden', tab !== 'fences');
  }));
  $('#fence-list').addEventListener('click', e => {
    const btn = e.target.closest('[data-act]');
    const item = e.target.closest('.fence-item');
    if (!btn || !item) return;
    const f = fences.find(x => x.id === item.dataset.id);
    if (!f) return;
    if (btn.dataset.act === 'locate') zoomToFence(f);
    else if (btn.dataset.act === 'rename') {
      const name = prompt('围栏新名称：', f.name);
      if (name && name.trim()) {
        f.name = name.trim();
        f.updatedAt = Date.now();
        save(LS.fences, fences);
        renderFences();
        toast('围栏已改名');
      }
    } else if (btn.dataset.act === 'redraw') {
      editingFenceId = f.id;
      closeModal('modal-fence');
      startFenceDraw(f.type, f.name);
    } else if (btn.dataset.act === 'del') {
      if (confirm(`删除电子围栏「${f.name}」？`)) {
        fences = fences.filter(x => x.id !== f.id);
        save(LS.fences, fences);
        renderFences();
        toast('围栏已删除');
      }
    }
  });

  // 测距与路径规划
  $('#btn-map-ruler').addEventListener('click', toggleRanging);
  $('#btn-map-route').addEventListener('click', () => {
    $('#route-origin').value = '';
    $('#route-dest').value = '';
    $('#route-mode').value = 'driving';
    routeOriginSel = null;
    routeDestSel = null;
    renderRoutePicked('origin');
    renderRoutePicked('dest');
    $('#route-origin-list').innerHTML = '';
    $('#route-dest-list').innerHTML = '';
    openRouteModal();
    $('#route-origin').focus();
  });
  $('#route-origin-search').addEventListener('click', () => searchRoutePoint('origin'));
  $('#route-dest-search').addEventListener('click', () => searchRoutePoint('dest'));
  $('#route-origin').addEventListener('keydown', e => { if (e.key === 'Enter') searchRoutePoint('origin'); });
  $('#route-dest').addEventListener('keydown', e => { if (e.key === 'Enter') searchRoutePoint('dest'); });
  $('#map-route-cancel').addEventListener('click', cancelRoutePick);
  $$('.route-pick-list').forEach(el => el.addEventListener('click', e => {
    const it = e.target.closest('.route-pick-item');
    if (!it) return;
    selectRoutePoint(it.dataset.target, {
      lng: +it.dataset.lng, lat: +it.dataset.lat,
      name: it.dataset.name, address: it.dataset.addr,
    });
  }));
  $$('.route-picked').forEach(el => el.addEventListener('click', e => {
    const btn = e.target.closest('[data-clear]');
    if (!btn) return;
    if (btn.dataset.clear === 'origin') routeOriginSel = null;
    else routeDestSel = null;
    renderRoutePicked(btn.dataset.clear);
  }));
  $('#route-plan-start').addEventListener('click', () => {
    closeModal('modal-route');
    planRoute();
  });

  // 智能体
  $('#btn-ag-save').addEventListener('click', () => {
    agentCfg = {
      apiKey: $('#ag-key').value.trim(),
      baseUrl: $('#ag-base').value.trim() || 'https://api.deepseek.com',
      model: $('#ag-model').value,
      voiceFix: $('#ag-voicefix').checked,
    };
    save(LS.agent, agentCfg);
    toast('配置已保存');
  });
  $('#btn-chat-send').addEventListener('click', () => sendChat($('#chat-input').value));
  $('#btn-voice').addEventListener('click', toggleVoice);

  // 语音快捷键：Alt+V 切换；智能体页按住空格说话，松开发送
  let holdVoice = false;
  const anyModalOpen = () => !!document.querySelector('.modal:not(.hidden)');
  document.addEventListener('keydown', e => {
    if (e.altKey && !e.ctrlKey && !e.shiftKey && e.code === 'KeyV') {
      e.preventDefault();
      if ($('#page-agent').classList.contains('hidden')) switchPage('agent');
      toggleVoice();
      return;
    }
    const onAgent = !$('#page-agent').classList.contains('hidden');
    const typing = document.activeElement === $('#chat-input');
    if (e.code === 'Space' && !e.repeat && onAgent && !typing && !anyModalOpen()) {
      e.preventDefault();
      holdVoice = true;
      if (!recognizing && speechSupported()) toggleVoice();
    }
  });
  document.addEventListener('keyup', e => {
    if (e.code === 'Space' && holdVoice) {
      holdVoice = false;
      if (recognizing) stopVoice();
    }
  });
  $('#chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { sendChat($('#chat-input').value); }
  });
  $$('.qchip').forEach(c => c.addEventListener('click', () => sendChat(c.dataset.q)));
  // 聊天内「打开网站」兜底按钮（真实用户手势，必能打开）
  $('#chat-msgs').addEventListener('click', e => {
    const btn = e.target.closest('.open-fallback');
    if (btn && btn.dataset.url) window.open(btn.dataset.url, '_blank', 'noopener');
  });
  // 对话会话管理
  $('#btn-new-chat').addEventListener('click', newChat);
  $('#sess-list').addEventListener('click', e => {
    const item = e.target.closest('.sess-item');
    if (!item) return;
    if (e.target.closest('.sess-del')) {
      const s = sessions.find(x => x.id === item.dataset.id);
      if (s && confirm(`删除对话「${s.title}」？`)) {
        sessions = sessions.filter(x => x.id !== s.id);
        save(LS.sessions, sessions);
        if (currentSid === s.id) newChat();
        else renderSessions();
      }
      return;
    }
    switchSession(item.dataset.id);
  });
}

/* ==================== 渲染总入口 ==================== */
function renderAll() {
  ensureViewWeek();
  renderWeekBadge();
  renderWeekNav();
  renderSchedule();
  renderToday();
  renderBookmarks();
  renderTasks();
  renderGantt();
  renderUsage();
  updateRemindBadge();
  renderReminders();
  updateBanner();
}

/* ==================== 初始化 ==================== */
document.addEventListener('DOMContentLoaded', () => {
  // 回填设置
  $('#semester-start').value = settings.semesterStart;
  $('#max-sec').value = settings.maxSection;
  $('#ag-key').value = agentCfg.apiKey;
  $('#ag-base').value = agentCfg.baseUrl;
  $('#ag-model').value = agentCfg.model;
  $('#ag-voicefix').checked = agentCfg.voiceFix !== false;
  $('#gt-zoom').value = settings.ganttZoom || 16;

  bindAll();
  migrateUsage();      // 旧统计数据结构迁移
  migratePrices();     // 旧全局单价结构迁移为每模型单价
  migrateAgentModel(); // 已下线模型迁移（chat/reasoner → v4-flash）并清理其单价条目
  renderAll();
  // 任务提醒循环：启动时检查一次，之后每 30 秒检查
  checkTaskReminders();
  setInterval(checkTaskReminders, 30000);
  // 恢复上次的对话会话（若有保存）
  const sid = load(LS.sessCurrent, '');
  if (sid && sessions.some(s => s.id === sid)) switchSession(sid);
  else renderSessions();
});
