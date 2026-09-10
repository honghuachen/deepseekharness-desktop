#!/usr/bin/env node
/**
 * kernel-versions.js 无头自测：构造模拟 npm 包 JSON 响应，覆盖：
 *   1) 版本分类（stable/rc/alpha 判定）
 *   2) 按发布时间倒序排序
 *   3) recommended 标记（对应 dist-tags.latest）
 *   4) 网络失败 / 响应格式异常时返回 null
 *
 * 退出码 0=全部通过；非 0=有断言失败。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  fetchAllKernelVersions,
  classifyTag,
  normalizeReleaseTag,
  fetchKernelReleases,
  clearKernelReleasesCache,
} = require('../src/main/kernel-versions.js');

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

function mockManifest() {
  return {
    'dist-tags': { latest: '0.1.2-rc.1', alpha: '0.1.2-alpha.5', next: '0.1.2-rc.1' },
    versions: {
      '0.1.0-alpha.1': {},
      '0.1.1-rc.1': {},
      '0.1.2-rc.1': {},
      '0.1.2-alpha.5': {},
    },
    time: {
      '0.1.0-alpha.1': '2026-01-01T00:00:00.000Z',
      '0.1.1-rc.1': '2026-02-01T00:00:00.000Z',
      '0.1.2-rc.1': '2026-03-01T00:00:00.000Z',
      '0.1.2-alpha.5': '2026-02-15T00:00:00.000Z',
    },
  };
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
  process.stdout.write('classifyTag:\n');
  await t("'0.1.2-alpha.5' → alpha", () => {
    assert.equal(classifyTag('0.1.2-alpha.5'), 'alpha');
  });
  await t("'0.1.2-rc.1' → rc", () => {
    assert.equal(classifyTag('0.1.2-rc.1'), 'rc');
  });
  await t("'1.0.0'（无预发布后缀）→ stable", () => {
    assert.equal(classifyTag('1.0.0'), 'stable');
  });

  process.stdout.write('fetchAllKernelVersions:\n');
  await t('解析全部版本 + 按时间倒序 + 标记 recommended', async () => {
    await withMockFetch(
      new Response(JSON.stringify(mockManifest()), { status: 200 }),
      async () => {
        const result = await fetchAllKernelVersions();
        assert.ok(result, '应返回非 null 结果');
        assert.equal(result.latestTag, '0.1.2-rc.1');
        assert.equal(result.entries.length, 4);
        // 倒序：0.1.2-rc.1(03-01) > 0.1.2-alpha.5(02-15) > 0.1.1-rc.1(02-01) > 0.1.0-alpha.1(01-01)
        assert.deepEqual(
          result.entries.map((e) => e.version),
          ['0.1.2-rc.1', '0.1.2-alpha.5', '0.1.1-rc.1', '0.1.0-alpha.1'],
        );
        const recommended = result.entries.find((e) => e.recommended);
        assert.equal(recommended.version, '0.1.2-rc.1');
        assert.equal(result.entries.filter((e) => e.recommended).length, 1);
        assert.equal(result.entries.find((e) => e.version === '0.1.2-alpha.5').tag, 'alpha');
        assert.equal(result.entries.find((e) => e.version === '0.1.1-rc.1').tag, 'rc');
      },
    );
  });

  await t('HTTP 非 200 → 返回 null', async () => {
    await withMockFetch(new Response('nope', { status: 500 }), async () => {
      const result = await fetchAllKernelVersions();
      assert.equal(result, null);
    });
  });

  await t('响应缺少 versions 字段 → 返回 null', async () => {
    await withMockFetch(
      new Response(JSON.stringify({ 'dist-tags': { latest: '1.0.0' } }), { status: 200 }),
      async () => {
        const result = await fetchAllKernelVersions();
        assert.equal(result, null);
      },
    );
  });

  await t('网络异常（fetch 抛错）→ 返回 null', async () => {
    const orig = global.fetch;
    global.fetch = async () => {
      throw new Error('ENETUNREACH');
    };
    try {
      const result = await fetchAllKernelVersions();
      assert.equal(result, null);
    } finally {
      global.fetch = orig;
    }
  });

  process.stdout.write('normalizeReleaseTag:\n');
  await t("前缀 'dsh-v0.1.5-rc.1' → 0.1.5-rc.1", () => {
    assert.equal(normalizeReleaseTag('dsh-v0.1.5-rc.1'), '0.1.5-rc.1');
  });
  await t("前缀 'v0.1.5-alpha.2' → 0.1.5-alpha.2", () => {
    assert.equal(normalizeReleaseTag('v0.1.5-alpha.2'), '0.1.5-alpha.2');
  });
  await t("无前缀 '0.1.3-alpha.1' → 0.1.3-alpha.1", () => {
    assert.equal(normalizeReleaseTag('0.1.3-alpha.1'), '0.1.3-alpha.1');
  });
  await t('空或非字符串 → 空字符串', () => {
    assert.equal(normalizeReleaseTag(''), '');
    assert.equal(normalizeReleaseTag(null), '');
    assert.equal(normalizeReleaseTag(undefined), '');
  });

  process.stdout.write('fetchKernelReleases:\n');
  await t('正确拉取并解析 releases 映射表及缓存', async () => {
    clearKernelReleasesCache();
    const mockReleases = [
      {
        tag_name: 'dsh-v0.1.5-rc.1',
        name: 'v0.1.5-rc.1',
        published_at: '2026-09-10T03:09:00Z',
        body: '## 0.1.5-rc.1 更新说明',
        html_url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.1',
      },
      {
        tag_name: 'v0.1.5-alpha.2',
        name: 'v0.1.5-alpha.2',
        published_at: '2026-09-09T14:23:10Z',
        body: 'Alpha 2 变更',
        html_url: 'https://github.com/deepseek-ai/deepseek-harness/releases/tag/v0.1.5-alpha.2',
      },
    ];

    let fetchCount = 0;
    const orig = global.fetch;
    global.fetch = async () => {
      fetchCount++;
      return new Response(JSON.stringify(mockReleases), { status: 200 });
    };

    try {
      const res1 = await fetchKernelReleases();
      assert.ok(res1, '返回非 null');
      assert.equal(fetchCount, 1);
      assert.ok(res1['0.1.5-rc.1']);
      assert.equal(res1['0.1.5-rc.1'].body, '## 0.1.5-rc.1 更新说明');
      assert.equal(res1['0.1.5-rc.1'].tag, 'dsh-v0.1.5-rc.1');
      assert.ok(res1['0.1.5-alpha.2']);

      // 命中缓存测试
      const res2 = await fetchKernelReleases();
      assert.equal(fetchCount, 1, '命中缓存时不应发起二次请求');
      assert.equal(res2['0.1.5-rc.1'].body, '## 0.1.5-rc.1 更新说明');

      // bypassCache 测试
      const res3 = await fetchKernelReleases({ bypassCache: true });
      assert.equal(fetchCount, 2, 'bypassCache 时应发起新请求');
    } finally {
      global.fetch = orig;
      clearKernelReleasesCache();
    }
  });

  await t('GitHub HTTP 错误时返回 null', async () => {
    clearKernelReleasesCache();
    await withMockFetch(new Response('Rate limit', { status: 403 }), async () => {
      const result = await fetchKernelReleases({ bypassCache: true });
      assert.equal(result, null);
    });
  });

  await t('GitHub 网络异常时返回 null', async () => {
    clearKernelReleasesCache();
    const orig = global.fetch;
    global.fetch = async () => {
      throw new Error('ETIMEDOUT');
    };
    try {
      const result = await fetchKernelReleases({ bypassCache: true });
      assert.equal(result, null);
    } finally {
      global.fetch = orig;
      clearKernelReleasesCache();
    }
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
