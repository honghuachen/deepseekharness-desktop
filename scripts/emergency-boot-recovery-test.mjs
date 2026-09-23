import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  togglePluginBundle,
  removePluginsFromProfile,
} = require('../src/main/plugin-guard.js');
const {
  parseFailedPlugins,
  formatPluginFailure,
  escapeHtml,
} = require('../src/main/main-window-preload.cjs');

let passed = 0;
async function t(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

function makeTmpProfileDir() {
  const d = path.join(os.tmpdir(), `dsh-emergency-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

console.log('=== 应急恢复（提取插件名 & 列表结构化 & 停用/删除）测试 ===');

// 1. parseFailedPlugins 结构化列表解析测试
await t('解析用户真实报错截图中的多行文本为结构化列表', async () => {
  const rawText = `
Failed to load plugins

web boot: 2 entries did not activate
dsh-client-auto-continue: pending (waiting for service:
settingsScope)
@chenhw7/dsh-memory: pending (waiting for service: settingsScope)
  `;
  const list = parseFailedPlugins(rawText);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'dsh-client-auto-continue');
  assert.equal(list[0].rawReason, 'pending (waiting for service: settingsScope)');
  assert.ok(list[0].friendlyReason.includes('settingsScope'));
  assert.ok(list[0].friendlyReason.includes('新内核已移除'));

  assert.equal(list[1].name, '@chenhw7/dsh-memory');
  assert.equal(list[1].rawReason, 'pending (waiting for service: settingsScope)');
  assert.ok(list[1].friendlyReason.includes('settingsScope'));
});

await t('解析普通包名与 scoped 包名', async () => {
  const text = 'foo-plugin: failed\n@my-scope/my-plugin: import failed: Cannot find module';
  const list = parseFailedPlugins(text);
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'foo-plugin');
  assert.equal(list[0].friendlyReason, '插件激活失败');
  assert.equal(list[1].name, '@my-scope/my-plugin');
  assert.equal(list[1].friendlyReason, '代码导入失败（模块缺失或语法不兼容）');
});

await t('过滤非插件行（如 web boot 摘要、标题行等）', async () => {
  const text = `
    Failed to load plugins
    插件加载失败
    web boot: 3 entries did not activate
    valid-pkg: pending
  `;
  const list = parseFailedPlugins(text);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'valid-pkg');
});

await t('HTML 转义函数测试', async () => {
  assert.equal(escapeHtml('<script>alert("xss")</script>'), '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  assert.equal(escapeHtml("a & b 'c'"), 'a &amp; b &#39;c&#39;');
});

// 2. togglePluginBundle 停用/启用测试
await t('停用 bundle 插件：从 bundles 移出，加入 disabledBundles', async () => {
  const dir = makeTmpProfileDir();
  const pkg = {
    name: 'profile-web',
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', 'dsh-client-auto-continue', '@chenhw7/dsh-memory'],
        disabledBundles: [],
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

  await togglePluginBundle(dir, 'dsh-client-auto-continue', false);

  const updated = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.ok(!updated.dsh.profile.bundles.includes('dsh-client-auto-continue'));
  assert.ok(updated.dsh.profile.disabledBundles.includes('dsh-client-auto-continue'));
  assert.ok(updated.dsh.profile.bundles.includes('@chenhw7/dsh-memory'));
});

await t('连续停用多个插件', async () => {
  const dir = makeTmpProfileDir();
  const pkg = {
    name: 'profile-web',
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', 'dsh-client-auto-continue', '@chenhw7/dsh-memory'],
        disabledBundles: [],
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

  await togglePluginBundle(dir, 'dsh-client-auto-continue', false);
  await togglePluginBundle(dir, '@chenhw7/dsh-memory', false);

  const updated = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.deepEqual(updated.dsh.profile.bundles, ['@deepseek-ai/dsh-base']);
  assert.ok(updated.dsh.profile.disabledBundles.includes('dsh-client-auto-continue'));
  assert.ok(updated.dsh.profile.disabledBundles.includes('@chenhw7/dsh-memory'));
});

// 3. 测试通过子插件名称（如 @opencode2dsh/dsh-plugin）关联并停用/删除父 Bundle（如 opencode2dsh）
await t('通过子插件名 @opencode2dsh/dsh-plugin 停用所属 Bundle opencode2dsh', async () => {
  const dir = makeTmpProfileDir();
  const pkg = {
    name: 'profile-web',
    dependencies: {
      opencode2dsh: 'github:FishBottle7/opencode2dsh',
    },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', 'opencode2dsh'],
        disabledBundles: [],
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

  // 模拟 node_modules/opencode2dsh
  const nmBundleDir = path.join(dir, 'node_modules', 'opencode2dsh');
  fs.mkdirSync(nmBundleDir, { recursive: true });
  fs.writeFileSync(
    path.join(nmBundleDir, 'package.json'),
    JSON.stringify({
      name: 'opencode2dsh',
      dependencies: { '@opencode2dsh/dsh-plugin': '^0.2.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(nmBundleDir, 'cordis.patch.yml'),
    '- insert:\n    - id: @opencode2dsh/dsh-plugin\n      name: @opencode2dsh/dsh-plugin\n'
  );

  // 触发停用
  await togglePluginBundle(dir, '@opencode2dsh/dsh-plugin', false);

  const updated = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.ok(!updated.dsh.profile.bundles.includes('opencode2dsh'), 'opencode2dsh 应从 bundles 中剔除');
  assert.ok(updated.dsh.profile.disabledBundles.includes('opencode2dsh'), 'opencode2dsh 应加入 disabledBundles');
  assert.ok(updated.dsh.profile.disabledBundles.includes('@opencode2dsh/dsh-plugin'), '@opencode2dsh/dsh-plugin 应加入 disabledBundles');
});

await t('通过子插件名 @opencode2dsh/dsh-plugin 彻底删除所属 Bundle opencode2dsh', async () => {
  const dir = makeTmpProfileDir();
  const pkg = {
    name: 'profile-web',
    dependencies: {
      opencode2dsh: 'github:FishBottle7/opencode2dsh',
    },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', 'opencode2dsh'],
        disabledBundles: [],
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

  // 模拟 node_modules/opencode2dsh
  const nmBundleDir = path.join(dir, 'node_modules', 'opencode2dsh');
  fs.mkdirSync(nmBundleDir, { recursive: true });
  fs.writeFileSync(
    path.join(nmBundleDir, 'package.json'),
    JSON.stringify({
      name: 'opencode2dsh',
      dependencies: { '@opencode2dsh/dsh-plugin': '^0.2.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2)
  );
  fs.writeFileSync(
    path.join(nmBundleDir, 'cordis.patch.yml'),
    '- insert:\n    - id: @opencode2dsh/dsh-plugin\n      name: @opencode2dsh/dsh-plugin\n'
  );

  // 触发删除
  const res = await removePluginsFromProfile(dir, ['@opencode2dsh/dsh-plugin'], {});
  assert.ok(res.removed.length > 0, '应该成功移除项');

  const updated = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.ok(!updated.dependencies?.opencode2dsh, 'dependencies 中应清除 opencode2dsh');
  assert.ok(!updated.dsh.profile.bundles.includes('opencode2dsh'), 'bundles 中应清除 opencode2dsh');
});

await t('在 node_modules 缺失时通过启发式关联识别并停用父包', async () => {
  const dir = makeTmpProfileDir();
  const pkg = {
    name: 'profile-web',
    dependencies: {
      opencode2dsh: 'github:FishBottle7/opencode2dsh',
    },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', 'opencode2dsh'],
        disabledBundles: [],
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

  // 注意：此处不建立 node_modules
  await togglePluginBundle(dir, '@opencode2dsh/dsh-plugin', false);

  const updated = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.ok(!updated.dsh.profile.bundles.includes('opencode2dsh'), '即便无 node_modules 也应剔除 opencode2dsh');
  assert.ok(updated.dsh.profile.disabledBundles.includes('opencode2dsh'), '应将 opencode2dsh 加入 disabledBundles');
});

console.log(`\n🎉 全部 ${passed} 个应急恢复测试通过！`);


