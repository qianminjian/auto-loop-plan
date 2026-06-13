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
 *   node phase-state.js record-commit <phaseId> <hash[,hash,...]>  记录 commit hash(支持单 hash 或 comma-separated 多 hash)
 *   node phase-state.js record-confirm <phaseId> <decision>        追加 userConfirmation(Bug-07,decision: c|s|a)
 *   node phase-state.js has-confirm <phaseId>                      检查 phase 是否已确认(exit 0=是, 1=否,Bug-07)
 *   node phase-state.js validate-summary <phaseId>                 校验 phase summary.md 长度(Bug-10,≤500 chars,exit 0=PASS / 1=超长 / 2=不存在 / 3=非 UTF-8 / 4=空文件)
 *   node phase-state.js generate-summary-template <phaseId>         输出 summary.md 统一模板(P3-4)
 *   node phase-state.js lock                      获取锁
 *   node phase-state.js unlock --reason=<r>       释放锁(Bug-08:必须带 --reason,合法值 all-completed|aborted|alert)
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
const VALID_STATUSES = [
  'pending', 'in_progress', 'executed', 'audited', 'fixed', 'gated', 'completed',
  // Bug-06:manual gate 专用中间态(见 SKILL.md "Manual Gate Protocol")
  'awaiting_user_review', 'user-review-pass', 'user-review-fail',
  // P1-4:verification phase 快速路径(跳过 audited/fixed,见 SKILL.md "Verification Phase")
  'verified',
];
const ACTIVE_STATUSES = ['pending', 'in_progress', 'executed', 'audited', 'fixed', 'gated', 'awaiting_user_review', 'verified'];
// P2-15: 同一 phase 最多累积的确认条数(防 LLM 幻觉 / 恶意循环调用导致 state.json 爆炸)
const MAX_CONFIRMATIONS_PER_PHASE = 10;
const STRIKE_THRESHOLDS = { phaseRetry: 3, regression: 2, sameCategory: 5 };

// Bug-10:summary.md 字符数上限(中文字符按 1 char 计,不按字节)
// 硬约束 — 超 500 chars → FATAL,要求重写
// 与 SKILL.md "summary.md 长度约束 (Bug-10)" 章节保持同步
const SUMMARY_MAX_CHARS = 500;

// Bug-06:状态机合法转换表
//   - 每个阶段的 status 只能从一组特定的来源状态进入
//   - 跳过任何状态 → FATAL(防止 LLM 幻觉或乱序调用导致状态错乱)
//   - 任何不在此表中的 (from, to) 组合都被视为非法
//   - 注:'pending' 作为起点,不校验来源(set-phase 不会主动把任意状态 → pending)
const ALLOWED_TRANSITIONS = {
  // 标准自动流程
  'pending':              ['in_progress'],
  'in_progress':          ['executed'],
  'executed':             ['audited', 'verified'],  // P1-4: verification phase 可跳过 audited
  'audited':              ['fixed'],
  'fixed':                ['gated'],
  'verified':             ['gated'],                // P1-4: verification → gated 直通
  'gated':                ['completed', 'awaiting_user_review'],  // auto → completed;manual → awaiting_user_review
  // Bug-06:manual gate 流程(gated 进入 manual gate 后必须经此路径离开)
  'awaiting_user_review': ['user-review-pass', 'user-review-fail'],
  'user-review-pass':     ['completed'],
  // 'user-review-fail' 终态:失败 ALERT,不向其他状态转换
  // 'completed' 终态:不向其他状态转换
};

// 反向索引:任何状态只能从 ALLOWED_TRANSITIONS[X] 中来(快速查询)
const VALID_PREDECESSORS = (() => {
  const map = {};
  for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
    for (const t of targets) {
      if (!map[t]) map[t] = [];
      map[t].push(from);
    }
  }
  return map;
})();

// 终态:不允许 set-phase 离开这些状态
const TERMINAL_STATUSES = ['completed', 'user-review-fail'];

// 把合法转换表格式化为可读字符串(供 FATAL 消息使用)
function formatTransitionTable() {
  const lines = [];
  for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
    lines.push(`  ${from} → ${targets.join(' | ') || '(终态)'}`);
  }
  return lines.join('\n');
}

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
  // P3-5: 一次性剥离老 state.json 残留字段
  //   - networkStatus:未实现 set-network-status 命令(P2-7 删除)
  //   - exitReason   :未实现 set-exit-reason 命令(P2-7 删除)
  // 老用户从 v1.x 升级到 v2.0.x 时,state.json 可能仍含这些字段
  // init 不会主动写(向后兼容旧数据),但每次 readState 时剥离
  // 命令输出(get / summary 等)不应再泄漏这些字段
  // 副作用:readState 返回的对象被 in-place 修改,readState 调用方不会感知差异
  let stripped = 0;
  for (const staleField of ['networkStatus', 'exitReason']) {
    if (Object.prototype.hasOwnProperty.call(state, staleField)) {
      delete state[staleField];
      stripped++;
    }
  }
  if (stripped > 0) {
    // 用 stderr 提示(不静默剥离),让 orchestrator 知道发生了兼容清理
    process.stderr.write(`[INFO] readState 剥离 ${stripped} 个已删除字段(${['networkStatus', 'exitReason'].filter(f => true).join('/')}),建议下次写盘时持久化清理\n`);
  }
  return state;
}

function writeState(state) {
  atomicWrite(STATE_FILE, state);
  // 多版本轮转:bak.3 → 丢弃,bak.2 → bak.3,bak.1 → bak.2,当前 → bak.1
  // 这样保留最近 3 个历史版本,损坏时可按序回退
  // P2-4 优化:
  //   - 跳过空 state 备份(空 state 污染 bak 链,恢复时无法用)
  //   - per-file try/catch,任一 copy 失败 warn 但不阻塞主写入
  //   - 仍保持向后兼容:bak.1/2/3 内容与旧版一致
  if (!state || (typeof state === 'object' && Object.keys(state).length === 0)) {
    return; // 空 state 不备份
  }
  // bak.2 → bak.3
  if (fs.existsSync(BACKUP_FILES[1])) {
    try { fs.copyFileSync(BACKUP_FILES[1], BACKUP_FILES[2]); }
    catch (e) { process.stderr.write(`[WARN] 备份轮转 ${path.basename(BACKUP_FILES[1])}→${path.basename(BACKUP_FILES[2])} 失败: ${e.message}\n`); }
  }
  // bak.1 → bak.2
  if (fs.existsSync(BACKUP_FILES[0])) {
    try { fs.copyFileSync(BACKUP_FILES[0], BACKUP_FILES[1]); }
    catch (e) { process.stderr.write(`[WARN] 备份轮转 ${path.basename(BACKUP_FILES[0])}→${path.basename(BACKUP_FILES[1])} 失败: ${e.message}\n`); }
  }
  // 当前 → bak.1
  try { fs.copyFileSync(STATE_FILE, BACKUP_FILES[0]); }
  catch (e) { process.stderr.write(`[WARN] 备份当前 state→${path.basename(BACKUP_FILES[0])} 失败: ${e.message}\n`); }
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
      // P1-C: 验证 lock.pid 是正整数,防止恶意 lock 文件触发 execSync 命令注入
      //      即使将来 process.kill 兜底失效(版本升级/类型放宽),也确保不传字符串到 shell
      const pidValid = typeof lock.pid === 'number' && Number.isInteger(lock.pid) && lock.pid > 0;
      if (pidValid) {
        const isAlive = (() => {
          try { process.kill(lock.pid, 0); return true; } catch { return false; }
        })();
        if (isAlive && lock.hostname === os.hostname()) {
          // 检查进程是否是 claude/node — 用 execFileSync 不走 shell,参数化传递
          try {
            const { execFileSync } = require('child_process');
            const cmdline = execFileSync('ps', ['-o', 'comm=', '-p', String(lock.pid)], { encoding: 'utf8', timeout: 2000 }).trim();
            if (cmdline.includes('claude') || cmdline.includes('node')) {
              die(`编排器已在运行 (pid ${lock.pid}, 启动于 ${lock.startTime})`);
            }
          } catch {}
        } else {
          // stale lock (PID 已死)或不同主机 — 允许覆盖
          process.stderr.write(`[phase-state] 检测到残留锁 (pid ${lock.pid} 已不存在)，自动清理\n`);
        }
      } else {
        // pid 无效(损坏或攻击构造) — 静默清理后重新获取
        process.stderr.write(`[phase-state] 锁文件损坏(pid 无效),自动清理\n`);
      }
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
  // P3-28: 与 P1-C 一致,改用 execFileSync 参数化(不经过 shell)
  //   - 旧实现 execSync('df -m . | tail -1') 走 shell + pipe,无注入风险但风格不一致
  //   - 新实现 execFileSync('df', ['-P', '.']) 取所有行,parse 倒数第二行的 Available
  //   - 跨平台:macOS df 默认 512-byte blocks,加 -P 用 1024-byte 标准化(更可移植)
  try {
    const { execFileSync } = require('child_process');
    const df = execFileSync('df', ['-P', '.'], { encoding: 'utf8' });
    return parseDfOutput(df, minMB);
  } catch (e) {
    return { ok: false, note: '无法检查磁盘空间，跳过', error: e.message };
  }
}

