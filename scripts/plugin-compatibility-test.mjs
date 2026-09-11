import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  checkPluginKernelCompatibility,
  installPluginToProfile,
} = require('../src/main/plugin-guard.js');

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

function makeTmpDir() {
  const d = path.join(os.tmpdir(), `dsh-compat-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

console.log('=== 插件与内核兼容性检测测试 ===');

// 1. peerDependencies 测试
await t('peerDependencies 范围满足 → 判定兼容', async () => {
  const pkg = {
    name: 'test-plugin',
    version: '1.0.0',
    peerDependencies: {
      '@deepseek-ai/cordis': '^4.0.1',
      '@deepseek-ai/dsh-session': '>=0.1.2-rc.1',
      'react': '^18.0.0',
    },
  };
  const res = await checkPluginKernelCompatibility(pkg, '0.1.5-rc.1');
  assert.equal(res.compatible, true);
});

await t('peerDependencies 要求更高主版本 → 判定不兼容并说明冲突包', async () => {
  const pkg = {
    name: 'future-plugin',
    version: '2.0.0',
    peerDependencies: {
      '@deepseek-ai/dsh-session': '>=0.2.0',
    },
  };
  const res = await checkPluginKernelCompatibility(pkg, '0.1.5-rc.1');
  assert.equal(res.compatible, false);
  assert.match(res.reason, /@deepseek-ai\/dsh-session/);
  assert.match(res.reason, />=0.2.0/);
  assert.match(res.reason, /v0.1.5-rc.1/);
});

await t('peerDependencies 要求更低旧版本（如 <0.1.4） → 判定不兼容', async () => {
  const pkg = {
    name: 'legacy-plugin',
    version: '0.9.0',
    peerDependencies: {
      '@deepseek-ai/dsh': '<0.1.4',
    },
  };
  const res = await checkPluginKernelCompatibility(pkg, '0.1.5-rc.1');
  assert.equal(res.compatible, false);
  assert.match(res.reason, /@deepseek-ai\/dsh/);
});

await t('非官方 peerDependencies（如 react, lodash）不参与内核版本校验', async () => {
  const pkg = {
    name: 'common-plugin',
    version: '1.0.0',
    peerDependencies: {
      react: '^19.0.0',
      lodash: '^5.0.0',
    },
  };
  const res = await checkPluginKernelCompatibility(pkg, '0.1.5-rc.1');
  assert.equal(res.compatible, true);
});

// 2. dsh.compatibility 声明测试
await t('dsh.compatibility.dshReleases 明确标记 incompatible → 判定不兼容', async () => {
  const pkg = {
    name: 'release-incompat-plugin',
    version: '1.0.0',
    dsh: {
      compatibility: {
        dshReleases: {
          '0.1.5-rc.1': 'incompatible',
        },
      },
    },
  };
  const res = await checkPluginKernelCompatibility(pkg, '0.1.5-rc.1');
  assert.equal(res.compatible, false);
  assert.match(res.reason, /明确标记不支持/);
});

await t('dsh.compatibility.kernel 范围超出 → 判定不兼容', async () => {
  const pkg = {
    name: 'kernel-range-plugin',
    version: '1.0.0',
    dsh: {
      compatibility: {
        kernel: '^0.2.0',
      },
    },
  };
  const res = await checkPluginKernelCompatibility(pkg, '0.1.5-rc.1');
  assert.equal(res.compatible, false);
  assert.match(res.reason, /\^0.2.0/);
});

await t('dsh.compatibility.minVersion 高于当前版本 → 判定不兼容', async () => {
  const pkg = {
    name: 'min-ver-plugin',
    version: '1.0.0',
    dsh: {
      compatibility: {
        minVersion: '0.1.6',
      },
    },
  };
  const res = await checkPluginKernelCompatibility(pkg, '0.1.5-rc.1');
  assert.equal(res.compatible, false);
  assert.match(res.reason, /最低内核版本/);
});

await t('dsh.compatibility.maxVersion 低于当前版本 → 判定不兼容', async () => {
  const pkg = {
    name: 'max-ver-plugin',
    version: '1.0.0',
    dsh: {
      compatibility: {
        maxVersion: '0.1.4',
      },
    },
  };
  const res = await checkPluginKernelCompatibility(pkg, '0.1.5-rc.1');
  assert.equal(res.compatible, false);
  assert.match(res.reason, /最高内核版本/);
});

// 3. engines 声明测试
await t('engines.dsh 不满足 → 判定不兼容', async () => {
  const pkg = {
    name: 'engine-plugin',
    version: '1.0.0',
    engines: {
      dsh: '>=0.2.0',
    },
  };
  const res = await checkPluginKernelCompatibility(pkg, '0.1.5-rc.1');
  assert.equal(res.compatible, false);
  assert.match(res.reason, /engines 限定内核版本/);
});

// 4. 未提供 activeKernelVersion 时容错
await t('未指定 activeKernelVersion 时不发生阻断', async () => {
  const pkg = {
    name: 'any-plugin',
    version: '1.0.0',
    peerDependencies: {
      '@deepseek-ai/dsh-session': '>=0.2.0',
    },
  };
  const res = await checkPluginKernelCompatibility(pkg, null);
  assert.equal(res.compatible, true);
});

// 5. installPluginToProfile 集成测试与自动回滚
await t('installPluginToProfile 遇到不兼容插件：拦截安装并完整回滚 package.json 与文件', async () => {
  const dir = makeTmpDir();
  const initialPkg = {
    name: 'test-web-profile',
    dependencies: {
      'existing-dep': '^1.0.0',
    },
    dsh: {
      profile: {
        bundles: ['existing-bundle'],
      },
    },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(initialPkg, null, 2));

  // 模拟 pnpm 安装后写入的不兼容 package.json
  const mockPnpm = path.join(dir, 'mock-pnpm.cjs');
  fs.writeFileSync(
    mockPnpm,
    `
    const fs = require('node:fs');
    const path = require('node:path');
    const modDir = path.join(process.cwd(), 'node_modules', 'incompatible-plugin');
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, 'package.json'),
      JSON.stringify({
        name: 'incompatible-plugin',
        version: '1.0.0',
        peerDependencies: {
          '@deepseek-ai/dsh-session': '>=0.2.0'
        },
        dsh: { bundle: { patch: './cordis.patch.yml' } }
      })
    );
    `,
  );

  const res = await installPluginToProfile(
    dir,
    { name: 'incompatible-plugin', installSpec: 'latest' },
    {
      nodeBin: process.execPath,
      pnpmCjs: mockPnpm,
      activeKernelVersion: '0.1.5-rc.1',
    },
  );

  assert.equal(res.ok, false);
  assert.match(res.error, /由于兼容性问题安装失败/);
  assert.match(res.error, /@deepseek-ai\/dsh-session/);

  // 验证 package.json 自动回滚，未残留 incompatible-plugin
  const restoredPkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(restoredPkg.dependencies['incompatible-plugin'], undefined);
  assert.equal(restoredPkg.dependencies['existing-dep'], '^1.0.0');
  assert.deepEqual(restoredPkg.dsh.profile.bundles, ['existing-bundle']);

  // 验证 node_modules 中该插件已被清理
  const modExists = fs.existsSync(path.join(dir, 'node_modules', 'incompatible-plugin'));
  assert.equal(modExists, false);
});

await t('installPluginToProfile 遇到兼容插件：安装成功并正常写入', async () => {
  const dir = makeTmpDir();
  const initialPkg = {
    name: 'test-web-profile',
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(initialPkg, null, 2));

  const mockPnpm = path.join(dir, 'mock-pnpm.cjs');
  fs.writeFileSync(
    mockPnpm,
    `
    const fs = require('node:fs');
    const path = require('node:path');
    const modDir = path.join(process.cwd(), 'node_modules', 'compatible-plugin');
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, 'package.json'),
      JSON.stringify({
        name: 'compatible-plugin',
        version: '1.2.0',
        peerDependencies: {
          '@deepseek-ai/dsh-session': '>=0.1.0'
        },
        dsh: { bundle: { patch: './cordis.patch.yml' } }
      })
    );
    `,
  );

  const res = await installPluginToProfile(
    dir,
    { name: 'compatible-plugin', installSpec: 'latest' },
    {
      nodeBin: process.execPath,
      pnpmCjs: mockPnpm,
      activeKernelVersion: '0.1.5-rc.1',
    },
  );

  assert.equal(res.ok, true);
  assert.equal(res.name, 'compatible-plugin');
  assert.equal(res.version, '1.2.0');

  const afterPkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  assert.equal(afterPkg.dependencies['compatible-plugin'], '^1.2.0');
  assert(afterPkg.dsh.profile.bundles.includes('compatible-plugin'));
});

console.log(`\n全部 ${passed} 项兼容性测试通过 ✓\n`);
