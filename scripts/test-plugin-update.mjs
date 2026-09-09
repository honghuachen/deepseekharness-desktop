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
  updatePlugin,
  updatePlugins,
  checkProfileUpdates,
  isOfficial,
} = guard;

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
