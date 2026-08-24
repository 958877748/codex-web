'use strict';

const AppServer = require('./app-server');

class Runner {
  constructor() {
    this.app = new AppServer();
    this.bin = this.app.bin;
    this.sessions = new Map();
    this.onEvent = null;
    this.onState = null;
    this.app.onNotification = (message) => this._handleNotification(message);
  }

  runningList() { return [...this.sessions.values()].filter((s) => s.turnId).map((s) => ({ id: s.id, cwd: s.cwd, startedAt: s.startedAt })); }
  isRunning(id) { const s = this.sessions.get(id); return !!(s && s.turnId); }
  _emit(ev, id) { if (this.onEvent) this.onEvent(ev, id); }
  _setState(id, state) { if (this.onState) this.onState(id, state); }

  _handleNotification(message) {
    const p = message.params || {};
    const id = p.threadId || (p.thread && p.thread.id);
    if (!id) return;
    const state = this.sessions.get(id);
    if (message.method === 'turn/started' && state) {
      state.turnId = p.turn && p.turn.id;
      this._setState(id, 'running');
      this._emit({ seq: null, ts: new Date().toISOString(), kind: 'task_started', payload: { turnId: state.turnId } }, id);
    }
    if (message.method === 'thread/status/changed' && state) {
      const type = p.status && p.status.type;
      if (type === 'idle' || type === 'completed' || type === 'interrupted') {
        state.turnId = null;
        this._setState(id, state.stopRequested ? 'stopped' : 'idle');
        if (state.stopRequested) this.sessions.delete(id);
      }
    }
    if (message.method === 'item/started' && p.item && p.item.type === 'commandExecution') {
      this._emit({ seq: null, ts: new Date().toISOString(), kind: 'tool_call', payload: {
        callId: p.item.id,
        name: 'shell_command',
        input: p.item.command || '',
        output: '',
        status: 'running',
        exitCode: null,
      } }, id);
    } else if (message.method === 'item/commandExecution/outputDelta') {
      this._emit({ seq: null, ts: new Date().toISOString(), kind: 'tool_output', payload: { callId: p.itemId, output: p.delta || '', status: 'completed' } }, id);
    } else if (message.method === 'item/completed') {
      const ev = p.item && p.item.type === 'commandExecution'
        ? { seq: null, ts: new Date().toISOString(), kind: 'tool_output', payload: { callId: p.item.id, output: p.item.aggregatedOutput || '', status: p.item.status === 'failed' ? 'failed' : 'completed', exitCode: p.item.exitCode == null ? null : Number(p.item.exitCode) } }
        : this._normalizeItem(p.item);
      if (ev) this._emit(ev, id);
    } else if (message.method === 'turn/completed') {
      const turn = p.turn || {};
      const last = [...(turn.items || [])].reverse().find((x) => x.type === 'agentMessage');
      this._emit({ seq: null, ts: new Date().toISOString(), kind: 'task_complete', payload: { durationMs: turn.durationMs, error: turn.error || null, lastAgentMessage: last ? last.text || '' : '' } }, id);
    }
  }

  _normalizeItem(item) {
    if (!item) return null;
    if (item.type === 'userMessage') return { seq: null, ts: new Date().toISOString(), kind: 'user_message', payload: { message: this._text(item.content) } };
    if (item.type === 'agentMessage') return { seq: null, ts: new Date().toISOString(), kind: 'agent_message', payload: { message: item.text || '', phase: item.phase || 'final' } };
    if (item.type === 'commandExecution') return { seq: null, ts: new Date().toISOString(), kind: 'tool_call', payload: { callId: item.id, name: 'shell_command', input: item.command || '', output: item.aggregatedOutput || '', status: item.status === 'failed' ? 'failed' : 'completed', exitCode: item.exitCode == null ? null : Number(item.exitCode) } };
    return null;
  }

  _text(content) { return Array.isArray(content) ? content.map((x) => x && x.text || '').join('\n').trim() : ''; }

  _events(thread) {
    const events = [];
    let seq = 0;
    for (const turn of (thread && thread.turns) || []) {
      for (const item of turn.items || []) {
        const ev = this._normalizeItem(item);
        if (ev) events.push({ ...ev, seq: seq++ });
      }
    }
    return events;
  }

  async listSessions() {
    const threads = await this.app.listThreads();
    return threads.map((thread) => ({
      id: thread.id,
      cwd: thread.cwd || '',
      title: thread.preview || pathTitle(thread.cwd),
      model: thread.modelProvider || null,
      originator: thread.source || '',
      createdAt: thread.createdAt ? new Date(thread.createdAt * 1000).toISOString() : null,
      updatedAt: thread.updatedAt ? new Date(thread.updatedAt * 1000).toISOString() : null,
    }));
  }

  async sessionDetail(id) {
    const thread = await this._readThreadWhenReady(id);
    if (!thread) return null;
    return { id: thread.id, cwd: thread.cwd || '', model: thread.modelProvider || null, createdAt: thread.createdAt ? new Date(thread.createdAt * 1000).toISOString() : null, events: this._events(thread) };
  }

  async hasSession(id) { return !!(await this.app.readThread(id)); }

  async _readThreadWhenReady(id, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const thread = await this.app.readThread(id);
        if (thread) return thread;
      } catch (e) {
        lastError = e;
        // A newly-created rollout can be visible before its metadata is flushed.
        if (!/empty|failed to read session metadata|thread-store internal error/i.test(e.message)) throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    if (lastError) throw lastError;
    return null;
  }
  async backgroundTerminals(id) {
    try { return await this.app.listBackgroundTerminals(id); }
    catch (e) { if (/thread not found/i.test(e.message)) return []; throw e; }
  }
  async terminateBackgroundTerminal(id, processId) { return this.app.terminateBackgroundTerminal(id, processId); }
  async cleanBackgroundTerminals(id) { return this.app.cleanBackgroundTerminals(id); }

  async start({ cwd, prompt }) {
    const thread = await this.app.startThread(cwd);
    this.sessions.set(thread.id, { id: thread.id, threadId: thread.id, cwd, turnId: null, startedAt: new Date().toISOString(), stopRequested: false });
    await this.app.startTurn(thread.id, prompt, cwd);
    await this._readThreadWhenReady(thread.id);
    return thread.id;
  }

  waitFile() { return Promise.resolve(true); }

  async send(id, prompt) {
    let state = this.sessions.get(id);
    const known = state || {};
    const thread = await this.app.resumeThread(id, known.cwd || null);
    if (!thread) throw new Error('session not found');
    state = this.sessions.get(id) || { id, threadId: id, cwd: thread.cwd || process.cwd(), turnId: null, startedAt: new Date().toISOString(), stopRequested: false };
    state.cwd = thread.cwd || state.cwd;
    this.sessions.set(id, state);
    await this.app.startTurn(id, prompt, state.cwd);
    return { ok: true };
  }

  stop(id) {
    const state = this.sessions.get(id);
    if (!state || !state.turnId) return { ok: false, reason: 'no running process' };
    state.stopRequested = true;
    this.app.interrupt(state.threadId, state.turnId).catch(() => {});
    return { ok: true };
  }

  shutdown() { for (const id of this.runningList().map((x) => x.id)) this.stop(id); this.app.shutdown(); }
}

function pathTitle(cwd) { return String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || '(无消息)'; }

module.exports = Runner;
