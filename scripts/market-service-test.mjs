#!/usr/bin/env node
/**
 * market-service.js 无头单元测试：
 *   1) dedupAndRankPlugins: 规范化去重、字段补全、高星优先、Top 100 截取
 *   2) fetchMarketTop100: 远程拉取、本地 12h 缓存命中、网络失败时内置种子降级
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  dedupAndRankPlugins,
  fetchMarketTop100,
  normalizeRepoUrl,
} = require('../src/main/market/market-service.js');

let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (err) {
    failed++;
    process.stdout.write(`  ✗ ${name}\n    ${err.stack || err}\n`);
  }
}

async function main() {
  process.stdout.write('normalizeRepoUrl 测试:\n');

  await t('正确剥除 .git 后缀、结尾斜杠并转小写', async () => {
    assert.equal(normalizeRepoUrl('https://GitHub.com/Owner/Repo.git/'), 'https://github.com/owner/repo');
    assert.equal(normalizeRepoUrl(''), '');
  });

  process.stdout.write('dedupAndRankPlugins 测试:\n');

  await t('同一个 GitHub 仓库的重复收录被成功合并且优先保留高星与中文描述', async () => {
    const raw = [
      {
        name: 'dsh-plugin-a',
        url: 'https://github.com/owner/repo',
        stars: 100,
        description: { zh: '优质的中文功能描述' },
        category: 'ui',
      },
      {
        name: 'dsh-plugin-a-dup',
        url: 'https://github.com/owner/repo.git/',
        stars: 200,
        description: '暂无描述',
        category: 'ui',
      },
    ];
    const res = dedupAndRankPlugins(raw);
    assert.equal(res.length, 1);
    assert.equal(res[0].stars, 200);
    assert.equal(res[0].description, '优质的中文功能描述');
  });

  await t('每个分类按得分综合降序，且默认每个分类推荐 Top 10 并分配分类排名', async () => {
    const raw = Array.from({ length: 30 }, (_, i) => ({
      name: `plugin-${i}`,
      stars: i * 10,
      url: `https://github.com/owner/plugin-${i}`,
      category: 'tools',
    }));
    const res = dedupAndRankPlugins(raw, { perCategoryLimit: 10 });
    assert.equal(res.length, 10);
    assert.equal(res[0].displayName, 'plugin-29');
    assert.equal(res[0].categoryRank, 1);
    assert.equal(res[9].categoryRank, 10);
  });

  await t('当原始名称为泛型内部名 (如 dsh-runtime, deepseek-harness) 时自动对齐为开源项目真实名称与包名', async () => {
    const raw = [
      {
        name: 'dsh-runtime',
        repository: 'open-design',
        owner: 'nexu-io',
        url: 'https://github.com/nexu-io/open-design',
        install: 'dsh plugin --profile web add github:nexu-io/open-design#path:packages/dsh-runtime',
        stars: 95000,
        category: 'ui',
      },
      {
        name: 'deepseek-harness',
        repository: 'archify',
        owner: 'tt-a1i',
        url: 'https://github.com/tt-a1i/archify',
        install: 'dsh plugin --profile web add @tt-a1i/archify-dsh',
        stars: 55000,
        category: 'skill',
      },
    ];
    const res = dedupAndRankPlugins(raw);
    assert.equal(res[0].displayName, 'open-design');
    assert.equal(res[0].repoFullName, 'nexu-io/open-design');
    assert.equal(res[0].packageName, 'dsh-runtime');

    assert.equal(res[1].displayName, 'archify');
    assert.equal(res[1].repoFullName, 'tt-a1i/archify');
    assert.equal(res[1].packageName, '@tt-a1i/archify-dsh');

    const baseRaw = [
      {
        name: 'base',
        repository: 'deepseek-harness-studio',
        owner: 'fufankeji',
        install: 'dsh plugin --profile web add @deepseek-ai/dsh-base',
        stars: 600,
        category: 'memory',
      },
    ];
    const baseRes = dedupAndRankPlugins(baseRaw);
    assert.equal(baseRes[0].displayName, 'deepseek-harness-studio', '泛型名 base 应自动映射为真实项目名称');
  });

  await t('官方推荐插件正确识别并打上 official=true 标记', async () => {
    const raw = [
      {
        name: 'acp-app',
        owner: 'whitelonng',
        install: 'dsh plugin --profile web add @deepseek-ai/dsh-acp-app',
        stars: 100,
        category: 'ui',
      },
      {
        name: 'custom-tool',
        owner: 'community-dev',
        install: 'dsh plugin --profile web add community-tool',
        stars: 50,
        category: 'tools',
      },
    ];
    const res = dedupAndRankPlugins(raw);
    const officialItem = res.find((p) => p.name === '@deepseek-ai/dsh-acp-app');
    const normalItem = res.find((p) => p.name === 'community-tool');
    assert.ok(officialItem, '应包含官方包');
    assert.equal(officialItem.official, true, '官方包应具有 official=true');
    assert.ok(normalItem, '应包含社区包');
    assert.equal(normalItem.official, false, '社区包应为 official=false');
  });

  process.stdout.write('fetchMarketTop100 缓存与降级测试:\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-market-test-'));

  await t('网络失败时无缝降级使用内置种子数据 (100条)', async () => {
    const res = await fetchMarketTop100({
      dshHome: tmpDir,
      forceRefresh: true,
      fetchFn: async () => { throw new Error('网络中断模拟'); },
    });
    assert.ok(res.plugins.length >= 100, '降级种子数据应不少于 100 条');
    assert.ok(res.categories.length > 0);
    assert.equal(res.fromCache, true);
  });

  await t('网络请求成功时正常更新并写磁盘缓存', async () => {
    const fakeRankings = {
      rankings: {
        stars: [
          { name: 'online-pkg-1', stars: 9999, url: 'https://github.com/a/b', description: 'desc 1', category: 'tools' },
        ],
      },
    };
    const res = await fetchMarketTop100({
      dshHome: tmpDir,
      forceRefresh: true,
      fetchFn: async () => new Response(JSON.stringify(fakeRankings), { status: 200 }),
    });
    assert.equal(res.plugins[0].name, 'online-pkg-1');
    assert.equal(res.fromCache, false);

    // 缓存文件已写入
    const cacheFile = path.join(tmpDir, '.market-cache.json');
    assert.ok(fs.existsSync(cacheFile));

    // 第二次调用在 TTL 内直接命中缓存
    const res2 = await fetchMarketTop100({
      dshHome: tmpDir,
      forceRefresh: false,
      fetchFn: async () => { throw new Error('不应走到网络'); },
    });
    assert.equal(res2.fromCache, true);
    assert.equal(res2.plugins[0].name, 'online-pkg-1');
  });

  // 清理临时文件
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
