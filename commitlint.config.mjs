export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 12 个 type（与 atdo 项目历史一致）
    'type-enum': [2, 'always', [
      'feat', 'fix', 'docs', 'style', 'refactor', 'test',
      'chore', 'perf', 'ci', 'revert', 'security', 'hotfix',
    ]],
    // F11 修订：subject ≤ 100 chars（默认 50 对中文太短，中文字符宽度大约相当于英文 2-3 倍）
    'subject-max-length': [2, 'always', 100],
    // body 行长不限制（中文文档常含长行表格 / URL）
    'body-max-line-length': [0],
    // footer 行长不限制
    'footer-max-line-length': [0],
  },
};
