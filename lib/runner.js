'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { resolveCodexBin, sessionsDir } = require('./config');
const { findSessionFile, normalizeEvent, sessionDetail } = require('./sessions');

const TAIL_INTERVAL_MS = 700;
const MIGRATE_TIMEOUT_MS = 120000;
const START_TIMEOUT_MS = 30000;

class Runner {
  constructor() {
    this.bin = resolveCodexBin();
    this.sessions = new Map(); // id -> state
    this.onEvent = null; // (normalizedEvent, sessionId) => void
    this.onState = null; // (sessionId, state) => void
  }

  runningList() {
    const out = [];
    for (const [id, s] of this.sessions) {
      if (s.child && !s.child.killed && s.child.exitCode === null) {
        out.push({ id, cwd: s.cwd, startedAt: s.startedAt });
      }
    }
    return out;
  }

  isRunning(id) {
    const s = this.sessions.get(id);
    return !!(s && s.child && !s.child.killed && s.child.exitCode === null);
  }

  _emit(ev, id) {
    if (this.onEvent) this.onEvent(ev, id);
  }

  _setState(id, state) {
    if (this.onState) this.onState(id, state);
  }

  _spawn(args, cwd, onReady) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(this.bin, args, {
          cwd,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        reject(new Error(`无法启动 codex: ${e.message}`));
        return;
      }
      let buf = '';
      let stderrTail = '';
      let ready = false;
      const startupTimer = setTimeout(() => {
        if (ready) return;
        try { child.kill(); } catch {}
        reject(new Error(`codex 启动超时: ${stderrTail.trim() || '未收到 thread.started'}`));
      }, START_TIMEOUT_MS);
      const onLine = (line) => {
        if (!line.trim()) return;
        let ev = null;
        try {
          ev = JSON.parse(line);
        } catch {
          return;
        }
        if (ev.type === 'thread.started') {
          if (!ready && ev.thread_id) {
            ready = true;
            clearTimeout(startupTimer);
            onReady(ev.thread_id, child);
            resolve({ child, id: ev.thread_id });
          }
        }
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          onLine(line);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d) => {
        stderrTail = (stderrTail + d).slice(-8000);
      });
      child.on('error', (e) => {
        clearTimeout(startupTimer);
        if (!ready) reject(new Error(`无法启动 codex: ${e.message}`));
      });
      child.on('close', () => {
        clearTimeout(startupTimer);
        if (!ready) reject(new Error(`codex 提前退出: ${stderrTail.trim() || '未知错误'}`));
      });
    });
  }

  _attach(id, child, cwd, file) {
    const state = {
      id,
      child,
      cwd,
      file,
      offset: 0,
      lineNo: 0,
      tailBuffer: '',
      decoder: new StringDecoder('utf8'),
      tailer: null,
      fileProbe: null,
      startedAt: new Date().toISOString(),
      stopRequested: false,
    };
    this.sessions.set(id, state);
    this._setState(id, 'running');
    if (file) this._startTail(id);
    child.on('close', () => {
      if (state.tailer) {
        clearInterval(state.tailer);
        state.tailer = null;
        this._tailOnce(id, true); // final sync
      }
      if (state.fileProbe) {
        clearInterval(state.fileProbe);
        state.fileProbe = null;
      }
      state.child = null;
      this._setState(id, state.stopRequested ? 'stopped' : 'idle');

      // `codex exec` writes a legacy rollout. Publish it to the paginated
      // thread index used by the interactive CLI once the file is complete.
      this._migrateSession(id).catch(() => {});

      if (state.stopRequested) {
        setTimeout(() => {
          if (this.sessions.get(id) && !this.sessions.get(id).child) this.sessions.delete(id);
        }, 60 * 1000);
      }
    });
  }

  _migrateSession(id) {
    return new Promise((resolve) => {
      let child;
      let settled = false;
      let timer;
      const finish = (ok) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ok);
      };

      try {
        child = spawn(this.bin, ['migrate-rollouts', '--apply', '--thread', id, '--json'], {
          cwd: process.cwd(),
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        finish(false);
        return;
      }

      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        finish(false);
      }, MIGRATE_TIMEOUT_MS);
      child.on('error', () => finish(false));
      child.on('close', (code) => finish(code === 0));
    });
  }

  _startTail(id) {
    const s = this.sessions.get(id);
    if (!s || s.tailer) return;
    s.tailer = setInterval(() => this._tailOnce(id), TAIL_INTERVAL_MS);
  }

  _tailOnce(id, flush) {
    const s = this.sessions.get(id);
    if (!s || !s.file) return;
    let stat;
    try {
      stat = fs.statSync(s.file);
    } catch {
      return;
    }
    if (stat.size < s.offset) {
      s.offset = 0;
      s.tailBuffer = '';
      s.decoder = new StringDecoder('utf8');
    }
    if (stat.size <= s.offset && !(flush && s.tailBuffer)) return;
    const fd = fs.openSync(s.file, 'r');
    let text;
    try {
      const buf = Buffer.alloc(Math.max(0, stat.size - s.offset));
      if (buf.length) fs.readSync(fd, buf, 0, buf.length, s.offset);
      text = s.tailBuffer + s.decoder.write(buf);
      if (flush) text += s.decoder.end();
      s.tailBuffer = '';
      s.offset = stat.size;
    } finally {
      fs.closeSync(fd);
    }
    const lines = text.split('\n');
    if (!flush && !text.endsWith('\n')) s.tailBuffer = lines.pop() || '';
    for (let i = 0; i < lines.length; i++) {
      const raw = normalizeEvent(parseJson(lines[i]), s.lineNo);
      s.lineNo += 1;
      if (raw) this._emit(raw, id);
    }
  }

  async start({ cwd, prompt }) {
    const { id } = await this._spawn(['exec', '--json', '--skip-git-repo-check', '-C', cwd, prompt], cwd, (id, child) => {
      let file = findSessionFile(id);
      if (!file) {
        // The file may be created a moment later; locate it in the tail loop.
        file = null;
      }
      this._attach(id, child, cwd, file);
      if (!file) {
        const probe = setInterval(() => {
          const f = findSessionFile(id);
          if (f) {
            clearInterval(probe);
            const s = this.sessions.get(id);
            if (s) {
              s.file = f;
              this._startTail(id);
            }
          }
        }, 700);
        const s = this.sessions.get(id);
        if (s) s.fileProbe = probe;
      }
    });
    await this.waitFile(id, 10000);
    return id;
  }

  waitFile(id, timeoutMs) {
    return new Promise((resolve) => {
      const s = this.sessions.get(id);
      if (s && s.file) return resolve(s.file);
      const start = Date.now();
      const t = setInterval(() => {
        const st = this.sessions.get(id);
        const f = (st && st.file) || findSessionFile(id);
        if (f || Date.now() - start > timeoutMs) {
          clearInterval(t);
          if (st && !st.file) st.file = f;
          resolve(f || null);
        }
      }, 400);
    });
  }

  send(id, prompt) {
    const detail = sessionDetail(id);
    const cwd = detail && detail.cwd ? detail.cwd : process.cwd();
    const s = this.sessions.get(id);
    const file = (s && s.file) || (detail && detail.file) || findSessionFile(id);
    return this._spawn(['exec', 'resume', id, '--json', '--skip-git-repo-check', prompt], cwd, (sid, child) => {
      this._attach(sid, child, cwd, file);
    }).then(() => ({ ok: true }));
  }

  stop(id) {
    const s = this.sessions.get(id);
    if (!s || !s.child || s.child.exitCode !== null) return { ok: false, reason: 'no running process' };
    s.stopRequested = true;
    const pid = s.child.pid;
    if (process.platform === 'win32') {
      try {
        const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => {});
      } catch {}
    } else {
      try {
        s.child.kill('SIGTERM');
      } catch {}
    }
    return { ok: true };
  }

  shutdown() {
    for (const id of this.runningList()) this.stop(id);
  }
}

function parseJson(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

module.exports = Runner;