// P2-3: 抽出 parseDfOutput 纯函数,便于测试两种 df 输出格式
//   - macOS 默认 df:512-byte blocks,Available 在第 3 列(或变长列位)
//   - GNU df -P:1024-byte blocks,固定 6 列,Available 在第 4 列(parts[3])
//   - 缺省:用 parts[3] || parts[2] 兼容(parts[2] 是 Used;若 parts[3] 不可用回退)
//   - 测试覆盖见 atdo.test.js v2.0.x P2-3
function parseDfOutput(dfOutput, minMB = 500) {
  // df -P 输出格式:
  //   Filesystem     1024-blocks      Used Available Capacity Mounted on
  //   /dev/disk1s5   488245288 312345678 175899610    64%    /
  // macOS 默认 df 输出格式(无 -P):
  //   Filesystem    512-blocks      Used  Available Capacity iused      iused%  Mounted on
  //   /dev/disk1s5  976490576 312345678 175899610    64% ...
  const lines = dfOutput.trim().split('\n');
  if (lines.length < 2) return { ok: false, note: 'df 输出格式异常,跳过', error: 'lines < 2' };
  const parts = lines[1].trim().split(/\s+/);
  // -P 模式:Available 在第 4 列(parts[3])
  // macOS / 部分 Unix:Available 在第 4 列(parts[3])但 block size 不同
  // 老旧 BSD:可能在第 3 列(parts[2] 是 Available)
  // 用 fallback 兼容两种模式
  const available = parseInt(parts[3] || parts[2], 10);
  if (Number.isNaN(available)) {
    return { ok: false, note: 'df 输出无法解析,跳过', error: `parts: ${JSON.stringify(parts)}` };
  }
  if (available < minMB) {
    die(`磁盘可用空间不足: ${available}MB < ${minMB}MB`);
  }
  return { availableMB: available, minRequired: minMB, ok: true };
}

// ─── 心跳 ───────────────────────────────────────────────

const HEARTBEAT_STATUSES = ['active', 'paused', 'completed', 'failed'];

