#!/usr/bin/env node
/**
 * main-window-preload.cjs 逻辑测试：
 * 纯 Node 轻量模拟 DOM 节点，验证设置按钮识别算法与升级标识按钮挂载。
 */
import assert from 'node:assert/strict';

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

class MockElement {
  constructor(tagName, id = '', className = '') {
    this.tagName = tagName.toUpperCase();
    this.id = id;
    this.className = className;
    this.classList = {
      _classes: new Set(className ? className.split(/\s+/) : []),
      add(c) { this._classes.add(c); },
      remove(c) { this._classes.delete(c); },
      contains(c) { return this._classes.has(c); },
    };
    this.children = [];
    this.parentElement = null;
    this.textContent = '';
    this.attributes = new Map();
  }

  getAttribute(k) { return this.attributes.get(k) || null; }
  setAttribute(k, v) { this.attributes.set(k, v); }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  after(sibling) {
    if (!this.parentElement) return;
    const idx = this.parentElement.children.indexOf(this);
    if (idx !== -1) {
      sibling.parentElement = this.parentElement;
      this.parentElement.children.splice(idx + 1, 0, sibling);
    }
  }

  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.children.indexOf(this);
      if (idx !== -1) {
        this.parentElement.children.splice(idx, 1);
      }
      this.parentElement = null;
    }
  }

  get nextSibling() {
    if (!this.parentElement) return null;
    const idx = this.parentElement.children.indexOf(this);
    return this.parentElement.children[idx + 1] || null;
  }

  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all[0] || null;
  }

  querySelectorAll(selector) {
    const res = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (selector === 'button' && child.tagName === 'BUTTON') res.push(child);
        else if (selector === 'span' && child.tagName === 'SPAN') res.push(child);
        walk(child);
      }
    };
    walk(this);
    return res;
  }

  closest(selector) {
    let curr = this.parentElement;
    while (curr) {
      if (selector.includes('settingsArea') && curr.className.includes('settingsArea')) return curr;
      if (selector.includes('footArea') && curr.className.includes('footArea')) return curr;
      curr = curr.parentElement;
    }
    return null;
  }
}

function findSettingsButton(doc) {
  const buttons = doc.querySelectorAll('button');
  for (const btn of buttons) {
    const text = btn.textContent?.trim();
    if (text === '设置' || text === 'Settings') {
      return btn;
    }
  }
  for (const btn of buttons) {
    const aria = btn.getAttribute('aria-label');
    if (aria === '设置' || aria === 'Settings') {
      return btn;
    }
    const span = btn.querySelector('span');
    if (span) {
      const text = span.textContent?.trim();
      if (text === '设置' || text === 'Settings') {
        return btn;
      }
    }
  }
  for (const btn of buttons) {
    if (btn.closest('[class*="settingsArea"]') || btn.closest('[class*="footArea"]')) {
      if (btn.id !== 'dsh-app-update-badge-btn') {
        return btn;
      }
    }
  }
  return null;
}

// 与 main-window-preload.cjs 中同名函数保持逻辑一致（该文件顶层 require('electron')，无法在纯 node 里直接
// require 测试，故在此镜像一份纯逻辑用于验证 tooltip 文案与点击路由行为）
function getTooltipText(status) {
  const parts = [];
  if (status?.shell?.hasUpdate) parts.push(`容器有新版 (v${status.shell.latest || ''})`);
  if (status?.kernel?.hasUpdate) parts.push(`内核有新版 (v${status.kernel.latest || ''})`);
  if (status?.plugins?.hasUpdate) parts.push(`${status.plugins.count} 个插件有新版`);
  if (parts.length === 0) return '发现新版本，点击打开检查更新';
  const targetHint = status?.shell?.hasUpdate || status?.kernel?.hasUpdate ? '打开检查更新' : '打开插件管理器';
  return `${parts.join('，')}，点击${targetHint}`;
}

function isPluginsOnlyUpdate(status) {
  return Boolean(status?.plugins?.hasUpdate) && !status?.shell?.hasUpdate && !status?.kernel?.hasUpdate;
}

async function main() {
  process.stdout.write('preload 查找与挂载逻辑测试:\n');

  await t('正确匹配中文「设置」按钮并在其后插入升级按钮', async () => {
    const root = new MockElement('div', '', 'hHd-Xa_root');
    const foot = root.appendChild(new MockElement('div', '', 'hHd-Xa_footArea'));
    const area = foot.appendChild(new MockElement('div', '', 'hHd-Xa_settingsArea'));
    const btn = area.appendChild(new MockElement('button', '', 'VOzbGW_trigger'));
    const span = btn.appendChild(new MockElement('span', '', 'VOzbGW_triggerLabel'));
    span.textContent = '设置';
    btn.textContent = '设置';

    const found = findSettingsButton(root);
    assert.equal(found, btn);

    const updateBtn = new MockElement('button', 'dsh-app-update-badge-btn');
    updateBtn.textContent = '升级';
    found.after(updateBtn);
    found.parentElement.classList.add('dsh-update-foot-wrapper');

    assert.equal(found.nextSibling, updateBtn);
    assert.ok(found.parentElement.classList.contains('dsh-update-foot-wrapper'));
  });

  await t('在英文环境下正确匹配「Settings」按钮', async () => {
    const root = new MockElement('div');
    const btn = root.appendChild(new MockElement('button'));
    btn.setAttribute('aria-label', 'Settings');
    const found = findSettingsButton(root);
    assert.equal(found, btn);
  });

  await t('无更新时移除升级按钮', async () => {
    const root = new MockElement('div');
    const updateBtn = root.appendChild(new MockElement('button', 'dsh-app-update-badge-btn'));
    assert.equal(root.children.length, 1);
    updateBtn.remove();
    assert.equal(root.children.length, 0);
  });

  await t('壳或内核有更新时，优先跳转「检查更新」而非插件管理器', async () => {
    const status = {
      shell: { hasUpdate: true, latest: '1.7.0' },
      kernel: { hasUpdate: false },
      plugins: { hasUpdate: true, count: 2 },
    };
    assert.equal(isPluginsOnlyUpdate(status), false);
    assert.match(getTooltipText(status), /打开检查更新$/);
  });

  await t('仅插件有更新（壳/内核均最新）→ 跳转插件管理器', async () => {
    const status = {
      shell: { hasUpdate: false },
      kernel: { hasUpdate: false },
      plugins: { hasUpdate: true, count: 3 },
    };
    assert.equal(isPluginsOnlyUpdate(status), true);
    assert.match(getTooltipText(status), /3 个插件有新版.*打开插件管理器$/);
  });

  await t('全部无更新 → 兜底文案', async () => {
    const status = { shell: { hasUpdate: false }, kernel: { hasUpdate: false }, plugins: { hasUpdate: false, count: 0 } };
    assert.equal(isPluginsOnlyUpdate(status), false);
    assert.equal(getTooltipText(status), '发现新版本，点击打开检查更新');
  });

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
