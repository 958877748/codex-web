'use strict';

const fs = require('fs');
const path = require('path');
const { sessionsDir } = require('./config');

const LIST_SCAN_BYTES = 512 * 1024;
const MAX_TOOL_OUTPUT = 8000;

function walkFiles(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) out.push(p);
  }
}

function allSessionFiles() {
  const out = [];
  walkFiles(sessionsDir(), out);
  return out;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function truncate(text, max) {
  if (typeof text !== 'string') return '';
  return text.length > max ? text.slice(0, max) + '\n… (已截断)' : text;
}

function textFromContent(content) {
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      if (typeof c === 'string') return c;
      if (c && c.type === 'input_text') return c.text || '';
      if (c && c.type === 'output_text') return c.text || '';
      if (c && c.type === 'text') return c.text || '';
      if (c && (c.type === 'Text' || c.type === 'text_delta')) return c.text || '';
      return '';
    })
    .join('\n')
    .trim();
}

function normalizeEvent(raw, lineIndex) {
  if (!raw || typeof raw !== 'object') return null;
  const seq = typeof raw.ordinal === 'number' ? raw.ordinal : lineIndex;
  const base = { seq, ts: raw.timestamp || null };
  switch (raw.type) {
    case 'session_meta': {
      const p = raw.payload || {};
      return {
        ...base,
        kind: 'meta',
        payload: {
          id: p.id,
          cwd: p.cwd,
          createdAt: p.timestamp,
          originator: p.originator,
          cliVersion: p.cli_version,
          modelProvider: p.model_provider,
        },
      };
    }
    case 'turn_context': {
      const p = raw.payload || {};
      return { ...base, kind: 'turn_context', payload: { model: p.model, effort: p.effort, cwd: p.cwd } };
    }
    case 'event_msg':
      return normalizeEventMsg(raw, base);
    case 'response_item':
      return normalizeResponseItem(raw, base);
    default:
      return null;
  }
}

function normalizeEventMsg(raw, base) {
  const p = raw.payload || {};
  switch (p.type) {
    case 'user_message':
      return { ...base, kind: 'user_message', payload: { message: p.message || '' } };
    case 'agent_message':
      return { ...base, kind: 'agent_message', payload: { message: p.message || '', phase: p.phase || 'commentary' } };
    case 'task_started':
      return { ...base, kind: 'task_started', payload: { startedAt: p.started_at, turnId: p.turn_id } };
    case 'task_complete':
      return {
        ...base,
        kind: 'task_complete',
        payload: { completedAt: p.completed_at, durationMs: p.duration_ms, lastAgentMessage: p.last_agent_message },
      };
    case 'token_count':
      return { ...base, kind: 'token_usage', payload: { info: p.info || null } };
    case 'patch_apply_end':
      return { ...base, kind: 'file_change', payload: { success: !!p.success, fileCount: p.changes ? Object.keys(p.changes).length : 0 } };
    case 'item_completed':
      return normalizeCompletedItem(p.item, base);
    default:
      return null;
  }
}

function normalizeCompletedItem(item, base) {
  if (!item || typeof item !== 'object') return null;
  const content = textFromContent(item.content);
  if (item.type === 'UserMessage') {
    return content ? { ...base, kind: 'user_message', payload: { message: content } } : null;
  }
  if (item.type === 'AgentMessage') {
    return content ? { ...base, kind: 'agent_message', payload: { message: content, phase: item.phase || 'final' } } : null;
  }
  if (item.type === 'CommandExecution') {
    const command = Array.isArray(item.command) ? item.command.join(' ') : String(item.command || '');
    const output = item.aggregated_output || item.stdout || item.stderr || '';
    return {
      ...base,
      kind: 'tool_call',
      payload: {
        callId: item.id,
        name: Array.isArray(item.command) && item.command[0] ? item.command[0] : 'shell_command',
        input: command,
        output: truncate(output, MAX_TOOL_OUTPUT),
        status: item.status === 'failed' || item.exit_code != null && item.exit_code !== 0 ? 'failed' : 'completed',
        exitCode: item.exit_code == null ? null : Number(item.exit_code),
      },
    };
  }
  return null;
}