function writeHeartbeat(phaseId, taskId, status) {
  // P2-C: status 白名单(防止 LLM 传 "RUNNING"/"完成" 等异体字符串,让 watchdog 误判)
  if (status !== undefined && status !== null && status !== '' && !HEARTBEAT_STATUSES.includes(status)) {
    die(`heartbeat status 无效: "${status}",有效值: ${HEARTBEAT_STATUSES.join(', ')}`);
  }
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

// ─── Tier 3.5 任务列表型 plan 解析 (F-01) ─────────────────────
// 协议(见 SKILL.md Step 3 "Tier 3.5 — Freeform Markdown 任务列表型"):
//   - 二级标题 `### P<priority>-<index>` 作为 phase 边界(priority ∈ 0|1|2|3)
//   - 标题后的内容(到下一个 ### 或 ## 标题)合并成 tasks[] 数组
//   - 任务列表型 plan 无 depends_on,所有 phase 互相独立
//   - phase id 用 NN 格式顺序编号(从 00 开始)
//
// 调度策略(由 cmdInit 的 detection 阶段调用):
//   1. 扫 `### P[0-3]-N` 模式 → 命中 ≥ 1 → 启用 Tier 3.5
//   2. 同时存在 `## Phase N:` 或 `### Phase N:` → FATAL(语义冲突)
//   3. 无 `### P?-N` 但有 `## N.` 标题 → FATAL(只有分块,无任务项)
//
// 输入:plan 原始 markdown 文本
// 输出:解析后的 phases 数组(每项 {name, tasks, depends_on, ...} 形态,与现有
//      Tier 3 JSON 路径结构一致 — number/id 在 init 后续阶段统一分配)
function parseTaskListPlan(text) {
  const lines = text.split('\n');
  // 1) 扫所有 `### P[0-3]-N` 标题(必须 ≥ 1)
  const TASK_HEADER_RE = /^###\s+P([0-3])-(\d{1,2})\b\s*:?\s*(.*)$/;
  // 阶段序列型冲突检测(必须 0 命中,否则语义冲突 FATAL)
  const PHASE_HEADER_RE = /^#{2,3}\s*Phase\s+\d+/i;
  // 任务项:checkbox `- [ ] xxx` / `- [x] xxx` 或纯文本 `- xxx`
  const TASK_LINE_RE = /^\s*-\s+(?:\[[ xX]\]\s+)?(.+?)\s*$/;
  const taskHeaders = [];  // {priority, index, name, startLine}
  let hasPhaseSequence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (TASK_HEADER_RE.test(line)) {
      const m = line.match(TASK_HEADER_RE);
      // 保留 `P0-1: xxx` 完整前缀作为 phase name(用户友好 — 在 phase 列表中
      // 一眼看出优先级 + 序号)。如果标题只有 `### P0-1` 无 `:` 和内容,name 仍带 `P0-1`
      const tail = m[3].trim();
      const fullName = tail ? `P${m[1]}-${m[2]}: ${tail}` : `P${m[1]}-${m[2]}`;
      taskHeaders.push({
        priority: parseInt(m[1], 10),
        index: parseInt(m[2], 10),
        name: fullName,
        startLine: i,
      });
    }
    if (PHASE_HEADER_RE.test(line)) hasPhaseSequence = true;
  }
  if (taskHeaders.length === 0) return null;  // 调用方负责处理 "无 P?-N" 场景
  if (hasPhaseSequence) {
    die('plan 同时含 `## Phase N:` 和 `### P?-N`,语义冲突(阶段序列 vs 任务列表)。请统一为其中一种格式');
  }
  // 2) 解析每个 task header 后续内容为 tasks[]
  const phases = [];
  for (let i = 0; i < taskHeaders.length; i++) {
    const h = taskHeaders[i];
    const nextStart = i + 1 < taskHeaders.length ? taskHeaders[i + 1].startLine : lines.length;
    // 收集 h.startLine+1 到 nextStart-1 之间的任务行(到下一个 `##` / `###` 标题停止)
    const tasks = [];
    for (let j = h.startLine + 1; j < nextStart; j++) {
      const line = lines[j];
      // 遇到下一个二级/三级标题(任何)→ 提前终止
      if (/^#{1,3}\s+/.test(line)) break;
      const tm = line.match(TASK_LINE_RE);
      if (tm) {
        const taskText = tm[1].trim();
        if (taskText) tasks.push(taskText);
      }
    }
    phases.push({
      name: h.name,
      tasks,
      // 任务列表型无依赖,显式给空数组(供 init 后续统一处理)
      depends_on: [],
    });
  }
  return phases;
}

// ─── init plan tier 检测 (F-01) ─────────────────────────────
// 用于:cmdInit 接受 plan 输入时,根据结构自动选用对应解析器
// 当前支持:phase-sequence(JSON Tier 2 入口)/ task-list(Tier 3.5)
// 返回:phases 数组(供 init 后续统一处理 — 字段名 name/tasks/depends_on)
// 失败 → die(FATAL)
//
// 调用场景:cmdInit 解析 plan JSON 后,如果 plan.phases 字段为空/缺失,自动
//          把整个 stdin 当作 markdown 文本,走 Tier 3.5 检测
function detectAndParsePlan(plan, rawInput) {
  // Tier 2:plan JSON 已有 phases[] 字段 → 走老路径(向后兼容)
  if (Array.isArray(plan.phases) && plan.phases.length > 0) {
    return { tier: 'phase-sequence', phases: plan.phases };
  }
  // Tier 3.5 检测:phases 缺失/为空,但 stdin 给了原始 markdown 文本
  if (rawInput && typeof rawInput === 'string') {
    // 简单检测:含 `### P[0-3]-` 模式 → 启用 Tier 3.5
    // P3-29:统一 regex 与 SKILL.md L331 协议 /\d{1,2}\b/(1-2 位 index + word boundary)
    if (/^###\s+P[0-3]-\d{1,2}\b/m.test(rawInput)) {
      const phases = parseTaskListPlan(rawInput);
      if (phases && phases.length > 0) {
        return { tier: 'task-list', phases };
      }
      // 有 P?-N 模式但解析失败(如同时含 Phase N:)→ parseTaskListPlan 已 die
    }
  }
  // 兜底:不是任务列表型,plan.phases 也空 → 让后续 init 报"未找到任何阶段"
  return { tier: 'phase-sequence', phases: plan.phases || [] };
}

// ─── 命令处理 ───────────────────────────────────────────

const cmd = process.argv[2];
const args = process.argv.slice(3);

function cmdInit() {
  ensureDir();
  let plan;
  let rawInput = '';  // 保留 stdin 原始文本(F-01 Tier 3.5 检测用)
  try {
    // Read from stdin (avoid shell escaping) or fall back to args[0]
    rawInput = fs.readFileSync(0, 'utf8').trim() || args[0];
    if (!rawInput) throw new Error('empty input');
    plan = JSON.parse(rawInput);
  } catch {
    // F-01:stdin 不是合法 JSON,但可能含 markdown 任务列表型 plan
    // 1) 优先级合法 (P[0-3]-N) → 走 Tier 3.5
    // 2) 优先级越界 (P[4-9]-N) → FATAL,提示"形似任务列表型但 priority 越界"
    // 3) 完全不像任务列表型 → 走老路径,报"需要有效 JSON"
    // P3-29:统一 regex 与 SKILL.md L331 协议 /^###\s+P[0-3]-(\d{1,2})\b/m
    //   旧实现用 \d(单)只接受 1 位 index;新实现 \d{1,2}\b 接受 1-2 位
    //   TASK_HEADER_RE(L341)已用 \d{1,2}\b,这里保持一致
    if (rawInput) {
      if (/^###\s+P[0-3]-\d{1,2}\b/m.test(rawInput)) {
        plan = { phases: [] };  // 占位,让 detectAndParsePlan 走 Tier 3.5 路径
      } else if (/^###\s+P\d-\d{1,2}\b/m.test(rawInput)) {
        die('任务列表型 plan 的 priority 必须在 0/1/2/3 之一,收到形似 `### P?-N` 但 priority 越界。提示:如果 plan 是阶段序列型,使用 `## Phase N:` 格式');
      } else {
        die('init 需要有效的 JSON 输入（通过 stdin 或第一个参数传入）');
      }
    } else {
      die('init 需要有效的 JSON 输入（通过 stdin 或第一个参数传入）');
    }
  }
  // F-01:Tier 3.5 检测 — 如果 plan JSON 没有 phases[] 字段,但 stdin 文本含
  // `### P?-N` 模式,自动启用任务列表型解析。phase-sequence 路径走老逻辑(向后兼容)
  const detected = detectAndParsePlan(plan, rawInput);
  plan.phases = detected.phases;
  // 任务列表型无 depends_on,无需环检测(显式空数组,跳过),但保险起见仍走环检测
  // (空依赖图不会形成环,Kahn 算法会一次性遍历完,无副作用)
  // P2-D: 长度限制(name/goal/tasks 防止 DoS — 单 init 把 state.json 撑到 MB 级)
  const NAME_MAX = 200;
  const GOAL_MAX = 2000;
  const TASKS_MAX = 50;
  const TASK_LEN_MAX = 500;
  const phases = (plan.phases || []).map((p, i) => {
    const name = p.name || p.id || `Phase ${i + 1}`;
    if (typeof name !== 'string') die(`阶段 ${i + 1} name 必须是字符串`);
    if (name.length > NAME_MAX) die(`阶段 ${i + 1} name 长度 ${name.length} > ${NAME_MAX}`);
    const goal = p.goal || '';
    if (typeof goal !== 'string') die(`阶段 ${i + 1} goal 必须是字符串`);
    if (goal.length > GOAL_MAX) die(`阶段 ${i + 1} goal 长度 ${goal.length} > ${GOAL_MAX}`);
    const tasks = p.tasks || [];
    if (!Array.isArray(tasks)) die(`阶段 ${String(i + 1).padStart(2, '0')} tasks 必须是字符串数组(string[]),不是 number 也不是 {id, desc}[]。例:["task A", "task B"]`);
    if (tasks.length > TASKS_MAX) die(`阶段 ${i + 1} tasks 数量 ${tasks.length} > ${TASKS_MAX}。请将阶段拆分为多个更小的阶段`);
    for (const t of tasks) {
      if (typeof t !== 'string') die(`阶段 ${String(i + 1).padStart(2, '0')} task 必须是字符串(string),不是 ${typeof t} 也不是 {id, desc} 对象。例:["task A", "task B"]`);
      if (t.length > TASK_LEN_MAX) die(`阶段 ${i + 1} task 长度 > ${TASK_LEN_MAX}`);
    }
    return {
      number: String(i + 1).padStart(2, '0'),
      name,
      goal,
      tasks,
      successCriteria: p.success_criteria || [],
      dependsOn: p.depends_on || p.requires || [],
      isGate: p.is_gate !== undefined ? p.is_gate : (p.gate !== undefined ? p.gate : false),
      // Bug-06:gate 类型标识 — auto / manual / hybrid
      //   auto:   agent 全自动通过(默认,向后兼容)
      //   manual: 必须用户判断,orchestrator 暂停 + AskUserQuestion
      //   hybrid: agent 报告 + orchestrator 自动化检查 + 用户最终签字
      // 输入字段:gate_type(下划线,plan 风格) / gateType(camelCase)
      gateType: p.gate_type || p.gateType || 'auto',
      // P1-4:phase 类型标识 — implementation / verification
      //   implementation(默认):标准流程 pending → in_progress → executed → audited → fixed → gated → completed
      //   verification:        快速路径 pending → in_progress → executed → verified → gated → completed
      //                        跳过 audited/fixed(纯验证阶段无新代码产出,无需审计/修复)
      // 输入字段:phase_type(下划线,plan 风格) / phaseType(camelCase)
      phaseType: p.phase_type || p.phaseType || 'implementation',
      status: 'pending',
      commits: [],
      commitHash: null,  // 兼容字段:最后一个 commit 的 hash(单 hash 场景与多 hash 场景共用)
      startedAt: null,
      completedAt: null,
      statusSince: null,
    };
  });

  if (phases.length === 0) die('plan 中未找到任何阶段。请检查计划文件格式是否正确。');

  // ─── Plan 校验:LLM 不可信原则(depends_on 引用存在性、环检测、任务数警告)───
  const ids = new Set(phases.map(p => p.number));
  for (const p of phases) {
    // depends_on 引用存在性
    // 提示:阶段 id 是 2 位数字字符串(01/02/03),由位置自动分配
    //      depends_on 必须用自动分配的 id,如 ["01", "02"],不是 "phase1" / "1"
    for (const dep of p.dependsOn) {
      if (!ids.has(dep)) die(`阶段 ${p.number} depends_on 引用不存在的阶段 "${dep}"。阶段 id 由位置自动分配(2 位数字字符串),请用 ["01", "02"] 这种格式,而不是 "phase1"/"1"`);
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

  // Bug-09:planHash 字段(state.json 顶层可选)
  //   - 来源:plan JSON 顶层 planHash 字段(用户/上游自己算好 md5)
  //   - 缺失时不 FATAL(向后兼容 — 旧 init 调用无 planHash 必须继续工作)
  //   - 仅做基本类型校验(必须是字符串);非字符串 → FATAL(防 type confusion)
  //   - 写入 state.json 顶层,供 orchestrator 做防御性 md5 对比
  let planHash = null;
  if (plan && Object.prototype.hasOwnProperty.call(plan, 'planHash')) {
    if (typeof plan.planHash !== 'string') {
      die(`init: plan.planHash 必须是字符串(string),不是 ${typeof plan.planHash}。如果不需要 hash,请省略 planHash 字段`);
    }
    if (plan.planHash.length === 0) {
      die(`init: plan.planHash 不能是空字符串。如果不需要 hash,请省略 planHash 字段`);
    }
    // 长度上限:md5 是 32 hex,这里是 planHash 的最大可能值(留余量)
    if (plan.planHash.length > 64) {
      die(`init: plan.planHash 长度 ${plan.planHash.length} > 64(超过 md5+ 实际可能范围)`);
    }
    planHash = plan.planHash;
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
    // P2-7: 删除死字段 networkStatus(未实现 set-network-status 命令,init 写入后无任何读写)
    securityEvents: [],
    // P2-7: 删除死字段 exitReason(同上)
  };
  // Bug-09:planHash 写入顶层(仅当 plan JSON 提供了它,缺失时字段不存在 — 向后兼容)
  if (planHash !== null) {
    state.planHash = planHash;
  }
  writeState(state);
  process.stdout.write(JSON.stringify({ ok: true, phases: phases.length, planHash: planHash || undefined }, null, 2));
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
  const idx = state.phases.indexOf(phase);
  // P2-A: 状态机一致性 — 不允许把"未来"阶段直接 completed
  // LLM 幻觉或乱序调用会导致 phase X 已 completed 但游标未前进,后续逻辑错乱
  if (status === 'completed' && idx > state.currentPhaseIndex) {
    die(`阶段 ${phaseId} 不是当前阶段(游标在 ${state.phases[state.currentPhaseIndex]?.number || '?'}),不能直接 completed`);
  }
  // Bug-06: 状态机合法性校验 — 不允许跳过中间状态
  // 例:pending → completed 跳过 in_progress/executed/audited/fixed/gated → FATAL
  // 任何不在 ALLOWED_TRANSITIONS 中的 (from, to) 组合都拒绝
  // 例外 1:同状态(status === currentStatus)视为幂等,允许(避免 orchestrator 重复 set-phase 时误报)
  // 例外 2:currentStatus === 'pending' 视为起点(没有前任),仅校验目标在 ALLOWED_TRANSITIONS['pending'] 中
  const currentStatus = phase.status;
  if (currentStatus !== status) {  // 同状态短路
    const allowed = VALID_PREDECESSORS[status] || [];
    if (!allowed.includes(currentStatus)) {
      die(`阶段 ${phaseId} 状态非法转换: "${currentStatus}" → "${status}"。

允许的转换表:
${formatTransitionTable()}

提示:从 "${currentStatus}" 只能转换到: ${(ALLOWED_TRANSITIONS[currentStatus] || ['(终态,不可再转)']).join(', ')}`);
    }
  }
  // 终态保护:'completed' / 'user-review-fail' 不可再转换
  if (TERMINAL_STATUSES.includes(currentStatus) && currentStatus !== status) {
    die(`阶段 ${phaseId} 已是终态 "${currentStatus}",不可再转换。终态列表: ${TERMINAL_STATUSES.join(', ')}`);
  }
  // P1-4: verification 快速路径仅限 phaseType='verification' 的 phase
  // 防止 orchestrator 误操作将 implementation phase 送入 verified 状态,跳过 audit/fix
  if (status === 'verified' && (phase.phaseType || 'implementation') !== 'verification') {
    die(`阶段 ${phaseId} phaseType="${phase.phaseType || 'implementation'}",不允许进入 verified 状态。只有 phaseType="verification" 的纯验证阶段才能走此快速路径。implementation 阶段请走 audited → fixed 标准路径。`);
  }
  phase.status = status;
  phase.updatedAt = new Date().toISOString();
  phase.statusSince = new Date().toISOString();
  if (status === 'in_progress' && !phase.startedAt) phase.startedAt = new Date().toISOString();
  if (status === 'completed') {
    phase.completedAt = new Date().toISOString();
    // 单调推进:completed 时把游标推到下一阶段
    if (idx === state.currentPhaseIndex && idx + 1 < state.phases.length) {
      state.currentPhaseIndex = idx + 1;
    }
  }
  // Bug-06: 顶层 awaiting_user_review 字段(可选,manual gate 进行时存在,清理由下次 set-phase 完成态触发)
  if (status === 'awaiting_user_review') {
    state.awaiting_user_review = {
      phaseId,
      askedAt: new Date().toISOString(),
      // optionsShown 由 orchestrator 在 AskUserQuestion 中提供,这里不强制结构
      optionsShown: ['pass', 'fail', 'request-changes', 'skip'],
    };
  } else if (status === 'user-review-pass' || status === 'user-review-fail' || status === 'completed') {
    // 离开 manual gate:清除顶层标记(仅当当前顶层就是本 phase 时,避免误清其他 phase 的标记)
    if (state.awaiting_user_review && state.awaiting_user_review.phaseId === phaseId) {
      delete state.awaiting_user_review;
    }
  }
  state.updatedAt = new Date().toISOString();
  writeState(state);
  process.stdout.write(JSON.stringify({ ok: true, phase: phaseId, status, currentPhaseIndex: state.currentPhaseIndex }));
}

// P2-5: 抽 helper — 从 currentPhaseIndex 起找第一个 !== completed 的 phase
// cmdGetCurrentPhase 用它做游标推进,cmdSummary 用它做"当前阶段"读出
// DRY:两边共用同一游标推进逻辑,未来调整(例:跳过 user-review-fail)只改一处
function findCurrentPhase(state) {
  const startIdx = state.currentPhaseIndex || 0;
  for (let i = startIdx; i < state.phases.length; i++) {
    if (state.phases[i].status !== 'completed') {
      return { phase: state.phases[i], index: i };
    }
  }
  return { phase: null, index: startIdx };
}

function cmdGetCurrentPhase() {
  const state = readState();

  // 单调推进:从 currentPhaseIndex 位置开始,找第一个 status !== 'completed' 的阶段
  // 编排器每完成一阶段调用 set-phase ... completed,游标才前进
  // 中间态(executed/audited/fixed/gated)被识别为"还在做",不前进游标
  // P2-E: 只在游标实际变化时写盘(性能优化 — 5 次 get 不再触发 5 次备份轮转)
  const { phase, index } = findCurrentPhase(state);
  let cursorChanged = false;
  if (phase) {
    if (index !== state.currentPhaseIndex) {
      state.currentPhaseIndex = index;
      cursorChanged = true;
    }
  }

  if (!phase) {
    process.stdout.write(JSON.stringify({ done: true, message: "所有阶段已完成" }));
    return;
  }

  if (cursorChanged) writeState(state);
  const result = {
    number: phase.number,
    name: phase.name,
    goal: phase.goal,
    tasks: phase.tasks,
    isGate: phase.isGate,
    status: phase.status,
    // P2-6: ACTIVE_STATUSES 真正投入使用 — 标记 phase 是否处于"活跃中间态"
    // orchestrator 据此判断"phase 还在做事"还是"已完成/已失败",不再依赖 status 字符串
    isActive: ACTIVE_STATUSES.includes(phase.status),
    // P1-4: 返回 phaseType 让 orchestrator 判断应走标准路径还是 verification 快速路径
    phaseType: phase.phaseType || 'implementation',
    totalPhases: state.phases.length,
    index: state.currentPhaseIndex,
  };
  // P1-2: 协议承诺 awaiting_user_review 时返回 awaitingUserReview: true
  // orchestrator 据此判断 "manual gate 期间,等用户答复" 而非解析 status 字符串
  if (phase.status === 'awaiting_user_review') {
    result.gateType = 'manual';
    result.awaitingUserReview = true;
  }
  process.stdout.write(JSON.stringify(result));
}

function cmdIncStrike() {
  const state = readState();
  const phaseId = args[0];
  // rawType 用于校验是否传了空串;type 用于实际写入,默认 execution
  const rawType = args[1];
  const type = rawType || 'execution';
  // 参数校验:phaseId 必须存在,type 必须符合规范
  if (!phaseId) die('inc-strike 需要 phaseId 作为第一个参数');
  if (rawType !== undefined) {
    if (typeof rawType !== 'string' || rawType.trim() === '') {
      die('inc-strike type 不能为空字符串');
    }
    // P2-B: type 严格白名单(防止 LLM 幻觉写 "../../../etc/passwd" / emoji / 超长字符串)
    if (rawType.length > 32) {
      die(`inc-strike type 长度 ${rawType.length} > 32`);
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(rawType)) {
      die(`inc-strike type 只能含字母/数字/-/_,收到: "${rawType}"`);
    }
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
  // P3-3: 达到阈值时输出 ALERT 建议到 stderr
  //   - 不直接写文件(由 orchestrator 决定是否落盘)
  //   - 输出格式遵循 SKILL.md 协议(让 orchestrator 能 parse)
  //   - 多维度同时触发时合并输出(避免重复)
  if (maxed) {
    const alerts = [];
    if (maxedPhase) {
      alerts.push(`- **phaseRetry 触发**: ${phaseId} 的 ${type} 已 ${count}/${STRIKE_THRESHOLDS.phaseRetry} 次,建议升级 manual gate 或暂停该 phase`);
    }
    if (maxedRegression) {
      alerts.push(`- **regression 触发**: 全局 regression 已 ${count}/${STRIKE_THRESHOLDS.regression} 次,建议暂停回退所有未完成 phase 并重新审计`);
    }
    if (maxedCategory) {
      alerts.push(`- **sameCategory 触发**: ${type} 类问题跨阶段累计 ${categoryCount}/${STRIKE_THRESHOLDS.sameCategory} 次,建议升级为系统性重构`);
    }
    const alertBlock = [
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '⚠️  [atdo ALERT] 3-strike 触发 — 建议写入 ALERT.md',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      `阶段: ${phaseId}`,
      `类型: ${type}`,
      `phaseRetry 计数: ${count}/${STRIKE_THRESHOLDS.phaseRetry} (maxed=${maxedPhase})`,
      `regression 计数: ${state.strikes.regression || 0}/${STRIKE_THRESHOLDS.regression} (maxed=${maxedRegression})`,
      `sameCategory 计数: ${categoryCount || 0}/${STRIKE_THRESHOLDS.sameCategory} (maxed=${maxedCategory})`,
      '',
      '建议行动:',
      ...alerts,
      '',
      '提示: ALERT 内容由 orchestrator 决定是否写入 .phase-execution/ALERT.md;',
      '      phase-state.js 不自动写文件(避免覆盖已有 ALERT 内容)。',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n');
    process.stderr.write(alertBlock + '\n');
  }
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
  const raw = args[1];
  const phase = state.phases.find(p => p.number === phaseId);
  if (!phase) die(`阶段 ${phaseId} 不存在`);
  // Bug-03: 支持 comma-separated 多 hash(agent 一次产 N 个 commit 场景)
  //   例子:record-commit 01 32db291,3c79edb,078de4c
  //   - 全部校验通过 → 全部写入 phase.commits(数组),并把最后一个 hash 同步到 phase.commitHash(兼容字段)
  //   - 任一不通过 → FATAL(精确指出哪个 hash 在哪个位置无效),原子性:不部分写入
  //   - 空字符串 / 仅空白 / 仅逗号 / 末尾悬空逗号 → FATAL
  //   - 单 hash 调用("abc1234")仍按单元素数组处理,完全向后兼容
  if (typeof raw !== 'string' || raw.trim() === '') {
    die(`record-commit 需要非空的 hash 参数(支持单 hash 或逗号分隔的多个 hash)。例如: record-commit ${phaseId} abc1234 或 record-commit ${phaseId} abc1234,def5678`);
  }
  const parts = raw.split(',').map(s => s.trim());
  // 1) 任何空片段都拒绝(含末尾悬空逗号、中间空段、纯逗号)
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '') {
      die(`无效的 commit hash 列表: 位置 ${i + 1} 为空(原始参数: "${raw}")。正确格式: "hash1,hash2,hash3",hash 之间用英文逗号分隔,不要带空格或空段`);
    }
  }
  // 2) 任何 hash 不符合 7-40 位 hex 字符 → 拒绝(精确指出位置)
  // 但 "HEAD"(大小写不敏感)是例外 — P1-2: 解析为当前 HEAD 的完整 hash
  const HASH_RE = /^[a-f0-9]{7,40}$/i;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].toUpperCase() === 'HEAD') {
      try {
        const { execFileSync } = require('child_process');
        const resolved = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim();
        if (!HASH_RE.test(resolved)) {
          die(`record-commit: 无法解析 HEAD → "${resolved}" 不匹配 7-40 位 hex 字符`);
        }
        parts[i] = resolved;
      } catch (e) {
        die(`record-commit: 无法解析 HEAD(git rev-parse 失败): ${e.message}`);
      }
    }
  }
  for (let i = 0; i < parts.length; i++) {
    if (!HASH_RE.test(parts[i])) {
      die(`无效的 commit hash: 位置 ${i + 1} 的 "${parts[i]}" 不匹配 7-40 位 hex 字符(原始参数: "${raw}")。正确格式: "hash1,hash2,hash3",例:32db291,3c79edb,078de4c`);
    }
  }
  // 3) 全部校验通过 → 原子写入(此时 state 还没动过,validate-then-write 天然原子)
  phase.commits = parts;
  phase.commitHash = parts[parts.length - 1];  // 兼容字段:SKILL.md 报告模板与 E2E 测试读这个
  state.updatedAt = new Date().toISOString();
  writeState(state);
  process.stdout.write(JSON.stringify({ ok: true, phase: phaseId, commits: parts, count: parts.length }));
}

