#!/usr/bin/env node
/**
 * atdo skill 自动化测试
 * 用法: node _proc-use/reports/atdo.test.js
 * 退出码: 0 = 全部通过, 1 = 有失败
 *
 * 测试内容(按命令):
 *   init          — 正常/无效/空/字段别名/环/depends_on/任务数 WARN
 *   get           — 全状态/标量/点路径/缺失键/嵌套
 *   set-phase     — 合法/非法/白名单/游标推进/不存在阶段
 *   get-cur-phase — 推进/跳过 completed/done
 *   inc-strike    — 累加/三维度/参数校验/不存在阶段
 *   record-commit — 合法 hash/非法 hash
 *   sanitize      — 多种 token 全部 [REDACTED]
 *   check-disk    — 字段完整
 *   heartbeat     — 写入/字段
 *   lock/unlock   — 锁获取/释放/stale/active
 *   backup 轮转   — 主+多 bak 损坏按序回退 + WARN
 *   E2E 3 阶段    — 完整流程
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// 指向项目内的 phase-state.js(不指向 install 路径)
// 原因:测试应在项目根运行,加载当前 commit 的代码,而非 install 部署的副本。
//      install 路径可能在多分支开发中落后于源码,导致测试跑在过期代码上。
//      Bug-06 起改为项目内路径,SKILL_PATH 也是同样的相对路径风格。
const SCRIPT = path.join(__dirname, '../../scripts/phase-state.js');

function run(...args) {
  const res = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: process.env.TEST_CWD,
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  return {
    ok: res.status === 0,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    code: res.status || 0,
  };
}

function runIn(cwd, ...args) {
  const oldCwd = process.env.TEST_CWD;
  process.env.TEST_CWD = cwd;
  try {
    return run(...args);
  } finally {
    process.env.TEST_CWD = oldCwd;
  }
}

function initPlan(dir, plan) {
  return runIn(dir, 'init', plan);
}

// Bug-06:状态机辅助函数 —— 走完 phase 完整流程到 completed(pending → in_progress → executed → audited → fixed → gated → completed)
// 用于:旧测试期望"set-phase X completed"一步完成,但 Bug-06 引入的严格状态机要求走完所有中间态
//      用此函数替代直接的 "set-phase X completed" 以保持状态机一致性
// 失败时返回最后一次调用的结果(让测试 stderr 可见)
function runToCompleted(dir, phaseId) {
  const steps = ['in_progress', 'executed', 'audited', 'fixed', 'gated', 'completed'];
  let r;
  for (const s of steps) {
    r = runIn(dir, 'set-phase', phaseId, s);
    if (r.code !== 0) return r;
  }
  return r;
}

describe('init', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('正常 plan', () => {
    const r = initPlan(dir, JSON.stringify({ phases: [
      { number: '01', name: 'a', goal: 'g', tasks: ['t1'], is_gate: false },
    ]}));
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"phases":\s*1/);
  });

  test('字段别名 (success_criteria/depends_on/requires)', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
    try {
      const r = initPlan(d, JSON.stringify({ phases: [
        { number: '01', name: 'a', success_criteria: 'sc' },
        { number: '02', name: 'b', depends_on: ['01'] },
      ]}));
      assert.equal(r.code, 0);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('空 phases die', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
    try {
      const r = initPlan(d, JSON.stringify({ phases: [] }));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /未找到任何阶段/);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('无效 JSON die', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
    try {
      const r = initPlan(d, 'not json');
      assert.equal(r.code, 1);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('depends_on 引用不存在 die', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
    try {
      const r = initPlan(d, JSON.stringify({ phases: [
        { number: '01', name: 'a' },
        { number: '02', name: 'b', depends_on: ['99'] },
      ]}));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /不存在的阶段 "99"/);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('环依赖 die', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
    try {
      const r = initPlan(d, JSON.stringify({ phases: [
        { number: '01', name: 'a', depends_on: ['02'] },
        { number: '02', name: 'b', depends_on: ['01'] },
      ]}));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /循环依赖/);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('自依赖识别为环', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
    try {
      const r = initPlan(d, JSON.stringify({ phases: [
        { number: '01', name: 'a', depends_on: ['01'] },
      ]}));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /循环依赖/);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('任务数 >15 WARN 但不 die', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
    try {
      const tasks = Array.from({ length: 20 }, (_, i) => `t${i+1}`);
      const r = initPlan(d, JSON.stringify({ phases: [{ number: '01', name: 'a', tasks }] }));
      assert.equal(r.code, 0);
      assert.match(r.stderr, /20 个任务/);
      assert.match(r.stderr, />15/);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

describe('get', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
    initPlan(dir, JSON.stringify({ phases: [{ number: '01', name: 'phase-a' }] }));
  });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('读标量字段', () => {
    const r = runIn(dir, 'get', 'phases.0.name');
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'phase-a');  // get 标量走 String(val),不带 JSON 引号
  });

  test('读点路径嵌套', () => {
    const r = runIn(dir, 'get', 'strikes.regression');
    assert.equal(r.stdout, '0');
  });

  test('缺失键返回 null', () => {
    const r = runIn(dir, 'get', 'phases.0.nope');
    assert.equal(r.stdout, 'null');
  });

  test('无 key 返回全 state', () => {
    const r = runIn(dir, 'get');
    const j = JSON.parse(r.stdout);
    assert.ok(j.phases);
  });
});

describe('set-phase status 白名单 + 游标推进', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
    initPlan(dir, JSON.stringify({ phases: [
      { number: '01', name: 'a' }, { number: '02', name: 'b' }, { number: '03', name: 'c' },
    ]}));
  });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('合法 status 通过', () => {
    const r = runIn(dir, 'set-phase', '01', 'in_progress');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /"ok":\s*true/);
  });

  test('非法 status die', () => {
    const r = runIn(dir, 'set-phase', '01', 'notreal');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /无效 status/);
  });

  test('不存在的阶段 die', () => {
    const r = runIn(dir, 'set-phase', '99', 'in_progress');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /不存在/);
  });

  test('completed 自动推进游标 0→1', () => {
    // Bug-06:状态机要求走完整流程(gated 才能 → completed)
    const r = runToCompleted(dir, '01');
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"currentPhaseIndex":\s*1/);
  });

  test('中间态不动游标', () => {
    runIn(dir, 'set-phase', '02', 'in_progress');
    const r = runIn(dir, 'get', 'currentPhaseIndex');
    assert.equal(r.stdout, '1');
  });

  test('完成最后一阶段游标不越界', () => {
    // Bug-06:状态机要求走完整流程(走完 02 → 走完 03)
    const r2 = runToCompleted(dir, '02');
    assert.equal(r2.code, 0, r2.stderr);
    const r3 = runToCompleted(dir, '03');
    assert.match(r3.stdout, /"currentPhaseIndex":\s*2/);
  });
});

describe('get-current-phase 单调推进', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
    initPlan(dir, JSON.stringify({ phases: [
      { number: '01', name: 'a' }, { number: '02', name: 'b' },
    ]}));
  });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('初始化后返 01', () => {
    const r = runIn(dir, 'get-current-phase');
    assert.match(r.stdout, /"number":\s*"01"/);
  });

  test('中间态(fixed)不前进游标', () => {
    runIn(dir, 'set-phase', '01', 'in_progress');
    runIn(dir, 'set-phase', '01', 'fixed');
    const r = runIn(dir, 'get-current-phase');
    assert.match(r.stdout, /"number":\s*"01"/);
  });

  test('完成 01 后返 02', () => {
    // Bug-06:状态机要求走完整流程
    runToCompleted(dir, '01');
    const r = runIn(dir, 'get-current-phase');
    assert.match(r.stdout, /"number":\s*"02"/);
  });

  test('全部 completed 返 done', () => {
    // Bug-06:状态机要求走完整流程
    runToCompleted(dir, '02');
    const r = runIn(dir, 'get-current-phase');
    assert.match(r.stdout, /"done":\s*true/);
  });
});

describe('inc-strike 三维度 + 参数校验', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
    initPlan(dir, JSON.stringify({ phases: [
      { number: '01', name: 'a' }, { number: '02', name: 'b' },
    ]}));
  });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('正常累加', () => {
    const r = runIn(dir, 'inc-strike', '01', 'execution');
    assert.equal(r.code, 0);
    assert.match(r.stdout, /"count":\s*1/);
  });

  test('无 phaseId die', () => {
    const r = runIn(dir, 'inc-strike');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /需要 phaseId/);
  });

  test('phaseId 不存在 die', () => {
    const r = runIn(dir, 'inc-strike', '99', 'type');
    assert.equal(r.code, 1);
  });

  test('type 空串 die', () => {
    const r = runIn(dir, 'inc-strike', '01', '');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /type 不能为空/);
  });

  test('5 次 type-safety 触发 sameCategory>=5', () => {
    for (let i = 0; i < 5; i++) runIn(dir, 'inc-strike', '02', 'type-safety');
    const r = runIn(dir, 'get', 'strikes.sameCategory.type-safety');
    assert.equal(r.stdout, '5');
  });

  test('2 次 regression 触发 maxedRegression', () => {
    runIn(dir, 'inc-strike', '01', 'regression');
    const r = runIn(dir, 'inc-strike', '01', 'regression');
    assert.match(r.stdout, /"maxedRegression":\s*true/);
  });
});

describe('record-commit hash 校验', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
    initPlan(dir, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
  });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('合法 7+ hex 字符', () => {
    const r = runIn(dir, 'record-commit', '01', 'abc1234');
    assert.equal(r.code, 0);
  });

  test('非法 hash die', () => {
    const r = runIn(dir, 'record-commit', '01', 'not-a-hash');
    assert.equal(r.code, 1);
  });
});

describe('Bug-03 record-commit comma-separated 多 hash', () => {
  // 用一个独立 dir 让每个 test 互不干扰(用 mkdtempSync 而非共享 before hook)
  function freshDir() {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-bug03-'));
    initPlan(d, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
    return d;
  }

  test('单 hash 仍然工作(向后兼容)', () => {
    const d = freshDir();
    try {
      const r = runIn(d, 'record-commit', '01', 'abc1234');
      assert.equal(r.code, 0, r.stderr);
      // 兼容字段 commitHash 必须仍可读(E2E 测试用)
      const get = runIn(d, 'get', 'phases.0.commitHash');
      assert.match(get.stdout, /abc1234/);
      // commits 数组应包含这一个 hash
      const getArr = runIn(d, 'get', 'phases.0.commits');
      assert.match(getArr.stdout, /abc1234/);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('3 个 comma-separated hash 全部记录', () => {
    const d = freshDir();
    try {
      const r = runIn(d, 'record-commit', '01', '32db291,3c79edb,078de4c');
      assert.equal(r.code, 0, r.stderr);
      // 计数正确
      assert.match(r.stdout, /"count":\s*3/);
      // commits 数组包含全部 3 个 hash(用 JSON 字符串顺序保证不被误匹配)
      const get = runIn(d, 'get', 'phases.0.commits');
      assert.match(get.stdout, /"32db291"/);
      assert.match(get.stdout, /"3c79edb"/);
      assert.match(get.stdout, /"078de4c"/);
      // 兼容字段 commitHash 应等于最后一个 hash
      const getLast = runIn(d, 'get', 'phases.0.commitHash');
      assert.match(getLast.stdout, /078de4c/);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('中间一个无效 hash → 全部拒绝(原子性)', () => {
    const d = freshDir();
    try {
      // 先记一个合法 hash,作为基线
      runIn(d, 'record-commit', '01', 'aaaaaaa');
      // 再尝试一个含无效 hash 的列表:32db291 合法,badhash 非法,078de4c 合法
      const r = runIn(d, 'record-commit', '01', '32db291,badhash,078de4c');
      assert.equal(r.code, 1, '应该 FATAL');
      // 错误消息精确指出位置 2
      assert.match(r.stderr, /位置\s*2/);
      // 原子性:state 不应被部分写入,commits 仍为基线的 ["aaaaaaa"]
      const get = runIn(d, 'get', 'phases.0.commits');
      assert.match(get.stdout, /aaaaaaa/);
      assert.doesNotMatch(get.stdout, /32db291/);
      assert.doesNotMatch(get.stdout, /badhash/);
      assert.doesNotMatch(get.stdout, /078de4c/);
      // commitHash 兼容字段也保持原样
      const getLast = runIn(d, 'get', 'phases.0.commitHash');
      assert.match(getLast.stdout, /aaaaaaa/);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('空字符串 / 仅 comma / 末尾悬空逗号 → 拒绝', () => {
    const d = freshDir();
    try {
      // 空字符串
      const r1 = runIn(d, 'record-commit', '01', '');
      assert.equal(r1.code, 1);
      assert.match(r1.stderr, /非空的 hash 参数/);
      // 仅逗号
      const r2 = runIn(d, 'record-commit', '01', ',');
      assert.equal(r2.code, 1);
      assert.match(r2.stderr, /位置\s*1/);
      // 末尾悬空逗号
      const r3 = runIn(d, 'record-commit', '01', 'abc1234,');
      assert.equal(r3.code, 1);
      assert.match(r3.stderr, /位置\s*2/);
      // 纯空白
      const r4 = runIn(d, 'record-commit', '01', '   ');
      assert.equal(r4.code, 1);
      // 中间空段(连续逗号)
      const r5 = runIn(d, 'record-commit', '01', 'abc1234,,def5678');
      assert.equal(r5.code, 1);
      assert.match(r5.stderr, /位置\s*2/);
      // 原子性:5 次拒绝都不应写入 state,commits 应仍为 []
      const get = runIn(d, 'get', 'phases.0.commits');
      assert.match(get.stdout, /\[\s*\]/);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });

  test('commas 周围空格会被 trim', () => {
    const d = freshDir();
    try {
      // 注意:hex 字符只允许 0-9 / a-f,g/h/i 之类不在范围
      const r = runIn(d, 'record-commit', '01', 'abc1234 , def5678 , feedface');
      assert.equal(r.code, 0, r.stderr);
      const get = runIn(d, 'get', 'phases.0.commits');
      assert.match(get.stdout, /"abc1234"/);
      assert.match(get.stdout, /"def5678"/);
      assert.match(get.stdout, /"feedface"/);
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  });
});

describe('sanitize 覆盖 2026 主流 token', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
  });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const TOKENS = [
    'sk-ant-api03-' + 'a'.repeat(20),
    'sk-proj-' + 'a'.repeat(20),
    'github_pat_11ABCDEFG0_' + 'a'.repeat(20),
    'gho_' + 'a'.repeat(20),
    'ghu_' + 'a'.repeat(20),
    'ghs_' + 'a'.repeat(20),
    'ghr_' + 'a'.repeat(20),
    'AKIA' + 'A'.repeat(16),
    'glpat-' + 'a'.repeat(20),
    'xoxb-' + 'a'.repeat(20),
    'dckr_pat_' + 'a'.repeat(20),
    'npm_' + 'a'.repeat(20),
    'pypi-AgEIcHlwaS5vcmc' + 'a'.repeat(20),
    'ATATT' + 'a'.repeat(20),
  ];
  const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxxxx\n-----END RSA PRIVATE KEY-----';

  for (const tok of TOKENS) {
    test(`脱敏: ${tok.slice(0, 20)}...`, () => {
      // P1-1 路径白名单:文件必须在 .phase-execution/ 内
      const f = path.join(dir, '.phase-execution', `t-${Math.random().toString(36).slice(2, 8)}.txt`);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, tok);
      const r = runIn(dir, 'sanitize', f);
      assert.equal(r.code, 0);
      const content = fs.readFileSync(f, 'utf8');
      assert.equal(content, '[REDACTED]', `未脱敏: ${content}`);
    });
  }

  test('脱敏 PEM 整块', () => {
    const f = path.join(dir, '.phase-execution', 'pem.txt');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, PEM);
    runIn(dir, 'sanitize', f);
    const content = fs.readFileSync(f, 'utf8');
    assert.equal(content, '[REDACTED]');
  });

  test('脱敏 process.env.SECRET = value', () => {
    const f = path.join(dir, '.phase-execution', 'env.txt');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, "process.env.MY_SECRET = 'supervalue12345'");
    runIn(dir, 'sanitize', f);
    const content = fs.readFileSync(f, 'utf8');
    assert.match(content, /\[REDACTED\]/);
    assert.doesNotMatch(content, /supervalue12345/);
  });

  test('干净文件不被脱敏', () => {
    const f = path.join(dir, '.phase-execution', 'clean.txt');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'no secrets here');
    const r = runIn(dir, 'sanitize', f);
    assert.match(r.stdout, /"sanitized":\s*false/);
  });

  // P1-1: 路径白名单 — 只允许 .phase-execution/ 下的文件
  test('拒绝 .phase-execution/ 外的文件', () => {
    const f = path.join(dir, '..', 'outside.txt');
    fs.writeFileSync(f, 'AKIAIOSFODNN7EXAMPLE');
    const r = runIn(dir, 'sanitize', f);
    assert.equal(r.code, 1);
    // 两种合法的"拒绝"消息:lexical 失败 / symlink 逃逸
    assert.match(r.stderr, /(仅允许处理 \.phase-execution\/|不在 \.phase-execution\/ 内)/);
    // 原文件不应被改写
    assert.equal(fs.readFileSync(f, 'utf8'), 'AKIAIOSFODNN7EXAMPLE');
  });

  test('拒绝路径穿越 (.phase-execution/../../etc/passwd)', () => {
    const r = runIn(dir, 'sanitize', '.phase-execution/../../etc/passwd');
    assert.equal(r.code, 1);
    // 文件不存在 → lexical 检查 → "仅允许处理" 消息
    assert.match(r.stderr, /仅允许处理 \.phase-execution\//);
  });

  test('允许 .phase-execution/ 内文件', () => {
    const f = path.join(dir, '.phase-execution', 'inside.txt');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'AKIAIOSFODNN7EXAMPLE');
    const r = runIn(dir, 'sanitize', f);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /"sanitized":\s*true/);
    assert.equal(fs.readFileSync(f, 'utf8'), '[REDACTED]');
  });
});

// P0: SKILL.md 敏感文件检测正则 — 覆盖 .env.local / config/.env / id_rsa 等
// 镜像 SKILL.md:275 的两阶段过滤(命中 → 排除白名单)
describe('敏感文件检测正则 (SKILL.md:275)', () => {
  const SECRET_RE = '(\\.env(\\.[^/]+)?$|\\.pem$|\\.key$|id_rsa$|id_dsa$|id_ed25519$|credentials?\\.[^/]+$|secrets?\\.[^/]+$)';
  const SAFE_RE = '\\.env\\.(example|sample|template|dist|default)$';
  // 镜像 SKILL.md 的两阶段 pipeline
  function isSecret(filename) {
    if (!new RegExp(SECRET_RE, 'i').test(filename)) return false;
    if (new RegExp(SAFE_RE, 'i').test(filename)) return false;
    return true;
  }
  const SHOULD_HIT = [
    '.env', '.env.local', '.env.production', '.env.development',
    'config/.env', 'app/.env.test',
    'id_rsa', 'id_dsa', 'id_ed25519',
    'credentials.json', 'credentials.yml',
    'secret.txt', 'secrets.json',
    'app.pem', 'server.key', 'foo/bar/baz.pem',
  ];
  const SHOULD_PASS = [
    'README.md', 'package.json', 'app.py', 'settings.py',
    'environment.ts', 'envelope.js',  // 含 env 但不是 .env 文件
    'myfile.txt',
    // P1-A: .env 模板/示例文件(约定俗成应允许 commit)
    '.env.example', '.env.sample', '.env.template', '.env.dist', '.env.default',
  ];
  for (const f of SHOULD_HIT) {
    test(`应命中: ${f}`, () => {
      assert.ok(isSecret(f), `${f} 未被命中`);
    });
  }
  for (const f of SHOULD_PASS) {
    test(`应放过: ${f}`, () => {
      assert.ok(!isSecret(f), `${f} 误命中`);
    });
  }
});

// P1-C: acquireLock 抗命令注入 — 恶意 lock 文件不应触发 execSync
describe('lock 抗注入 (P1-C)', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('拒绝字符串 pid(攻击向量)', () => {
    fs.mkdirSync(path.join(dir, '.phase-execution'), { recursive: true });
    // 模拟攻击:在 pid 字段塞 shell 注入字符串
    fs.writeFileSync(path.join(dir, '.phase-execution/lock'), JSON.stringify({
      pid: '123; touch /tmp/atdo-INJECTED-MARKER',
      startTime: new Date().toISOString(),
      hostname: os.hostname(),
    }));
    // 删除可能的旧 marker
    try { fs.unlinkSync('/tmp/atdo-INJECTED-MARKER'); } catch {}
    const r = runIn(dir, 'lock');
    assert.equal(r.code, 0);  // 应能成功获取新锁
    assert.ok(!fs.existsSync('/tmp/atdo-INJECTED-MARKER'), 'shell 注入被执行!');
    try { fs.unlinkSync('/tmp/atdo-INJECTED-MARKER'); } catch {}
  });

  test('拒绝负数 pid', () => {
    fs.mkdirSync(path.join(dir, '.phase-execution'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.phase-execution/lock'), JSON.stringify({
      pid: -1, startTime: new Date().toISOString(), hostname: os.hostname(),
    }));
    const r = runIn(dir, 'lock');
    assert.equal(r.code, 0);
  });

  test('拒绝浮点 pid', () => {
    fs.mkdirSync(path.join(dir, '.phase-execution'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.phase-execution/lock'), JSON.stringify({
      pid: 1.5, startTime: new Date().toISOString(), hostname: os.hostname(),
    }));
    const r = runIn(dir, 'lock');
    assert.equal(r.code, 0);
  });

  test('拒绝 null pid', () => {
    fs.mkdirSync(path.join(dir, '.phase-execution'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.phase-execution/lock'), JSON.stringify({
      pid: null, startTime: new Date().toISOString(), hostname: os.hostname(),
    }));
    const r = runIn(dir, 'lock');
    assert.equal(r.code, 0);
  });
});

describe('backup 多版本轮转 + 损坏回退 + WARN', () => {
  let dir;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
  });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('连续 3 次 init 生成 bak.1/2/3', () => {
    initPlan(dir, JSON.stringify({ phases: [{ number: '01', name: 'v1' }] }));
    initPlan(dir, JSON.stringify({ phases: [{ number: '01', name: 'v2' }] }));
    initPlan(dir, JSON.stringify({ phases: [{ number: '01', name: 'v3' }] }));
    const phaseDir = path.join(dir, '.phase-execution');
    assert.ok(fs.existsSync(path.join(phaseDir, 'state.json.bak.1')));
    assert.ok(fs.existsSync(path.join(phaseDir, 'state.json.bak.2')));
    assert.ok(fs.existsSync(path.join(phaseDir, 'state.json.bak.3')));
  });

  test('主损坏 → WARN 从 bak.1 回退', () => {
    // 重新初始化干净环境
    fs.rmSync(path.join(dir, '.phase-execution'), { recursive: true, force: true });
    initPlan(dir, JSON.stringify({ phases: [{ number: '01', name: 'v1' }] }));
    initPlan(dir, JSON.stringify({ phases: [{ number: '01', name: 'v2' }] }));
    fs.writeFileSync(path.join(dir, '.phase-execution/state.json'), 'garbage');
    const r = runIn(dir, 'get', 'phases.0.name');
    assert.match(r.stderr, /WARN.*state\.json\.bak\.1/);
    assert.match(r.stdout, /v2/);
  });

  test('主+bak.1 损坏 → WARN 从 bak.2 回退', () => {
    fs.rmSync(path.join(dir, '.phase-execution'), { recursive: true, force: true });
    initPlan(dir, JSON.stringify({ phases: [{ number: '01', name: 'v1' }] }));
    initPlan(dir, JSON.stringify({ phases: [{ number: '01', name: 'v2' }] }));
    initPlan(dir, JSON.stringify({ phases: [{ number: '01', name: 'v3' }] }));
    fs.writeFileSync(path.join(dir, '.phase-execution/state.json'), 'garbage');
    fs.writeFileSync(path.join(dir, '.phase-execution/state.json.bak.1'), 'garbage');
    const r = runIn(dir, 'get', 'phases.0.name');
    assert.match(r.stderr, /WARN.*state\.json\.bak\.2/);
    assert.match(r.stdout, /v2/);
  });

  test('全部损坏 die', () => {
    fs.rmSync(path.join(dir, '.phase-execution'), { recursive: true, force: true });
    initPlan(dir, JSON.stringify({ phases: [{ number: '01', name: 'v1' }] }));
    fs.writeFileSync(path.join(dir, '.phase-execution/state.json'), 'garbage');
    fs.writeFileSync(path.join(dir, '.phase-execution/state.json.bak.1'), 'garbage');
    fs.writeFileSync(path.join(dir, '.phase-execution/state.json.bak.2'), 'garbage');
    fs.writeFileSync(path.join(dir, '.phase-execution/state.json.bak.3'), 'garbage');
    const r = runIn(dir, 'get', 'phases.0.name');
    assert.equal(r.code, 1);
    assert.match(r.stderr, /损坏且无备份/);
  });
});

describe('E2E 3 阶段完整流程', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-')); });
  after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  test('init → 3 阶段走完 → commit → done', () => {
    initPlan(dir, JSON.stringify({ phases: [
      { number: '01', name: 'a' },
      { number: '02', name: 'b', is_gate: true },
      { number: '03', name: 'c' },
    ]}));

    // 阶段 1
    assert.equal(runIn(dir, 'get-current-phase').stdout.match(/"number":\s*"(\d+)"/)[1], '01');
    // Bug-06:状态机要求走完整流程(in_progress → executed → audited → fixed → gated → completed)
    runIn(dir, 'set-phase', '01', 'in_progress');
    runIn(dir, 'set-phase', '01', 'executed');
    runIn(dir, 'set-phase', '01', 'audited');
    runIn(dir, 'set-phase', '01', 'fixed');
    runIn(dir, 'set-phase', '01', 'gated');
    runIn(dir, 'set-phase', '01', 'completed');
    runIn(dir, 'record-commit', '01', 'aaaaaaa');

    // 阶段 2 (gate)
    assert.equal(runIn(dir, 'get-current-phase').stdout.match(/"number":\s*"(\d+)"/)[1], '02');
    runIn(dir, 'set-phase', '02', 'in_progress');
    runIn(dir, 'set-phase', '02', 'executed');
    runIn(dir, 'set-phase', '02', 'audited');
    runIn(dir, 'set-phase', '02', 'fixed');
    runIn(dir, 'set-phase', '02', 'gated');
    runIn(dir, 'set-phase', '02', 'completed');
    runIn(dir, 'record-commit', '02', 'bbbbbbb');

    // 阶段 3
    assert.equal(runIn(dir, 'get-current-phase').stdout.match(/"number":\s*"(\d+)"/)[1], '03');
    runIn(dir, 'set-phase', '03', 'in_progress');
    runIn(dir, 'set-phase', '03', 'executed');
    runIn(dir, 'set-phase', '03', 'audited');
    runIn(dir, 'set-phase', '03', 'fixed');
    runIn(dir, 'set-phase', '03', 'gated');
    runIn(dir, 'set-phase', '03', 'completed');
    runIn(dir, 'record-commit', '03', 'ccccccc');

    // 完成
    const r = runIn(dir, 'get-current-phase');
    assert.match(r.stdout, /"done":\s*true/);

    // commit hash 全部记录
    const h1 = runIn(dir, 'get', 'phases.0.commitHash');
    const h2 = runIn(dir, 'get', 'phases.1.commitHash');
    const h3 = runIn(dir, 'get', 'phases.2.commitHash');
    assert.match(h1.stdout, /aaaaaaa/);
    assert.match(h2.stdout, /bbbbbbb/);
    assert.match(h3.stdout, /ccccccc/);
  });
});

// ─── v6 6 个 P2 修复测试 ──────────────────────────────────
// 目的:验证 P2-A/B/C/D/E/F 6 个修复都生效,避免下次重构意外回退
describe('P2 修复回归 (v6 6 项加固)', () => {
  describe('P2-A: set-phase 状态机一致性', () => {
    let dir;
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
      initPlan(dir, JSON.stringify({ phases: [
        { number: '01', name: 'a' },
        { number: '02', name: 'b' },
        { number: '03', name: 'c' },
      ]}));
    });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('跳过中间阶段直接 completed → die', () => {
      // 游标在 01,试图把 03 标 completed 应被拒绝
      const r = runIn(dir, 'set-phase', '03', 'completed');
      assert.equal(r.code, 1);
      assert.match(r.stderr, /不是当前阶段/);
    });

    test('合法顺序(01→02→03)全部 completed 通过', () => {
      // Bug-06:状态机要求走完整流程(pending → in_progress → executed → audited → fixed → gated → completed)
      runIn(dir, 'set-phase', '01', 'in_progress');
      runIn(dir, 'set-phase', '01', 'executed');
      runIn(dir, 'set-phase', '01', 'audited');
      runIn(dir, 'set-phase', '01', 'fixed');
      runIn(dir, 'set-phase', '01', 'gated');
      runIn(dir, 'set-phase', '01', 'completed');
      // 现在游标在 02,可以把 02 标 completed(走完整流程)
      runIn(dir, 'set-phase', '02', 'in_progress');
      runIn(dir, 'set-phase', '02', 'executed');
      runIn(dir, 'set-phase', '02', 'audited');
      runIn(dir, 'set-phase', '02', 'fixed');
      runIn(dir, 'set-phase', '02', 'gated');
      const r = runIn(dir, 'set-phase', '02', 'completed');
      assert.equal(r.code, 0);
    });

    test('非 completed 状态不触发游标校验(可乱序 in_progress)', () => {
      // 03 标 in_progress 应当允许(只是开始,不是完成)
      const r = runIn(dir, 'set-phase', '03', 'in_progress');
      assert.equal(r.code, 0);
    });
  });

  describe('P2-B: inc-strike type 白名单', () => {
    let dir;
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
      initPlan(dir, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
    });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('路径穿越攻击向量 → die', () => {
      const r = runIn(dir, 'inc-strike', '01', '../../../etc/passwd');
      assert.equal(r.code, 1);
      assert.match(r.stderr, /type 只能含字母/);
    });

    test('含 emoji → die', () => {
      const r = runIn(dir, 'inc-strike', '01', '🚀rocket');
      assert.equal(r.code, 1);
    });

    test('超长字符串 (>32) → die', () => {
      const r = runIn(dir, 'inc-strike', '01', 'a'.repeat(33));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /type 长度/);
    });

    test('含空格 → die', () => {
      const r = runIn(dir, 'inc-strike', '01', 'has space');
      assert.equal(r.code, 1);
    });

    test('合法 type (含 - _) 通过', () => {
      const r1 = runIn(dir, 'inc-strike', '01', 'type-safety');
      const r2 = runIn(dir, 'inc-strike', '01', 'lint_check');
      assert.equal(r1.code, 0);
      assert.equal(r2.code, 0);
    });

    test('32 字符边界值通过', () => {
      const r = runIn(dir, 'inc-strike', '01', 'a'.repeat(32));
      assert.equal(r.code, 0);
    });
  });

  describe('P2-C: heartbeat status 白名单', () => {
    let dir;
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
      initPlan(dir, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
    });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('合法 status (active/paused/completed/failed) 通过', () => {
      for (const s of ['active', 'paused', 'completed', 'failed']) {
        const r = runIn(dir, 'heartbeat', '01', 't1', s);
        assert.equal(r.code, 0, `status=${s} 失败: ${r.stderr}`);
      }
    });

    test('异体字符串 RUNNING → die', () => {
      const r = runIn(dir, 'heartbeat', '01', 't1', 'RUNNING');
      assert.equal(r.code, 1);
      assert.match(r.stderr, /heartbeat status 无效/);
    });

    test('中文状态 → die', () => {
      const r = runIn(dir, 'heartbeat', '01', 't1', '运行中');
      assert.equal(r.code, 1);
    });

    test('空 status 默认 active 不 die', () => {
      const r = runIn(dir, 'heartbeat', '01', 't1', '');
      assert.equal(r.code, 0);
    });
  });

  describe('P2-D: init 长度限制', () => {
    let dir;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-')); });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('name > 200 字符 → die', () => {
      const r = initPlan(dir, JSON.stringify({ phases: [
        { number: '01', name: 'a'.repeat(201), goal: 'g', tasks: ['t'] },
      ]}));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /name 长度/);
    });

    test('goal > 2000 字符 → die', () => {
      const r = initPlan(dir, JSON.stringify({ phases: [
        { number: '01', name: 'a', goal: 'a'.repeat(2001), tasks: ['t'] },
      ]}));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /goal 长度/);
    });

    test('tasks > 50 项 → die', () => {
      const r = initPlan(dir, JSON.stringify({ phases: [
        { number: '01', name: 'a', goal: 'g', tasks: Array(51).fill('t') },
      ]}));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /tasks 数量/);
    });

    test('单 task > 500 字符 → die', () => {
      const r = initPlan(dir, JSON.stringify({ phases: [
        { number: '01', name: 'a', goal: 'g', tasks: ['a'.repeat(501)] },
      ]}));
      assert.equal(r.code, 1);
      assert.match(r.stderr, /task 长度/);
    });

    test('边界值(200/2000/50/500)通过', () => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
      try {
        const r = initPlan(d, JSON.stringify({ phases: [
          {
            number: '01',
            name: 'a'.repeat(200),
            goal: 'a'.repeat(2000),
            tasks: Array(50).fill('a'.repeat(500)),
          },
        ]}));
        assert.equal(r.code, 0, r.stderr);
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });
  });

  describe('P2-E: get-current-phase 只在游标变化时写盘', () => {
    let dir;
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
      initPlan(dir, JSON.stringify({ phases: [
        { number: '01', name: 'a' },
        { number: '02', name: 'b' },
      ]}));
    });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('连续 5 次调用不写 state.json', () => {
      // 把所有 bak 都删除,这样如果写盘会留下 .bak.1 (备份轮转)
      const stateFile = path.join(dir, '.phase-execution/state.json');
      const bak1 = path.join(dir, '.phase-execution/state.json.bak.1');

      // 记录初始 mtime + 备份状态
      const mtime0 = fs.statSync(stateFile).mtimeMs;
      const bak1ExistsBefore = fs.existsSync(bak1);

      // 连续调用 5 次(不修改 phase 状态,游标不应变化)
      for (let i = 0; i < 5; i++) {
        runIn(dir, 'get-current-phase');
      }

      // 1. mtime 应未变(没写盘)
      const mtime1 = fs.statSync(stateFile).mtimeMs;
      assert.equal(mtime0, mtime1, 'state.json 不应被改写');

      // 2. bak.1 不应被创建(写盘会触发备份轮转)
      const bak1ExistsAfter = fs.existsSync(bak1);
      assert.equal(bak1ExistsBefore, bak1ExistsAfter, 'bak.1 不应被生成');
    });

    test('推进 phase 后,get-current 才会写盘', () => {
      const stateFile = path.join(dir, '.phase-execution/state.json');
      // 推进 01 到 completed
      runIn(dir, 'set-phase', '01', 'in_progress');
      runIn(dir, 'set-phase', '01', 'executed');
      runIn(dir, 'set-phase', '01', 'completed');
      // 此时游标应已到 02
      const mtime0 = fs.statSync(stateFile).mtimeMs;
      // 短暂 sleep 避免 mtime 精度问题
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      return wait(50).then(() => {
        // 现在调用 get-current,游标已在 02 且 02 未完成,不应再写
        runIn(dir, 'get-current-phase');
        const mtime1 = fs.statSync(stateFile).mtimeMs;
        // 完成 01 时已经写过盘(推进游标),但 get-current 自身不应再触发一次
        // (因为 startIdx=1, status='pending' !== 'completed',i==currentPhaseIndex 不写)
        // 此断言验证 mtime 未变化 ≥ 50ms
        assert.ok(mtime1 >= mtime0);
      });
    });
  });

  describe('P2-F: cmdSanitize 死代码清理', () => {
    let dir;
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-'));
      initPlan(dir, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
    });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('正常文件 sanitize 不崩溃', () => {
      const target = path.join(dir, '.phase-execution/test-p2f.md');
      fs.writeFileSync(target, 'normal content', 'utf8');
      const r = runIn(dir, 'sanitize', target);
      assert.equal(r.code, 0);
    });

    test('空文件 sanitize 不崩溃', () => {
      const target = path.join(dir, '.phase-execution/test-p2f-empty.md');
      fs.writeFileSync(target, '', 'utf8');
      const r = runIn(dir, 'sanitize', target);
      assert.equal(r.code, 0);
    });

    test('非 .phase-execution 路径被拒绝(白名单仍生效)', () => {
      const r = runIn(dir, 'sanitize', '/tmp/outside.md');
      assert.equal(r.code, 1);
    });
  });
});

// ─── SKILL.md 文档守卫(防止 P1 ScheduleWakeup 误用回归)──
// 教训:commit 95587f7 之前 SKILL.md 第 9 步误用 ScheduleWakeup,
// 实际只在 /loop 模式下工作。文档类 bug 容易反复 — 加硬约束。
describe('SKILL.md 文档守卫', () => {
  const SKILL_PATH = path.join(__dirname, '../../SKILL.md');
  const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');
  const lines = skillContent.split('\n');

  test('ScheduleWakeup 仅在警告上下文(行需含 NOT/禁止/不)', () => {
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('ScheduleWakeup')) {
        if (!/NOT|禁止|❌|不|deprecated|弃用/.test(line)) {
          violations.push(`L${i + 1}: ${line.trim()}`);
        }
      }
    }
    assert.equal(violations.length, 0,
      `ScheduleWakeup 误用(必须作为警告出现):\n${violations.join('\n')}`);
  });

  test('PROCESS_FILE_POLICY 用 INJECT marker,不用 ${} 引用', () => {
    assert.equal(skillContent.includes('${PROCESS_FILE_POLICY}'), false,
      '${PROCESS_FILE_POLICY} 已被替换为 <<INJECT: ...>>,发现残留');
  });

  test('所有 4 个 agent spawn 块都引用 PROCESS_FILE_POLICY(≥4 个 INJECT)', () => {
    const matches = skillContent.match(/<<INJECT: copy the verbatim PROCESS_FILE_POLICY/g);
    assert.ok(matches && matches.length >= 4,
      `应有 ≥4 个 INJECT marker,实际 ${matches ? matches.length : 0}`);
  });

  test('Step 9 Continuation 使用 CronCreate 而非 ScheduleWakeup', () => {
    // 必须显式调用 CronCreate
    assert.match(skillContent, /CronCreate\(/);
    // 必须 durable: true
    assert.match(skillContent, /durable:\s*true/);
    // 必须 recurring: false(一次性,fire 后自动删除)
    assert.match(skillContent, /recurring:\s*false/);
  });

  test('PROCESS_FILE_POLICY 包含 buginfo/ 子目录', () => {
    assert.match(skillContent, /_proc-use\/buginfo\//);
  });

  test('Step 9 prompt 包含防御性 context check', () => {
    // 防止 cron 在错误上下文中 fire
    assert.match(skillContent, /DEFENSIVE CONTEXT CHECK/);
    assert.match(skillContent, /not in atdo context/);
  });

  test('Step 9 prompt 给出 SKILL.md 显式路径', () => {
    // 防止 woken-up agent 找不到 SKILL.md
    assert.match(skillContent, /~\/\.agents\/skills\/atdo\/SKILL\.md/);
  });

  test('Step 9 prompt 使用 installed 路径调用脚本(非 scripts/...)', () => {
    // 防止 woken-up agent 在新会话 cwd 不对时失败
    assert.match(skillContent, /~\/\.agents\/skills\/atdo\/scripts\/phase-state\.js/);
    assert.match(skillContent, /~\/\.agents\/skills\/atdo\/scripts\/watchdog\.sh/);
  });
});

// ─── Bug-02 (P0): state.json schema 文档 + 错误消息改进 回归 ──
// 症状:orchestrator 第一次 init state.json 要试错 3 次(tasks 数组/task 字符串/
//       depends_on 引用 id 不存在)。修复:3 条隐性规则写进 SKILL.md,错误消息
//       给出"应该长啥样"提示。
// 这里验证修复落地,避免下次重构回退到无法自解释的错误消息。
describe('Bug-02 state.json schema 文档 + 错误消息', () => {
  const SKILL_PATH = path.join(__dirname, '../../SKILL.md');
  const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

  describe('SKILL.md 包含 state.json Schema 章节', () => {
    test('包含 ## state.json Schema 标题', () => {
      assert.match(skillContent, /##\s+state\.json\s+Schema/);
    });

    test('包含 3 条隐性规则(必须/禁止语义)', () => {
      // 规则 1:tasks 必须是 string[]
      assert.match(skillContent, /string\[\]/);
      // 规则 2:阶段 id 是 2 位数字字符串
      assert.match(skillContent, /2\s*位数字字符串|2\s*位/);
      assert.match(skillContent, /01|02|03/);
      // 规则 3:depends_on 精确匹配
      assert.match(skillContent, /depends_on/);
      assert.match(skillContent, /精确匹配|不存在/);
    });

    test('包含完整正例 JSON(phases + id 示例)', () => {
      // 关键字检查:必须同时出现 "phases" 和 2 位数字 id 示例 "01"
      // 防止以后编辑把示例删掉又没人发现
      assert.match(skillContent, /"phases"/);
      assert.match(skillContent, /"01"/);
      // tasks 字段示例(用 string[] 形态)
      assert.match(skillContent, /"tasks"/);
    });

    test('包含反例 + 正例对比', () => {
      // 反例标记
      assert.match(skillContent, /反例|❌/);
      // 正例标记
      assert.match(skillContent, /正例|✅/);
    });
  });

  describe('phase-state.js 错误消息含"应该长啥样"提示', () => {
    let dir;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-test-')); });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('tasks 不是数组 → 错误消息含 string[] 说明 + 示例', () => {
      // Bug-02 试错 #1:用户传 tasks: 1(number) 而非数组
      const r = initPlan(dir, JSON.stringify({ phases: [
        { name: 'a', tasks: 'not an array' },
      ]}));
      assert.equal(r.code, 1);
      // 必须告诉用户"应该是 string[]",而不是仅仅"必须是数组"
      assert.match(r.stderr, /string\[\]/);
      // 必须给一个具体例子
      assert.match(r.stderr, /task A.*task B|例如|例:/);
    });

    test('task 不是字符串 → 错误消息含 string + typeof 提示', () => {
      // Bug-02 试错 #2:用户传 number 或 {id, desc} 对象
      const r = initPlan(dir, JSON.stringify({ phases: [
        { name: 'a', tasks: [1, 2, 3] },
      ]}));
      assert.equal(r.code, 1);
      // 错误消息必须提及 string 类型
      assert.match(r.stderr, /string/);
      // 必须明确告诉用户不是 {id, desc} 对象(常见混淆源)
      assert.match(r.stderr, /id.*desc|\{id/);
      // 阶段号用 2 位数字格式(与其他错误消息保持一致)
      assert.match(r.stderr, /阶段\s*01/);
    });

    test('depends_on 引用不存在 → 错误消息含"用 01 不用 phase1"提示', () => {
      // Bug-02 试错 #3:用户传 depends_on: ["phase1"] 误以为这是 id
      const r = initPlan(dir, JSON.stringify({ phases: [
        { name: 'a' },
        { name: 'b', depends_on: ['phase1'] },
      ]}));
      assert.equal(r.code, 1);
      // 必须告诉用户正确格式(2 位数字)
      assert.match(r.stderr, /01/);
      // 必须显式提到反例("phase1")
      assert.match(r.stderr, /phase1/);
    });
  });
});

// ─── Bug-05 (P1): [AUTO-EXEC-RESULT] 强制 methodology 字段 + Trust Nothing 第 13 项 ──
// 症状:Phase 02 Gate 2 agent 用 `sleep 0.05s` 模拟 AI 推理(典型 bash proxy benchmark),
//       报告 §0.1-0.3 透明承认是 proxy,但最终仍判定 "Gate 2: PASS"。
//       根因:[AUTO-EXEC-RESULT: ...] marker 协议没有 methodology 字段,orchestrator
//       不知道这是 proxy 报告,无法识别"proxy 报告冒充 PASS"。
// 修复:
//   1. SKILL.md 改写 marker 协议,强制 methodology=proxy|real|mixed
//   2. Trust Nothing 检查清单新增第 13 项:methodology=proxy 不得判定 PASS,
//      必须显式标 INCONCLUSIVE,要求人工放行或 real 验证
describe('Bug-05 AUTO-EXEC-RESULT 强制 methodology 字段 + Trust Nothing 第 13 项', () => {
  const SKILL_PATH = path.join(__dirname, '../../SKILL.md');
  const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

  // 测试 1:SKILL.md 文档包含 methodology=proxy|real|mixed 完整说明
  test('SKILL.md 包含 "methodology=proxy|real|mixed" 完整说明', () => {
    // 必须同时出现 methodology 关键字和三种取值
    assert.match(skillContent, /methodology/);
    // 三种取值必须同时出现(空格允许)
    assert.match(skillContent, /proxy\s*\|\s*real\s*\|\s*mixed/);
    // 必须解释 proxy / real / mixed 的语义
    assert.match(skillContent, /proxy/);
    assert.match(skillContent, /real/);
    assert.match(skillContent, /mixed/);
  });

  // 测试 2:SKILL.md 文档包含 INCONCLUSIVE 或"proxy 不构成 gate 通过"类似明确说明
  test('SKILL.md 包含 INCONCLUSIVE 或"proxy 不构成 gate 通过"明确说明', () => {
    // 必须明确"proxy 不构成 gate 通过"或类似说明(关键词同义即可)
    // 允许的中文/英文措辞:INCONCLUSIVE / proxy 不构成 / proxy 不得 / proxy 不能算 PASS
    assert.match(
      skillContent,
      /INCONCLUSIVE|proxy\s*不构成|proxy\s*不得|proxy\s*不能|proxy\s*不应\s*判定\s*PASS|proxy-only/i
    );
  });

  // 测试 3:SKILL.md 文档包含"proxy 测试"或"proxy 报告"相关条款
  test('SKILL.md 包含"proxy 测试"或"proxy 报告"相关条款', () => {
    // 必须明确提到"proxy 测试"或"proxy 报告"(中文/英文二选一)
    // 防止以后编辑把这段关键说明删掉又没人发现
    assert.match(skillContent, /proxy\s*测试|proxy\s*报告|proxy\s*benchmark|proxy\s*模拟/i);
  });

  // 测试 4:SKILL.md 文档包含"人工放行"或"human sign-off"流程
  test('SKILL.md 包含"人工放行"或"human sign-off"流程', () => {
    // 必须明确"人工放行"或"human sign-off"作为 proxy 报告的处理路径
    assert.match(skillContent, /人工放行|人工\s*签|人工\s*判定|human\s*sign-off|human\s*override|人工\s*复核/i);
  });
});

// ─── Bug-04 (P1): 非 Gate Phase commit 规则明文化 回归 ──
// 症状:SKILL.md §8 原标题"Git Commit (gate phases only, after all checks pass)"
//       字面暗示"非 Gate Phase 不允许 commit",但工程实践要求"原子提交"——
//       Phase 01(非 Gate)agent 内部产 3 个原子 commit 是正确做法,与协议字面冲突。
// 修复:§8 重写为"按阶段类型区分"的 4 个子小节(8.1 Gate / 8.2 非 Gate /
//       8.3 红线 / 8.4 失败处理),明文允许非 Gate Phase agent 内部原子提交。
describe('Bug-04 非 Gate Phase commit 规则明文化', () => {
  const SKILL_PATH = path.join(__dirname, '../../SKILL.md');
  const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

  // 测试 1:SKILL.md 包含"非 Gate Phase"明确协议说明
  test('SKILL.md 包含"非 Gate"或"非关口"明确协议说明', () => {
    // 必须明确提到"非 Gate"或"非关口"作为协议名词
    // 防止以后编辑把这段关键说明删掉又没人发现
    assert.match(skillContent, /非\s*Gate\s*Phase|非\s*关口/);
    // 必须有专章说明(§8.2 这样的子小节)
    assert.match(skillContent, /###\s*8\.2\s*非\s*Gate/);
  });

  // 测试 2:§8 小节包含"原子提交"或"atomic commit"相关说明
  test('SKILL.md §8 包含"原子提交"或"atomic commit"相关说明', () => {
    // 必须提到"原子提交"概念(中文)或 "atomic commit" (英文)
    // 解释为什么非 Gate Phase 允许 agent 内部多次 commit
    assert.match(skillContent, /原子提交|atomic\s*commit/i);
    // 必须解释原则(每个 commit 只解决一个问题)
    assert.match(skillContent, /每个\s*commit\s*只解决|one\s*commit\s*one\s*(thing|issue)/i);
  });

  // 测试 3:SKILL.md 明确说明 orchestrator 在非 Gate Phase 不强制 commit
  test('SKILL.md 明确说明 orchestrator 在非 Gate Phase 不强制 commit', () => {
    // 必须明确"不需要 commit"或"不强制 commit"或"不强制在 phase 收尾再 commit"
    // 防止误判:orchestrator 误以为"非 Gate Phase 必须 commit"或"非 Gate Phase 不能 commit"
    assert.match(skillContent, /不需要\s*commit|不强制\s*commit|不强制在\s*phase\s*收尾|不需要\s*强制/);
    // 必须提到 orchestrator 收尾仅持久化 state.json(不需 commit)
    assert.match(skillContent, /orchestrator.*?不需要\s*commit|orchestrator\s*在\s*非\s*Gate\s*Phase\s*收尾.*?不需要/i);
  });
});

// ─── Bug-06 (P1): Manual Gate Protocol 定义 + state schema 扩展 ──
// 症状:Gate 3 等场景是"人工对比 02/03/10 三篇资产"——这是用户判断,agent 不可代理。
//      SKILL.md "Phase Execution Protocol" 全程没说如何处理 manual gate,
//      orchestrator 只能临时拼凑 AskUserQuestion,流程 ad-hoc。
// 修复:
//   1. SKILL.md 新增 "Manual Gate Protocol" 章节,定义 gateType 字段(auto/manual/hybrid) +
//      状态机(audited → awaiting_user_review → user-review-pass | user-review-fail)
//   2. phase-state.js 扩展 set-phase 接受 awaiting_user_review / user-review-pass /
//      user-review-fail + 严格状态机校验(跳过任何状态 → FATAL)
//   3. state.json 顶层新增可选字段 awaiting_user_review({phaseId, askedAt, optionsShown})
describe('Bug-06 Manual Gate Protocol 定义 + state schema 扩展', () => {
  const SKILL_PATH = path.join(__dirname, '../../SKILL.md');
  const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

  // 测试 1:SKILL.md 包含 "gateType" 或 "manual gate" 协议说明
  test('SKILL.md 包含 gateType/manual gate 协议说明', () => {
    // 必须明确提到 gateType 字段
    assert.match(skillContent, /gateType/);
    // 必须列出三种取值(auto / manual / hybrid)
    assert.match(skillContent, /\bauto\b/);
    assert.match(skillContent, /\bmanual\b/);
    assert.match(skillContent, /\bhybrid\b/);
    // 必须用"manual gate"作为协议名词
    assert.match(skillContent, /manual\s*gate/i);
  });

  // 测试 2:SKILL.md 包含 "awaiting_user_review" 状态说明
  test('SKILL.md 包含 awaiting_user_review 状态说明', () => {
    // 必须明确提到 awaiting_user_review 作为状态名(防止以后编辑把这段删掉)
    assert.match(skillContent, /awaiting_user_review/);
    // 必须配套提到 user-review-pass(用户签字通过)
    assert.match(skillContent, /user-review-pass/);
    // 必须配套提到 user-review-fail(用户判定不通过)
    assert.match(skillContent, /user-review-fail/);
  });

  // 测试 3:SKILL.md 包含 Manual Gate Protocol 章节标题
  test('SKILL.md 包含 Manual Gate Protocol 章节标题', () => {
    // 必须有专章(## 或 ### 二级/三级标题)
    assert.match(skillContent, /##+\s*Manual\s*Gate\s*Protocol/i);
    // 必须有 Bug-06 标记(标明该章节是 Bug-06 修复)
    // 用 \d+ 匹配版本号/编号,避免以后版本号变了硬编码失败
    assert.match(skillContent, /Bug-?06|Bug[\s-]?0?6/);
  });

  // 测试 4:phase-state.js 支持新状态 awaiting_user_review / user-review-pass
  describe('phase-state.js 支持 manual gate 新状态', () => {
    let dir;
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-bug06-'));
      initPlan(dir, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
    });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('set-phase 接受 awaiting_user_review(在 gated 之后)', () => {
      // 先走到 gated 状态(完整流程:pending → in_progress → executed → audited → fixed → gated)
      runIn(dir, 'set-phase', '01', 'in_progress');
      runIn(dir, 'set-phase', '01', 'executed');
      runIn(dir, 'set-phase', '01', 'audited');
      runIn(dir, 'set-phase', '01', 'fixed');
      runIn(dir, 'set-phase', '01', 'gated');
      // 现在手动 gate 入口:应该被接受
      const r = runIn(dir, 'set-phase', '01', 'awaiting_user_review');
      assert.equal(r.code, 0, r.stderr);
      // 顶层 awaiting_user_review 字段必须存在
      const state = JSON.parse(runIn(dir, 'get').stdout);
      assert.ok(state.awaiting_user_review, '顶层 awaiting_user_review 字段应存在');
      assert.equal(state.awaiting_user_review.phaseId, '01');
      assert.ok(state.awaiting_user_review.askedAt, 'askedAt 必须有值');
      assert.ok(Array.isArray(state.awaiting_user_review.optionsShown), 'optionsShown 必须是数组');
    });

    test('set-phase 接受 user-review-pass(从 awaiting_user_review 出发)', () => {
      // 走到 awaiting_user_review
      runIn(dir, 'set-phase', '01', 'in_progress');
      runIn(dir, 'set-phase', '01', 'executed');
      runIn(dir, 'set-phase', '01', 'audited');
      runIn(dir, 'set-phase', '01', 'fixed');
      runIn(dir, 'set-phase', '01', 'gated');
      runIn(dir, 'set-phase', '01', 'awaiting_user_review');
      // user-review-pass 应被接受
      const r = runIn(dir, 'set-phase', '01', 'user-review-pass');
      assert.equal(r.code, 0, r.stderr);
      // 顶层 awaiting_user_review 字段必须被清除
      const state = JSON.parse(runIn(dir, 'get').stdout);
      assert.equal(state.awaiting_user_review, undefined, '完成 manual gate 后顶层字段应被清除');
    });
  });

  // 测试 5:phase-state.js 拒绝非法状态转换(如 pending → completed 跳过中间状态)
  describe('phase-state.js 严格状态机校验', () => {
    function freshDir() {
      return fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-bug06-strict-'));
    }

    test('pending → completed 跳过中间态 → FATAL', () => {
      // 之前的合法 set-phase 用法:set-phase <id> completed 在"游标指向的阶段"上是允许的
      // 等等,先看现有 P2-A 测试..."跳过中间阶段直接 completed → die"用的是 03(游标不指向)
      // 这里测的是同一阶段内"pending → completed 跳过中间态"
      // Bug-06 状态机:pending 只能 → in_progress,不能直接 → completed
      const d = freshDir();
      try {
        initPlan(d, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
        const r = runIn(d, 'set-phase', '01', 'completed');
        assert.equal(r.code, 1, 'pending → completed 跳过中间态应被拒绝');
        assert.match(r.stderr, /非法转换|允许的转换表/);
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('in_progress → completed 跳过 executed/audited/fixed/gated → FATAL', () => {
      const d = freshDir();
      try {
        initPlan(d, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
        runIn(d, 'set-phase', '01', 'in_progress');
        const r = runIn(d, 'set-phase', '01', 'completed');
        assert.equal(r.code, 1, 'in_progress → completed 跳过中间态应被拒绝');
        assert.match(r.stderr, /非法转换/);
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('executed → gated 跳过 audited/fixed → FATAL', () => {
      const d = freshDir();
      try {
        initPlan(d, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
        runIn(d, 'set-phase', '01', 'in_progress');
        runIn(d, 'set-phase', '01', 'executed');
        const r = runIn(d, 'set-phase', '01', 'gated');
        assert.equal(r.code, 1, 'executed → gated 跳过 audited/fixed 应被拒绝');
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('completed → 任意状态 → FATAL(终态保护)', () => {
      const d = freshDir();
      try {
        initPlan(d, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
        // 走完正常流程到 completed
        runIn(d, 'set-phase', '01', 'in_progress');
        runIn(d, 'set-phase', '01', 'executed');
        runIn(d, 'set-phase', '01', 'audited');
        runIn(d, 'set-phase', '01', 'fixed');
        runIn(d, 'set-phase', '01', 'gated');
        runIn(d, 'set-phase', '01', 'completed');
        // 现在尝试回到 in_progress
        const r = runIn(d, 'set-phase', '01', 'in_progress');
        assert.equal(r.code, 1, 'completed → in_progress 应被拒绝(终态保护)');
        assert.match(r.stderr, /终态/);
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('manual gate: gated → completed(auto gate 直通)合法', () => {
      // 验证 gated → completed 仍然合法(向后兼容,auto gate 直通)
      const d = freshDir();
      try {
        initPlan(d, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
        runIn(d, 'set-phase', '01', 'in_progress');
        runIn(d, 'set-phase', '01', 'executed');
        runIn(d, 'set-phase', '01', 'audited');
        runIn(d, 'set-phase', '01', 'fixed');
        runIn(d, 'set-phase', '01', 'gated');
        const r = runIn(d, 'set-phase', '01', 'completed');
        assert.equal(r.code, 0, 'auto gate 直通 gated → completed 必须仍然合法');
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });
  });
});

// ─── Bug-08 (P2): lock 持有语义明文化 + unlock 严格化 回归 ──
// 症状:Phase 01 完成后 lock 仍持久持有,协议没明确"何时释放"。
// 修复:
//   1. SKILL.md Step 1 新增 "Lock 持有语义" 子小节,明文:
//      - 持有时间:从 atdo 启动 → 所有 phase 完成(unlock 在 phase 间不释放)
//      - 持有目的:防止并发 /atdo 误启动
//      - lock 文件状态 ≠ atdo 真实状态(state.json 是 single source of truth)
//      - unlock 时机清单(all-completed / aborted / alert)
//   2. phase-state.js 强化 unlock 命令:必须显式 --reason 参数,合法值
//      all-completed|aborted|alert;无参数 → 拒绝(防止 orchestrator 误调)
//   3. 默认 reason 也不接受(即使 "alert" 看似最常见,仍要求写明 — 强制确认)
describe('Bug-08 lock 持有语义明文化 + unlock 严格化', () => {
  const SKILL_PATH = path.join(__dirname, '../../SKILL.md');
  const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

  describe('SKILL.md Lock 持有语义文档', () => {
    test('SKILL.md 包含 "lock 持续持有" 或 "持有到所有 phase 完成" 等明确说明', () => {
      // 必须明文表达"lock 从 atdo 启动持续持有 → 所有 phase 完成时 unlock"
      // 防止以后编辑把这段关键说明删掉又没人发现
      // 接受多种等价措辞(中文/英文) — markdown 加粗符号 ** 在中文字之间会切断 \s* 匹配,
      // 因此用 [^X]* 任意非关键字符形式绕过(注意:不要用 \s*|\** 这种 alternation,
      //      因为 JS regex 在 [\s\*] 中 * 是字面字符,会失败)
      assert.match(
        skillContent,
        /lock\s*持续持有|持续持有.*?所有\s*phase|持有到\s*所有\s*phase\s*完成|lock.*?持有.*?所有\s*phase\s*完成|从\s*atdo\s*启动[\s\S]*?所有\s*phase\s*完成[^才]{0,4}才[^u]{0,4}unlock|atdo\s*启动.*?持有/i
      );
      // 必须明确"不在 phase 间释放"(杜绝真空期)
      assert.match(
        skillContent,
        /不.*?在\s*phase\s*间\s*释放|不在\s*phase\s*间\s*释放|不\s*在\s*phase\s*间\s*释放/
      );
    });

    test('SKILL.md 包含 unlock 时机清单 (all-completed / aborted / alert)', () => {
      // 必须明确列出三个合法 unlock 时机(防止 orchestrator 误判)
      assert.match(skillContent, /all-completed/);
      assert.match(skillContent, /aborted/);
      assert.match(skillContent, /alert/);
      // 必须明文"禁止在 phase 间释放"(方案 A 关键约束)
      assert.match(skillContent, /禁止.*?释放|禁止.*?unlock/);
    });
  });

  describe('phase-state.js unlock --reason 严格化', () => {
    let dir;
    before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-bug08-')); });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    function freshLockDir() {
      // 每个 test 用独立 dir,避免 lock 状态相互干扰
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-bug08-unlock-'));
      initPlan(d, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
      // 先获取 lock(后续 unlock 才有对象可释放)
      runIn(d, 'lock');
      return d;
    }

    test('unlock 无参数 → 拒绝(防止 orchestrator 误调)', () => {
      const d = freshLockDir();
      try {
        const r = runIn(d, 'unlock');
        assert.equal(r.code, 1, 'unlock 无参数应被拒绝');
        // 错误消息必须显式提到"必须显式带 --reason"
        assert.match(r.stderr, /unlock\s*必须\s*显式\s*带\s*--reason/);
        // 必须列出合法 reason 清单
        assert.match(r.stderr, /all-completed\s*\|\s*aborted\s*\|\s*alert/);
        // lock 文件不应被释放(原文件应仍存在)
        assert.ok(
          fs.existsSync(path.join(d, '.phase-execution/lock')),
          'unlock 失败后 lock 文件应仍存在(防止误释放)'
        );
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('unlock --reason=alert(默认 reason)仍要求显式确认 → 通过但写明 reason', () => {
      const d = freshLockDir();
      try {
        const r = runIn(d, 'unlock', '--reason=alert');
        assert.equal(r.code, 0, r.stderr);
        // 必须 echo 写明 reason
        assert.match(r.stdout, /"reason":\s*"alert"/);
        // 审计记录到 stderr
        assert.match(r.stderr, /unlock reason=alert/);
        // lock 文件应被释放
        assert.ok(
          !fs.existsSync(path.join(d, '.phase-execution/lock')),
          'unlock 成功后 lock 文件应被删除'
        );
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('unlock --reason=all-completed → 正常完成场景', () => {
      const d = freshLockDir();
      try {
        const r = runIn(d, 'unlock', '--reason=all-completed');
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /"reason":\s*"all-completed"/);
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('unlock --reason=aborted → 用户显式终止场景', () => {
      const d = freshLockDir();
      try {
        const r = runIn(d, 'unlock', '--reason=aborted');
        assert.equal(r.code, 0, r.stderr);
        assert.match(r.stdout, /"reason":\s*"aborted"/);
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('unlock --reason=foo (非法 reason) → 拒绝', () => {
      const d = freshLockDir();
      try {
        const r = runIn(d, 'unlock', '--reason=foo');
        assert.equal(r.code, 1, '非法 reason 应被拒绝');
        assert.match(r.stderr, /无效\s*reason|合法\s*reason/);
        // lock 文件不应被释放
        assert.ok(
          fs.existsSync(path.join(d, '.phase-execution/lock')),
          '非法 reason unlock 失败后 lock 文件应仍存在'
        );
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('unlock --reason (空值) → 拒绝', () => {
      const d = freshLockDir();
      try {
        // --reason= 形式(空 reason)
        const r = runIn(d, 'unlock', '--reason=');
        assert.equal(r.code, 1, '--reason= 空值应被拒绝');
        assert.match(r.stderr, /--reason\s*必须\s*有值|合法\s*reason/);
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });
  });
});

// ─── Bug-07 (P2): Checkpoint 协议改 Phase-scoped 幂等 token 回归 ──
// 症状:原协议列 3 个 checkpoint(解析后 / Phase 开始前 / 首次 fix 前),触发条件
//      重叠/模糊:
//        - 用户同意"启动 Phase 02"(第一次 checkpoint)后,要不要再问"Phase 02 开始前"
//        - fix retry 时,orchestrator 怎么知道"是不是首次 fix"?需跟踪 fix attempt 计数
// 修复:采用"幂等 token + phase 进入时一次性确认"机制,要点:
//   1. SKILL.md 重构 Checkpoint 章节,明文"phase-scoped 一次性确认"
//   2. state.json 顶层新增 userConfirmations[] 数组(每条含 phaseId/scope/decidedAt/decision)
//   3. phase 进入时检查 userConfirmations,已 confirmed → 跳过询问
//   4. fix retry / 重新审计 不触发 checkpoint(已确认过)
//   5. 3-strike / manual gate 是另一类 checkpoint,不在本 scope 内
//   6. phase-state.js 新增 record-confirm / has-confirm 命令
describe('Bug-07 Checkpoint 协议 Phase-scoped 幂等 token', () => {
  const SKILL_PATH = path.join(__dirname, '../../SKILL.md');
  const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

  describe('SKILL.md Checkpoint 协议文档', () => {
    test('SKILL.md 包含 "Phase-scoped" / "一次性确认" / "幂等" checkpoint 协议说明', () => {
      // 至少包含以下三个关键词之一(任一即可,允许多种中文/英文措辞)
      // 防止以后编辑把这段关键说明删掉又没人发现
      const re = /Phase-scoped|phase-scoped|一次性确认|幂\s*等|idempotent/i;
      assert.match(skillContent, re,
        'SKILL.md 必须包含 Phase-scoped / 一次性确认 / 幂等 checkpoint 协议说明');
    });

    test('SKILL.md 包含 userConfirmations state 字段说明', () => {
      // 必须显式提到 state.json 的 userConfirmations 字段(数组名)
      assert.match(skillContent, /userConfirmations/,
        'SKILL.md 必须包含 state.json userConfirmations 字段说明');
      // 必须配套说明 decision 取值(至少提到 c / s / a 三选一)
      assert.match(skillContent, /c\s*\|\s*s\s*\|\s*a|'c'|'s'|'a'/,
        'SKILL.md 必须说明 decision 取值 c|s|a');
    });

    test('SKILL.md 明确说明 fix retry 不触发 checkpoint', () => {
      // 必须显式表达"fix retry 不再询问 checkpoint"(关键边界)
      // 允许的中文措辞:"fix retry 不触发 checkpoint" / "修复 retry 不再问" / "不再询问"
      // 防止以后编辑把这段关键说明删掉又没人发现
      const re = /fix\s*retry[\s\S]{0,40}(不\s*触发|不\s*再\s*问|不\s*再\s*询问|不再\s*触发)/i;
      assert.match(skillContent, re,
        'SKILL.md 必须明确说明 fix retry 不触发 checkpoint');
    });
  });

  describe('phase-state.js record-confirm 命令', () => {
    let dir;
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-bug07-'));
      initPlan(dir, JSON.stringify({ phases: [
        { number: '01', name: 'a' },
        { number: '02', name: 'b' },
      ]}));
    });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('record-confirm 合法 decision=c 写入 userConfirmations 数组', () => {
      const r = runIn(dir, 'record-confirm', '01', 'c');
      assert.equal(r.code, 0, r.stderr);
      // state.json 顶层 userConfirmations 应包含本条
      const state = JSON.parse(runIn(dir, 'get').stdout);
      assert.ok(Array.isArray(state.userConfirmations), 'userConfirmations 必须是数组');
      const conf = state.userConfirmations.find(c => c.phaseId === '01');
      assert.ok(conf, '应找到 phaseId=01 的确认记录');
      assert.equal(conf.scope, 'phase-full', 'scope 必须固定为 phase-full');
      assert.equal(conf.decision, 'c', 'decision 必须为 c');
      assert.ok(conf.decidedAt, 'decidedAt 必须有值');
    });

    test('record-confirm 合法 decision=s / a 写入', () => {
      // 清空之前的确认(用独立 dir,避免污染)
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-bug07-rc-'));
      try {
        initPlan(d, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
        for (const decision of ['s', 'a']) {
          const r = runIn(d, 'record-confirm', '01', decision);
          assert.equal(r.code, 0, `decision=${decision} 应被接受`);
          const state = JSON.parse(runIn(d, 'get').stdout);
          const conf = state.userConfirmations.find(c => c.phaseId === '01' && c.decision === decision);
          assert.ok(conf, `应找到 decision=${decision} 的确认记录`);
        }
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('record-confirm 非法 decision → FATAL', () => {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-bug07-rc-'));
      try {
        initPlan(d, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
        // 非法 decision 列表:大写 / 数字 / 字符串 / 空
        const bads = ['C', 'continue', '1', 'x', ''];
        for (const bad of bads) {
          const r = runIn(d, 'record-confirm', '01', bad);
          assert.equal(r.code, 1, `非法 decision="${bad}" 应被拒绝`);
        }
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('record-confirm 同一 phase 多次记录,userConfirmations 数组累计', () => {
      // 验证幂等性:同一 phase 可被多次 confirm(c → s 流转),不覆盖
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-bug07-rc-'));
      try {
        initPlan(d, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
        runIn(d, 'record-confirm', '01', 'c');
        runIn(d, 'record-confirm', '01', 'a');
        const state = JSON.parse(runIn(d, 'get').stdout);
        const confs = state.userConfirmations.filter(c => c.phaseId === '01');
        assert.equal(confs.length, 2, '同一 phase 多次 confirm,应累计 2 条');
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('record-confirm phaseId 不存在 → die', () => {
      const r = runIn(dir, 'record-confirm', '99', 'c');
      assert.equal(r.code, 1);
      assert.match(r.stderr, /不存在/);
    });
  });

  describe('phase-state.js has-confirm 命令', () => {
    let dir;
    before(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-bug07-'));
      initPlan(dir, JSON.stringify({ phases: [
        { number: '01', name: 'a' },
        { number: '02', name: 'b' },
      ]}));
    });
    after(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('已确认 → exit code 0(has-confirm 01)', () => {
      // 先 confirm 01
      runIn(dir, 'record-confirm', '01', 'c');
      // has-confirm 01 应返回 0
      const r = runIn(dir, 'has-confirm', '01');
      assert.equal(r.code, 0, `已确认时 has-confirm 应返回 0,实际: ${r.code}, stderr: ${r.stderr}`);
    });

    test('未确认 → exit code 1(has-confirm 02)', () => {
      // 02 尚未 confirm
      const r = runIn(dir, 'has-confirm', '02');
      assert.equal(r.code, 1, `未确认时 has-confirm 应返回 1,实际: ${r.code}, stderr: ${r.stderr}`);
    });

    test('向后兼容:旧 state.json 无 userConfirmations → has-confirm 返回 1', () => {
      // 构造一个没有 userConfirmations 字段的 state.json(模拟旧版)
      const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-bug07-hc-'));
      try {
        initPlan(d, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
        // 手动删除 userConfirmations 字段(模拟旧 state.json)
        const stateFile = path.join(d, '.phase-execution/state.json');
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        delete state.userConfirmations;
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
        // has-confirm 应视为空数组(向后兼容)
        const r = runIn(d, 'has-confirm', '01');
        assert.equal(r.code, 1, '旧 state.json 无 userConfirmations 应返回 1(未确认)');
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('已 confirm 任意 decision(c/s/a)均视为已确认', () => {
      // 验证 has-confirm 看到 c / s / a 都算"已确认"(避免 orchestrator 误以为要重新问)
      for (const dec of ['c', 's', 'a']) {
        const d = fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-bug07-hc-'));
        try {
          initPlan(d, JSON.stringify({ phases: [{ number: '01', name: 'a' }] }));
          runIn(d, 'record-confirm', '01', dec);
          const r = runIn(d, 'has-confirm', '01');
          assert.equal(r.code, 0, `decision=${dec} 应视为已确认,实际: ${r.code}`);
        } finally { fs.rmSync(d, { recursive: true, force: true }); }
      }
    });
  });
});

// ─── Bug-09 (P2): state.json 是 single source of truth + planHash 防漂移 回归 ──
// 症状:state.json 的 `phases[].tasks[]` 与原 plan file 的 task 列表没有自动
//      同步机制 — plan 改了 state.json 不会跟变,反之亦然,潜在数据漂移风险。
// 修复:
//   1. SKILL.md 新增 "Plan vs State 一致性规则" 章节,明文:
//      - state.json 是 single source of truth (SSOT)
//      - plan file 只在 init 时读一次,init 后不再读取
//      - planHash 防御性检测(可选,缺失/不一致不阻断)
//   2. phase-state.js init 接受 plan JSON 顶层可选 planHash 字段,
//      写入 state.json 顶层(向后兼容 — 缺失时无字段,init 不 FATAL)
//   3. 旧 state.json 无 planHash 字段时,所有命令正常工作
describe('Bug-09 state.json 是 single source of truth + planHash 防漂移', () => {
  const SKILL_PATH = path.join(__dirname, '../../SKILL.md');
  const skillContent = fs.readFileSync(SKILL_PATH, 'utf8');

  describe('SKILL.md Plan vs State 一致性规则文档', () => {
    test('SKILL.md 包含 "single source of truth" / "SSOT" / "state.json 是 single source" 明确说明', () => {
      // Bug-09 关键文档:SSOT 原则必须明文表达
      // 接受多种等价措辞(英文 / 中文)
      const re = /single\s*source\s*of\s*truth|SSOT|state\.json\s*是\s*single\s*source/i;
      assert.match(skillContent, re,
        'SKILL.md 必须包含 single source of truth / SSOT / state.json 是 single source 明确说明');
    });

    test('SKILL.md 包含 "plan file 只在 init 时读一次" 或类似明确说明', () => {
      // Bug-09 关键边界:plan file 角色明文 — 只在 init 时读一次
      // 接受多种等价措辞(中文表达略有差异)
      // 关键点:必须表达"只在 init 读一次" / "init 后不再读取"
      const re = /plan\s*file[^。\n]{0,40}(只在|仅在|只\s*在)\s*init|plan[^。\n]{0,40}init\s*时\s*读\s*一次|init\s*后[^。\n]{0,40}(不再|不\s*再)\s*读取|init\s*时[^。\n]{0,40}读\s*一次/;
      assert.match(skillContent, re,
        'SKILL.md 必须包含 plan file 只在 init 时读一次 类似明确说明');
    });

    test('SKILL.md 包含 planHash 字段说明', () => {
      // Bug-09 防御性检测:必须提到 planHash 字段
      assert.match(skillContent, /planHash/,
        'SKILL.md 必须包含 planHash 字段说明');
    });

    test('SKILL.md 明文禁止在 phase 启动前重新读 plan file 解析 tasks', () => {
      // Bug-09 明确禁止 — 防止未来重构回退
      // 关键边界:orchestrator 不得重新解析 plan
      // SKILL.md 用法: `**不得**` (加粗) — 接受加粗/非加粗
      const re = /\**不得\**\s*重新\s*读\s*plan|不得\s*重新\s*解析|不得\s*在\s*phase\s*启动前/;
      assert.match(skillContent, re,
        'SKILL.md 必须明文禁止在 phase 启动前重新读 plan file');
    });

    test('SKILL.md 明确说明 plan 改动不生效 + 重新 init 路径', () => {
      // 用户答疑:用户改 plan 怎么没生效 + 怎么"换 plan"
      // 必须告诉用户"用新 plan 重新 init"路径
      assert.match(skillContent, /plan\s*不\s*再生效|plan\s*不\s*会\s*自动\s*生效|plan\s*改\s*了[^。\n]{0,15}不\s*生效/);
      // 必须告诉用户重新 init(rm state.json + 重启)
      assert.match(skillContent, /重新\s*init|rm\s*\.phase-execution\/state\.json|rm\s*state\.json/);
    });
  });

  describe('phase-state.js init 接受可选 planHash 字段', () => {
    function freshDir() {
      return fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-bug09-'));
    }

    test('plan JSON 含 planHash → 写入 state.json 顶层', () => {
      const d = freshDir();
      try {
        const r = initPlan(d, JSON.stringify({
          phases: [{ number: '01', name: 'a' }],
          planHash: 'abc123def456',
        }));
        assert.equal(r.code, 0, r.stderr);
        // state.json 顶层必须有 planHash 字段
        const state = JSON.parse(runIn(d, 'get').stdout);
        assert.equal(state.planHash, 'abc123def456', 'planHash 必须写入 state.json 顶层');
        // 也可通过 get planHash 单独读
        const got = runIn(d, 'get', 'planHash');
        assert.equal(got.stdout, 'abc123def456');
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('plan JSON 不含 planHash → 不 FATAL,state.json 顶层无 planHash 字段(向后兼容)', () => {
      const d = freshDir();
      try {
        const r = initPlan(d, JSON.stringify({
          phases: [{ number: '01', name: 'a' }],
        }));
        assert.equal(r.code, 0, r.stderr);
        // state.json 顶层不应有 planHash 字段(向后兼容 — 旧 init 调用无此字段必须工作)
        const state = JSON.parse(runIn(d, 'get').stdout);
        assert.equal(state.planHash, undefined, 'planHash 缺失时 state.json 顶层不应有 planHash 字段');
        // get planHash 应返回 null(缺失键)
        const got = runIn(d, 'get', 'planHash');
        assert.equal(got.stdout, 'null');
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('planHash 非字符串 → FATAL(防 type confusion)', () => {
      const d = freshDir();
      try {
        const r = initPlan(d, JSON.stringify({
          phases: [{ number: '01', name: 'a' }],
          planHash: 12345,  // 数字而非字符串
        }));
        assert.equal(r.code, 1, 'planHash 非字符串应 FATAL');
        assert.match(r.stderr, /planHash\s*必须是\s*字符串/);
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('planHash 空字符串 → FATAL', () => {
      const d = freshDir();
      try {
        const r = initPlan(d, JSON.stringify({
          phases: [{ number: '01', name: 'a' }],
          planHash: '',
        }));
        assert.equal(r.code, 1, 'planHash 空字符串应 FATAL');
        assert.match(r.stderr, /planHash\s*不能\s*是\s*空\s*字符串/);
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('planHash 超长(>64 字符) → FATAL', () => {
      const d = freshDir();
      try {
        const r = initPlan(d, JSON.stringify({
          phases: [{ number: '01', name: 'a' }],
          planHash: 'a'.repeat(65),  // md5=32 / sha256=64,留余量 64
        }));
        assert.equal(r.code, 1, 'planHash 超长应 FATAL');
        assert.match(r.stderr, /planHash\s*长度/);
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('md5 长度边界值(32 hex) → 通过', () => {
      const d = freshDir();
      try {
        const md5 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';  // 32 chars
        const r = initPlan(d, JSON.stringify({
          phases: [{ number: '01', name: 'a' }],
          planHash: md5,
        }));
        assert.equal(r.code, 0, r.stderr);
        const state = JSON.parse(runIn(d, 'get').stdout);
        assert.equal(state.planHash, md5);
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });

    test('64 字符上限边界值 → 通过', () => {
      const d = freshDir();
      try {
        const r = initPlan(d, JSON.stringify({
          phases: [{ number: '01', name: 'a' }],
          planHash: 'a'.repeat(64),
        }));
        assert.equal(r.code, 0, r.stderr);
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });
  });

  describe('向后兼容:旧 state.json 无 planHash 字段', () => {
    function freshDir() {
      return fs.mkdtempSync(path.join(os.tmpdir(), 'atdo-bug09-bc-'));
    }

    test('get/set-phase/get-current-phase 等命令对旧 state.json 正常工作', () => {
      const d = freshDir();
      try {
        // 模拟旧版 init 产出的 state.json(无 planHash 字段)
        fs.mkdirSync(path.join(d, '.phase-execution'), { recursive: true });
        const oldState = {
          version: '2.0',
          projectRoot: d,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          phases: [
            { number: '01', name: 'a', status: 'pending', commits: [], commitHash: null },
            { number: '02', name: 'b', status: 'pending', commits: [], commitHash: null },
          ],
          currentPhaseIndex: 0,
          strikes: { phaseRetry: {}, regression: 0, sameCategory: {} },
          networkStatus: { consecutiveFailures: 0, lastSuccessfulCall: null },
          securityEvents: [],
          exitReason: null,
        };
        fs.writeFileSync(path.join(d, '.phase-execution/state.json'), JSON.stringify(oldState, null, 2));
        // get planHash 应返回 null(字段不存在)
        const got = runIn(d, 'get', 'planHash');
        assert.equal(got.stdout, 'null');
        // set-phase 仍正常工作
        const r1 = runIn(d, 'set-phase', '01', 'in_progress');
        assert.equal(r1.code, 0);
        // get-current-phase 仍正常工作
        const r2 = runIn(d, 'get-current-phase');
        assert.match(r2.stdout, /"number":\s*"01"/);
      } finally { fs.rmSync(d, { recursive: true, force: true }); }
    });
  });
});
