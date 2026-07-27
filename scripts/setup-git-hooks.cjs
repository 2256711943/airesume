const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const gitDir = path.join(repoRoot, '.git');
const huskyDir = path.join(repoRoot, '.husky');
const huskyInternalDir = path.join(huskyDir, '_');
const gitHooksDir = path.join(gitDir, 'hooks');
const hookNames = ['pre-commit', 'pre-push'];
const launcherNames = [
  'pre-commit',
  'pre-merge-commit',
  'prepare-commit-msg',
  'commit-msg',
  'post-commit',
  'applypatch-msg',
  'pre-applypatch',
  'post-applypatch',
  'pre-rebase',
  'post-rewrite',
  'post-checkout',
  'post-merge',
  'pre-push',
  'pre-auto-gc',
];
const huskyShimSource = path.join(repoRoot, 'node_modules', 'husky', 'husky');

function log(message) {
  console.log(`[hooks] ${message}`);
}

function fail(message) {
  console.error(`[hooks] ${message}`);
  process.exit(1);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.error) {
    fail(`failed to run "${command} ${args.join(' ')}": ${result.error.message}`);
  }

  if (result.status !== 0) {
    fail(`"${command} ${args.join(' ')}" exited with code ${result.status}`);
  }
}

function ensureGitRepository() {
  if (!fs.existsSync(gitDir)) {
    log('skipping hook installation because .git is missing');
    process.exit(0);
  }
}

function ensureHuskyInstalled() {
  if (!fs.existsSync(huskyDir)) {
    fail('missing .husky directory');
  }

  if (!fs.existsSync(huskyShimSource)) {
    fail('missing local husky package, run npm install first');
  }

  log('refreshing Husky internal hook launcher');
  fs.rmSync(path.join(huskyInternalDir, 'husky.sh'), { force: true });
  fs.mkdirSync(huskyInternalDir, { recursive: true });
  fs.writeFileSync(path.join(huskyInternalDir, '.gitignore'), '*\n', 'utf8');
  fs.copyFileSync(huskyShimSource, path.join(huskyInternalDir, 'h'));

  for (const launcherName of launcherNames) {
    const launcherPath = path.join(huskyInternalDir, launcherName);
    fs.writeFileSync(launcherPath, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n', {
      encoding: 'utf8',
      mode: 0o755,
    });
  }

  fs.writeFileSync(
    path.join(huskyInternalDir, 'husky.sh'),
    'echo "husky - DEPRECATED\n\nPlease remove the following two lines from $0:\n\n#!/usr/bin/env sh\n. \\"\\$(dirname -- \\"\\$0\\")/_/husky.sh\\"\n\nThey WILL FAIL in v10.0.0\n"\n',
    'utf8',
  );
}

function ensureHookCommands() {
  const expectedCommands = {
    'pre-commit': 'npx lint-staged',
    'pre-push': 'npm run validate',
  };

  for (const [hookName, command] of Object.entries(expectedCommands)) {
    const hookPath = path.join(huskyDir, hookName);
    if (!fs.existsSync(hookPath)) {
      log(`creating missing .husky/${hookName}`);
      fs.writeFileSync(hookPath, `${command}\n`, 'utf8');
    }
  }
}

function ensureHooksPath() {
  log('configuring Git to use .husky/_ as hooksPath');
  runCommand('git', ['config', 'core.hooksPath', '.husky/_']);
}

function ensureGitHookProxies() {
  fs.mkdirSync(gitHooksDir, { recursive: true });

  for (const hookName of hookNames) {
    const proxyPath = path.join(gitHooksDir, hookName);
    const proxyContent = [
      '#!/usr/bin/env sh',
      `exec sh "$(dirname "$0")/../../.husky/_/${hookName}" "$@"`,
      '',
    ].join('\n');

    fs.writeFileSync(proxyPath, proxyContent, 'utf8');
  }

  log('wrote compatibility proxies to .git/hooks');
}

function ensureHuskyLaunchers() {
  for (const hookName of hookNames) {
    const launcherPath = path.join(huskyInternalDir, hookName);
    if (!fs.existsSync(launcherPath)) {
      fail(`missing Husky launcher for ${hookName}`);
    }
  }
}

function main() {
  ensureGitRepository();
  ensureHuskyInstalled();
  ensureHookCommands();
  ensureHooksPath();
  ensureHuskyLaunchers();
  ensureGitHookProxies();
  log('Git hook installation is healthy');
}

main();