function cmdSanitize() {
  const filepath = args[0];
  if (!filepath) die('sanitize 需要文件路径作为参数');
  // P1-1: 路径白名单——只允许 .phase-execution/ 下的文件
  // 防止恶意调用读取/改写系统文件(/.ssh/id_rsa、/etc/passwd 等)
  // macOS 上 /var 是 /private/var 的符号链接,test 可能用未归一化路径:
  //   cwd = /private/var/.../atdo-test-XXX/
  //   传入 filepath = /var/.../atdo-test-XXX/.phase-execution/t.txt(未归一化)
  // 解决:用 realpathSync 归一化两边;文件不存在时回退到 lexical 检查
  const cwdReal = fs.realpathSync(process.cwd());
  const stateDirReal = path.join(cwdReal, STATE_DIR);
  const targetResolved = path.resolve(filepath);
  if (fs.existsSync(filepath)) {
    // 文件存在:realpath 归一化后比对(同时拦截 symlink 逃逸)
    const targetReal = fs.realpathSync(filepath);
    if (targetReal !== stateDirReal && !targetReal.startsWith(stateDirReal + path.sep)) {
      die(`sanitize: 目标 ${targetReal} 不在 ${STATE_DIR}/ 内(可能是 symlink 逃逸)`);
    }
  } else {
    // 文件不存在:lexical 检查识别路径穿越(如 .phase-execution/../../etc/passwd)
    if (targetResolved !== stateDirReal && !targetResolved.startsWith(stateDirReal + path.sep)) {
      die(`sanitize 仅允许处理 ${STATE_DIR}/ 下的文件(收到: ${filepath}, 解析后: ${targetResolved})`);
    }
    die(`文件 ${filepath} 不存在`);
  }
  // 到这里文件必然存在(P2-F: 删掉冗余的二次 existsSync 检查)
  const content = fs.readFileSync(filepath, 'utf8');
  const sanitized = sanitize(content);
  // P2-14: SKILL.md 协议 L1256 要求 sanitize 写 securityEvents 到 state.json
  // 算法:数原文中 SECRET_PATTERNS 命中总数(replace 命中)
  let secretsFound = 0;
  if (sanitized !== content) {
    for (const pattern of SECRET_PATTERNS) {
      // match 可能 null(无匹配);global flag 影响 matchAll 但不改变 match
      const matches = content.match(pattern) || [];
      secretsFound += matches.length;
    }
    fs.writeFileSync(filepath, sanitized, 'utf8');
    // 写 state.json.securityEvents — 容忍 state.json 不存在(无 state 时跳过,不让 sanitize 命令强制 init)
    if (fs.existsSync(STATE_FILE)) {
      try {
        const state = readState();
        if (!Array.isArray(state.securityEvents)) state.securityEvents = [];
        state.securityEvents.push({
          file: filepath,
          at: new Date().toISOString(),
          secretsFound,
        });
        state.updatedAt = new Date().toISOString();
        writeState(state);
      } catch (e) {
        // securityEvents 写失败不应阻塞 sanitize 主流程(已成功脱敏 + 写文件)
        process.stderr.write(`[WARN] sanitize 写 securityEvents 失败: ${e.message}\n`);
      }
    }
    process.stdout.write(JSON.stringify({ sanitized: true, file: filepath, secretsFound, eventCount: fs.existsSync(STATE_FILE) ? readState().securityEvents.length : 0 }));
  } else {
    process.stdout.write(JSON.stringify({ sanitized: false, file: filepath, secretsFound: 0 }));
  }
}

