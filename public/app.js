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
  };

  const el = {
    app: $('app'),
    sidebar: $('sidebar'),
    scrim: $('scrim'),
    closeSidebar: $('closeSidebar'),
    menuBtn: $('menuBtn'),
    newSessionBtn: $('newSessionBtn'),
    sessionList: $('sessionList'),
    chatTitle: $('chatTitle'),
    chatSub: $('chatSub'),
    statusPill: $('statusPill'),
    stopBtn: $('stopBtn'),
    chatScroll: $('chatScroll'),
    chat: $('chat'),
    newPanel: $('newPanel'),
    projectSelect: $('projectSelect'),
    newPrompt: $('newPrompt'),
    cancelNew: $('cancelNew'),
    createSession: $('createSession'),
    promptInput: $('promptInput'),
    sendBtn: $('sendBtn'),
    toast: $('toast'),
  };

  // ---------- helpers ----------

  function toast(msg, isError) {
    el.toast.textContent = msg;
    el.toast.classList.toggle('error', !!isError);
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.toast.hidden = true;
    }, 3500);
  }

  async function api(pathname, options) {
    const opts = options || {};
    const headers = Object.assign({}, opts.headers || {});
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
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

  function truncate(s, n) {
    return s.length > n ? s.slice(0, n) + '\n… (已截断)' : s;
  }

  // ---------- SSE ----------

  let sse = null;
  let lastLiveEventAt = 0;

  function openEventStream() {
    if (sse) sse.close();
    sse = new EventSource('/api/events');
    sse.onopen = () => {
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
    } catch {}
  }

  let refreshLock = false;
  async function refreshNow() {
    if (refreshLock) return;
    refreshLock = true;
    try {
      await loadSessions();
      if (state.currentId && state.detail) {
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
          renderChat();
          el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
        } catch {}
      }
    } finally {
      refreshLock = false;
    }
  }

  function renderSessionList() {
    el.sessionList.innerHTML = '';
    for (const s of state.sessions) {
      const li = document.createElement('li');
      li.className = 'session-item' + (s.id === state.currentId ? ' active' : '');
      li.innerHTML =
        '<div class="session-title">' + esc(s.title) + '</div>' +
        '<div class="session-meta">' +
        '<span class="dot ' + (s.status === 'running' ? 'running' : '') + '"></span>' +
        '<span class="cwd">' + esc(s.cwd || '') + '</span>' +
        '<span>' + relTime(s.updatedAt) + '</span>' +
        '</div>';
      li.addEventListener('click', () => openSession(s.id));
      el.sessionList.appendChild(li);
    }
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
    state.detail = null;
    state.lastSeq = -1;
    el.promptInput.disabled = true;
    el.sendBtn.disabled = true;
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
      renderChat();
      el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
      scheduleSessionRefresh();
    } catch (e) {
      toast('加载会话失败:' + e.message, true);
      state.currentId = null;
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
    if (running && state.detail) {
      el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
    }
  }

  let pillTimer = null;
  function updateStatusPill() {
    const pill = el.statusPill;
    pill.classList.remove('running', 'stopped');
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
      pill.textContent = '空闲';
    }
  }

  function renderChat() {
    const events = state.detail ? state.detail.events : [];
    el.chat.innerHTML = '';
    if (!events.length) {
      el.chat.innerHTML = '<div class="empty-state"><h2>这个会话还没有消息</h2></div>';
      return;
    }
    const toolMap = new Map();
    const frag = document.createDocumentFragment();
    let pendingToken = null;
    let lastUser = null;
    let lastAgent = null;
    for (const ev of events) {
      if (ev.kind === 'user_message') {
        if (lastUser === ev.payload.message) continue;
        lastUser = ev.payload.message;
        frag.appendChild(bubble('user', ev.payload.message));
      } else if (ev.kind === 'agent_message') {
        if (lastAgent === ev.payload.message) continue;
        lastAgent = ev.payload.message;
        frag.appendChild(bubble('assistant', ev.payload.message));
      } else if (ev.kind === 'tool_call') {
        const card = toolCard(ev.payload);
        toolMap.set(ev.payload.callId, card);
        frag.appendChild(card.el);
      } else if (ev.kind === 'tool_output') {
        const card = toolMap.get(ev.payload.callId);
        if (card) card.finish(ev.payload);
      } else if (ev.kind === 'token_usage') {
        pendingToken = ev.payload.info;
      } else if (ev.kind === 'task_started') {
        frag.appendChild(chip('开始处理', 'running'));
      } else if (ev.kind === 'task_complete') {
        const parts = ['完成'];
        if (ev.payload.durationMs != null) parts.push('用时 ' + Math.round(ev.payload.durationMs / 1000) + 's');
        if (pendingToken && pendingToken.total_token_usage) {
          const u = pendingToken.total_token_usage;
          parts.push('输入 ' + u.input_tokens + ' · 输出 ' + u.output_tokens);
        }
        frag.appendChild(chip(parts.join(' · '), ''));
        pendingToken = null;
      }
    }
    el.chat.appendChild(frag);
  }

  function bubble(role, text) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = text;
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
    const statusCls = payload.status === 'running' ? 'run' : 'ok';
    const statusText = payload.status === 'running' ? '运行中' : '完成';
    el.innerHTML =
      '<div class="tool-head">' +
      '<span class="tool-name">' + esc(payload.name) + '</span>' +
      '<span class="tool-status ' + statusCls + '">' + statusText + '</span>' +
      '</div>' +
      '<div class="tool-body">' +
      (payload.input ? '<div class="label">输入</div><pre></pre>' : '') +
      '<div class="label">输出</div><pre class="out"></pre>' +
      '</div>';
    const head = el.querySelector('.tool-head');
    const inputPre = el.querySelector('pre');
    const outPre = el.querySelector('pre.out');
    if (inputPre) inputPre.textContent = truncate(payload.input, 4000);
    outPre.textContent = '(等待输出…)';
    head.addEventListener('click', () => el.classList.toggle('open'));
    const finish = (outPayload) => {
      const status = outPayload.exitCode === 0 ? 'ok' : outPayload.exitCode != null ? 'fail' : 'ok';
      const text = outPayload.exitCode === 0 ? '成功' : outPayload.exitCode != null ? '失败 (exit ' + outPayload.exitCode + ')' : '完成';
      const st = el.querySelector('.tool-status');
      st.className = 'tool-status ' + status;
      st.textContent = text;
      outPre.textContent = outPayload.output || '(无输出)';
    };
    return { el, finish };
  }

  function appendEvent(ev) {
    if (ev.seq != null && ev.seq <= state.lastSeq) return;
    if (ev.seq != null) state.lastSeq = ev.seq;
    state.detail.events.push(ev);
    renderChat();
    el.chatScroll.scrollTop = el.chatScroll.scrollHeight;
  }

  // ---------- new session ----------

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
    } catch {}
  }

  el.newSessionBtn.addEventListener('click', () => {
    if (!state.projects.length) loadProjects();
    el.newPanel.hidden = false;
    el.newPrompt.value = '';
    el.newPrompt.focus();
  });
  el.cancelNew.addEventListener('click', () => {
    el.newPanel.hidden = true;
  });

  el.createSession.addEventListener('click', async () => {
    const cwd = el.projectSelect.value;
    const prompt = el.newPrompt.value.trim();
    if (!cwd || !prompt) {
      toast('请选择项目并输入指令', true);
      return;
    }
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
    el.promptInput.value = '';
    el.promptInput.style.height = 'auto';
    el.sendBtn.disabled = true;
    try {
      await api('/api/sessions/' + state.currentId + '/messages', { method: 'POST', body: { prompt: text } });
      setRunning(true);
      scheduleSessionRefresh();
    } catch (e) {
      toast('发送失败:' + e.message, true);
      el.sendBtn.disabled = false;
    }
  }

  el.stopBtn.addEventListener('click', async () => {
    if (!state.currentId) return;
    try {
      await api('/api/sessions/' + state.currentId + '/stop', { method: 'POST', body: {} });
      toast('已发送停止请求');
    } catch (e) {
      toast('停止失败:' + e.message, true);
    }
  });

  // ---------- init ----------

  (function init() {
    openEventStream();
    loadSessions();
    loadProjects();

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
