'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function sessionsDir() {
  return path.join(codexHome(), 'sessions');
}

function resolveCodexBin() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) {
    return process.env.CODEX_BIN;
  }
  const roots = [];
  try {
    const r = execSync('npm root -g', { encoding: 'utf8', shell: true, windowsHide: true }).trim();
    if (r) roots.push(r);
  } catch {}
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  roots.push('/usr/local/lib/node_modules');
  for (const root of roots) {
    const packageRoot = path.join(root, '@openai', 'codex');
    const platformPackage = process.platform === 'win32'
      ? (process.arch === 'arm64' ? '@openai/codex-win32-arm64' : '@openai/codex-win32-x64')
      : null;
    const vendorTarget = process.platform === 'win32'
      ? (process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc')
      : null;
    const candidates = platformPackage
      ? [path.join(packageRoot, 'node_modules', platformPackage, 'vendor', vendorTarget, 'bin', 'codex.exe')]
      : [path.join(packageRoot, 'bin', 'codex')];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return 'codex';
}

function parseProjects(configText) {
  const projects = [];
  const lines = configText.split(/\r?\n/);
  let current = null;
  let trusted = false;
  const sectionRe = /^\[projects\.(?:"((?:[^"\\]|\\.)*)"|'([^']*)')\]$/;
  for (const line of lines) {
    const trimmed = line.trim();
    const m = trimmed.match(sectionRe);
    if (m) {
      if (current && trusted) projects.push(current);
      current = m[1] !== undefined ? m[1].replace(/\\([\\"])/g, '$1') : m[2];
      trusted = false;
      continue;
    }
    if (current && /^\[/.test(trimmed)) {
      if (trusted) projects.push(current);
      current = null;
      trusted = false;
      continue;
    }
    if (current) {
      const t = trimmed.match(/^trust_level\s*=\s*"?(\w+)"?/);
      if (t && (t[1] === 'trusted' || t[1] === 'always')) trusted = true;
    }
  }
  if (current && trusted) projects.push(current);
  return [...new Set(projects)].sort();
}

function listProjects() {
  const cfg = path.join(codexHome(), 'config.toml');
  if (!fs.existsSync(cfg)) return [];
  try {
    return parseProjects(fs.readFileSync(cfg, 'utf8'));
  } catch {
    return [];
  }
}

function localIPv4() {
  const ifs = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
  ips.sort((a, b) => rank(a) - rank(b));
  return ips.length ? ips[0] : '127.0.0.1';
}

module.exports = { codexHome, sessionsDir, resolveCodexBin, listProjects, localIPv4 };