function cmdSummary() {
  const state = readState();
  const completed = state.phases.filter(p => p.status === 'completed').length;
  const total = state.phases.length;
  // P2-5: 与 cmdGetCurrentPhase 共用 findCurrentPhase helper
  const { phase: current } = findCurrentPhase(state);
  process.stdout.write(JSON.stringify({
    completed,
    total,
    current: current ? { number: current.number, name: current.name, status: current.status } : null,
    strikes: state.strikes,
    // P2-7: 删掉死字段 exitReason
  }));
}

// ─── unlock 严格化 (Bug-08) ────────────────────────────────
// 协议:lock 从 atdo 启动持续持有 → 所有 phase completed 时才 unlock
// unlock 必须显式带 --reason 参数,防止 orchestrator 误调
// 合法 reason 列表:
//   - all-completed:所有 phase 走完,正常完成(Step 9 收尾)
//   - aborted       :用户显式终止('a' at checkpoint / external kill)
//   - alert         :3-strike ALERT 触发,必须释放以让用户介入
// 任何不在此列表的 reason / 不带 --reason → FATAL
// (unlock 是不可逆的危险操作,严防误释放)
const UNLOCK_REASONS = ['all-completed', 'aborted', 'alert'];

function cmdUnlock() {
  // args 形如: ['--reason=alert'] / ['--reason', 'alert'] / [] (拒绝)
  // 复用 cmdIncStrike 的同样模式:严格白名单 + 显式确认
  // Bug-08:unlock 必须显式带 --reason 参数,即使 "alert" 看似最常见,也要求写明
  const VALID = /^--reason(?:=([a-z-]+))?$/;
  let reason = null;
  for (const a of args) {
    const m = a.match(VALID);
    if (!m) continue;
    if (!m[1]) {
      die(`unlock: --reason 必须有值,合法 reason: ${UNLOCK_REASONS.join(' | ')}`);
    }
    if (!UNLOCK_REASONS.includes(m[1])) {
      die(`unlock: 无效 reason "${m[1]}",合法 reason: ${UNLOCK_REASONS.join(' | ')}`);
    }
    reason = m[1];
    break;
  }
  if (!reason) {
    die(`unlock 必须显式带 --reason 参数。合法 reason: ${UNLOCK_REASONS.join(' | ')}
例: unlock --reason=all-completed
    unlock --reason=aborted
    unlock --reason=alert
原因:unlock 是不可逆的危险操作,lock 从 atdo 启动持续持有直到所有 phase 完成
     释放 lock 意味着允许并发 /atdo 实例启动,引入 state.json 游标错乱风险
     显式 --reason 强制 orchestrator 写明释放原因,防止"以为是无害操作"误调`);
  }
  releaseLock();
  // 写一条审计记录到 stderr(便于 watchdog / 调试追溯"谁在何时为什么 unlock")
  process.stderr.write(`[phase-state] unlock reason=${reason} at ${new Date().toISOString()}\n`);
  process.stdout.write(JSON.stringify({ ok: true, reason, at: new Date().toISOString() }));
}