function normalizeResponseItem(raw, base) {
  const p = raw.payload || {};
  switch (p.type) {
    case 'message': {
      const text = textFromContent(p.content);
      if (!text) return null;
      if (p.role === 'user') {
        // Exec rollouts may persist injected environment/developer context as
        // response items; the interactive CLI does not show those as messages.
        if (/^<(?:environment_context|skills_instructions|multi_agent_mode)\b/.test(text)) return null;
        return { ...base, kind: 'user_message', payload: { message: text } };
      }
      if (p.role === 'assistant') return { ...base, kind: 'agent_message', payload: { message: text, phase: 'final' } };
      return null;
    }
    case 'function_call':
      return { ...base, kind: 'tool_call', payload: { callId: p.call_id, name: p.name, input: p.arguments || '', status: 'running' } };
    case 'function_call_output': {
      const m = /Exit code: (\d+)/.exec(p.output || '');
      return {
        ...base,
        kind: 'tool_output',
        payload: { callId: p.call_id, output: truncate(p.output || '', MAX_TOOL_OUTPUT), status: 'completed', exitCode: m ? Number(m[1]) : null },
      };
    }
    case 'custom_tool_call':
      return {
        ...base,
        kind: 'tool_call',
        payload: {
          callId: p.call_id,
          name: p.name,
          input: typeof p.input === 'string' ? p.input : JSON.stringify(p.input || ''),
          status: 'completed',
        },
      };
    case 'custom_tool_call_output':
      return {
        ...base,
        kind: 'tool_output',
        payload: { callId: p.call_id, output: truncate(p.output || '', MAX_TOOL_OUTPUT), status: 'completed' },
      };
    case 'reasoning':
      return { ...base, kind: 'reasoning', payload: {} };
    default:
      return null;
  }
}

function dedupeEvents(events) {
  const out = [];
  let previousMessage = null;
  const seenSeq = new Set();
  for (const ev of events) {
    if (ev.seq != null) {
      if (seenSeq.has(ev.seq)) continue;
      seenSeq.add(ev.seq);
    }
    if (ev.kind === 'user_message' || ev.kind === 'agent_message') {
      const message = ev.payload && ev.payload.message;
      if (previousMessage && previousMessage.kind === ev.kind && previousMessage.message === message) continue;
      previousMessage = { kind: ev.kind, message };
    } else {
      previousMessage = null;
    }
    out.push(ev);
  }
  return out;
}

function readEvents(file, limitBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = limitBytes ? Math.min(size, limitBytes) : size;
    if (len === 0) return [];
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    const text = buf.toString('utf8');
    const events = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = parseJsonLine(lines[i]);
      if (!raw) continue;
      const ev = normalizeEvent(raw, i);
      if (ev) events.push(ev);
    }
    return events;
  } finally {
    fs.closeSync(fd);
  }
}

function sessionMetaFromFile(file) {
  const events = readEvents(file, 64 * 1024);
  for (const ev of events) {
    if (ev.kind === 'meta') return ev.payload;
  }
  return null;
}

function findSessionFile(id) {
  const files = allSessionFiles();
  for (const f of files) {
    if (path.basename(f).includes(id)) return f;
  }
  for (const f of files) {
    const meta = sessionMetaFromFile(f);
    if (meta && meta.id === id) return f;
  }
  return null;
}

function titleFromEvents(events) {
  for (const ev of events) {
    if (ev.kind !== 'user_message') continue;
    const t = (ev.payload.message || '').trim();
    if (!t || t.startsWith('<') || t.startsWith('# AGENTS.md')) continue;
    return t.split('\n')[0].slice(0, 80);
  }
  return null;
}

function listSessions() {
  const files = allSessionFiles();
  const list = [];
  for (const f of files) {
    let stat;
    try {
      stat = fs.statSync(f);
    } catch {
      continue;
    }
    const events = readEvents(f, LIST_SCAN_BYTES);
    let meta = null;
    let model = null;
    for (const ev of events) {
      if (ev.kind === 'meta' && !meta) meta = ev.payload;
      if (ev.kind === 'turn_context' && !model) model = ev.payload.model;
      if (meta && model) break;
    }
    if (!meta) continue;
    const title = titleFromEvents(events);
    list.push({
      id: meta.id,
      cwd: meta.cwd || '',
      title: title || path.basename(meta.cwd || '') || '(无消息)',
      model: model || null,
      originator: meta.originator || '',
      createdAt: meta.createdAt || null,
      updatedAt: stat.mtime.toISOString(),
    });
  }
  list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return list;
}

function sessionDetail(id) {
  const file = findSessionFile(id);
  if (!file) return null;
  const events = dedupeEvents(readEvents(file));
  let meta = null;
  let model = null;
  let cwd = null;
  for (const ev of events) {
    if (ev.kind === 'meta' && !meta) meta = ev.payload;
    if (ev.kind === 'turn_context' && !model) model = ev.payload.model;
    if (ev.kind === 'turn_context' && !cwd) cwd = ev.payload.cwd;
  }
  return {
    id,
    file,
    cwd: cwd || (meta && meta.cwd) || '',
    model: model || (meta && meta.modelProvider) || null,
    createdAt: (meta && meta.createdAt) || null,
    events,
  };
}

module.exports = { allSessionFiles, listSessions, sessionDetail, findSessionFile, normalizeEvent, dedupeEvents, readEvents };
