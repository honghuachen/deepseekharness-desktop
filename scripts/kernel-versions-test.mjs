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
const { fetchAllKernelVersions, classifyTag } = require('../src/main/kernel-versions.js');

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