// ─── userConfirmations (Bug-07) ──────────────────────────
// 协议:phase-scoped 一次性确认
//   - record-confirm <phaseId> <decision> 追加 userConfirmation 到 state.json
//   - has-confirm <phaseId>                 exit 0 = 已确认 / exit 1 = 未确认
// decision 必须严格 ∈ {c, s, a},非法值 FATAL
// 同一 phase 多次 confirm:数组累计(不覆盖,保留历史)
// 旧 state.json 无 userConfirmations 字段时视为空数组(向后兼容)
const VALID_DECISIONS = ['c', 's', 'a'];

function cmdRecordConfirm() {
  const state = readState();
  const phaseId = args[0];
  const decision = args[1];
  if (!phaseId) die('record-confirm 需要 phaseId 作为第一个参数');
  if (!decision) die('record-confirm 需要 decision 作为第二个参数 (c | s | a)');
  if (!VALID_DECISIONS.includes(decision)) {
    die(`record-confirm: 无效 decision "${decision}",合法值: ${VALID_DECISIONS.join(' | ')}`);
  }
  // phaseId 引用存在性(防止 phaseId 拼写错误时污染 state)
  if (!state.phases.find(p => p.number === phaseId)) {
    die(`record-confirm: 阶段 ${phaseId} 不存在`);
  }
  // 顶层 userConfirmations 数组(按需创建,init 不预创建)
  if (!Array.isArray(state.userConfirmations)) state.userConfirmations = [];
  // P2-15: 防止 LLM 幻觉 / 恶意脚本在循环中累积,加单 phase 上限
  const phaseConfirms = state.userConfirmations.filter(c => c.phaseId === phaseId);
  if (phaseConfirms.length >= MAX_CONFIRMATIONS_PER_PHASE) {
    die(`record-confirm: phase ${phaseId} 已累积 ${phaseConfirms.length} 条确认,达上限 ${MAX_CONFIRMATIONS_PER_PHASE}。可能 LLM 循环调用 — 请人工介入。`);
  }
  const entry = {
    phaseId,
    scope: 'phase-full',  // 固定值,目前协议只支持 phase-full
    decidedAt: new Date().toISOString(),
    decision,
  };
  state.userConfirmations.push(entry);
  state.updatedAt = new Date().toISOString();
  writeState(state);
  process.stdout.write(JSON.stringify({ ok: true, ...entry, total: state.userConfirmations.length }));
}

function cmdHasConfirm() {
  const state = readState();
  const phaseId = args[0];
  if (!phaseId) die('has-confirm 需要 phaseId 作为参数');
  // 向后兼容:旧 state.json 无 userConfirmations 字段时视为空数组
  const confirmations = Array.isArray(state.userConfirmations) ? state.userConfirmations : [];
  // P2-12: LIFO 语义 — 取该 phase 的最后一条确认(用户最新决策优先)
  //   例:phase 01 先 c 同意,后 a 终止,has-confirm 应返 a(让 orchestrator 知道用户已终止)
  //   旧实现 find() 取第一条,在"先 c 后 a"场景会返 c,orchestrator 误以为用户同意
  //   LIFO 语义:用户最新决策代表"现在的意图",历史 c 仅作审计
  const phaseConfirms = confirmations.filter(c => c.phaseId === phaseId);
  const found = phaseConfirms.length > 0 ? phaseConfirms[phaseConfirms.length - 1] : null;
  if (found) {
    // 已确认(任意 decision:c / s / a 都算,避免 orchestrator 误以为要重新问)
    process.stdout.write(JSON.stringify({ confirmed: true, phaseId, decision: found.decision, decidedAt: found.decidedAt }));
    process.exit(0);
  } else {
    process.stdout.write(JSON.stringify({ confirmed: false, phaseId }));
    process.exit(1);
  }
}

// ─── summary.md 长度校验 (Bug-10) ──────────────────────────
// 协议:每个 phase 的 .phase-execution/phases/<phaseId>/summary.md
//      字符数 ≤ SUMMARY_MAX_CHARS(= 500),中文字符按 1 char 计
// orchestrator 在 phase 收尾写完 summary.md 后立即调此命令校验
//
// 退出码:
//   0 — 字符数 ≤ 500,stdout 输出"✅ summary.md is X chars (≤500)"
//   1 — 字符数 > 500,stderr 输出实际字符数 + 前 100 字符预览
//   2 — summary.md 文件不存在
//   3 — 文件不是 UTF-8(无法按字符计数)
//   4 — 文件为空
//
// 字符数统计:JS text.length(UTF-16 code unit),与文件字节数无关
// 边界:500 字符正好是 500 chars(含),即 length === 500 → PASS
function cmdValidateSummary() {
  const phaseId = args[0];
  if (!phaseId) die('validate-summary 需要 phaseId 作为第一个参数');
  // phaseId 引用存在性(防止 phaseId 拼写错误时读非预期路径)
  const state = readState();
  if (!state.phases.find(p => p.number === phaseId)) {
    die(`validate-summary: 阶段 ${phaseId} 不存在`);
  }
  // 路径:与 SKILL.md Step 9 写 summary 的 heredoc 路径保持一致
  // 实际位置:.phase-execution/phases/<phaseId>/summary.md
  const summaryPath = path.join('.phase-execution', 'phases', phaseId, 'summary.md');
  if (!fs.existsSync(summaryPath)) {
    process.stderr.write(`[phase-state] validate-summary: ${summaryPath} 不存在。请先在 Step 9 写完 summary.md 再校验。\n`);
    process.exit(2);
  }
  // 读文件 + UTF-8 校验 + 字符数统计
  // Node.js fs.readFileSync 默认 'utf8' 编码:若文件不是合法 UTF-8,会输出替换字符 �
  // 这里检测替换字符数量,>0 视为非 UTF-8(exit 3)
  let content;
  try {
    const buf = fs.readFileSync(summaryPath);
    content = buf.toString('utf8');
    // 校验 UTF-8 有效性:替换字符 U+FFFD 的出现暗示原始字节不是合法 UTF-8
    if (content.includes('�')) {
      process.stderr.write(`[phase-state] validate-summary: ${summaryPath} 不是合法 UTF-8 文件(包含替换字符)\n`);
      process.exit(3);
    }
  } catch (e) {
    process.stderr.write(`[phase-state] validate-summary: 读取 ${summaryPath} 失败: ${e.message}\n`);
    process.exit(3);
  }
  // 空文件检测(content.trim() 为空,含纯空白)
  if (content.trim() === '') {
    process.stderr.write(`[phase-state] validate-summary: ${summaryPath} 是空文件。请写入本阶段总结(关键决策 / commit hash / 已知遗留)\n`);
    process.exit(4);
  }
  // 字符数统计:Array.from(content).length(Unicode code point 数) — P2-16 修复
  // 原 text.length 是 UTF-16 code unit,emoji 😀 / 罕用汉字 = 2 chars 误算
  // 改用 Array.from 取迭代器(spread 同样),每个 code point 算 1 char
  // 边界:500 字符正好是 500 chars(含),即 length === 500 → PASS
  const charCount = Array.from(content).length;
  if (charCount > SUMMARY_MAX_CHARS) {
    // 超长:输出实际字符数 + 前 100 字符预览(辅助用户定位冗余)
    // 预览:取前 100 chars,过长部分加省略号
    const preview = content.length > 100
      ? content.slice(0, 100) + '...'
      : content;
    process.stderr.write(`[phase-state] validate-summary: ${summaryPath} 超长 (${charCount} chars > ${SUMMARY_MAX_CHARS})。请精简,删除详细日志 / 代码片段 / 装饰符,只保留关键决策 + commit hash + 已知遗留。\n`);
    process.stderr.write(`前 100 字符预览:\n${preview}\n`);
    process.exit(1);
  }
  // PASS
  process.stdout.write(`✅ summary.md is ${charCount} chars (≤${SUMMARY_MAX_CHARS})`);
}

