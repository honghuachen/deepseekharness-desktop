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
  checkProfileUpdates,
  isOfficial,
} = guard;
const { buildInventory } = require(path.join(__dirname, '..', 'src', 'main', 'plugin-manager.js'));

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

    const res = await updatePlugin(dir, 'dsh-history-rewind', {
      nodeBin: fakeNode,
      pnpmCjs: fakePnpm,
      log: () => {},
    });

    assert.equal(res.ok, true);
    assert.equal(res.from, '1111111');
    assert.equal(res.to, '2222222');

    // 关键校验：package.json 必须保留原 github:... 格式，绝不能被改成 ^new2222 或 ^latest
    const afterPkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(afterPkg.dependencies['dsh-history-rewind'], 'github:DDDonzy/dsh-history-rewind');

    // 校验执行了 pnpm update dsh-history-rewind
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'pnpm-args.json'), 'utf8'));
    assert.equal(args[0], 'update');
    assert.equal(args.includes('dsh-history-rewind'), true);
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
