#!/usr/bin/env node
/**
 * 构建期工具下载：把运行更新引擎所需的工具落进 vendor/
 *   1. pnpm.cjs —— pnpm 官方单文件发行版（用于安装官方 dsh 运行时）
 *   2. node-<platform>-<arch>/ —— 便携 Node v22 LTS（可选，--no-node 跳过；
 *      打包后 APP 自带，运行不再依赖系统 Node）
 * 幂等：已存在则跳过。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFileP = promisify(execFile);

const VENDOR = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'vendor');
const PNPM_VERSION = '11.24.0';
const NODE_MAJOR = 22;

async function downloadTo(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 ${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  return buf.length;
}

async function extractTar(tarball, destDir) {
  await fs.mkdir(destDir, { recursive: true });
  await execFileP('tar', ['-xzf', tarball, '-C', destDir]);
}

async function ensurePnpm() {
  const destDir = path.join(VENDOR, 'pnpm');
  if (fsSync.existsSync(path.join(destDir, 'bin', 'pnpm.cjs'))) {
    console.log('[fetch-tools] vendor/pnpm 已存在，跳过');
    return;
  }
  console.log(`[fetch-tools] 下载 pnpm@${PNPM_VERSION} …`);
  const tmp = path.join(os.tmpdir(), `pnpm-${PNPM_VERSION}.tgz`);
  const size = await downloadTo(
    `https://registry.npmjs.org/pnpm/-/pnpm-${PNPM_VERSION}.tgz`,
    tmp,
  );
  console.log(`[fetch-tools]   ${(size / 1048576).toFixed(1)} MB，解压 …`);
  const extractDir = path.join(os.tmpdir(), `pnpm-${PNPM_VERSION}-extract`);
  await fs.rm(extractDir, { recursive: true, force: true });
  await extractTar(tmp, extractDir);
  await fs.mkdir(VENDOR, { recursive: true });
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.rename(path.join(extractDir, 'package'), destDir);
  await fs.rm(extractDir, { recursive: true, force: true });
  console.log('[fetch-tools] ✓ vendor/pnpm/');
}

async function ensureNode(platform, arch) {
  const dirName = `node-${platform}-${arch}`;
  const destDir = path.join(VENDOR, dirName);
  const binName = platform === 'win32' ? 'node.exe' : path.join('bin', 'node');
  if (fsSync.existsSync(path.join(destDir, binName))) {
    console.log(`[fetch-tools] ${dirName} 已存在，跳过`);
    return;
  }
  console.log('[fetch-tools] 查询 Node v22 LTS 最新版 …');
  const res = await fetch('https://nodejs.org/dist/index.json');
  if (!res.ok) throw new Error(`nodejs.org index HTTP ${res.status}`);
  const index = await res.json();
  const entry = index.find((v) => v.version.startsWith(`v${NODE_MAJOR}.`) && v.lts);
  if (!entry) throw new Error('未找到 v22 LTS 版本');
  const version = entry.version; // 形如 v22.x.y
  const ext = platform === 'win32' ? '.zip' : '.tar.gz';
  // 官方发行名：Windows 为 -win-x64（目录内同样带 win 字样），其余为 -<platform>-<arch>
  const distName = platform === 'win32' ? 'win-x64' : `${platform}-${arch}`;
  const file = `node-${version}-${distName}${ext}`;
  const url = `https://nodejs.org/dist/${version}/${file}`;
  console.log(`[fetch-tools] 下载 ${file} …`);
  const tmpTar = path.join(os.tmpdir(), file);
  const size = await downloadTo(url, tmpTar);
  console.log(`[fetch-tools]   ${(size / 1048576).toFixed(1)} MB，解压 …`);
  const extractDir = path.join(os.tmpdir(), `node-${version}-extract`);
  await fs.rm(extractDir, { recursive: true, force: true });
  await extractTar(tmpTar, extractDir);
  await fs.mkdir(VENDOR, { recursive: true });
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.rename(path.join(extractDir, `node-${version}-${distName}`), destDir);
  await fs.rm(extractDir, { recursive: true, force: true });
  console.log(`[fetch-tools] ✓ vendor/${dirName}`);
}

const skipNode = process.argv.includes('--no-node');

try {
  await ensurePnpm();
  if (!skipNode) {
    if (process.platform === 'darwin') {
      await ensureNode('darwin', process.arch);
    }
    // Windows 便携 Node：供交叉打包 win 目标随包分发（打包配置按平台择一拷贝）
    await ensureNode('win32', 'x64');
  }
  console.log('[fetch-tools] 完成');
} catch (err) {
  console.error('[fetch-tools] 失败:', err.message);
  process.exit(1);
}