// ─── 锁持有时长检查 (Bug-08 / P3-24) ──────────────────────
// 协议:lock 持有超过 24h 警告但需人工确认(不自动释放)
// 场景:某个 phase 跑死/被 kill,lock 残留。24h 后自动警告提醒人工 unlock。
// 退出码:
//   0 — lock 不存在 / 持有时长 < 24h(正常)
//   1 — lock 持有时长 ≥ 24h(警告,但不 FATAL,不自动 unlock)
function cmdCheckLockAge() {
  if (!fs.existsSync(LOCK_FILE)) {
    process.stdout.write(JSON.stringify({ exists: false, ageHours: 0, warning: false }));
    return;  // 退出码 0
  }
  const lock = readJSON(LOCK_FILE);
  if (!lock || !lock.startTime) {
    // lock 损坏 — 不警告(让 acquireLock 在下次启动时清理)
    process.stdout.write(JSON.stringify({ exists: true, ageHours: 0, warning: false, note: 'lock 损坏,跳过' }));
    return;
  }
  const startMs = new Date(lock.startTime).getTime();
  if (Number.isNaN(startMs)) {
    process.stdout.write(JSON.stringify({ exists: true, ageHours: 0, warning: false, note: 'lock.startTime 不可解析,跳过' }));
    return;
  }
  const ageMs = Date.now() - startMs;
  const ageHours = ageMs / (1000 * 60 * 60);
  const LOCK_AGE_WARN_HOURS = 24;
  if (ageHours >= LOCK_AGE_WARN_HOURS) {
    // 警告:输出到 stderr(让 orchestrator / cron 看到),不 FATAL
    process.stderr.write(
      `[WARN] lock 持有 ${ageHours.toFixed(1)} 小时(超过 ${LOCK_AGE_WARN_HOURS}h)。` +
      `可能 phase 跑死 / 被 kill 而未 unlock。请人工确认后 unlock(--reason=aborted|alert)。\n`
    );
    process.stdout.write(JSON.stringify({
      exists: true,
      ageHours: Math.round(ageHours * 10) / 10,
      warning: true,
      startTime: lock.startTime,
      pid: lock.pid,
    }));
    process.exit(1);
  }
  // 正常:输出持有时长,exit 0
  process.stdout.write(JSON.stringify({
    exists: true,
    ageHours: Math.round(ageHours * 10) / 10,
    warning: false,
    startTime: lock.startTime,
    pid: lock.pid,
  }));
}

// ─── planHash 对比 (Bug-09 / P2-17) ──────────────────────
// 协议:state.json 顶层 planHash 是 init 时记录的 plan md5(由用户/上游算好传入)
//   orchestrator 可选做"当前 plan-file vs state.planHash"对比,纯防御性
//   不一致 → 输出 INFO(不阻断),用于检测 init 后 plan file 被误改
// 此命令:读 plan-file 算 md5,与 state.planHash 对比,输出 match/mismatch
// 退出码:
//   0 — hash 一致(matched)
//   1 — hash 不一致(mismatch)
//   2 — state.json 无 planHash 字段(向后兼容 — init 时未传入)
//   3 — plan-file 不存在 / 读取失败
//   4 — plan-file 内容为空(空文件无 md5)
function cmdComparePlanHash() {
  const planFile = args[0];
  if (!planFile) die('compare-plan-hash 需要 plan-file 路径作为参数');
  // 读 plan file 内容(路径白名单不强求 — plan file 是用户/项目自有文件,非 .phase-execution/)
  if (!fs.existsSync(planFile)) {
    process.stderr.write(`[phase-state] compare-plan-hash: plan file ${planFile} 不存在\n`);
    process.exit(3);
  }
  let content;
  try {
    content = fs.readFileSync(planFile, 'utf8');
  } catch (e) {
    process.stderr.write(`[phase-state] compare-plan-hash: 读取 ${planFile} 失败: ${e.message}\n`);
    process.exit(3);
  }
  if (content.length === 0) {
    process.stderr.write(`[phase-state] compare-plan-hash: ${planFile} 是空文件,无 md5\n`);
    process.exit(4);
  }
  // 算 md5
  const crypto = require('crypto');
  const currentHash = crypto.createHash('md5').update(content, 'utf8').digest('hex');
  // 读 state.planHash
  const state = readState();
  if (!state.planHash) {
    process.stderr.write(`[phase-state] compare-plan-hash: state.json 无 planHash 字段(可能是旧 init 调用未传入)。当前 plan-file md5 = ${currentHash}\n`);
    process.exit(2);
  }
  if (currentHash === state.planHash) {
    process.stdout.write(JSON.stringify({ match: true, currentHash, stateHash: state.planHash }));
    process.exit(0);
  } else {
    process.stdout.write(JSON.stringify({ match: false, currentHash, stateHash: state.planHash, note: 'plan file 已被修改(init 后),state.json 仍按原 plan 执行' }));
    process.exit(1);
  }
}

// ─── summary 模板生成 (P3-4) ──────────────────────────────
// 协议:每个 phase 收尾写 summary.md 时,orchestrator 手写 heredoc 格式不一致
//   此命令输出统一模板,orchestrator 填充后写入 summary.md
// 模板遵循 SKILL.md "summary.md 长度约束" 的取舍规则:
//   应该写:关键决策/commit hash/文件路径/已知遗留
//   不应该写:详细日志/代码片段/LLM 推理过程/装饰符
// 输出:纯文本模板(orchestrator 用 heredoc 写入 summary.md 前先过目)
function cmdGenerateSummaryTemplate() {
  const phaseId = args[0];
  if (!phaseId) die('generate-summary-template 需要 phaseId 作为参数');
  const state = readState();
  const phase = state.phases.find(p => p.number === phaseId);
  if (!phase) die(`阶段 ${phaseId} 不存在`);
  const template = [
    `决策: <本阶段关键决策,如架构选型/拒绝的方案>`,
    `文件: <修改的文件路径,逗号分隔>`,
    `Commit: <commit hash>`,
    `Gate: ${phase.isGate ? '关口通过' : '非关口'}(methodology=<proxy|real|mixed>)`,
    `遗留: <已知未完成项,留给后续阶段>`,
  ].join('\n');
  process.stdout.write(template);
}

// ─── atdo-003 P1: proxy-recovery-decision ─────────────────
// 命令: proxy-recovery-decision <phaseId> <verdict> [--evidence=<path>] [--reason=<r>]
//   verdict ∈ {auto-pass, manual-required}
//   F1 [P0] 强约束: auto-pass 必须带 --evidence 文件，5 维全 PASS
//     防 LLM agent 偷懒触发 "agent 自报告 auto-pass" 违反 Bug-05 协议
//     auto-pass 的合规判据：orchestrator 直跑 5 维独立验证生成 evidence,
//     而非依赖 agent 自报告的 methodology=proxy + SUCCESS
//   manual-required 不需 evidence (升 manual gate)
//   reason ≤ 200 chars
//   幂等: 同 phase 同 verdict 重复调用 → exit 0 不重复写 (at 字段不变)
const PROXY_VERDICTS = ['auto-pass', 'manual-required'];
const REQUIRED_EVIDENCE_DIMENSIONS = ['fileExistence', 'syntax', 'diffRange', 'debugResidue', 'secretScan'];
const PROXY_REASON_MAX_CHARS = 200;

function cmdProxyRecoveryDecision() {
  const phaseId = args[0];
  const verdict = args[1];
  if (!phaseId) die('proxy-recovery-decision 需要 phaseId 作为第一个参数');
  if (!verdict) die(`proxy-recovery-decision 需要 verdict 作为第二个参数，合法 verdict: ${PROXY_VERDICTS.join(' | ')}`);
  if (!PROXY_VERDICTS.includes(verdict)) {
    die(`proxy-recovery-decision: 无效 verdict "${verdict}"，合法 verdict: ${PROXY_VERDICTS.join(' | ')}`);
  }

  // 解析 --evidence=<path> / --reason=<r>（与 cmdUnlock 相同的正则模式）
  let evidencePath = null;
  let reason = '';
  for (const a of args.slice(2)) {
    const mE = a.match(/^--evidence(?:=(.+))?$/);
    if (mE) {
      if (!mE[1]) die('proxy-recovery-decision: --evidence 必须有值（路径）');
      evidencePath = mE[1];
      continue;
    }
    const mR = a.match(/^--reason(?:=(.*))?$/);
    if (mR) {
      reason = mR[1] || '';
      continue;
    }
  }

  if (reason.length > PROXY_REASON_MAX_CHARS) {
    die(`proxy-recovery-decision: reason 长度 ${reason.length} 超 ${PROXY_REASON_MAX_CHARS} chars`);
  }

  // F1 核心: auto-pass 必须带 evidence 且 5 维全 PASS
  if (verdict === 'auto-pass') {
    if (!evidencePath) {
      die(`proxy-recovery-decision: verdict=auto-pass 必须带 --evidence=<path>
原因（F1 [P0]）：防 LLM agent 偷懒触发 "agent 自报告 auto-pass" 违反 Bug-05 协议
auto-pass 合规判据：orchestrator 直跑 5 维验证（fileExistence/syntax/diffRange/debugResidue/secretScan）
            生成 evidence.json，所有维度必须 PASS，命令二次校验`);
    }
    if (!fs.existsSync(evidencePath)) {
      die(`proxy-recovery-decision: evidence 文件不存在: ${evidencePath}`);
    }
    let evidence;
    try {
      const content = fs.readFileSync(evidencePath, 'utf8');
      evidence = JSON.parse(content);
    } catch (e) {
      die(`proxy-recovery-decision: evidence 文件非合法 JSON: ${e.message}`);
    }
    for (const dim of REQUIRED_EVIDENCE_DIMENSIONS) {
      if (evidence[dim] === undefined) {
        die(`proxy-recovery-decision: evidence 缺 ${dim} 维度（必需 5 维：${REQUIRED_EVIDENCE_DIMENSIONS.join(', ')}）`);
      }
      if (evidence[dim] !== 'PASS') {
        die(`proxy-recovery-decision: evidence.${dim} 必须为 "PASS"，当前 "${evidence[dim]}"`);
      }
    }
  }

  // 读 state，定位 phase
  const state = readState();
  const phase = state.phases.find(p => p.number === phaseId);
  if (!phase) die(`phase ${phaseId} 不存在`);

  // 幂等：同 verdict 重复调用 → exit 0，at 不变
  if (phase.proxyRecovery && phase.proxyRecovery.verdict === verdict) {
    process.stdout.write(JSON.stringify({
      ok: true,
      idempotent: true,
      phaseId,
      verdict,
      at: phase.proxyRecovery.at,
    }));
    return;
  }

  // 写入 proxyRecovery
  phase.proxyRecovery = {
    at: new Date().toISOString(),
    verdict,
    reason,
    evidence: evidencePath,
  };
  writeState(state);
  process.stdout.write(JSON.stringify({
    ok: true,
    phaseId,
    verdict,
    at: phase.proxyRecovery.at,
  }));
}

