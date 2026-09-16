#!/usr/bin/env node
/**
 * shell-update.js 无头自测：构造模拟 GitHub Releases API 响应，覆盖：
 *   1) hasUpdate 判断正确（含 tag 里 v 前缀的处理）
 *   2) 已是最新版本时 hasUpdate=false
 *   3) 请求失败 / 无 Release / 响应格式异常时返回 null
 *
 * 退出码 0=全部通过；非 0=有断言失败。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  checkShellUpdate,
  fetchShellReleases,
  clearShellReleasesCache,
  normalizeShellReleaseTag,
} = require('../src/main/shell-update.js');

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

async function withMockFetch(response, fn) {
  const orig = global.fetch;
  global.fetch = async () => response;
  try {
    await fn();
  } finally {
    global.fetch = orig;
  }
}

async function main() {
  await t('tag 带 v 前缀 + 有新版 → hasUpdate=true，latestTag 去掉前缀', async () => {
    await withMockFetch(
      new Response(JSON.stringify({ tag_name: 'v1.6.0', html_url: 'https://example.com/releases/v1.6.0' }), {
        status: 200,
      }),
      async () => {
        const result = await checkShellUpdate('1.5.0');
        assert.ok(result);
        assert.equal(result.latestTag, '1.6.0');
        assert.equal(result.hasUpdate, true);
        assert.equal(result.htmlUrl, 'https://example.com/releases/v1.6.0');
      },
    );
  });

  await t('当前已是最新版本 → hasUpdate=false', async () => {
    await withMockFetch(
      new Response(JSON.stringify({ tag_name: 'v1.5.0' }), { status: 200 }),
      async () => {
        const result = await checkShellUpdate('1.5.0');
        assert.ok(result);
        assert.equal(result.hasUpdate, false);
      },
    );
  });

  await t('当前版本比 Release 更新（本地领先）→ hasUpdate=false', async () => {
    await withMockFetch(
      new Response(JSON.stringify({ tag_name: 'v1.4.0' }), { status: 200 }),
      async () => {
        const result = await checkShellUpdate('1.5.0');
        assert.ok(result);
        assert.equal(result.hasUpdate, false);
      },
    );
  });

  await t('HTTP 404（无 Release）→ 返回 null', async () => {
    await withMockFetch(new Response('not found', { status: 404 }), async () => {
      const result = await checkShellUpdate('1.5.0');
      assert.equal(result, null);
    });
  });

  await t('响应缺少 tag_name 字段 → 返回 null', async () => {
    await withMockFetch(new Response(JSON.stringify({}), { status: 200 }), async () => {
      const result = await checkShellUpdate('1.5.0');
      assert.equal(result, null);
    });
  });

  await t('网络异常（fetch 抛错）→ 返回 null', async () => {
    const orig = global.fetch;
    global.fetch = async () => {
      throw new Error('ENETUNREACH');
    };
    try {
      const result = await checkShellUpdate('1.5.0');
      assert.equal(result, null);
    } finally {
      global.fetch = orig;
    }
  });

  await t('normalizeShellReleaseTag: 剥除 v 前缀', async () => {
    assert.equal(normalizeShellReleaseTag('v1.6.7'), '1.6.7');
    assert.equal(normalizeShellReleaseTag('1.6.7'), '1.6.7');
    assert.equal(normalizeShellReleaseTag(''), '');
    assert.equal(normalizeShellReleaseTag(null), '');
  });

  await t('checkShellUpdate: 返回 body 和 publishedAt', async () => {
    await withMockFetch(
      new Response(JSON.stringify({
        tag_name: 'v1.6.7',
        html_url: 'https://example.com/releases/v1.6.7',
        body: '### 更新日志\n- 新增特性',
        published_at: '2026-09-15T12:00:00Z',
      }), { status: 200 }),
      async () => {
        const result = await checkShellUpdate('1.6.6');
        assert.ok(result);
        assert.equal(result.latestTag, '1.6.7');
        assert.equal(result.hasUpdate, true);
        assert.equal(result.body, '### 更新日志\n- 新增特性');
        assert.equal(result.publishedAt, '2026-09-15T12:00:00Z');
      },
    );
  });

  await t('fetchShellReleases: 正确拉取并解析 releases 映射表及缓存', async () => {
    clearShellReleasesCache();
    let fetchCount = 0;
    const mockReleases = [
      {
        tag_name: 'v1.6.7',
        name: 'v1.6.7',
        published_at: '2026-09-15T12:00:00Z',
        body: 'Changelog 1.6.7',
        html_url: 'https://example.com/releases/tag/v1.6.7',
      },
      {
        tag_name: 'v1.6.6',
        name: 'v1.6.6',
        published_at: '2026-09-10T12:00:00Z',
        body: 'Changelog 1.6.6',
        html_url: 'https://example.com/releases/tag/v1.6.6',
      },
    ];

    const orig = global.fetch;
    global.fetch = async () => {
      fetchCount++;
      return new Response(JSON.stringify(mockReleases), { status: 200 });
    };

    try {
      const res1 = await fetchShellReleases();
      assert.ok(res1);
      assert.equal(Object.keys(res1).length, 2);
      assert.equal(res1['1.6.7'].version, '1.6.7');
      assert.equal(res1['1.6.7'].body, 'Changelog 1.6.7');
      assert.equal(res1['1.6.6'].version, '1.6.6');
      assert.equal(fetchCount, 1);

      // 命中缓存，不发起二次网络请求
      const res2 = await fetchShellReleases();
      assert.equal(fetchCount, 1);
      assert.deepEqual(res2, res1);

      // bypassCache 绕过缓存
      const res3 = await fetchShellReleases({ bypassCache: true });
      assert.equal(fetchCount, 2);
      assert.deepEqual(res3, res1);
    } finally {
      global.fetch = orig;
      clearShellReleasesCache();
    }
  });

  await t('fetchShellReleases: GitHub HTTP 错误时返回 null', async () => {
    clearShellReleasesCache();
    await withMockFetch(new Response('rate limit', { status: 403 }), async () => {
      const res = await fetchShellReleases();
      assert.equal(res, null);
    });
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
