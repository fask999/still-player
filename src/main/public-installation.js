'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const PUBLIC_MARKER = Object.freeze({schemaVersion: 1, distribution: 'public', userDataDirectory: 'STILL',
  backendBootstrapManifest: 'manifests/public-backend.json'});
async function readPublicInstallation(appRoot) {
  const filename = path.join(appRoot, 'public-release.json');
  let stat;
  try {stat = await fs.lstat(filename);} catch (error) {if (error.code === 'ENOENT') return null; throw error;}
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw new Error('公开安装标记无效。');
  const value = JSON.parse(await fs.readFile(filename, 'utf8'));
  if (!value || Object.keys(value).length !== Object.keys(PUBLIC_MARKER).length ||
      !Object.entries(PUBLIC_MARKER).every(([key, expected]) => Object.hasOwn(value, key) && value[key] === expected)) throw new Error('公开安装标记无效。');
  return PUBLIC_MARKER;
}
function publicInstallationPaths({marker, localAppData, dataOverride} = {}) {
  if (marker !== PUBLIC_MARKER) throw new Error('未验证公开安装标记。');
  const parent = dataOverride || localAppData;
  if (typeof parent !== 'string' || !path.isAbsolute(parent)) throw new Error('无法确定当前用户的本地数据目录。');
  const dataDir = dataOverride ? path.resolve(parent) : path.join(parent, 'STILL');
  return Object.freeze({dataDir, backendDir: path.join(dataDir, 'backend', 'foobar2000')});
}
async function assertPublicDataPaths(dataDir) {
  for (const filename of [dataDir, path.join(dataDir, 'electron', 'session')]) {
    for (let cursor = path.resolve(filename); ; cursor = path.dirname(cursor)) {
      const stat = await fs.lstat(cursor).catch(error => {if (error.code === 'ENOENT') return null; throw error;});
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('公开安装数据目录不能经过文件、链接或 junction。');
      if (path.dirname(cursor) === cursor) break;
    }
  }
}
async function assertPublicBackendCode(backendDir, files) {
  const expected = new Set(files.map(row => row.relativePath.toLowerCase())), allowedDirectories = new Set();
  for (const relative of expected) {
    let parent = path.posix.dirname(relative);
    while (parent !== '.') {allowedDirectories.add(parent); parent = path.posix.dirname(parent);}
  }
  let count = 0; const seen = new Set();
  async function metadata(filename) {
    const relative = path.relative(backendDir, filename);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('公开内核代码目录越界。');
    let cursor = backendDir, stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('公开内核代码根目录无效。');
    for (const part of relative ? relative.split(path.sep) : []) {
      cursor = path.join(cursor, part); stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1) throw new Error('公开内核代码目录包含链接。');
    }
    return stat;
  }
  async function walk(relative) {
    const directory = path.join(backendDir, relative);
    try {if (!(await metadata(directory)).isDirectory()) throw new Error('公开内核代码目录无效。');}
    catch (error) {if (error.code === 'ENOENT') return; throw error;}
    for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
      if (++count > 600) throw new Error('公开内核代码目录超出上限。');
      const child = `${relative}/${entry.name}`, key = child.toLowerCase();
      if (seen.has(key)) throw new Error('公开内核代码目录包含重复项。'); seen.add(key);
      const stat = await metadata(path.join(backendDir, child));
      if (stat.isDirectory() && allowedDirectories.has(key)) await walk(child);
      else if (!stat.isFile() || !expected.has(key)) throw new Error('发现来源清单之外的内核代码；未载入或覆盖该文件。');
    }
  }
  await metadata(backendDir);
  for (const entry of await fs.readdir(backendDir, {withFileTypes: true})) {
    if (/\.(?:exe|dll)$/i.test(entry.name)) {
      await metadata(path.join(backendDir, entry.name));
      if (!entry.isFile() || !expected.has(entry.name.toLowerCase())) throw new Error('发现未声明的根目录可执行文件；未载入或覆盖它。');
    }
  }
  await walk('components'); await walk('runtime'); await walk('themes'); await walk('doc');
  await walk('profile/user-components-x64');
  const legacy = path.join(backendDir, 'profile/user-components');
  try {await metadata(legacy); if ((await fs.readdir(legacy)).length) throw new Error('不能载入旧组件目录。');}
  catch (error) {if (error.code !== 'ENOENT') throw error;}
}
module.exports = {readPublicInstallation, publicInstallationPaths, assertPublicDataPaths, assertPublicBackendCode};