// ─── atdo-001 P2: check-workspace --suggest ─────────────────
// 命令: check-workspace --suggest
//   stdin: git status --porcelain 输出（XY <filename>，?? <filename> 等）
//   stdin: git status --porcelain 输出（XY <filename>，?? <filename> 等）
//   stdout 决策:
//     CLEAN                            (空输入 = 工作区干净)
//     SUGGEST_AUTO_STAGE\n<files>      (全部脏文件在豁免目录)
//     BLOCK: <non-exempt-files>        (任一非豁免脏文件)
//   豁免目录列表（F4 YAGNI：硬编码，未来可扩展为 config）
const WORKSPACE_EXEMPT_PATHS = [
  '.phase-execution/',  // atdo 运行时
  'doc/',                // D6 设计文档目录
  '_proc-use/',          // D7 过程文档目录
  '.serena/',            // Serena MCP 副产物（PLAN1 撞过的真实场景）
];

function cmdCheckWorkspace() {
  if (!args.includes('--suggest')) {
    die('check-workspace 当前仅支持 --suggest 模式');
  }
  // 读 stdin（git status --porcelain 输出）
  let stdin = '';
  try {
    stdin = fs.readFileSync(0, 'utf8');
  } catch (e) {
    die(`check-workspace: 读取 stdin 失败: ${e.message}`);
  }

  const lines = stdin.split('\n').filter(l => l.length > 0);
  if (lines.length === 0) {
    process.stdout.write('CLEAN');
    return;
  }

  // 解析 git status --porcelain 输出
  // 格式: 'XY filename' (X=index, Y=worktree, 2 字符 + 1 空格)
  //   或: '?? filename' (untracked)
  // 文件路径从位置 3 开始
  const exempt = [];
  const nonExempt = [];
  for (const line of lines) {
    const filepath = line.substring(3).trim();
    if (!filepath) continue;
    // rename 格式: 'R  oldname -> newname'，取 newname
    let actualPath = filepath;
    if (filepath.includes(' -> ')) {
      actualPath = filepath.split(' -> ')[1].trim();
    }
    const isExempt = WORKSPACE_EXEMPT_PATHS.some(prefix =>
      actualPath.startsWith(prefix)
    );
    if (isExempt) {
      exempt.push(actualPath);
    } else {
      nonExempt.push(actualPath);
    }
  }

  if (nonExempt.length > 0) {
    process.stdout.write(`BLOCK: ${nonExempt.join(', ')}`);
  } else {
    process.stdout.write(`SUGGEST_AUTO_STAGE\n${exempt.join('\n')}`);
  }
}

// ─── atdo-004 P2: advance-phase ─────────────────────────────
// 命令: advance-phase <phaseId> [--to=<status>]
//   F3 修订：按 phase.gateType 决策终点
//     gateType=auto      → 推到 completed
//     gateType=manual    → 推到 gated（让 manual gate 接管）
//     gateType=hybrid    → 推到 gated
//   边界:
//     awaiting_user_review / completed / user-review-fail → die

function chooseAutoPath(current, nexts, target) {
  // 1. 直达
  if (nexts.includes(target)) return target;
  // 2. BFS 找能到 target 的分支
  for (const next of nexts) {
    if (canReach(next, target)) return next;
  }
  return null;
}

function canReach(from, target) {
  if (from === target) return true;
  const visited = new Set([from]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift();
    const nexts = ALLOWED_TRANSITIONS[cur] || [];
    for (const n of nexts) {
      if (n === target) return true;
      if (!visited.has(n)) {
        visited.add(n);
        queue.push(n);
      }
    }
  }
  return false;
}

function cmdAdvancePhase() {
  const phaseId = args[0];
  if (!phaseId) die('advance-phase 需要 phaseId');

  // 解析 --to=<status>
  let targetStatus = null;
  for (const a of args.slice(1)) {
    const m = a.match(/^--to(?:=(.+))?$/);
    if (m && m[1]) targetStatus = m[1];
  }

  const state = readState();
  const phase = state.phases.find(p => p.number === phaseId);
  if (!phase) die(`phase ${phaseId} 不存在`);

  // 边界：终态 / manual gate 中 → die
  if (['completed', 'user-review-fail', 'awaiting_user_review'].includes(phase.status)) {
    die(`phase ${phaseId} 当前 status="${phase.status}"，不可 advance（终态或 manual gate 中）`);
  }

  // 默认终点按 gateType 决策（F3 修订）
  if (!targetStatus) {
    const gateType = phase.gateType || 'auto';
    targetStatus = (gateType === 'manual' || gateType === 'hybrid') ? 'gated' : 'completed';
  }

  // 校验 targetStatus
  if (!VALID_STATUSES.includes(targetStatus)) {
    die(`advance-phase: 无效 targetStatus "${targetStatus}"`);
  }

  // 已到目标 → noop OK（manual gate 已 gated 时常见）
  if (phase.status === targetStatus) {
    process.stdout.write(JSON.stringify({ ok: true, phaseId, status: targetStatus, noop: true }));
    return;
  }

  // 循环推进：每步调命令行 set-phase 复用全部校验
  const { spawnSync } = require('child_process');
  let current = phase.status;
  let safety = 20;
  const recordPath = [current];
  while (current !== targetStatus && safety-- > 0) {
    const nexts = ALLOWED_TRANSITIONS[current];
    if (!nexts || nexts.length === 0) {
      die(`advance-phase: 无法从 "${current}" 推进（无合法转换）`);
    }
    const next = chooseAutoPath(current, nexts, targetStatus);
    if (!next) {
      die(`advance-phase: 找不到从 "${current}" 到 "${targetStatus}" 的路径`);
    }
    // 调命令行 set-phase（复用全部校验逻辑：终态保护 / 游标推进 / awaiting_user_review 处理 / etc）
    const res = spawnSync('node', [__filename, 'set-phase', phaseId, next], {
      encoding: 'utf8',
      cwd: process.cwd(),
      env: process.env,
    });
    if (res.status !== 0) {
      die(`advance-phase: set-phase ${current} → ${next} 失败: ${(res.stderr || '').trim()}`);
    }
    recordPath.push(next);
    current = next;
  }

  if (safety <= 0) {
    die(`advance-phase: safety limit 触发（推进步骤超 20），疑似死循环`);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    phaseId,
    from: phase.status,
    to: targetStatus,
    path: recordPath,
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
  'record-confirm': cmdRecordConfirm,  // Bug-07
  'has-confirm': cmdHasConfirm,        // Bug-07
  'validate-summary': cmdValidateSummary,  // Bug-10
  'generate-summary-template': cmdGenerateSummaryTemplate,  // P3-4
  'proxy-recovery-decision': cmdProxyRecoveryDecision,  // atdo-003 P1
  'check-workspace': cmdCheckWorkspace,  // atdo-001 P2
  'advance-phase': cmdAdvancePhase,  // atdo-004 P2
  'compare-plan-hash': cmdComparePlanHash,  // Bug-09 / P2-17
  lock: () => { process.stdout.write(JSON.stringify(acquireLock())); },
  unlock: cmdUnlock,
  'check-disk': () => { process.stdout.write(JSON.stringify(checkDisk())); },
  'check-lock-age': cmdCheckLockAge,  // Bug-08 / P3-24
  sanitize: cmdSanitize,
  heartbeat: () => { writeHeartbeat(args[0], args[1], args[2]); process.stdout.write(JSON.stringify({ ok: true })); },
  summary: cmdSummary,
};

if (commands[cmd]) {
  commands[cmd]();
} else {
  // P2-2: 无参数调用时 cmd 是 undefined,字符串拼接会出现 "未知命令: undefined"
  // 显式区分两种情况:无参数 / 未知命令
  const cmdLabel = (cmd === undefined || cmd === null || cmd === '') ? '<未指定>' : cmd;
  process.stderr.write(`未知命令: ${cmdLabel}\n可用命令: ${Object.keys(commands).join(', ')}\n`);
  process.exit(1);
}
