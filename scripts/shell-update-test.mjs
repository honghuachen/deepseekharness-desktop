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
const { checkShellUpdate } = require('../src/main/shell-update.js');

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
