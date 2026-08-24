'use strict';

const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { resolveCodexBin } = require('./config');

class AppServer {
  constructor() {
    this.bin = resolveCodexBin();
    this.child = null;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = null;
    this.startPromise = null;
  }

  async start() {
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise((resolve, reject) => {
      let child;
      try { child = spawn(this.bin, ['app-server', '--listen', 'stdio://'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
      catch (e) { reject(new Error(`无法启动 Codex App Server: ${e.message}`)); return; }
      this.child = child;
      let stderr = '';
      child.stdout.on('data', (chunk) => this._onData(chunk));
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-8000); });
      child.on('error', (e) => this._failAll(new Error(`App Server 启动失败: ${e.message}`)));
      child.on('close', (code) => { this.child = null; this._failAll(new Error(`App Server 已退出 (${code})${stderr.trim() ? `: ${stderr.trim()}` : ''}`)); });
      this.request('initialize', { clientInfo: { name: 'codex-web-panel', version: '0.1.0' }, capabilities: { experimentalApi: true } }).then(() => { this.notify('initialized', {}); resolve(); }).catch(reject);
    }).catch((e) => { this.startPromise = null; throw e; });
    return this.startPromise;
  }

  _onData(chunk) {
    this.buffer += this.decoder.write(chunk);
    let i;
    while ((i = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, i).trim(); this.buffer = this.buffer.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id != null && (msg.result !== undefined || msg.error !== undefined)) {
        const call = this.pending.get(String(msg.id)); if (!call) continue;
        this.pending.delete(String(msg.id));
        if (msg.error) call.reject(new Error(msg.error.message || 'App Server 请求失败')); else call.resolve(msg.result);
      } else if (msg.method && this.onNotification) this.onNotification(msg);
    }
  }

  _failAll(error) { for (const call of this.pending.values()) call.reject(error); this.pending.clear(); }

  request(method, params) {
    if (!this.child || !this.child.stdin.writable) return Promise.reject(new Error('App Server 未运行'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(String(id), { resolve, reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  notify(method, params) { if (this.child && this.child.stdin.writable) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }

  async listThreads() {
    await this.start();
    const all = []; let cursor = null;
    do {
      const result = await this.request('thread/list', { limit: 200, cursor, sourceKinds: [] });
      all.push(...(result.data || [])); cursor = result.nextCursor || null;
    } while (cursor && all.length < 5000);
    return all;
  }

  async readThread(threadId) { await this.start(); const result = await this.request('thread/read', { threadId, includeTurns: true }); return result.thread || null; }
  async resumeThread(threadId, cwd) {
    await this.start();
    const result = await this.request('thread/resume', {
      threadId,
      cwd: cwd || null,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      initialTurnsPage: { limit: 100 },
    });
    return result.thread || null;
  }
  async listBackgroundTerminals(threadId) { await this.start(); const result = await this.request('thread/backgroundTerminals/list', { threadId, limit: 100 }); return result.data || []; }
  async terminateBackgroundTerminal(threadId, processId) { await this.start(); return this.request('thread/backgroundTerminals/terminate', { threadId, processId }); }
  async cleanBackgroundTerminals(threadId) { await this.start(); return this.request('thread/backgroundTerminals/clean', { threadId }); }
  async startThread(cwd) { await this.start(); const result = await this.request('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' }); return result.thread; }
  async startTurn(threadId, prompt, cwd) { await this.start(); return this.request('turn/start', { threadId, cwd, input: [{ type: 'text', text: prompt }] }); }
  async interrupt(threadId, turnId) { await this.start(); return this.request('turn/interrupt', { threadId, turnId }); }

  shutdown() { this._failAll(new Error('App Server 已关闭')); if (this.child) { try { this.child.kill(); } catch {} this.child = null; } this.startPromise = null; }
}

module.exports = AppServer;
