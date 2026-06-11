#!/usr/bin/env node
/**
 * phase-state.js — atdo 状态管理脚本
 * 零外部依赖，纯 Node.js 内置模块
 *
 * 用法:
 *   node phase-state.js init <plan-json>         初始化状态
 *   node phase-state.js get <key>                 读取状态字段
 *   node phase-state.js set-phase <id> <status>  设置阶段状态
 *   node phase-state.js get-current-phase         获取当前待处理阶段
 *   node phase-state.js inc-strike <phaseId> <type>  增加 strike 计数
 *   node phase-state.js get-strikes <phaseId>     获取 strike 计数
 *   node phase-state.js record-commit <phaseId> <hash>  记录 commit hash
 *   node phase-state.js lock                      获取锁
 *   node phase-state.js unlock                    释放锁
 *   node phase-state.js check-disk                磁盘空间检查
 *   node phase-state.js sanitize <file>           脱敏文件中的密钥
 *   node phase-state.js heartbeat                 写入心跳
 *   node phase-state.js summary                   输出当前状态摘要
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = '.phase-execution';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const BACKUP_FILE = path.join(STATE_DIR, 'state.json.backup');
// 多版本轮转:.bak.1(最近) / .bak.2 / .bak.3(最旧),损坏时按序回退
const BACKUP_FILES = [
  path.join(STATE_DIR, 'state.json.bak.1'),
  path.join(STATE_DIR, 'state.json.bak.2'),
  path.join(STATE_DIR, 'state.json.bak.3'),
];
const BACKUP_LEGACY = BACKUP_FILE; // 向后兼容旧版单一 backup 文件名
const TMP_PREFIX = 'state.json.tmp';
const LOCK_FILE = path.join(STATE_DIR, 'lock');
const HEARTBEAT_FILE = path.join(STATE_DIR, 'heartbeat.json');
const PROGRESS_FILE = path.join(STATE_DIR, 'progress.md');
const ALERT_FILE = path.join(STATE_DIR, 'ALERT.md');

// 阶段状态白名单(set-phase 校验,getCurrentPhase 识别)—— 与 SKILL.md 协议保持同步
const VALID_STATUSES = ['pending', 'in_progress', 'executed', 'audited', 'fixed', 'gated', 'completed'];
const ACTIVE_STATUSES = ['pending', 'in_progress', 'executed', 'audited', 'fixed', 'gated'];
const STRIKE_THRESHOLDS = { phaseRetry: 3, regression: 2, sameCategory: 5 };

// ─── 工具函数 ───────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) {
    fs.mkdirSync(STATE_DIR, { recursive: true });
  }
}

function readJSON(filepath, fallback = null) {
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function atomicWrite(filepath, data) {
  ensureDir();
  const json = JSON.stringify(data, null, 2);
  const tmpPath = path.join(STATE_DIR, `${TMP_PREFIX}.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmpPath, json, 'utf8');
  const fd = fs.openSync(tmpPath, 'r+');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmpPath, filepath);
}

function readState() {
  let state = readJSON(STATE_FILE);
  // 主文件损坏/缺失 → 按序回退:bak.1(最近) → bak.2 → bak.3 → 旧版单一 backup
  // 静默回退会导致时序错位(用户以为在 phase 5,实际回到 phase 3),必须 stderr WARN 告知编排器
  if (!state) {
    for (const f of [...BACKUP_FILES, BACKUP_LEGACY]) {
      state = readJSON(f);
      if (state) {
        process.stderr.write(`[WARN] 主 state.json 损坏/缺失,已从 ${path.basename(f)} 回退。数据可能不是最新。\n`);
        break;
      }
    }
  }
  if (!state) {
    die('状态文件损坏且无备份，无法恢复。请检查 .phase-execution/ 目录。');
  }
  return state;
}

function writeState(state) {
  atomicWrite(STATE_FILE, state);
  // 多版本轮转:bak.3 → 丢弃,bak.2 → bak.3,bak.1 → bak.2,当前 → bak.1
  // 这样保留最近 3 个历史版本,损坏时可按序回退
  try {
    if (fs.existsSync(BACKUP_FILES[1])) fs.copyFileSync(BACKUP_FILES[1], BACKUP_FILES[2]);
    if (fs.existsSync(BACKUP_FILES[0])) fs.copyFileSync(BACKUP_FILES[0], BACKUP_FILES[1]);
    fs.copyFileSync(STATE_FILE, BACKUP_FILES[0]);
  } catch {
    // 备份失败不阻塞主流程
  }
}

function die(msg) {
  process.stderr.write(`[phase-state] FATAL: ${msg}\n`);
  process.exit(1);
}

// ─── 密钥脱敏 ───────────────────────────────────────────

const SECRET_PATTERNS = [
  // LLM provider keys
  /\b(sk-(?:ant-)?(?:proj-)?[a-zA-Z0-9-]{20,})\b/g,        // OpenAI sk-, sk-proj-, Anthropic sk-ant-
  /\b(sk-ant-api\d{2}-[a-zA-Z0-9_-]{20,})\b/g,              // Anthropic 2025+ format
  // GitHub tokens (legacy + new fine-grained)
  /\b(ghp_[a-zA-Z0-9]{20,})\b/g,                            // GitHub PAT (classic)
  /\b(github_pat_[a-zA-Z0-9_]{20,})\b/g,                    // GitHub fine-grained PAT (2022+)
  /\b(gho_[a-zA-Z0-9]{20,})\b/g,                            // GitHub OAuth
  /\b(ghu_[a-zA-Z0-9]{20,})\b/g,                            // GitHub App user-to-server
  /\b(ghs_[a-zA-Z0-9]{20,})\b/g,                            // GitHub App server-to-server
  /\b(ghr_[a-zA-Z0-9]{20,})\b/g,                            // GitHub App refresh
  // Other SaaS tokens
  /\b(AKIA[A-Z0-9]{16})\b/g,                                // AWS access key
  /\b(glpat-[a-zA-Z0-9_-]{16,})\b/g,                        // GitLab
  /\b(xox[abprs]-[a-zA-Z0-9-]{10,})\b/g,                    // Slack
  /\b(dckr_pat_[a-zA-Z0-9_-]{16,})\b/g,                    // Docker Hub
  /\b(npm_[a-zA-Z0-9]{16,})\b/g,                            // npm token
  /\b(pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{16,})\b/g,          // PyPI token
  /\b(ATATT[A-Za-z0-9_-]{16,})\b/g,                         // Atlassian
  // PEM private keys (whole block)
  /(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)/g,
  // JWT
  /\b(eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})\b/g,
  // Generic key=value assignments
  /\b(API[_-]?KEY\s*=\s*['"]?)([^\s'"]{8,})(['"]?)/gi,
  /\b(SECRET[_\s]?KEY\s*=\s*['"]?)([^\s'"]{8,})(['"]?)/gi,
  /\b(TOKEN\s*=\s*['"]?)([^\s'"]{8,})(['"]?)/gi,
  /\b(PASSWORD\s*=\s*['"]?)([^\s'"]{8,})(['"]?)/gi,
  // process.env.X = 'value' style
  /\b(process\.env\.[A-Z_]+\s*=\s*['"])([^'"]{8,})(['"])/g,
];

function sanitize(text) {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, ...args) => {
      // args = [capture1, capture2, ..., offset:number, originalString:string]
      // Last two elements are always offset (number) and the original full string.
      const captures = args.slice(0, -2).filter(c => c !== undefined);

      if (captures.length >= 3) {
        // Key=value pattern: prefix=[REDACTED]suffix
        return `${captures[0]}[REDACTED]${captures[2] || ''}`;
      }
      if (captures.length >= 2) {
        // prefix + secret pattern (no suffix group)
        return `${captures[0]}[REDACTED]`;
      }
      // Single capture group: replace entire match with [REDACTED]
      return '[REDACTED]';
    });
  }
  return result;
}

// ─── 锁管理 ─────────────────────────────────────────────

function acquireLock() {
  ensureDir();
  if (fs.existsSync(LOCK_FILE)) {
    const lock = readJSON(LOCK_FILE);
    if (lock) {
      const isAlive = (() => {
        try { process.kill(lock.pid, 0); return true; } catch { return false; }
      })();
      if (isAlive && lock.hostname === os.hostname()) {
        // 检查进程是否是 claude
        try {
          const cmdline = require('child_process').execSync(`ps -o comm= -p ${lock.pid}`, { encoding: 'utf8', timeout: 2000 }).trim();
          if (cmdline.includes('claude') || cmdline.includes('node')) {
            die(`编排器已在运行 (pid ${lock.pid}, 启动于 ${lock.startTime})`);
          }
        } catch {}
      }
      // stale lock — 允许覆盖
      process.stderr.write(`[phase-state] 检测到残留锁 (pid ${lock.pid} 已不存在)，自动清理\n`);
    }
  }
  const lock = {
    pid: process.pid,
    startTime: new Date().toISOString(),
    hostname: os.hostname(),
  };
  fs.writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2), 'utf8');
  return lock;
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch {}
}

// ─── 磁盘检查 ───────────────────────────────────────────

function checkDisk(minMB = 500) {
  try {
    const { execSync } = require('child_process');
    const df = execSync('df -m . | tail -1', { encoding: 'utf8' });
    const parts = df.trim().split(/\s+/);
    const available = parseInt(parts[3], 10);
    if (available < minMB) {
      die(`磁盘可用空间不足: ${available}MB < ${minMB}MB`);
    }
    return { availableMB: available, minRequired: minMB, ok: true };
  } catch (e) {
    return { ok: false, note: '无法检查磁盘空间，跳过', error: e.message };
  }
}

// ─── 心跳 ───────────────────────────────────────────────

function writeHeartbeat(phaseId, taskId, status) {
  ensureDir();
  const hb = {
    timestamp: new Date().toISOString(),
    pid: process.pid,
    currentPhase: phaseId || null,
    currentTask: taskId || null,
    status: status || 'active',
  };
  fs.writeFileSync(HEARTBEAT_FILE, JSON.stringify(hb, null, 2), 'utf8');
}

// ─── 命令处理 ───────────────────────────────────────────

const cmd = process.argv[2];
const args = process.argv.slice(3);

function cmdInit() {
  ensureDir();
  let plan;
  try {
    // Read from stdin (avoid shell escaping) or fall back to args[0]
    const input = fs.readFileSync(0, 'utf8').trim() || args[0];
    plan = JSON.parse(input);
  } catch {
    die('init 需要有效的 JSON 输入（通过 stdin 或第一个参数传入）');
  }
  const phases = (plan.phases || []).map((p, i) => ({
    number: String(i + 1).padStart(2, '0'),
    name: p.name || p.id || `Phase ${i + 1}`,
    goal: p.goal || '',
    tasks: p.tasks || [],
    successCriteria: p.success_criteria || [],
    dependsOn: p.depends_on || p.requires || [],
    isGate: p.is_gate !== undefined ? p.is_gate : (p.gate !== undefined ? p.gate : false),
    status: 'pending',
    commitHash: null,
    startedAt: null,
    completedAt: null,
    statusSince: null,
  }));

  if (phases.length === 0) die('plan 中未找到任何阶段。请检查计划文件格式是否正确。');

  // ─── Plan 校验:LLM 不可信原则(depends_on 引用存在性、环检测、任务数警告)───
  const ids = new Set(phases.map(p => p.number));
  for (const p of phases) {
    // depends_on 引用存在性
    for (const dep of p.dependsOn) {
      if (!ids.has(dep)) die(`阶段 ${p.number} depends_on 引用不存在的阶段 "${dep}"`);
    }
    // 任务数警告(>15 提示拆分)
    if (Array.isArray(p.tasks) && p.tasks.length > 15) {
      process.stderr.write(`[WARN] 阶段 ${p.number} 有 ${p.tasks.length} 个任务(>15),建议拆分\n`);
    }
  }
  // 环检测(Kahn 算法)
  const inDeg = Object.fromEntries(phases.map(p => [p.number, 0]));
  const adj = Object.fromEntries(phases.map(p => [p.number, []]));
  for (const p of phases) {
    for (const dep of p.dependsOn) {
      adj[dep].push(p.number);
      inDeg[p.number]++;
    }
  }
  const queue = phases.filter(p => inDeg[p.number] === 0).map(p => p.number);
  let visited = 0;
  while (queue.length) {
    const cur = queue.shift();
    visited++;
    for (const next of adj[cur]) {
      if (--inDeg[next] === 0) queue.push(next);
    }
  }
  if (visited !== phases.length) {
    const cycleNodes = phases.filter(p => inDeg[p.number] > 0).map(p => p.number);
    die(`检测到循环依赖,涉及阶段: ${cycleNodes.join(', ')}`);
  }

  const state = {
    version: '2.0',
    projectRoot: process.cwd(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    phases,
    currentPhaseIndex: 0,
    strikes: {
      phaseRetry: {},
      regression: 0,
      sameCategory: {},
    },
    networkStatus: {
      consecutiveFailures: 0,
      lastSuccessfulCall: null,
    },
    securityEvents: [],
    exitReason: null,
  };
  writeState(state);
  process.stdout.write(JSON.stringify({ ok: true, phases: phases.length }, null, 2));
}

function cmdGet() {
  const state = readState();
  const key = args[0];
  if (!key) {
    process.stdout.write(JSON.stringify(state, null, 2));
    return;
  }
  const keys = key.split('.');
  let val = state;
  for (const k of keys) {
    if (val === undefined || val === null) break;
    val = val[k];
  }
  if (val === undefined) {
    process.stdout.write('null');
  } else if (typeof val === 'object') {
    process.stdout.write(JSON.stringify(val, null, 2));
  } else {
    process.stdout.write(String(val));
  }
}

function cmdSetPhase() {
  const state = readState();
  const phaseId = args[0];
  const status = args[1];
  if (!VALID_STATUSES.includes(status)) {
    die(`无效 status: "${status}"，有效值: ${VALID_STATUSES.join(', ')}`);
  }
  const phase = state.phases.find(p => p.number === phaseId);
  if (!phase) die(`阶段 ${phaseId} 不存在`);
  phase.status = status;
  phase.updatedAt = new Date().toISOString();
  phase.statusSince = new Date().toISOString();
  if (status === 'in_progress' && !phase.startedAt) phase.startedAt = new Date().toISOString();
  if (status === 'completed') {
    phase.completedAt = new Date().toISOString();
    // 单调推进:completed 时把游标推到下一阶段
    const idx = state.phases.indexOf(phase);
    if (idx === state.currentPhaseIndex && idx + 1 < state.phases.length) {
      state.currentPhaseIndex = idx + 1;
    }
  }
  state.updatedAt = new Date().toISOString();
  writeState(state);
  process.stdout.write(JSON.stringify({ ok: true, phase: phaseId, status, currentPhaseIndex: state.currentPhaseIndex }));
}

function cmdGetCurrentPhase() {
  const state = readState();

  // 单调推进:从 currentPhaseIndex 位置开始,找第一个 status !== 'completed' 的阶段
  // 编排器每完成一阶段调用 set-phase ... completed,游标才前进
  // 中间态(executed/audited/fixed/gated)被识别为"还在做",不前进游标
  const startIdx = state.currentPhaseIndex || 0;
  let phase = null;
  for (let i = startIdx; i < state.phases.length; i++) {
    if (state.phases[i].status !== 'completed') {
      phase = state.phases[i];
      state.currentPhaseIndex = i;
      break;
    }
  }

  if (!phase) {
    process.stdout.write(JSON.stringify({ done: true, message: "所有阶段已完成" }));
    return;
  }

  writeState(state);
  process.stdout.write(JSON.stringify({
    number: phase.number,
    name: phase.name,
    goal: phase.goal,
    tasks: phase.tasks,
    isGate: phase.isGate,
    status: phase.status,
    totalPhases: state.phases.length,
    index: state.currentPhaseIndex,
  }));
}

function cmdIncStrike() {
  const state = readState();
  const phaseId = args[0];
  // rawType 用于校验是否传了空串;type 用于实际写入,默认 execution
  const rawType = args[1];
  const type = rawType || 'execution';
  // 参数校验:phaseId 必须存在,type 不能是空字符串
  if (!phaseId) die('inc-strike 需要 phaseId 作为第一个参数');
  if (rawType !== undefined && (typeof rawType !== 'string' || rawType.trim() === '')) {
    die('inc-strike type 不能为空字符串');
  }
  // phaseId 引用存在性(防止 phaseRetry[undefined]={} 污染 state)
  if (!state.phases.find(p => p.number === phaseId)) die(`inc-strike: 阶段 ${phaseId} 不存在`);

  // 根据 type 分流到不同 strike 维度
  //   regression       → 写入 strikes.regression (全局计数,>=2 触发)
  //   其他              → 写入 strikes.phaseRetry[phaseId][type] (>=3 触发)
  //   同 type 同时累计 strikes.sameCategory[type] (>=5 触发,跨阶段同类问题)
  let maxedPhase = false, maxedRegression = false, maxedCategory = false, count, categoryCount;

  if (type === 'regression') {
    state.strikes.regression = (state.strikes.regression || 0) + 1;
    count = state.strikes.regression;
    maxedRegression = count >= STRIKE_THRESHOLDS.regression;
  } else {
    if (!state.strikes.phaseRetry[phaseId]) state.strikes.phaseRetry[phaseId] = {};
    if (!state.strikes.phaseRetry[phaseId][type]) state.strikes.phaseRetry[phaseId][type] = 0;
    state.strikes.phaseRetry[phaseId][type]++;
    count = state.strikes.phaseRetry[phaseId][type];
    maxedPhase = count >= STRIKE_THRESHOLDS.phaseRetry;

    // 同类问题跨阶段累计
    if (!state.strikes.sameCategory[type]) state.strikes.sameCategory[type] = 0;
    state.strikes.sameCategory[type]++;
    categoryCount = state.strikes.sameCategory[type];
    maxedCategory = categoryCount >= STRIKE_THRESHOLDS.sameCategory;
  }

  state.updatedAt = new Date().toISOString();
  writeState(state);
  const maxed = maxedPhase || maxedRegression || maxedCategory;
  process.stdout.write(JSON.stringify({
    phaseId,
    type,
    count,
    categoryCount: categoryCount || null,
    maxed,
    maxedPhase,
    maxedRegression,
    maxedCategory,
    action: maxed ? 'ALERT_AND_EXIT' : 'RETRY',
  }));
}

function cmdGetStrikes() {
  const state = readState();
  const phaseId = args[0];
  if (phaseId) {
    process.stdout.write(JSON.stringify(state.strikes.phaseRetry[phaseId] || {}));
  } else {
    process.stdout.write(JSON.stringify(state.strikes));
  }
}

function cmdRecordCommit() {
  const state = readState();
  const phaseId = args[0];
  const hash = args[1];
  const phase = state.phases.find(p => p.number === phaseId);
  if (!phase) die(`阶段 ${phaseId} 不存在`);
  if (!hash || !/^[a-f0-9]{7,40}$/i.test(hash)) die(`无效的 commit hash: "${hash}"`);
  phase.commitHash = hash;
  state.updatedAt = new Date().toISOString();
  writeState(state);
  process.stdout.write(JSON.stringify({ ok: true, phase: phaseId, hash }));
}

function cmdSanitize() {
  const filepath = args[0];
  if (!fs.existsSync(filepath)) die(`文件 ${filepath} 不存在`);
  const content = fs.readFileSync(filepath, 'utf8');
  const sanitized = sanitize(content);
  if (sanitized !== content) {
    fs.writeFileSync(filepath, sanitized, 'utf8');
    process.stdout.write(JSON.stringify({ sanitized: true, file: filepath }));
  } else {
    process.stdout.write(JSON.stringify({ sanitized: false, file: filepath }));
  }
}

function cmdSummary() {
  const state = readState();
  const completed = state.phases.filter(p => p.status === 'completed').length;
  const total = state.phases.length;
  // 与 cmdGetCurrentPhase 保持一致:用 currentPhaseIndex 找第一个 !== completed
  const startIdx = state.currentPhaseIndex || 0;
  let current = null;
  for (let i = startIdx; i < state.phases.length; i++) {
    if (state.phases[i].status !== 'completed') {
      current = state.phases[i];
      break;
    }
  }
  process.stdout.write(JSON.stringify({
    completed,
    total,
    current: current ? { number: current.number, name: current.name, status: current.status } : null,
    strikes: state.strikes,
    exitReason: state.exitReason,
  }));
}

// ─── 入口 ────────────────────────────────────────────────

const commands = {
  init: cmdInit,
  get: cmdGet,
  'set-phase': cmdSetPhase,
  'get-current-phase': cmdGetCurrentPhase,
  'inc-strike': cmdIncStrike,
  'get-strikes': cmdGetStrikes,
  'record-commit': cmdRecordCommit,
  lock: () => { process.stdout.write(JSON.stringify(acquireLock())); },
  unlock: () => { releaseLock(); process.stdout.write(JSON.stringify({ ok: true })); },
  'check-disk': () => { process.stdout.write(JSON.stringify(checkDisk())); },
  sanitize: cmdSanitize,
  heartbeat: () => { writeHeartbeat(args[0], args[1], args[2]); process.stdout.write(JSON.stringify({ ok: true })); },
  summary: cmdSummary,
};

if (commands[cmd]) {
  commands[cmd]();
} else {
  process.stderr.write(`未知命令: ${cmd}\n可用命令: ${Object.keys(commands).join(', ')}\n`);
  process.exit(1);
}
