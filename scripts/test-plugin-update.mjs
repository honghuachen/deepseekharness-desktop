#!/usr/bin/env node
/**
 * 第三方插件更新功能自测：纯 node，无网络依赖，覆盖：
 *   1) compareRangeToLatest 各类 range 的判定
 *   2) registry URL 构造（scoped / 普通 / 非法）
 *   3) 缓存命中 / 并发去重
 *   4) updatePlugin：备份 → 写新 range → pnpm 失败回滚（用 echo 假 pnpm）
 *   5) checkProfileUpdates：第三方依赖 vs 官方包
 *
 * 退出码 0=全部通过；非 0=有断言失败。
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

const guard = require(path.join(__dirname, '..', 'src', 'main', 'plugin-guard.js'));
const {
  compareRangeToLatest,
  createRegistryChecker,
  createGitHubChecker,
  parseGitHubSpec,
  parseRepoUrl,
  getInstalledGitCommit,
  updatePlugin,
  updatePlugins,
  installPluginToProfile,
  checkProfileUpdates,
  isOfficial,
  parsePnpmProgressLine,
} = guard;
const { buildInventory, rollbackPendingMutation } = require(path.join(__dirname, '..', 'src', 'main', 'plugin-manager.js'));

let failed = 0;
function t(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => process.stdout.write(`  ✓ ${name}\n`))
    .catch((err) => {
      failed++;
      process.stdout.write(`  ✗ ${name}\n    ${err.stack || err}\n`);
    });
}

function tmpProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-upd-'));
  return dir;
}

async function main() {
  process.stdout.write('compareRangeToLatest:\n');
  await t('^0.8.1 vs 0.9.0 → outdated', () => {
    assert.equal(compareRangeToLatest('^0.8.1', '0.9.0'), 'outdated');
  });
  await t('^1.0.0 vs 1.0.0 → current', () => {
    assert.equal(compareRangeToLatest('^1.0.0', '1.0.0'), 'current');
  });
  await t('~1.2.0 vs 1.2.5 → outdated', () => {
    assert.equal(compareRangeToLatest('~1.2.0', '1.2.5'), 'outdated');
  });
  await t('latest → unknown', () => {
    assert.equal(compareRangeToLatest('latest', '9.9.9'), 'unknown');
  });
  await t('git+https://... → unknown', () => {
    assert.equal(compareRangeToLatest('git+https://github.com/foo/bar.git', '1.0.0'), 'unknown');
  });
  await t('workspace:* → unknown', () => {
    assert.equal(compareRangeToLatest('workspace:*', '1.0.0'), 'unknown');
  });
  await t('latest=null → unknown', () => {
    assert.equal(compareRangeToLatest('^1.0.0', null), 'unknown');
  });
  await t('空字符串 → unknown', () => {
    assert.equal(compareRangeToLatest('', '1.0.0'), 'unknown');
  });
  await t('>=0.8.0 vs 0.9.0 → outdated（提取首个 semver）', () => {
    assert.equal(compareRangeToLatest('>=0.8.0 <1.0.0', '0.9.0'), 'outdated');
  });
  await t('rc 预发布：^1.0.0-rc.1 vs 1.0.0 → outdated', () => {
    assert.equal(compareRangeToLatest('^1.0.0-rc.1', '1.0.0'), 'outdated');
  });

  process.stdout.write('registry URL 构造:\n');
  await t('普通包 URL 正确', () => {
    const reg = createRegistryChecker();
    // 取出闭包里的 registryUrl 不可行，改为通过 fetchLatest 拦截：
    // 这里改为调用 fetchLatest 并用 stub global.fetch 捕获 URL
    const orig = global.fetch;
    let captured = null;
    global.fetch = async (url, opts) => {
      captured = String(url);
      return new Response(JSON.stringify({ version: '1.2.3' }), { status: 200, headers: { etag: 'W/"abc"' } });
    };
    return reg.fetchLatest('lodash').then((v) => {
      assert.equal(v, '1.2.3');
      assert.equal(captured, 'https://registry.npmjs.org/lodash/latest');
    }).finally(() => { global.fetch = orig; });
  });
  await t('scoped 包 URL 正确（@scope/name）', () => {
    const reg = createRegistryChecker();
    const orig = global.fetch;
    let captured = null;
    global.fetch = async (url) => {
      captured = String(url);
      return new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 });
    };
    return reg.fetchLatest('@mtensor/memos-local-plugin').then((v) => {
      assert.equal(v, '2.0.0');
      assert.equal(captured, 'https://registry.npmjs.org/@mtensor%2Fmemos-local-plugin/latest');
    }).finally(() => { global.fetch = orig; });
  });

  process.stdout.write('缓存 + 并发去重:\n');
  await t('相同包名多次调用只请求一次', async () => {
    const reg = createRegistryChecker();
    let n = 0;
    const orig = global.fetch;
    global.fetch = async () => {
      n++;
      return new Response(JSON.stringify({ version: '1.0.0' }), { status: 200 });
    };
    try {
      const [a, b, c] = await Promise.all([
        reg.fetchLatest('foo'),
        reg.fetchLatest('foo'),
        reg.fetchLatest('foo'),
      ]);
      assert.equal(a, '1.0.0');
      assert.equal(b, '1.0.0');
      assert.equal(c, '1.0.0');
      assert.equal(n, 1);
    } finally {
      global.fetch = orig;
    }
  });
  await t('失败也只请求一次（不被重复打）', async () => {
    const reg = createRegistryChecker();
    let n = 0;
    const orig = global.fetch;
    global.fetch = async () => {
      n++;
      return new Response('nope', { status: 500 });
    };
    try {
      const [a, b] = await Promise.all([
        reg.fetchLatest('bar'),
        reg.fetchLatest('bar'),
      ]);
      assert.equal(a, null);
      assert.equal(b, null);
      assert.equal(n, 1);
    } finally {
      global.fetch = orig;
    }
  });

  process.stdout.write('updatePlugin:\n');
  await t('pnpm 失败时回滚 package.json', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo',
      private: true,
      dependencies: { 'demo-pkg': '^0.8.1' },
    }, null, 2) + '\n');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    // 用一个会失败的假 pnpm
    const fakeNode = process.execPath;
    const fakePnpm = path.join(dir, 'fake-pnpm.cjs');
    fs.writeFileSync(fakePnpm, "process.exit(1);\n");
    const result = await updatePlugin(dir, 'demo-pkg', {
      targetVersion: 'latest',
      nodeBin: fakeNode,
      pnpmCjs: fakePnpm,
      log: () => {},
    });
    assert.equal(result.ok, false);
    assert.match(result.error || '', /退出码/);
    // 回滚：package.json 应当与最初一致
    const restored = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.deepEqual(restored.dependencies, { 'demo-pkg': '^0.8.1' });
    // 备份存在
    const backups = fs.readdirSync(dir).filter((n) => n.startsWith('.sanitized-backup-'));
    assert.equal(backups.length, 1);
  });
  await t('成功路径：指定版本号时 range 规范为 ^x.y.z', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo2',
      private: true,
      dependencies: { 'demo-pkg': '^0.8.1' },
    }, null, 2) + '\n');
    fs.mkdirSync(path.join(dir, 'node_modules')); // 必须存在以让 pnpm 跑
    const fakeNode = process.execPath;
    const fakePnpm = path.join(dir, 'fake-pnpm.cjs');
    fs.writeFileSync(fakePnpm, "process.exit(0);\n");
    const result = await updatePlugin(dir, 'demo-pkg', {
      targetVersion: '0.9.0',
      nodeBin: fakeNode,
      pnpmCjs: fakePnpm,
      log: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.to, '^0.9.0');
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(after.dependencies['demo-pkg'], '^0.9.0');
  });
  await t('成功路径：从 node_modules 读出安装版本规范为 ^x.y.z', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo2-nm',
      private: true,
      dependencies: { 'demo-pkg': '^0.8.1' },
    }, null, 2) + '\n');
    fs.mkdirSync(path.join(dir, 'node_modules', 'demo-pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'demo-pkg', 'package.json'), JSON.stringify({ version: '1.2.3' }));
    const fakeNode = process.execPath;
    const fakePnpm = path.join(dir, 'fake-pnpm.cjs');
    fs.writeFileSync(fakePnpm, "process.exit(0);\n");
    const result = await updatePlugin(dir, 'demo-pkg', {
      targetVersion: '1.2.3',
      nodeBin: fakeNode,
      pnpmCjs: fakePnpm,
      log: () => {},
    });
    assert.equal(result.ok, true);
    assert.equal(result.from, '^0.8.1');
    assert.equal(result.to, '^1.2.3');
  });
  await t('安装后版本未发生提升时判定为未生效', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo-stuck',
      private: true,
      dependencies: { 'demo-pkg': '^0.8.1' },
    }, null, 2) + '\n');
    fs.mkdirSync(path.join(dir, 'node_modules', 'demo-pkg'), { recursive: true });
    // node_modules 里仍然是 0.8.1（模拟 pnpm 因 lockfile 满足未做任何升级）
    fs.writeFileSync(path.join(dir, 'node_modules', 'demo-pkg', 'package.json'), JSON.stringify({ version: '0.8.1' }));
    const fakeNode = process.execPath;
    const fakePnpm = path.join(dir, 'fake-pnpm.cjs');
    fs.writeFileSync(fakePnpm, "process.exit(0);\n");
    const result = await updatePlugin(dir, 'demo-pkg', {
      targetVersion: 'latest',
      nodeBin: fakeNode,
      pnpmCjs: fakePnpm,
      log: () => {},
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /未提升/);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(after.dependencies['demo-pkg'], '^0.8.1');
  });
  await t('updatePlugins 批量升级多个依赖', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo-batch',
      private: true,
      dependencies: { 'pkg-a': '^1.0.0', 'pkg-b': '^2.0.0' },
    }, null, 2) + '\n');
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg-a'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg-b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg-a', 'package.json'), JSON.stringify({ version: '1.1.0' }));
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg-b', 'package.json'), JSON.stringify({ version: '2.1.0' }));
    const fakeNode = process.execPath;
    const fakePnpm = path.join(dir, 'fake-pnpm.cjs');
    fs.writeFileSync(fakePnpm, "process.exit(0);\n");
    const { report, anyChanged } = await updatePlugins(dir, [
      { name: 'pkg-a', target: '1.1.0' },
      { name: 'pkg-b', target: '2.1.0' },
    ], {
      nodeBin: fakeNode,
      pnpmCjs: fakePnpm,
      log: () => {},
    });
    assert.equal(anyChanged, true);
    assert.equal(report.length, 2);
    assert.equal(report[0].ok, true);
    assert.equal(report[0].to, '^1.1.0');
    assert.equal(report[1].ok, true);
    assert.equal(report[1].to, '^2.1.0');
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(after.dependencies['pkg-a'], '^1.1.0');
    assert.equal(after.dependencies['pkg-b'], '^2.1.0');
  });
  await t('updatePlugins 传递 dangerously-allow-all-builds 与 strict-dep-builds 参数与环境变量', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo-pnpm-args',
      private: true,
      dependencies: { 'pkg-c': '^1.0.0' },
    }, null, 2) + '\n');
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg-c'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg-c', 'package.json'), JSON.stringify({ version: '1.2.0' }));
    const fakeNode = process.execPath;
    const fakePnpm = path.join(dir, 'fake-pnpm-inspect.cjs');
    fs.writeFileSync(fakePnpm, `
      const fs = require('fs');
      fs.writeFileSync(${JSON.stringify(path.join(dir, 'captured.json'))}, JSON.stringify({
        argv: process.argv.slice(2),
        env: {
          dangerously: process.env.PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS,
          strict: process.env.PNPM_CONFIG_STRICT_DEP_BUILDS,
        }
      }));
      process.exit(0);
    `);
    const { report } = await updatePlugins(dir, [{ name: 'pkg-c', target: '1.2.0' }], {
      nodeBin: fakeNode,
      pnpmCjs: fakePnpm,
      log: () => {},
    });
    assert.equal(report[0].ok, true);
    const captured = JSON.parse(fs.readFileSync(path.join(dir, 'captured.json'), 'utf8'));
    assert.equal(captured.argv.includes('--config.dangerously-allow-all-builds=true'), true);
    assert.equal(captured.argv.includes('--config.strict-dep-builds=false'), true);
    assert.equal(captured.env.dangerously, 'true');
    assert.equal(captured.env.strict, 'false');
  });
  await t('官方包拒绝升级', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo3',
      private: true,
      dependencies: { '@deepseek-ai/dsh-base': '^0.1.0' },
    }, null, 2) + '\n');
    const result = await updatePlugin(dir, '@deepseek-ai/dsh-base', {
      targetVersion: 'latest',
      log: () => {},
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /官方包/);
  });
  await t('不存在的包名报错', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo4',
      private: true,
      dependencies: {},
    }, null, 2) + '\n');
    const result = await updatePlugin(dir, 'ghost', { log: () => {} });
    assert.equal(result.ok, false);
    assert.match(result.error, /不在该 profile/);
  });

  process.stdout.write('checkProfileUpdates:\n');
  await t('只检查第三方依赖（官方包不出现在结果里）', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo5',
      private: true,
      dependencies: {
        '@deepseek-ai/dsh-base': '^0.1.0',
        'demo-pkg': '^0.8.1',
        'another': '^2.0.0',
      },
    }, null, 2) + '\n');
    const reg = createRegistryChecker();
    const orig = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('demo-pkg')) return new Response(JSON.stringify({ version: '0.9.0' }), { status: 200 });
      if (u.includes('another')) return new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 });
      return new Response('{}', { status: 404 });
    };
    try {
      const out = await checkProfileUpdates(dir, { registry: reg });
      assert.equal(out.length, 2);
      const names = out.map((x) => x.name).sort();
      assert.deepEqual(names, ['another', 'demo-pkg']);
      const demo = out.find((x) => x.name === 'demo-pkg');
      const another = out.find((x) => x.name === 'another');
      assert.equal(demo.status, 'outdated');
      assert.equal(demo.latest, '0.9.0');
      assert.equal(another.status, 'current');
      assert.equal(another.latest, '2.0.0');
    } finally {
      global.fetch = orig;
    }
  });
  await t('registry 失败 → status=unknown, latest=null', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo6',
      private: true,
      dependencies: { 'flaky': '^1.0.0' },
    }, null, 2) + '\n');
    const reg = createRegistryChecker();
    const orig = global.fetch;
    global.fetch = async () => { throw new Error('ENETUNREACH'); };
    try {
      const out = await checkProfileUpdates(dir, { registry: reg });
      assert.equal(out.length, 1);
      assert.equal(out[0].status, 'unknown');
      assert.equal(out[0].latest, null);
    } finally {
      global.fetch = orig;
    }
  });
  await t('空 profile 返回 []', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'empty',
      private: true,
      dependencies: { '@deepseek-ai/dsh-base': '^0.1.0' },
    }, null, 2) + '\n');
    const out = await checkProfileUpdates(dir, {});
    assert.deepEqual(out, []);
  });
  await t('isOfficial 识别官方前缀', () => {
    assert.equal(isOfficial('@deepseek-ai/dsh'), true);
    assert.equal(isOfficial('@deepseek-ai/dsh-base'), true);
    assert.equal(isOfficial('lodash'), false);
    assert.equal(isOfficial('@mtensor/memos'), false);
  });

  process.stdout.write('parseGitHubSpec:\n');
  await t('解析各类 GitHub 依赖规格', () => {
    assert.deepEqual(parseGitHubSpec('github:foo/bar'), { owner: 'foo', repo: 'bar', ref: 'HEAD' });
    assert.deepEqual(parseGitHubSpec('github:foo/bar#main'), { owner: 'foo', repo: 'bar', ref: 'main' });
    assert.deepEqual(parseGitHubSpec('github:kusesad-1122/dsh-context-compactor'), { owner: 'kusesad-1122', repo: 'dsh-context-compactor', ref: 'HEAD' });
    assert.deepEqual(parseGitHubSpec('git+https://github.com/foo/bar.git'), { owner: 'foo', repo: 'bar', ref: 'HEAD' });
    assert.deepEqual(parseGitHubSpec('https://github.com/foo/bar#v1.0.0'), { owner: 'foo', repo: 'bar', ref: 'v1.0.0' });
    assert.deepEqual(parseGitHubSpec('git@github.com:foo/bar.git'), { owner: 'foo', repo: 'bar', ref: 'HEAD' });
    assert.deepEqual(parseGitHubSpec('github:ningbainb/deepseek-harness-desktop#path:packages/skins/blue-fantasy'), {
      owner: 'ningbainb',
      repo: 'deepseek-harness-desktop',
      ref: 'HEAD',
      path: 'packages/skins/blue-fantasy',
    });
    assert.deepEqual(parseGitHubSpec('github:ningbainb/deepseek-harness-desktop#main&path:packages/skins/blue-fantasy'), {
      owner: 'ningbainb',
      repo: 'deepseek-harness-desktop',
      ref: 'main',
      path: 'packages/skins/blue-fantasy',
    });
    assert.equal(parseGitHubSpec('^1.0.0'), null);
    assert.equal(parseGitHubSpec('lodash'), null);
    assert.equal(parseGitHubSpec(''), null);
  });

  process.stdout.write('getInstalledGitCommit:\n');
  await t('从 lockfile 提取已装 commit SHA', () => {
    const dir = tmpProfile();
    const fakeLock = `
importers:
  .:
    dependencies:
      dsh-history-rewind:
        specifier: github:DDDonzy/dsh-history-rewind
        version: https://codeload.github.com/DDDonzy/dsh-history-rewind/tar.gz/d6e583c870956db0454a75fd969663d3cbde1412
      regular-pkg:
        specifier: ^1.0.0
        version: 1.0.0
packages:
  dsh-history-rewind@https://codeload.github.com/DDDonzy/dsh-history-rewind/tar.gz/d6e583c870956db0454a75fd969663d3cbde1412:
    resolution: {tarball: https://codeload.github.com/DDDonzy/dsh-history-rewind/tar.gz/d6e583c870956db0454a75fd969663d3cbde1412}
`;
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), fakeLock);
    assert.equal(getInstalledGitCommit(dir, 'dsh-history-rewind'), 'd6e583c870956db0454a75fd969663d3cbde1412');
    assert.equal(getInstalledGitCommit(dir, 'regular-pkg'), null);
    assert.equal(getInstalledGitCommit(dir, 'non-existent'), null);
  });

  process.stdout.write('parsePnpmProgressLine:\n');
  await t('解析标准 Progress: 行（未完成）', () => {
    const r = parsePnpmProgressLine('Progress: resolved 175, reused 53, downloaded 8, added 10');
    assert.deepEqual(r, { resolved: 175, reused: 53, downloaded: 8, added: 10, done: false });
  });
  await t('解析末尾带 done 的 Progress: 行', () => {
    const r = parsePnpmProgressLine('Progress: resolved 175, reused 53, downloaded 8, added 10, done');
    assert.deepEqual(r, { resolved: 175, reused: 53, downloaded: 8, added: 10, done: true });
  });
  await t('前缀带 [guard] 等日志装饰也能解析', () => {
    const r = parsePnpmProgressLine('[guard]   Progress: resolved 1, reused 0, downloaded 0, added 0');
    assert.ok(r);
    assert.equal(r.resolved, 1);
  });
  await t('非 Progress: 行返回 null', () => {
    assert.equal(parsePnpmProgressLine('Done in 18.7s using pnpm v11.24.0'), null);
    assert.equal(parsePnpmProgressLine(''), null);
    assert.equal(parsePnpmProgressLine(null), null);
  });

  process.stdout.write('createGitHubChecker:\n');
  await t('Smart Git HTTP 解析 HEAD sha 与 tag', async () => {
    const checker = createGitHubChecker();
    const orig = global.fetch;
    const fakeGitUploadPack = `001e# service=git-upload-pack
00000159d6e583c870956db0454a75fd969663d3cbde1412 HEAD symref=HEAD:refs/heads/main
003dd6e583c870956db0454a75fd969663d3cbde1412 refs/heads/main
003cd6e583c870956db0454a75fd969663d3cbde1412 refs/tags/v0.1.0
0000`;
    global.fetch = async (url) => {
      assert.match(String(url), /info\/refs\?service=git-upload-pack/);
      return new Response(fakeGitUploadPack, { status: 200 });
    };
    try {
      const res = await checker.fetchLatest('github:DDDonzy/dsh-history-rewind');
      assert.equal(res.sha, 'd6e583c870956db0454a75fd969663d3cbde1412');
      assert.equal(res.shortSha, 'd6e583c');
      assert.equal(res.tag, 'v0.1.0');
    } finally {
      global.fetch = orig;
    }
  });

  await t('Smart Git HTTP 失败时降级至 GitHub API', async () => {
    const checker = createGitHubChecker();
    const orig = global.fetch;
    let smartTried = false;
    let apiTried = false;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('info/refs')) {
        smartTried = true;
        return new Response('Not Found', { status: 404 });
      }
      if (u.includes('api.github.com')) {
        apiTried = true;
        return new Response(JSON.stringify({ sha: '1111222233334444555566667777888899990000' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };
    try {
      const res = await checker.fetchLatest('github:test/repo');
      assert.equal(smartTried, true);
      assert.equal(apiTried, true);
      assert.equal(res.sha, '1111222233334444555566667777888899990000');
      assert.equal(res.shortSha, '1111222');
    } finally {
      global.fetch = orig;
    }
  });

  await t('第 1 优先级：优先请求 GitHub releases/latest 获取最新正式 Release', async () => {
    const checker = createGitHubChecker();
    const orig = global.fetch;
    let releaseApiHit = false;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('releases/latest')) {
        releaseApiHit = true;
        return new Response(JSON.stringify({ tag_name: 'v0.3.20' }), { status: 200 });
      }
      if (u.includes('commits/v0.3.20')) {
        return new Response(JSON.stringify({ sha: '3333444455556666777788889999000011112222' }), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    };
    try {
      const res = await checker.fetchLatest('github:zhu1090093659/dsh-web');
      assert.equal(releaseApiHit, true);
      assert.equal(res.tag, 'v0.3.20');
      assert.equal(res.version, '0.3.20');
      assert.equal(res.isRelease, true);
      assert.equal(res.sha, '3333444455556666777788889999000011112222');
      assert.equal(res.shortSha, '3333444');
    } finally {
      global.fetch = orig;
    }
  });

  await t('第 2 优先级：无 releases/latest 时，通过 Git Tags 筛选最高版本 Release Tag（忽略 HEAD commit）', async () => {
    const checker = createGitHubChecker();
    const orig = global.fetch;
    const fakeGitUploadPack = `
000001599999999999999999999999999999999999999999 HEAD
00461111111111111111111111111111111111111111 refs/tags/v1.0.0
00462222222222222222222222222222222222222222 refs/tags/v2.1.0
00492222222222222222222222222222222222222222 refs/tags/v2.1.0^{}
00463333333333333333333333333333333333333333 refs/tags/v1.5.0
0000`;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('releases/latest')) {
        return new Response('Not Found', { status: 404 });
      }
      if (u.includes('info/refs')) {
        return new Response(fakeGitUploadPack, { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    };
    try {
      const res = await checker.fetchLatest('github:test/multi-tag-repo');
      assert.equal(res.tag, 'v2.1.0');
      assert.equal(res.version, '2.1.0');
      assert.equal(res.sha, '2222222222222222222222222222222222222222');
      assert.equal(res.isRelease, true);
    } finally {
      global.fetch = orig;
    }
  });

  await t('第 3 优先级：无任何 Release 和版本 Tag 时，兜底使用默认分支最新代码 Commit Hash', async () => {
    const checker = createGitHubChecker();
    const orig = global.fetch;
    const fakeGitUploadPack = `
000001598888888888888888888888888888888888888888 HEAD
00468888888888888888888888888888888888888888 refs/heads/main
0000`;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('releases/latest')) return new Response('Not Found', { status: 404 });
      if (u.includes('info/refs')) return new Response(fakeGitUploadPack, { status: 200 });
      return new Response('Not Found', { status: 404 });
    };
    try {
      const res = await checker.fetchLatest('github:test/no-tag-repo');
      assert.equal(res.tag, null);
      assert.equal(res.version, null);
      assert.equal(res.isRelease, false);
      assert.equal(res.sha, '8888888888888888888888888888888888888888');
      assert.equal(res.shortSha, '8888888');
    } finally {
      global.fetch = orig;
    }
  });

  await t('monorepo #path: 子目录安装：忽略仓库级 Release Tag（避免与壳/主产品版本混淆），按路径自身最新提交与 package.json 取值', async () => {
    const checker = createGitHubChecker();
    const orig = global.fetch;
    let releaseApiHit = false;
    let pathCommitsHit = false;
    let pathPackageJsonHit = false;
    global.fetch = async (url) => {
      const u = String(url);
      // 仓库整体挂着一个与子插件毫无关系的“桌面壳”发布 Tag，绝不能被当成子插件的版本
      if (u.includes('releases/latest')) {
        releaseApiHit = true;
        return new Response(JSON.stringify({ tag_name: 'desktop-v3.3.0' }), { status: 200 });
      }
      if (u.includes('/commits?path=')) {
        pathCommitsHit = true;
        assert.match(u, /path=packages%2Fskins%2Fblue-fantasy/);
        return new Response(JSON.stringify([{ sha: '2fb56b13e8e9b02bf8cd8275bf028e2b21e65063' }]), { status: 200 });
      }
      if (u.includes('/contents/packages/skins/blue-fantasy/package.json')) {
        pathPackageJsonHit = true;
        const body = JSON.stringify({ version: '0.1.15' });
        return new Response(JSON.stringify({ content: Buffer.from(body, 'utf8').toString('base64') }), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    };
    try {
      const res = await checker.fetchLatest('github:ningbainb/deepseek-harness-desktop#path:packages/skins/blue-fantasy');
      assert.equal(releaseApiHit, false, '子目录安装不应查询仓库级 releases/latest');
      assert.equal(pathCommitsHit, true);
      assert.equal(pathPackageJsonHit, true);
      assert.equal(res.sha, '2fb56b13e8e9b02bf8cd8275bf028e2b21e65063');
      assert.equal(res.shortSha, '2fb56b1');
      assert.equal(res.tag, null);
      assert.equal(res.version, '0.1.15');
      assert.equal(res.isRelease, false);
    } finally {
      global.fetch = orig;
    }
  });

  process.stdout.write('checkProfileUpdates (GitHub 依赖):\n');
  await t('commit 一致 → current (已是最新)', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo-gh1',
      private: true,
      dependencies: { 'dsh-history-rewind': 'github:DDDonzy/dsh-history-rewind' },
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), `
importers:
  .:
    dependencies:
      dsh-history-rewind:
        specifier: github:DDDonzy/dsh-history-rewind
        version: https://codeload.github.com/DDDonzy/dsh-history-rewind/tar.gz/d6e583c870956db0454a75fd969663d3cbde1412
`);
    const gh = createGitHubChecker();
    const orig = global.fetch;
    global.fetch = async () => new Response(`00000159d6e583c870956db0454a75fd969663d3cbde1412 HEAD\n0000`, { status: 200 });
    try {
      const out = await checkProfileUpdates(dir, { githubChecker: gh });
      assert.equal(out.length, 1);
      assert.equal(out[0].name, 'dsh-history-rewind');
      assert.equal(out[0].status, 'current');
      assert.equal(out[0].latest, 'd6e583c');
      assert.equal(out[0].isGitHub, true);
    } finally {
      global.fetch = orig;
    }
  });

  await t('commit 不一致但声明版本号碰巧相同 → 仍判定 outdated（不被未跟进的 version 字段掩盖）', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo-gh-stale-version',
      private: true,
      dependencies: { 'blue-fantasy': 'github:ningbainb/deepseek-harness-desktop#path:packages/skins/blue-fantasy' },
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), `
importers:
  .:
    dependencies:
      blue-fantasy:
        specifier: github:ningbainb/deepseek-harness-desktop#path:packages/skins/blue-fantasy
        version: https://codeload.github.com/ningbainb/deepseek-harness-desktop/tar.gz/22f7d953f789b448654d2c016e2643a719d687ac
`);
    fs.mkdirSync(path.join(dir, 'node_modules', 'blue-fantasy'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'node_modules', 'blue-fantasy', 'package.json'),
      JSON.stringify({ name: 'blue-fantasy', version: '0.1.15' }, null, 2) + '\n',
    );
    const gh = createGitHubChecker();
    const orig = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      // 远端内容其实已经变了（新 sha），但维护者没跟着改 package.json 的 version 字段
      if (u.includes('/commits?path=')) {
        return new Response(JSON.stringify([{ sha: '2fb56b13e8e9b02bf8cd8275bf028e2b21e65063' }]), { status: 200 });
      }
      if (u.includes('/contents/packages/skins/blue-fantasy/package.json')) {
        const body = JSON.stringify({ version: '0.1.15' });
        return new Response(JSON.stringify({ content: Buffer.from(body, 'utf8').toString('base64') }), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    };
    try {
      const out = await checkProfileUpdates(dir, { githubChecker: gh });
      assert.equal(out.length, 1);
      assert.equal(out[0].name, 'blue-fantasy');
      assert.equal(out[0].status, 'outdated');
    } finally {
      global.fetch = orig;
    }
  });

  await t('npm 包即使 package.json 中有 GitHub 仓库地址，未走 git 安装仍走 npm 检查', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo-npm-repo',
      private: true,
      dependencies: { 'dsh-inherit': '^0.1.0' },
    }, null, 2) + '\n');
    fs.mkdirSync(path.join(dir, 'node_modules', 'dsh-inherit'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules', 'dsh-inherit', 'package.json'), JSON.stringify({
      name: 'dsh-inherit',
      version: '0.1.0',
      repository: { type: 'git', url: 'https://github.com/MayBeTheWorld/dsh-inherit.git' },
    }));
    const reg = createRegistryChecker();
    const orig = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('registry.npmjs.org')) {
        return new Response(JSON.stringify({ version: '0.1.0' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };
    try {
      const out = await checkProfileUpdates(dir, { registry: reg });
      assert.equal(out.length, 1);
      assert.equal(out[0].name, 'dsh-inherit');
      assert.equal(out[0].status, 'current');
      assert.equal(out[0].latest, '0.1.0');
      assert.equal(out[0].isGitHub, undefined);
    } finally {
      global.fetch = orig;
    }
  });

  await t('commit 不一致 → outdated (有新版)', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo-gh2',
      private: true,
      dependencies: { 'dsh-history-rewind': 'github:DDDonzy/dsh-history-rewind' },
    }, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), `
importers:
  .:
    dependencies:
      dsh-history-rewind:
        specifier: github:DDDonzy/dsh-history-rewind
        version: https://codeload.github.com/DDDonzy/dsh-history-rewind/tar.gz/1111111111111111111111111111111111111111
`);
    const gh = createGitHubChecker();
    const orig = global.fetch;
    global.fetch = async () => new Response(`000001592222222222222222222222222222222222222222 HEAD\n003c2222222222222222222222222222222222222222 refs/tags/v0.2.0\n0000`, { status: 200 });
    try {
      const out = await checkProfileUpdates(dir, { githubChecker: gh });
      assert.equal(out.length, 1);
      assert.equal(out[0].name, 'dsh-history-rewind');
      assert.equal(out[0].status, 'outdated');
      assert.equal(out[0].latest, 'v0.2.0 (2222222)');
      assert.equal(out[0].isGitHub, true);
    } finally {
      global.fetch = orig;
    }
  });

  process.stdout.write('updatePlugin (GitHub 依赖):\n');
  await t('GitHub 依赖更新：保留 package.json 依赖格式且调用 pnpm update', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo-gh3',
      private: true,
      dependencies: { 'dsh-history-rewind': 'github:DDDonzy/dsh-history-rewind' },
    }, null, 2) + '\n');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), `
importers:
  .:
    dependencies:
      dsh-history-rewind:
        specifier: github:DDDonzy/dsh-history-rewind
        version: https://codeload.github.com/DDDonzy/dsh-history-rewind/tar.gz/1111111111111111111111111111111111111111
`);
    const fakeNode = process.execPath;
    const fakePnpm = path.join(dir, 'fake-pnpm-gh.cjs');
    // fake pnpm 捕获命令并将 lockfile 更新为 new commit
    fs.writeFileSync(fakePnpm, `
      const fs = require('fs');
      const path = require('path');
      const args = process.argv.slice(2);
      fs.writeFileSync(${JSON.stringify(path.join(dir, 'pnpm-args.json'))}, JSON.stringify(args));
      // 模拟 pnpm update 更新了 lockfile
      const newLock = \`
importers:
  .:
    dependencies:
      dsh-history-rewind:
        specifier: github:DDDonzy/dsh-history-rewind
        version: https://codeload.github.com/DDDonzy/dsh-history-rewind/tar.gz/2222222222222222222222222222222222222222
\`;
      fs.writeFileSync(${JSON.stringify(path.join(dir, 'pnpm-lock.yaml'))}, newLock);
      process.exit(0);
    `);

    const fakeGithubChecker = {
      // 该仓库没有任何 Release/Tag，只有 HEAD commit —— 验证「无 Tag 时仍应落到具体 SHA」而非 no-op
      fetchLatest: async () => ({
        sha: '2222222222222222222222222222222222222222',
        shortSha: '2222222',
        tag: null,
        version: null,
        isRelease: false,
      }),
    };

    const res = await updatePlugin(dir, 'dsh-history-rewind', {
      nodeBin: fakeNode,
      pnpmCjs: fakePnpm,
      log: () => {},
      githubChecker: fakeGithubChecker,
    });

    assert.equal(res.ok, true);
    assert.equal(res.from, '1111111');
    assert.equal(res.to, '2222222');

    // 关键校验：package.json 必须保留 github:... 协议格式（绝不能被改成 ^new2222 或 ^latest 这类 npm 语义化版本写法），
    // 但无 Tag 时应带上解析出的具体 Commit SHA，而不是原地不变（那样等于 no-op，用户永远更新不到最新内容）
    const afterPkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(
      afterPkg.dependencies['dsh-history-rewind'],
      'github:DDDonzy/dsh-history-rewind#2222222222222222222222222222222222222222',
    );

    // range 确实变了（带上了具体 SHA），走的是 pnpm install 而非原地 pnpm update
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'pnpm-args.json'), 'utf8'));
    assert.equal(args[0], 'install');
  });

  await t('target="latest" 且远端只有 Commit SHA 没有 Tag（如 monorepo #path: 安装）→ 仍能算出目标 SHA，不会退化成 no-op', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: 'demo-gh-latest-no-tag',
      private: true,
      dependencies: { 'blue-fantasy': 'github:ningbainb/deepseek-harness-desktop#desktop-v3.3.0&path:packages/skins/blue-fantasy' },
    }, null, 2) + '\n');
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), `
importers:
  .:
    dependencies:
      blue-fantasy:
        specifier: github:ningbainb/deepseek-harness-desktop#desktop-v3.3.0&path:packages/skins/blue-fantasy
        version: https://codeload.github.com/ningbainb/deepseek-harness-desktop/tar.gz/22f7d953f789b448654d2c016e2643a719d687ac#path:packages/skins/blue-fantasy
`);
    const fakeNode = process.execPath;
    const fakePnpm = path.join(dir, 'fake-pnpm-latest-no-tag.cjs');
    fs.writeFileSync(fakePnpm, `
      const fs = require('fs');
      const args = process.argv.slice(2);
      fs.writeFileSync(${JSON.stringify(path.join(dir, 'pnpm-args.json'))}, JSON.stringify(args));
      const newLock = \`
importers:
  .:
    dependencies:
      blue-fantasy:
        specifier: github:ningbainb/deepseek-harness-desktop#2fb56b13e8e9b02bf8cd8275bf028e2b21e65063&path:packages/skins/blue-fantasy
        version: https://codeload.github.com/ningbainb/deepseek-harness-desktop/tar.gz/2fb56b13e8e9b02bf8cd8275bf028e2b21e65063#path:packages/skins/blue-fantasy
\`;
      fs.writeFileSync(${JSON.stringify(path.join(dir, 'pnpm-lock.yaml'))}, newLock);
      process.exit(0);
    `);

    const fakeGithubChecker = {
      fetchLatest: async () => ({
        sha: '2fb56b13e8e9b02bf8cd8275bf028e2b21e65063',
        shortSha: '2fb56b1',
        tag: null,
        version: '0.1.15',
        isRelease: false,
      }),
    };

    const res = await updatePlugin(dir, 'blue-fantasy', {
      targetVersion: 'latest',
      nodeBin: fakeNode,
      pnpmCjs: fakePnpm,
      log: () => {},
      githubChecker: fakeGithubChecker,
    });

    assert.equal(res.ok, true);

    // 关键校验：package.json 里的 ref 必须被换成具体 SHA，而不是保留原 Tag 原地打转（no-op）
    const afterPkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(
      afterPkg.dependencies['blue-fantasy'],
      'github:ningbainb/deepseek-harness-desktop#2fb56b13e8e9b02bf8cd8275bf028e2b21e65063&path:packages/skins/blue-fantasy',
    );

    // 走的是 pkgModified=true 的 install 分支（因为 range 确实变了），而不是原地 pnpm update
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'pnpm-args.json'), 'utf8'));
    assert.equal(args[0], 'install');
  });

  process.stdout.write('parseRepoUrl:\n');
  await t('解析各类仓库及主页 URL', () => {
    assert.equal(parseRepoUrl('git+https://github.com/chenhw7/dsh-memory.git'), 'https://github.com/chenhw7/dsh-memory');
    assert.equal(parseRepoUrl('github:kusesad-1122/dsh-context-compactor'), 'https://github.com/kusesad-1122/dsh-context-compactor');
    assert.equal(parseRepoUrl('https://github.com/DDDonzy/dsh-history-rewind#readme'), 'https://github.com/DDDonzy/dsh-history-rewind');
    assert.equal(parseRepoUrl('git@github.com:foo/bar.git'), 'https://github.com/foo/bar');
    assert.equal(parseRepoUrl('owner/repo'), 'https://github.com/owner/repo');
    assert.equal(parseRepoUrl({ type: 'git', url: 'git+https://github.com/bowenliang123/dsh-context.git' }), 'https://github.com/bowenliang123/dsh-context');
    assert.equal(parseRepoUrl('https://gitlab.com/group/repo.git'), 'https://gitlab.com/group/repo');
    assert.equal(parseRepoUrl(null), null);
    assert.equal(parseRepoUrl(''), null);
  });

  process.stdout.write('buildInventory (URL 解析):\n');
  await t('正确生成第三方插件的 githubUrl 与 npmUrl', () => {
    const home = tmpProfile();
    const webDir = path.join(home, 'profiles', 'web');
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(
      path.join(webDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-profile-web',
        private: true,
        dependencies: {
          '@deepseek-ai/dsh-base': '0.1.0',
          'dsh-history-rewind': 'github:DDDonzy/dsh-history-rewind',
          'dsh-context': '^0.48.0',
          '@memtensor/memos-local-plugin': '^2.0.19',
        },
      }),
    );
    // 模拟 dsh-context 在 node_modules 中安装并提供了 repository
    const ctxModDir = path.join(webDir, 'node_modules', 'dsh-context');
    fs.mkdirSync(ctxModDir, { recursive: true });
    fs.writeFileSync(
      path.join(ctxModDir, 'package.json'),
      JSON.stringify({
        name: 'dsh-context',
        repository: { type: 'git', url: 'git+https://github.com/bowenliang123/dsh-context.git' },
      }),
    );

    const invs = buildInventory(home);
    assert.equal(invs.length, 1);
    const items = invs[0].items;

    const base = items.find((i) => i.name === '@deepseek-ai/dsh-base');
    assert.equal(base.official, true);
    assert.equal(base.githubUrl, null);
    assert.equal(base.npmUrl, null);

    const rewind = items.find((i) => i.name === 'dsh-history-rewind');
    assert.equal(rewind.official, false);
    assert.equal(rewind.githubUrl, 'https://github.com/DDDonzy/dsh-history-rewind');
    assert.equal(rewind.npmUrl, null);

    const ctx = items.find((i) => i.name === 'dsh-context');
    assert.equal(ctx.official, false);
    assert.equal(ctx.npmUrl, 'https://www.npmjs.com/package/dsh-context');
    assert.equal(ctx.githubUrl, 'https://github.com/bowenliang123/dsh-context');

    const memos = items.find((i) => i.name === '@memtensor/memos-local-plugin');
    assert.equal(memos.official, false);
    assert.equal(memos.npmUrl, 'https://www.npmjs.com/package/@memtensor/memos-local-plugin');
    assert.equal(memos.githubUrl, null);
  });

  process.stdout.write('installPluginToProfile:\n');

  await t('安装官方包抛错被拒绝', async () => {
    const dir = tmpProfile();
    await assert.rejects(
      () => installPluginToProfile(dir, { name: '@deepseek-ai/dsh-core' }),
      /官方包 @deepseek-ai\/dsh-core 不允许/,
    );
  });

  await t('缺少插件名称抛错', async () => {
    const dir = tmpProfile();
    await assert.rejects(
      () => installPluginToProfile(dir, { name: '' }),
      /缺少插件名称/,
    );
  });

  await t('成功安装：写入 dependencies 和 dsh.profile.bundles', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'test-profile',
        dependencies: {},
        dsh: { profile: { bundles: [] } },
      }),
    );

    const mockPnpm = path.join(dir, 'fake-pnpm.cjs');
    fs.writeFileSync(
      mockPnpm,
      `
      const fs = require('node:fs');
      const path = require('node:path');
      const modDir = path.join(process.cwd(), 'node_modules', 'awesome-market-tool');
      fs.mkdirSync(modDir, { recursive: true });
      fs.writeFileSync(path.join(modDir, 'package.json'), JSON.stringify({ name: 'awesome-market-tool', version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
      `,
    );

    const res = await installPluginToProfile(
      dir,
      { name: 'awesome-market-tool', installSpec: 'latest' },
      { nodeBin: process.execPath, pnpmCjs: mockPnpm },
    );

    assert.equal(res.ok, true);
    assert.equal(res.name, 'awesome-market-tool');
    assert.equal(res.version, '1.2.3');

    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies['awesome-market-tool'], '^1.2.3');
    assert.ok(pkg.dsh.profile.bundles.includes('awesome-market-tool'));

    // 测试非 bundle 插件（如 dsh-mcp-manager）安装：绝不应进入 bundles，应挂载至 cordis.patch.yml
    const nonBundlePnpm = path.join(dir, 'fake-pnpm-nb.cjs');
    fs.writeFileSync(
      nonBundlePnpm,
      `
      const fs = require('node:fs');
      const path = require('node:path');
      const modDir = path.join(process.cwd(), 'node_modules', 'custom-cordis-plugin');
      fs.mkdirSync(modDir, { recursive: true });
      fs.writeFileSync(path.join(modDir, 'package.json'), JSON.stringify({ name: 'custom-cordis-plugin', version: '0.5.0' }));
      `,
    );
    const resNb = await installPluginToProfile(
      dir,
      { name: 'custom-cordis-plugin', installSpec: 'latest' },
      { nodeBin: process.execPath, pnpmCjs: nonBundlePnpm },
    );
    assert.equal(resNb.ok, true);
    const pkgNb = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.ok(!pkgNb.dsh.profile.bundles.includes('custom-cordis-plugin'), '非 bundle 绝不进入 bundles');
    const patchContent = fs.readFileSync(path.join(dir, 'cordis.patch.yml'), 'utf8');
    assert.ok(patchContent.includes('custom-cordis-plugin'), '非 bundle 成功写入 cordis.patch.yml');

    // 测试当 installSpec 等于插件名称（未指定具体版本，如 dsh-whale-widget）时，初始依赖应设为 latest 而不是 ^dsh-whale-widget
    const res2 = await installPluginToProfile(
      dir,
      { name: 'another-tool', installSpec: 'another-tool' },
      { nodeBin: process.execPath, pnpmCjs: mockPnpm },
    );
    assert.equal(res2.ok, false, '因为 mock 没生成 another-tool 目录，因此验证到未拼错 ^another-tool 即可');
  });

  await t('pnpm 失败时自动回滚 package.json', async () => {
    const dir = tmpProfile();
    const originalPkg = {
      name: 'test-profile-rollback',
      dependencies: { 'existing-pkg': '^1.0.0' },
      dsh: { profile: { bundles: ['existing-pkg'] } },
    };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(originalPkg, null, 2));

    const mockFailingPnpm = path.join(dir, 'fail-pnpm.cjs');
    fs.writeFileSync(mockFailingPnpm, 'process.exit(1);');

    const res = await installPluginToProfile(
      dir,
      { name: 'fail-plugin', installSpec: 'latest' },
      { nodeBin: process.execPath, pnpmCjs: mockFailingPnpm },
    );

    assert.equal(res.ok, false);
    assert.match(res.error, /pnpm/i);

    const pkgAfter = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.deepEqual(pkgAfter, originalPkg);
  });

  await t('安装 GitHub 依赖时：若仓库有 Release 则优先锁定最新 Release Tag', async () => {
    const dir = tmpProfile();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({
        name: 'test-profile-gh-release',
        dependencies: {},
        dsh: { profile: { bundles: [] } },
      }),
    );

    const mockPnpm = path.join(dir, 'fake-pnpm-gh-rel.cjs');
    fs.writeFileSync(
      mockPnpm,
      `
      const fs = require('node:fs');
      const path = require('node:path');
      const modDir = path.join(process.cwd(), 'node_modules', 'awesome-gh-plugin');
      fs.mkdirSync(modDir, { recursive: true });
      fs.writeFileSync(path.join(modDir, 'package.json'), JSON.stringify({ name: 'awesome-gh-plugin', version: '2.5.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }));
      `,
    );

    const orig = global.fetch;
    global.fetch = async (url) => {
      const u = String(url);
      if (u.includes('releases/latest')) {
        return new Response(JSON.stringify({ tag_name: 'v2.5.0' }), { status: 200 });
      }
      return new Response('Not Found', { status: 404 });
    };

    try {
      const res = await installPluginToProfile(
        dir,
        { name: 'awesome-gh-plugin', installSpec: 'github:my-org/awesome-gh-plugin' },
        { nodeBin: process.execPath, pnpmCjs: mockPnpm },
      );
      assert.equal(res.ok, true);
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      assert.equal(pkg.dependencies['awesome-gh-plugin'], 'github:my-org/awesome-gh-plugin#v2.5.0');
    } finally {
      global.fetch = orig;
    }
  });

  process.stdout.write('plugins.html 插件状态与更新按钮逻辑:\n');
  await t('未检查状态下绝不展示「更新」按钮，仅展示「未检查」标签', async () => {
    const htmlContent = fs.readFileSync(path.join(__dirname, '../src/main/pages/plugins.html'), 'utf8');
    const statusTagMatch = htmlContent.match(/function statusTagFor\(item, p\) \{([\s\S]*?)\n\}/);
    const updateBtnMatch = htmlContent.match(/function updateBtnFor\(item, p\) \{([\s\S]*?)\n\}/);
    assert.ok(statusTagMatch, '能提取 statusTagFor 函数');
    assert.ok(updateBtnMatch, '能提取 updateBtnFor 函数');

    // statusTagFor/updateBtnFor 在真实页面里通过同一个 <script> 的闭包直接调用
    // progressBarHtml（不是显式传参），所以要在 new Function 执行时把它们挂到 global 上，
    // 这样函数体里的裸标识符查找才能命中——跟浏览器里同一份 <script> 内看到彼此的效果一致。
    const progressKeyMatch = htmlContent.match(/function progressKey\(profile, name\) \{ ([\s\S]*?) \}/);
    const progressPercentMatch = htmlContent.match(/function progressPercent\(pg\) \{([\s\S]*?)\n\}/);
    const progressBarHtmlMatch = htmlContent.match(/function progressBarHtml\(profile, name, fallbackTitle\) \{([\s\S]*?)\n\}/);
    assert.ok(progressKeyMatch, '能提取 progressKey 函数');
    assert.ok(progressPercentMatch, '能提取 progressPercent 函数');
    assert.ok(progressBarHtmlMatch, '能提取 progressBarHtml 函数');
    global.progressKey = new Function('profile', 'name', progressKeyMatch[1]);
    global.progressPercent = new Function('pg', progressPercentMatch[1]);
    global.progressState = new Map();
    global.progressBarHtml = new Function('profile', 'name', 'fallbackTitle', progressBarHtmlMatch[1]);

    const updateState = new Map();
    const esc = (s) => s;
    const statusTagFor = new Function('item', 'p', 'updateState', 'esc', statusTagMatch[1]);
    const updateBtnFor = new Function('item', 'p', 'updateState', 'esc', updateBtnMatch[1]);

    const item = { name: 'dsh-pet', rawName: 'dsh-pet', range: '^0.2.7' };

    // 1. 未检查状态（updateState 为空或未包含该插件）
    const tagUnchecked = statusTagFor(item, 'web', updateState, esc);
    const btnUnchecked = updateBtnFor(item, 'web', updateState, esc);
    assert.match(tagUnchecked, /未检查/);
    assert.equal(btnUnchecked, '', '未检查状态下更新按钮必须为空字符串，不可展示更新按钮');

    // 2. 检查中状态 (loading: true, updating: false)
    const m = new Map();
    updateState.set('web', m);
    m.set('dsh-pet', { loading: true, updating: false });
    const tagChecking = statusTagFor(item, 'web', updateState, esc);
    const btnChecking = updateBtnFor(item, 'web', updateState, esc);
    assert.match(tagChecking, /检查中/);
    assert.equal(btnChecking, '', '正在检查时更新按钮必须为空，不误显更新中或更新');

    // 3. 已是最新状态 (status: current)
    m.set('dsh-pet', { loading: false, updating: false, status: 'current', latest: '0.2.7' });
    const tagCurrent = statusTagFor(item, 'web', updateState, esc);
    const btnCurrent = updateBtnFor(item, 'web', updateState, esc);
    assert.match(tagCurrent, /已是最新/);
    assert.equal(btnCurrent, '', '已是最新时更新按钮为空');

    // 4. 有新版状态 (status: outdated)
    m.set('dsh-pet', { loading: false, updating: false, status: 'outdated', latest: '0.2.8' });
    const tagOutdated = statusTagFor(item, 'web', updateState, esc);
    const btnOutdated = updateBtnFor(item, 'web', updateState, esc);
    assert.equal(tagOutdated, '', '有新版时直接显示更新按钮，不重复显示“有新版”标签');
    assert.match(btnOutdated, /更新到 0\.2\.8/);

    // 5. 更新中状态 (updating: true)，还没收到任何进度行 → 退回纯 spinner，文案不变
    m.set('dsh-pet', { loading: true, updating: true });
    const tagUpdating = statusTagFor(item, 'web', updateState, esc);
    const btnUpdating = updateBtnFor(item, 'web', updateState, esc);
    assert.match(tagUpdating, /更新中/);
    assert.match(btnUpdating, /disabled>更新中…/);

    // 6. 更新中状态，且已经收到 pnpm 的 Progress: 行 → 展示真实进度条而不是纯 spinner
    global.progressState.set(global.progressKey('web', 'dsh-pet'), { resolved: 100, reused: 10, downloaded: 5, added: 50, done: false });
    const tagUpdatingWithProgress = statusTagFor(item, 'web', updateState, esc);
    const btnUpdatingWithProgress = updateBtnFor(item, 'web', updateState, esc);
    assert.match(tagUpdatingWithProgress, /progress-bar/);
    assert.match(tagUpdatingWithProgress, /50%/);
    assert.match(btnUpdatingWithProgress, /progress-bar/);
    global.progressState.clear();

    delete global.progressKey;
    delete global.progressPercent;
    delete global.progressState;
    delete global.progressBarHtml;
  });

  await t('applyUpdateCache 必须把 targetRef/targetTag 带进 updateState，否则「更新到」按钮会退化成用短 SHA 当 git ref（GitHub 无法解析）', async () => {
    const htmlContent = fs.readFileSync(path.join(__dirname, '../src/main/pages/plugins.html'), 'utf8');
    const getOrCreateMapMatch = htmlContent.match(/function getOrCreateMap\(profile\) \{([\s\S]*?)\n\}/);
    const applyUpdateCacheMatch = htmlContent.match(/function applyUpdateCache\(cache\) \{([\s\S]*?)\n\}/);
    const updateBtnMatch = htmlContent.match(/function updateBtnFor\(item, p\) \{([\s\S]*?)\n\}/);
    assert.ok(getOrCreateMapMatch, '能提取 getOrCreateMap 函数');
    assert.ok(applyUpdateCacheMatch, '能提取 applyUpdateCache 函数');

    const updateState = new Map();
    const realApplyUpdateCache = new Function('updateState', 'getOrCreateMap', `
      return function applyUpdateCache(cache) {
        ${applyUpdateCacheMatch[1]}
      };
    `)(updateState, (profile) => {
      let m = updateState.get(profile);
      if (!m) { m = new Map(); updateState.set(profile, m); }
      return m;
    });

    const fullSha = '2fb56b13e8e9b02bf8cd8275bf028e2b21e65063';
    realApplyUpdateCache({
      profiles: {
        web: [{ name: 'blue-fantasy', latest: '2fb56b1', from: 'v0.1.15 (22f7d95)', status: 'outdated', targetRef: fullSha, targetTag: null }],
      },
    });

    const st = updateState.get('web')?.get('blue-fantasy');
    assert.ok(st, '缓存里的条目必须被写入 updateState');
    assert.equal(st.targetRef, fullSha, 'applyUpdateCache 不能丢弃 targetRef 字段');

    const updateBtnFor = new Function('item', 'p', 'updateState', 'esc', updateBtnMatch[1]);
    const btn = updateBtnFor({ name: 'blue-fantasy', rawName: 'blue-fantasy', range: '...' }, 'web', updateState, (s) => s);
    // 「更新到」按钮实际发给后端的 data-target 必须是完整 40 位 SHA，不能是展示用的 7 位短 SHA（GitHub 无法把短 SHA 解析为 ref）
    assert.match(btn, new RegExp(`data-target="${fullSha}"`));
  });

  await t('市场"一键安装"按钮本身变成绿色进度条（progressPercentFor 驱动 .fill 宽度）', async () => {
    const htmlContent = fs.readFileSync(path.join(__dirname, '../src/main/pages/plugins.html'), 'utf8');
    const progressKeyMatch = htmlContent.match(/function progressKey\(profile, name\) \{ ([\s\S]*?) \}/);
    const progressPercentMatch = htmlContent.match(/function progressPercent\(pg\) \{([\s\S]*?)\n\}/);
    const progressPercentForMatch = htmlContent.match(/function progressPercentFor\(profile, name\) \{([\s\S]*?)\n\}/);
    assert.ok(progressPercentForMatch, '能提取 progressPercentFor 函数');

    global.progressKey = new Function('profile', 'name', progressKeyMatch[1]);
    global.progressPercent = new Function('pg', progressPercentMatch[1]);
    global.progressState = new Map();
    const progressPercentFor = new Function('profile', 'name', progressPercentForMatch[1]);

    // 还没收到任何进度行：0%（按钮上不显示百分比，交由调用方处理）
    assert.equal(progressPercentFor('web', 'dsh-token-pet'), 0);

    global.progressState.set(global.progressKey('web', 'dsh-token-pet'), { resolved: 177, reused: 52, downloaded: 1, added: 88, done: false });
    assert.equal(progressPercentFor('web', 'dsh-token-pet'), 50);

    global.progressState.set(global.progressKey('web', 'dsh-token-pet'), { resolved: 177, reused: 52, downloaded: 1, added: 177, done: true });
    assert.equal(progressPercentFor('web', 'dsh-token-pet'), 100);

    delete global.progressKey;
    delete global.progressPercent;
    delete global.progressState;
  });

  await t('市场卡片：已安装的插件按钮走 triggerRemoveFromMarket，未安装的走 triggerInstall', async () => {
    const htmlContent = fs.readFileSync(path.join(__dirname, '../src/main/pages/plugins.html'), 'utf8');
    const renderSingleCardMatch = htmlContent.match(/function renderSingleCard\(p\) \{([\s\S]*?)\n\}/);
    assert.ok(renderSingleCardMatch, '能提取 renderSingleCard 函数');

    global.installingSet = new Set();
    global.$ = (sel) => (sel === '#marketTargetProfile' ? { value: 'web' } : null);
    global.esc = (s) => s;
    global.progressPercentFor = () => 0;
    global.RESTARTING = false;
    global.formatStars = (n) => String(n || 0);
    const renderSingleCard = new Function('p', renderSingleCardMatch[1]);

    const base = { id: 'jimmy/dsh-token-pet', name: 'dsh-token-pet', displayName: 'dsh-token-pet', category: 'fun', categoryLabel: '趣味娱乐', description: 'desc', stars: 55 };

    const notInstalled = renderSingleCard({ ...base, installedProfiles: [] });
    assert.match(notInstalled, /onclick="triggerInstall\('jimmy\/dsh-token-pet'\)"/);
    assert.doesNotMatch(notInstalled, /label-remove/);

    const installed = renderSingleCard({ ...base, installedProfiles: ['web'] });
    assert.match(installed, /class="btn-install installed"/);
    assert.match(installed, /onclick="triggerRemoveFromMarket\('jimmy\/dsh-token-pet'\)"/);
    assert.match(installed, /label-installed/);
    assert.match(installed, /label-remove/);

    delete global.installingSet;
    delete global.$;
    delete global.esc;
    delete global.progressPercentFor;
    delete global.RESTARTING;
    delete global.formatStars;
  });

  process.stdout.write('rollbackPendingMutation（服务起不来时自动撤销刚才那次变更）:\n');
  await t('kind=install：把刚装上的插件从 dependencies/bundles 里撤掉', async () => {
    const dshHome = tmpProfile();
    const profileDir = path.join(dshHome, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
      name: 'web',
      private: true,
      dependencies: { 'deepseek-pet': '^0.2.0' },
      dsh: { profile: { bundles: ['deepseek-pet'] } },
    }, null, 2) + '\n');
    fs.mkdirSync(path.join(profileDir, 'node_modules', 'deepseek-pet'), { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'node_modules', 'deepseek-pet', 'package.json'),
      JSON.stringify({ name: 'deepseek-pet', version: '0.2.0' }, null, 2) + '\n',
    );

    await rollbackPendingMutation(
      { kind: 'install', profile: 'web', name: 'deepseek-pet' },
      { dshHome: () => dshHome, getNodeBin: async () => undefined, pnpmCjs: undefined, log: () => {} },
    );

    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies['deepseek-pet'], undefined, '导致服务起不来的插件必须从 dependencies 里撤掉');
    assert.ok(!pkg.dsh.profile.bundles.includes('deepseek-pet'), '也必须从 bundles 里撤掉');
  });

  await t('kind=toggleBundle：把刚切换的启用状态改回去', async () => {
    const dshHome = tmpProfile();
    const profileDir = path.join(dshHome, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({
      name: 'web',
      private: true,
      dependencies: { 'deepseek-pet': '^0.2.0' },
      dsh: { profile: { bundles: ['deepseek-pet'], disabledBundles: [] } },
    }, null, 2) + '\n');
    fs.mkdirSync(path.join(profileDir, 'node_modules', 'deepseek-pet'), { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'node_modules', 'deepseek-pet', 'package.json'),
      JSON.stringify({ name: 'deepseek-pet', version: '0.2.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2) + '\n',
    );

    // 模拟场景：用户刚把它从"停用"切到"启用"，结果服务起不来 → previousEnable=false，应该被改回停用
    await rollbackPendingMutation(
      { kind: 'toggleBundle', profile: 'web', name: 'deepseek-pet', previousEnable: false },
      { dshHome: () => dshHome, getNodeBin: async () => undefined, pnpmCjs: undefined, log: () => {} },
    );

    const pkg = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
    assert.ok(!pkg.dsh.profile.bundles.includes('deepseek-pet'), '必须改回停用状态：不再出现在 bundles 里');
    assert.ok(pkg.dsh.profile.disabledBundles.includes('deepseek-pet'), '必须出现在 disabledBundles 里');
  });

  if (failed) {
    process.stdout.write(`\n共 ${failed} 项断言失败\n`);
    process.exit(1);
  }
  process.stdout.write('\n✓ 全部通过\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
