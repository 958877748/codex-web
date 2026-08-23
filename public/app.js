(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const state = {
    sessions: [],
    currentId: null,
    detail: null,
    lastSeq: -1,
    running: false,
    runningSince: null,
    projects: [],
    sessionFilter: '',
    followLatest: true,
    restoredSession: false,
    connection: 'connecting',
    eventKeys: new Set(),
    renderContext: null,
  };

  const el = {
    app: $('app'),
    sidebar: $('sidebar'),
    scrim: $('scrim'),
    closeSidebar: $('closeSidebar'),
    menuBtn: $('menuBtn'),
    newSessionBtn: $('newSessionBtn'),
    emptyNewBtn: null,
    sessionSearch: $('sessionSearch'),
    sessionCount: $('sessionCount'),
    sessionList: $('sessionList'),
    chatTitle: $('chatTitle'),
    chatSub: $('chatSub'),
    connectionPill: $('connectionPill'),
    statusPill: $('statusPill'),
    stopBtn: $('stopBtn'),
    chatScroll: $('chatScroll'),
    chat: $('chat'),
    jumpLatest: $('jumpLatest'),
    newPanel: $('newPanel'),
    projectSelect: $('projectSelect'),
    newPrompt: $('newPrompt'),
    cancelNew: $('cancelNew'),
    createSession: $('createSession'),
    promptInput: $('promptInput'),
    sendBtn: $('sendBtn'),
    copySessionIdBtn: $('copySessionIdBtn'),
    toast: $('toast'),
  };

  // ---------- helpers ----------

  let webToken = '';
  try {
    const queryToken = new URLSearchParams(window.location.search).get('token');
    webToken = queryToken || sessionStorage.getItem('codex-web-token') || '';
    if (queryToken) {
      sessionStorage.setItem('codex-web-token', queryToken);
      const cleanUrl = window.location.pathname + window.location.hash;
      window.history.replaceState({}, document.title, cleanUrl);
    }
  } catch {}

  function toast(msg, isError) {
    el.toast.textContent = msg;
    el.toast.classList.toggle('error', !!isError);
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.toast.hidden = true;
    }, 3500);
  }

  function setConnection(status) {
    state.connection = status;
    el.app.classList.remove('connecting', 'offline', 'online');
    el.app.classList.add(status === 'online' ? 'online' : status === 'offline' ? 'offline' : 'connecting');
    el.connectionPill.className = 'connection-pill ' + status;
    el.connectionPill.textContent = status === 'online' ? '已连接' : status === 'offline' ? '已断开' : '重连中';
  }

  function isNearLatest() {
    const node = el.chatScroll;
    return node.scrollHeight - node.scrollTop - node.clientHeight < 72;
  }

  function updateLatestButton() {
    state.followLatest = isNearLatest();
    el.jumpLatest.hidden = state.followLatest;
  }

  function scrollLatest(force) {
    if (force || state.followLatest) {
      el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
    }
    updateLatestButton();
  }

  function eventKey(ev) {
    if (!ev) return '';
    if (ev.seq != null) return 'seq:' + ev.seq;
    const p = ev.payload || {};
    const id = p.callId || p.turnId || p.message || p.state || '';
    return [ev.kind, ev.ts || '', id].join(':');
  }

  async function api(pathname, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (webToken) headers['X-Codex-Token'] = webToken;
    const res = await fetch(pathname, {
      method: opts.method || 'GET',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  function relTime(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    const diff = Date.now() - t;
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + '分钟前';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + '小时前';
    const d = new Date(iso);
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function shellInline(text) {
    let out = esc(text);
    out = out.replace(/(^|\s)(--?[\w][\w-]*)/g, '$1<span class="flag">$2</span>');
    out = out.replace(/(&quot;[^&\n]*?&quot;|'[^'\n]*')/g, '<span class="string">$1</span>');
    return out;
  }

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + '\n… (已截断)' : s;
  }

  function inlineMarkdown(text) {
    let out = esc(text);
    out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    out = out.replace(/_([^_\n]+)_/g, '<em>$1</em>');
    out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    return out;
  }

  function markdown(text) {
    const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let paragraph = [];
    let list = null;
    let code = null;
    const flushParagraph = () => {
      if (paragraph.length) {
        out.push('<p>' + paragraph.map(inlineMarkdown).join('<br>') + '</p>');
        paragraph = [];
      }
    };
    const closeList = () => {
      if (list) {
        out.push('</' + list + '>');
        list = null;
      }
    };
    for (const line of lines) {
      const fence = line.match(/^\s*```\s*([\w+-]*)\s*$/);
      if (fence) {
        flushParagraph();
        closeList();
        if (code) {
          out.push('</code></pre>');
          code = null;
        } else {
          code = fence[1] || '';
          out.push('<pre><code' + (code ? ' class="language-' + esc(code) + '"' : '') + '>');
        }
        continue;
      }
      if (code) {
        out.push(esc(line) + '\n');
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        closeList();
        continue;
      }
      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flushParagraph();
        closeList();
        const level = heading[1].length;
        out.push('<h' + level + '>' + inlineMarkdown(heading[2]) + '</h' + level + '>');
        continue;
      }
      const item = line.match(/^\s*([-*+] |\d+[.] )(.+)$/);
      if (item) {
        flushParagraph();
        const ordered = /^\d/.test(item[1]);
        const nextList = ordered ? 'ol' : 'ul';
        if (list !== nextList) {
          closeList();
          list = nextList;
          out.push('<' + list + '>');
        }
        out.push('<li>' + inlineMarkdown(item[2]) + '</li>');
        continue;
      }
      if (/^\s*>/.test(line)) {
        flushParagraph();
        closeList();
        out.push('<blockquote>' + inlineMarkdown(line.replace(/^\s*>\s?/, '')) + '</blockquote>');
        continue;
      }
      closeList();
      paragraph.push(line);
    }
    if (code) out.push('</code></pre>');
    flushParagraph();
    closeList();
    return out.join('');
  }

  // ---------- SSE ----------

  let sse = null;
  let lastLiveEventAt = 0;

  function openEventStream() {
    if (sse) sse.close();
    setConnection('connecting');
    const streamUrl = webToken ? '/api/events?token=' + encodeURIComponent(webToken) : '/api/events';
    sse = new EventSource(streamUrl);
    sse.onopen = () => {
      setConnection('online');
      // Fires on initial connect and on every automatic reconnect.
      // Sync state so a page restored from background never shows stale data.
      refreshNow();
    };
    sse.onmessage = (e) => {
      lastLiveEventAt = Date.now();
      try {
        handleLive(JSON.parse(e.data));
      } catch {}
    };
    sse.onerror = () => {
      setConnection('offline');
      scheduleSessionRefresh();
    };
  }

  function handleLive(msg) {
    lastLiveEventAt = Date.now();
    const ev = msg.event;
    if (!ev) return;
    if (ev.kind === 'hello') {
      loadSessions();
      return;
    }
    if (ev.kind === 'turn_context') {
      if (msg.sessionId === state.currentId && state.detail && ev.payload.model) {
        state.detail.model = ev.payload.model;
        el.chatSub.textContent = [state.detail.cwd, state.detail.model].filter(Boolean).join(' · ');
      }
    }
    if (ev.kind === 'run_state') {
      const running = ev.payload.state === 'running';
      if (msg.sessionId === state.currentId) setRunning(running, ev.ts);
      scheduleSessionRefresh();
      return;
    }
    if (msg.sessionId === state.currentId && state.detail) {
      appendEvent(ev);
    } else {
      scheduleSessionRefresh();
    }
  }

  // ---------- sessions ----------

  let refreshTimer = null;
  function scheduleSessionRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      loadSessions();
    }, 800);
  }

  async function loadSessions() {
    try {
      const data = await api('/api/sessions');
      state.sessions = data.sessions || [];
      renderSessionList();
      if (!state.currentId && !state.restoredSession) {
        state.restoredSession = true;
        let saved = '';
        try { saved = localStorage.getItem('codex-current-session') || ''; } catch {}
        if (saved && state.sessions.some((s) => s.id === saved)) openSession(saved);
      }
    } catch (e) {
      if (!state.sessions.length) {
        el.sessionList.innerHTML = '<li class="session-empty">无法加载会话列表</li>';
      }
      if (state.connection === 'online') setConnection('offline');
    }
  }

  let refreshLock = false;
  async function refreshNow() {
    if (refreshLock) return;
    refreshLock = true;
    try {
      await loadSessions();
      if (state.currentId && state.detail) {
        const keepPosition = el.chatScroll.scrollTop;
        const shouldFollow = isNearLatest();
        try {
          const detail = await api('/api/sessions/' + state.currentId);
          state.detail = detail;
          let maxSeq = -1;
          for (const e of detail.events) {
            if (e.seq != null && e.seq > maxSeq) maxSeq = e.seq;
          }
          state.lastSeq = maxSeq;
          setRunning(detail.status === 'running');
          el.chatTitle.textContent = titleFromDetail(detail);
          el.chatSub.textContent = [detail.cwd, detail.model].filter(Boolean).join(' · ');
          renderChat({ preservePosition: true, keepPosition, shouldFollow });
        } catch {}
      }
    } finally {
      refreshLock = false;
    }
  }

  function renderSessionList() {
    el.sessionList.innerHTML = '';
    const query = state.sessionFilter.trim().toLowerCase();
    const sessions = query
      ? state.sessions.filter((s) => [s.title, s.cwd, s.model].filter(Boolean).join(' ').toLowerCase().includes(query))
      : state.sessions;
    el.sessionCount.textContent = query ? `${sessions.length}/${state.sessions.length}` : String(state.sessions.length);
    if (!sessions.length) {
      const empty = document.createElement('li');
      empty.className = 'session-empty';
      empty.textContent = query ? '没有匹配的会话' : '还没有会话';
      el.sessionList.appendChild(empty);
      return;
    }
    let lastBucket = '';
    for (const s of sessions) {
      const bucket = sessionBucket(s.updatedAt);
      if (bucket !== lastBucket) {
        const heading = document.createElement('li');
        heading.className = 'session-group-label';
        heading.textContent = bucket;
        el.sessionList.appendChild(heading);
        lastBucket = bucket;
      }
      const li = document.createElement('li');
      li.className = 'session-item' + (s.id === state.currentId ? ' active' : '');
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.innerHTML =
        '<div class="session-title">' + esc(s.title) + '</div>' +
        '<div class="session-meta">' +
        '<span class="dot ' + (s.status === 'running' ? 'running' : '') + '"></span>' +
        '<span class="cwd">' + esc(s.cwd || '') + '</span>' +
        '<span>' + relTime(s.updatedAt) + '</span>' +
        '</div>';
      li.addEventListener('click', () => openSession(s.id));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openSession(s.id);
        }
      });
      el.sessionList.appendChild(li);
    }
  }

  function sessionBucket(iso) {
    const date = iso ? new Date(iso) : new Date(0);
    const now = new Date();
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const time = date.getTime();
    if (time >= startToday) return '今天';
    if (time >= startToday - 24 * 60 * 60 * 1000) return '昨天';
    return '更早';
  }

  function openSidebar(open) {
    el.sidebar.classList.toggle('open', open);
    el.scrim.hidden = !open;
  }

  el.menuBtn.addEventListener('click', () => openSidebar(true));
  el.closeSidebar.addEventListener('click', () => openSidebar(false));
  el.scrim.addEventListener('click', () => openSidebar(false));

  async function openSession(id) {
    state.currentId = id;
    try { localStorage.setItem('codex-current-session', id); } catch {}
    state.detail = null;
    state.lastSeq = -1;
    state.eventKeys = new Set();
    state.renderContext = null;
    el.promptInput.disabled = true;
    el.sendBtn.disabled = true;
    el.copySessionIdBtn.hidden = !id;
    openSidebar(false);
    el.newPanel.hidden = true;
    el.chat.innerHTML = '<div class="empty-state"><h2>加载中…</h2></div>';
    try {
      const detail = await api('/api/sessions/' + id);
      state.detail = detail;
      let maxSeq = -1;
      for (const e of detail.events) {
        if (e.seq != null && e.seq > maxSeq) maxSeq = e.seq;
      }
      state.lastSeq = maxSeq;
      setRunning(detail.status === 'running');
      el.chatTitle.textContent = titleFromDetail(detail);
      el.chatSub.textContent = [detail.cwd, detail.model].filter(Boolean).join(' · ');
      renderChat({ forceBottom: true });
      scheduleSessionRefresh();
    } catch (e) {
      toast('加载会话失败:' + e.message, true);
      state.currentId = null;
      try { localStorage.removeItem('codex-current-session'); } catch {}
      renderChat();
      el.copySessionIdBtn.hidden = true;
    }
  }

  function titleFromDetail(detail) {
    for (const ev of detail.events) {
      if (ev.kind !== 'user_message') continue;
      const t = (ev.payload.message || '').trim();
      if (t && !t.startsWith('<')) return t.split('\n')[0].slice(0, 40);
    }
    return (detail.cwd || '').split(/[\\/]/).pop() || '会话';
  }

  // ---------- chat ----------

  function setRunning(running, ts) {
    state.running = running;
    state.runningSince = running ? (ts ? new Date(ts).getTime() : Date.now()) : null;
    updateStatusPill();
    el.stopBtn.hidden = !running;
    el.promptInput.disabled = running || !state.currentId;
    el.sendBtn.disabled = running || !state.currentId || !el.promptInput.value.trim();
    if (running && state.detail && isNearLatest()) scrollLatest(true);
  }

  let pillTimer = null;
  function updateStatusPill() {
    const pill = el.statusPill;
    pill.classList.remove('running', 'stopped', 'idle');
    if (state.running) {
      pill.classList.add('running');
      const update = () => {
        const s = state.runningSince ? Math.floor((Date.now() - state.runningSince) / 1000) : 0;
        pill.textContent = '运行中 ' + s + 's';
      };
      update();
      clearInterval(pillTimer);
      pillTimer = setInterval(update, 1000);
    } else {
      clearInterval(pillTimer);
      pill.classList.add('idle');
      pill.textContent = '空闲';
    }
  }

  function emptyState() {
    const div = document.createElement('div');
    div.className = 'empty-state';
    const heading = document.createElement('h2');
    heading.textContent = state.currentId ? '这个会话还没有消息' : '还没有打开会话';
    div.appendChild(heading);
    const detail = document.createElement('p');
    detail.textContent = state.currentId ? '发送一条消息开始工作' : '从左侧选择一个会话，或新建一个任务';
    div.appendChild(detail);
    if (!state.currentId) {
      const button = document.createElement('button');
      button.className = 'primary-btn empty-action';
      button.type = 'button';
      button.textContent = '+ 新建会话';
      button.addEventListener('click', () => openNewPanel());
      el.emptyNewBtn = button;
      div.appendChild(button);
    }
    return div;
  }

  function closeToolGroup(context) {
    if (context) context.toolGroup = null;
  }

  function createToolGroup(target, context) {
    const root = document.createElement('section');
    root.className = 'tool-group';
    root.dataset.groupKey = 'group-' + (context.groupIndex++);

    const summary = document.createElement('button');
    summary.className = 'tool-group-summary';
    summary.type = 'button';
    summary.setAttribute('aria-expanded', 'false');
    summary.innerHTML = '<span class="tool-group-dot">●</span><span class="tool-group-label">Ran</span><span class="tool-group-count">0 commands</span><span class="tool-group-hint">展开执行记录</span>';
    const body = document.createElement('div');
    body.className = 'tool-group-body';
    body.hidden = true;
    summary.addEventListener('click', () => {
      const open = !root.classList.contains('open');
      root.classList.toggle('open', open);
      body.hidden = !open;
      summary.setAttribute('aria-expanded', String(open));
      const hint = summary.querySelector('.tool-group-hint');
      if (hint) hint.textContent = open ? '收起执行记录' : '展开执行记录';
    });
    root.appendChild(summary);
    root.appendChild(body);
    target.appendChild(root);

    const group = {
      root,
      body,
      summary,
      cards: [],
      add(card) {
        this.cards.push(card);
        card.group = this;
        this.body.appendChild(card.el);
        context.toolMap.set(card.callId, card);
        this.update();
      },
      update() {
        const failed = this.cards.some((card) => card.el.classList.contains('fail'));
        const running = this.cards.some((card) => card.el.classList.contains('run'));
        root.classList.toggle('failed', failed);
        root.classList.toggle('running', !failed && running);
        const label = this.summary.querySelector('.tool-group-label');
        const count = this.summary.querySelector('.tool-group-count');
        if (label) label.textContent = running && !failed ? 'Run' : 'Ran';
        if (count) count.textContent = this.cards.length + (this.cards.length === 1 ? ' command' : ' commands');
      },
    };
    context.toolGroup = group;
    return group;
  }

  function appendTranscriptEvent(ev, target, context) {
    if (!ev || !context) return;
    if (ev.kind === 'user_message') {
      closeToolGroup(context);
      target.appendChild(bubble('user', ev.payload.message));
    } else if (ev.kind === 'agent_message') {
      closeToolGroup(context);
      target.appendChild(bubble('assistant', ev.payload.message));
    } else if (ev.kind === 'tool_call') {
      const group = context.toolGroup || createToolGroup(target, context);
      const card = toolCard(ev.payload);
      group.add(card);
      if (ev.payload.output) card.finish(ev.payload);
      group.update();
    } else if (ev.kind === 'tool_output') {
      const card = context.toolMap.get(ev.payload.callId);
      if (card) {
        card.finish(ev.payload);
        if (context.toolGroup) context.toolGroup.update();
      }
    } else if (ev.kind === 'token_usage') {
      context.pendingToken = ev.payload.info;
    } else if (ev.kind === 'task_started') {
      closeToolGroup(context);
      target.appendChild(chip('开始处理', 'running'));
    } else if (ev.kind === 'task_complete') {
      closeToolGroup(context);
      if (ev.payload.error && ev.payload.error.message) {
        let message = '';
        const rawError = String(ev.payload.error.message);
        try {
          const parsed = JSON.parse(rawError);
          message = parsed?.error?.message || parsed?.message || rawError;
        } catch {
          message = rawError;
        }
        target.appendChild(bubble('assistant', '**⚠️ 任务异常结束**\n\n```text\n' + message + '\n```'));
      } else if (!ev.payload.lastAgentMessage) {
        const parts = ['完成（无最终回复）'];
        if (ev.payload.durationMs != null) parts.push('用时 ' + Math.round(ev.payload.durationMs / 1000) + 's');
        target.appendChild(chip(parts.join(' · '), 'failed'));
      } else {
        const parts = ['完成'];
        if (ev.payload.durationMs != null) parts.push('用时 ' + Math.round(ev.payload.durationMs / 1000) + 's');
        if (context.pendingToken && context.pendingToken.total_token_usage) {
          const u = context.pendingToken.total_token_usage;
          parts.push('输入 ' + u.input_tokens + ' · 输出 ' + u.output_tokens);
        }
        target.appendChild(chip(parts.join(' · '), ''));
      }
      context.pendingToken = null;
    } else if (ev.kind === 'file_change') {
      closeToolGroup(context);
      const count = ev.payload.fileCount || 0;
      target.appendChild(chip((ev.payload.success ? '已应用' : '应用失败') + (count ? ' · ' + count + ' 个文件' : ''), ev.payload.success ? '' : 'failed'));
    }
  }

  function renderChat(options) {
    const opts = options || {};
    const events = state.detail ? state.detail.events : [];
    const oldPosition = opts.keepPosition == null ? el.chatScroll.scrollTop : opts.keepPosition;
    const shouldFollow = opts.forceBottom || opts.shouldFollow || (!opts.preservePosition && state.followLatest);
    el.chat.innerHTML = '';
    state.eventKeys = new Set();
    const context = { toolGroup: null, toolMap: new Map(), pendingToken: null, groupIndex: 0 };
    state.renderContext = context;
    if (!events.length) {
      el.chat.appendChild(emptyState());
    } else {
      const frag = document.createDocumentFragment();
      for (const ev of events) {
        const key = eventKey(ev);
        if (key) state.eventKeys.add(key);
        appendTranscriptEvent(ev, frag, context);
      }
      el.chat.appendChild(frag);
      closeToolGroup(context);
    }
    requestAnimationFrame(() => {
      if (shouldFollow) el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
      else el.chatScroll.scrollTop = oldPosition;
      updateLatestButton();
    });
  }

  function bubble(role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    if (role === 'assistant') div.innerHTML = markdown(text);
    else div.textContent = text;
    return div;
  }

  function chip(text, cls) {
    const div = document.createElement('div');
    div.className = 'chip' + (cls ? ' ' + cls : '');
    div.textContent = text;
    return div;
  }

  function toolCard(payload) {
    const el = document.createElement('div');
    el.className = 'tool';
    if (payload.callId) el.dataset.callId = payload.callId;
    const statusCls = payload.status === 'running' ? 'run' : payload.status === 'failed' ? 'fail' : 'ok';
    el.classList.add(statusCls);
    const statusText = payload.status === 'running' ? '运行中' : payload.status === 'failed' ? '失败' : '完成';
    const inputText = payload.input == null
      ? ''
      : typeof payload.input === 'string'
        ? payload.input
        : JSON.stringify(payload.input) || String(payload.input);
    let rawCommand = inputText;
    // Function-call events often persist arguments as JSON (for example
    // {"cmd":"git status","workdir":"..."}); show the useful command
    // in the collapsed row while keeping the complete payload in the body.
    try {
      const parsed = JSON.parse(rawCommand);
      if (typeof parsed === 'string') rawCommand = parsed;
      if (parsed && typeof parsed === 'object') {
        const candidate = parsed.cmd || parsed.command || parsed.input || parsed.query;
        if (typeof candidate === 'string') rawCommand = candidate;
        else if (Array.isArray(candidate)) rawCommand = candidate.join(' ');
      }
    } catch {}
    rawCommand = rawCommand.replace(/\s+/g, ' ').trim();
    const commandLabel = truncate(rawCommand || String(payload.name || 'tool'), 220);
    const commandPrefix = payload.status === 'running' ? 'Run' : 'Ran';
    el.innerHTML =
      '<div class="tool-head">' +
      '<span class="tool-prefix">' + commandPrefix + '</span>' +
      '<span class="tool-name">' + shellInline(commandLabel) + '</span>' +
      '<span class="tool-status ' + statusCls + '">' + statusText + '</span>' +
      '</div>' +
      '<div class="tool-body">' +
      (inputText ? '<div class="label">输入</div><pre></pre>' : '') +
      '<div class="label">输出</div><pre class="out"></pre>' +
      '</div>';
    const head = el.querySelector('.tool-head');
    const inputPre = el.querySelector('pre');
    const outPre = el.querySelector('pre.out');
    if (inputPre) inputPre.textContent = truncate(inputText, 4000);
    outPre.textContent = payload.output || '(等待输出…)';
    head.tabIndex = 0;
    head.setAttribute('role', 'button');
    head.setAttribute('aria-expanded', 'false');
    const toggle = () => {
      const open = !el.classList.contains('open');
      el.classList.toggle('open', open);
      head.setAttribute('aria-expanded', String(open));
    };
    head.addEventListener('click', toggle);
    head.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
    let handle;
    const finish = (outPayload) => {
      const status = outPayload.exitCode != null
        ? outPayload.exitCode === 0 ? 'ok' : 'fail'
        : outPayload.status === 'failed' ? 'fail' : 'ok';
      const text = status === 'fail'
        ? outPayload.exitCode != null ? '失败 (exit ' + outPayload.exitCode + ')' : '失败'
        : outPayload.exitCode === 0 ? '成功' : '完成';
      const st = el.querySelector('.tool-status');
      st.className = 'tool-status ' + status;
      el.classList.remove('run', 'ok', 'fail');
      el.classList.add(status);
      st.textContent = text;
      outPre.textContent = outPayload.output || '(无输出)';
      if (handle && handle.group) handle.group.update();
    };
    handle = { el, finish, callId: payload.callId, group: null };
    return handle;
  }

  function appendEvent(ev) {
    if (!state.detail) return;
    if (ev.seq != null && ev.seq <= state.lastSeq) return;
    const key = eventKey(ev);
    if (key && state.eventKeys.has(key)) return;

    // Rollouts often persist the same user/agent message as both a response
    // item and an item_completed event. Match the adjacent dedupe behavior
    // used by sessionDetail so live updates do not briefly show duplicates.
    const events = state.detail.events;
    const previousMessage = events.length ? events[events.length - 1] : null;
    if (
      (ev.kind === 'user_message' || ev.kind === 'agent_message') &&
      previousMessage &&
      previousMessage.kind === ev.kind &&
      previousMessage.payload &&
      previousMessage.payload.message === ev.payload.message
    ) {
      if (ev.seq != null) state.lastSeq = ev.seq;
      if (key) state.eventKeys.add(key);
      return;
    }

    const shouldFollow = isNearLatest();
    if (ev.seq != null) state.lastSeq = ev.seq;
    if (key) state.eventKeys.add(key);
    state.detail.events.push(ev);
    if (!state.renderContext) {
      renderChat({ forceBottom: shouldFollow });
      return;
    }
    appendTranscriptEvent(ev, el.chat, state.renderContext);
    if (shouldFollow) scrollLatest(true);
    else updateLatestButton();
  }

  // ---------- new session ----------

  function updateCreateButton() {
    const hasProject = !!el.projectSelect.value;
    const hasPrompt = !!el.newPrompt.value.trim();
    el.createSession.disabled = !hasProject || !hasPrompt;
  }

  function openNewPanel() {
    if (!state.projects.length) loadProjects();
    el.newPanel.hidden = false;
    el.newPrompt.value = '';
    updateCreateButton();
    el.newPrompt.focus();
  }

  async function loadProjects() {
    try {
      const data = await api('/api/projects');
      state.projects = data.projects || [];
      el.projectSelect.innerHTML = '';
      if (!state.projects.length) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '没有找到已信任的项目目录';
        el.projectSelect.appendChild(opt);
      }
      for (const p of state.projects) {
        const opt = document.createElement('option');
        opt.value = p;
        opt.textContent = p;
        el.projectSelect.appendChild(opt);
      }
      updateCreateButton();
    } catch (e) {
      el.projectSelect.innerHTML = '<option value="">项目列表加载失败</option>';
      updateCreateButton();
      if (!el.newPanel.hidden) toast('项目列表加载失败', true);
    }
  }

  el.newSessionBtn.addEventListener('click', openNewPanel);
  el.sessionSearch.addEventListener('input', () => {
    state.sessionFilter = el.sessionSearch.value;
    renderSessionList();
  });
  el.newPrompt.addEventListener('input', updateCreateButton);
  el.projectSelect.addEventListener('change', updateCreateButton);
  el.cancelNew.addEventListener('click', () => {
    el.newPanel.hidden = true;
  });

  el.createSession.addEventListener('click', async () => {
    const cwd = el.projectSelect.value;
    const prompt = el.newPrompt.value.trim();
    if (!cwd || !prompt) return;
    el.createSession.disabled = true;
    try {
      const data = await api('/api/sessions', { method: 'POST', body: { cwd, prompt } });
      el.newPanel.hidden = true;
      el.promptInput.value = '';
      loadSessions();
      await openSession(data.id);
    } catch (e) {
      toast('创建失败:' + e.message, true);
    } finally {
      el.createSession.disabled = false;
      updateCreateButton();
    }
  });

  // ---------- composer ----------

  el.promptInput.addEventListener('input', () => {
    el.promptInput.style.height = 'auto';
    el.promptInput.style.height = Math.min(el.promptInput.scrollHeight, 120) + 'px';
    el.sendBtn.disabled = state.running || !state.currentId || !el.promptInput.value.trim();
  });

  el.promptInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  el.sendBtn.addEventListener('click', sendMessage);

  async function sendMessage() {
    const text = el.promptInput.value.trim();
    if (!text || state.running || !state.currentId) return;
    const sessionId = state.currentId;
    el.promptInput.value = '';
    el.promptInput.style.height = 'auto';
    el.sendBtn.disabled = true;
    try {
      await api('/api/sessions/' + sessionId + '/messages', { method: 'POST', body: { prompt: text } });
      setRunning(true);
      scheduleSessionRefresh();
    } catch (e) {
      toast('发送失败:' + e.message, true);
      if (state.currentId === sessionId && !el.promptInput.value) {
        el.promptInput.value = text;
        el.promptInput.dispatchEvent(new Event('input'));
      }
      el.sendBtn.disabled = false;
    }
  }

  async function copySessionId() {
    const id = state.currentId;
    if (!id) return;
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(id);
      else {
        const area = document.createElement('textarea');
        area.value = id;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        if (!ok) throw new Error('copy failed');
      }
      toast('会话 ID 已复制');
    } catch (e) {
      toast('复制失败:' + e.message, true);
    }
  }

  el.copySessionIdBtn.addEventListener('click', copySessionId);
  el.stopBtn.addEventListener('click', async () => {
    if (!state.currentId) return;
    if (!window.confirm('确定停止当前任务吗？未完成的中间结果可能丢失。')) return;
    try {
      await api('/api/sessions/' + state.currentId + '/stop', { method: 'POST', body: {} });
      toast('已发送停止请求');
    } catch (e) {
      toast('停止失败:' + e.message, true);
    }
  });

  el.chatScroll.addEventListener('scroll', updateLatestButton, { passive: true });
  el.jumpLatest.addEventListener('click', () => scrollLatest(true));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.newPanel.hidden) {
      el.newPanel.hidden = true;
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (window.matchMedia('(min-width: 900px)').matches) el.sessionSearch.focus();
      else openSidebar(true);
    }
  });

  // ---------- init ----------

  (function init() {
    setConnection('connecting');
    renderChat();
    openEventStream();
    loadSessions();
    loadProjects();
    updateLatestButton();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        openEventStream(); // rebuild the stream in case the browser froze it
        refreshNow();
      }
    });
    window.addEventListener('pageshow', refreshNow);
    window.addEventListener('online', refreshNow);

    // Fallback: if the SSE stream goes quiet while a task is running,
    // refetch the current session so progress still shows up.
    setInterval(() => {
      if (state.currentId && state.running && Date.now() - lastLiveEventAt > 8000) {
        refreshNow();
      }
    }, 10000);
  })();
})();
