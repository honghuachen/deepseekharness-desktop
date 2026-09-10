#!/usr/bin/env node
/**
 * 插件守卫重构后的回归测试：
 *   盘点分类 → 按名部分移除（依赖/bundle/补丁块精准剔除，其余保留）→ 全量清理收敛
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { inventoryProfile, removePluginsFromProfile, sanitizeProfile, togglePluginBundle } = require('../src/main/plugin-guard.js');

let failed = false;
const assert = (cond, msg) => {
  console.log(`${cond ? '✓' : '✗'} ${msg}`);
  if (!cond) failed = true;
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-pm-'));
const profile = path.join(root, 'profiles', 'web');
await fs.mkdir(path.join(profile, 'node_modules', '.pnpm'), { recursive: true });

await fs.writeFile(
  path.join(profile, 'package.json'),
  JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      '@deepseek-ai/dsh-base': '0.1.1-rc.2',
      'market-alpha': '^1.0.0',
      'market-beta': '^2.0.0',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'market-alpha', 'market-beta'] } },
  }, null, 2),
);
await fs.writeFile(
  path.join(profile, 'cordis.patch.yml'),
  [
    '# 用户插件加载层',
    '- insert:',
    '    - id: alpha-ui',
    '      name: market-alpha',
    '# >>> funplay-mcp:x begin',
    '- insert:',
    '    - id: mcp-x',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '# <<< end',
    '- insert:',
    '    - id: beta-tool',
    '      name: market-beta',
  ].join('\n'),
);

// ── 盘点 ──
let inv = inventoryProfile(profile);
assert(inv.exists && inv.deps.length === 3 && inv.bundles.length === 4 && inv.inserts.length === 3, '盘点：deps/bundles/inserts 数量正确');
assert(inv.deps.find((d) => d.name === 'market-alpha')?.official === false, '分类：market-alpha 为第三方');
assert(inv.deps.find((d) => d.name === '@deepseek-ai/dsh-base')?.official === true, '分类：@deepseek-ai/* 为官方');
assert(inv.inserts.find((i) => i.id === 'mcp-x')?.official === true, '分类：MCP 插入块为官方组件配置');

// ── 部分移除：仅 market-alpha ──
const r1 = await removePluginsFromProfile(profile, ['market-alpha'], {});
assert(r1.removed.includes('market-alpha'), '部分移除报告包含 market-alpha');
let pkg = JSON.parse(await fs.readFile(path.join(profile, 'package.json'), 'utf8'));
assert(pkg.dependencies['market-beta'] === '^2.0.0', '未选中的 market-beta 依赖保留');
assert(pkg.dependencies['@deepseek-ai/dsh-base'] !== undefined, '官方依赖保留');
assert(!pkg.dsh.profile.bundles.includes('market-alpha') && pkg.dsh.profile.bundles.includes('market-beta'), 'bundle 引用精准剔除');
const patchAfter = await fs.readFile(path.join(profile, 'cordis.patch.yml'), 'utf8');
assert(!patchAfter.includes('alpha-ui'), '被移除插件的补丁块已删除');
assert(patchAfter.includes('beta-tool') && patchAfter.includes('mcp-x'), '其余补丁块（含官方 MCP）保留');
assert(fsSync.existsSync(path.join(profile, '.sanitized-backup-')) || fsSync.readdirSync(profile).some((n) => n.startsWith('.sanitized-backup-')), '已生成备份目录');
assert(fsSync.existsSync(path.join(profile, 'node_modules')), '仍有剩余第三方依赖时不动 node_modules');

// ── 全量清理：移除 market-beta 后只剩官方 ──
const r2 = await removePluginsFromProfile(profile, ['market-beta'], {});
assert(r2.removed.includes('market-beta') && r2.reconciled === 'pruned', `全量清理后 node_modules 被收敛（${r2.reconciled}）`);
pkg = JSON.parse(await fs.readFile(path.join(profile, 'package.json'), 'utf8'));
assert(Object.keys(pkg.dependencies).length === 1, '仅剩官方依赖');
assert(!fsSync.existsSync(path.join(profile, 'node_modules')), 'node_modules 已清除');

// ── 空移除 no-op ──
const r3 = await removePluginsFromProfile(profile, [], {});
assert(r3.removed.length === 0 && r3.reconciled === 'none', '空选择为 no-op');
// ── togglePluginBundle 启用与停用 ──
const tb1 = await togglePluginBundle(profile, 'test-plugin', true);
assert(tb1.ok && tb1.bundles.includes('test-plugin'), 'togglePluginBundle: 成功加入 bundle 启用');
let pkgTb = JSON.parse(await fs.readFile(path.join(profile, 'package.json'), 'utf8'));
assert(pkgTb.dsh.profile.bundles.includes('test-plugin'), 'package.json 已落盘 bundle');

const tb2 = await togglePluginBundle(profile, 'test-plugin', false);
assert(tb2.ok && !tb2.bundles.includes('test-plugin'), 'togglePluginBundle: 成功从 bundle 停用');
pkgTb = JSON.parse(await fs.readFile(path.join(profile, 'package.json'), 'utf8'));
assert(!pkgTb.dsh.profile.bundles.includes('test-plugin'), 'package.json 已剔除 bundle');

console.log(failed ? '\n有失败项' : '\n═══ 插件守卫测试全部通过 ═══');
process.exit(failed ? 1 : 0);
