'use strict';

// Main-process only. Paths, keys, ciphertext and developer tokens never belong
// in the renderer-facing status object returned by this module.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_TOKEN_LIFETIME = 15777000;
const DEFAULT_TOKEN_LIFETIME = 30 * 24 * 60 * 60;
const MAX_IMPORT_BYTES = 65536;
const ID = /^[A-Z0-9]{10}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function failure(code, message) { return Object.assign(new Error(message), {code, appleCredentialError: true}); }
function identifier(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw failure('invalid-identifier', `${label} 必须是 10 位大写字母或数字。`);
  return value;
}
function canonicalOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw failure('invalid-origin', 'MusicKit 来源地址无效。'); }
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!loopback && url.protocol !== 'https:') || url.username || url.password || url.origin !== value) throw failure('invalid-origin', 'MusicKit 来源必须是 HTTPS 或本机回环地址的完整 origin。');
  return url.origin;
}
function parsePart(value) {
  if (!BASE64URL.test(value)) throw failure('invalid-token', 'Developer token 格式无效。');
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw failure('invalid-token', 'Developer token 格式无效。'); }
}
function inspectDeveloperToken(token, {now = Math.floor(Date.now() / 1000), origin} = {}) {
  if (typeof token !== 'string' || token.length < 50 || token.length > MAX_IMPORT_BYTES) throw failure('invalid-token', 'Developer token 格式或大小无效。');
  const parts = token.trim().split('.');
  if (parts.length !== 3) throw failure('invalid-token', '请选择含完整 JWT developer token 的文件。');
  const header = parsePart(parts[0]);
  const claims = parsePart(parts[1]);
  if (!header || header.alg !== 'ES256' || !claims || typeof claims !== 'object' || Array.isArray(claims)) throw failure('invalid-token', 'Apple Music developer token 必须使用 ES256。');
  identifier(header.kid, 'Key ID'); identifier(claims.iss, 'Team ID');
  if (!Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp) || claims.iat <= 0 || claims.exp <= claims.iat || claims.exp - claims.iat > MAX_TOKEN_LIFETIME || claims.exp > now + MAX_TOKEN_LIFETIME || claims.iat > now + 300) throw failure('invalid-token-time', 'Developer token 的签发或有效期限不符合 Apple 要求。');
  if (claims.exp <= now + 30) throw failure('expired', 'Developer token 已过期或即将过期，请重新配置。');
  if (!BASE64URL.test(parts[2]) || Buffer.from(parts[2], 'base64url').length !== 64) throw failure('invalid-token', 'Developer token 的 ES256 签名格式无效。');
  let origins = null;
  if (claims.origin !== undefined) {
    if (!Array.isArray(claims.origin) || !claims.origin.length || claims.origin.length > 20) throw failure('invalid-origin', 'Developer token 的 origin claim 无效。');
    origins = claims.origin.map(canonicalOrigin);
    if (origin && !origins.includes(canonicalOrigin(origin))) throw failure('origin-mismatch', '此 developer token 的 origin 不包含本程序 MusicKit 来源，请使用匹配的 token。');
  }
  return {teamId: claims.iss, keyId: header.kid, issuedAt: claims.iat, expiresAt: claims.exp, origins};
}
function signDeveloperToken({teamId, keyId, privateKey, origin, lifetime = DEFAULT_TOKEN_LIFETIME, now = Math.floor(Date.now() / 1000)}) {
  identifier(teamId, 'Team ID'); identifier(keyId, 'Key ID');
  if (!Number.isSafeInteger(lifetime) || lifetime < 300 || lifetime > MAX_TOKEN_LIFETIME) throw failure('invalid-lifetime', 'Developer token 有效期必须在 5 分钟至 6 个月之间。');
  let key;
  try { key = crypto.createPrivateKey({key: privateKey, format: 'pem'}); }
  catch { throw failure('invalid-private-key', '所选文件不是可用的 MusicKit .p8 私钥。'); }
  if (key.asymmetricKeyType !== 'ec' || !['prime256v1', 'P-256'].includes(key.asymmetricKeyDetails?.namedCurve)) throw failure('invalid-private-key', 'MusicKit 私钥必须是 P-256 椭圆曲线密钥。');
  const header = Buffer.from(JSON.stringify({alg: 'ES256', kid: keyId, typ: 'JWT'})).toString('base64url');
  const claims = {iss: teamId, iat: now, exp: now + lifetime};
  if (origin) claims.origin = [canonicalOrigin(origin)];
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const input = `${header}.${payload}`;
  const signature = crypto.sign('sha256', Buffer.from(input), {key, dsaEncoding: 'ieee-p1363'}).toString('base64url');
  return `${input}.${signature}`;
}
async function readImport(file, type) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw failure('invalid-file', `请通过本机文件选择器选择${type}文件。`);
  let handle;
  try {
    handle = await fs.open(file, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_IMPORT_BYTES) throw failure('invalid-file', `${type}文件为空或过大。`);
    const buffer = Buffer.alloc(stat.size + 1);
    const {bytesRead} = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_IMPORT_BYTES || bytesRead !== stat.size) { buffer.fill(0); throw failure('invalid-file', `${type}文件在读取时发生变化。`); }
    return buffer.subarray(0, bytesRead);
  } catch (error) {
    if (error.code?.startsWith('invalid-')) throw error;
    throw failure('file-unreadable', `无法读取所选${type}文件，请重新选择。`);
  } finally { await handle?.close().catch(() => {}); }
}

function createAppleCredentials({dataDir, safeStorage, origin = 'http://127.0.0.1:43182', now = () => Math.floor(Date.now() / 1000)}) {
  const file = path.join(dataDir, 'apple-music', 'credentials.json');
  canonicalOrigin(origin);
  let token = null;
  let metadata = null;
  let issue = null;
  let closed = false;
  let pending = Promise.resolve();
  const encryptionAvailable = () => {
    try { return safeStorage?.isEncryptionAvailable() === true && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
    catch { return false; }
  };
  function status() {
    const expired = !!metadata && metadata.expiresAt <= now() + 30;
    return {configured: !!token && !expired, status: expired || issue === 'developer-token-expired' ? 'expired' : token ? 'configured' : 'missing-config',
      encryptionAvailable: encryptionAvailable(), credentials: metadata ? structuredClone(metadata) : null,
      reasonCodes: expired ? ['developer-token-expired'] : issue ? [issue] : token ? [] : ['missing-developer-config'],
      requiredOrigin: origin};
  }
  function enqueue(operation) {
    if (closed) return Promise.reject(failure('closed', 'Apple Music 凭据服务已关闭。'));
    const result = pending.then(operation).catch(error => { throw error.appleCredentialError ? error : failure('credential-operation-failed', 'Apple Music 配置未完成，请检查所选文件和本机安全存储。'); });
    pending = result.catch(() => {});
    return result;
  }
  async function persist(nextToken, nextMetadata) {
    if (!encryptionAvailable()) throw failure('secure-storage-unavailable', 'Windows 安全存储不可用，无法保存 developer token。');
    let encrypted;
    try { encrypted = safeStorage.encryptString(nextToken); }
    catch { throw failure('secure-storage-unavailable', 'Windows 无法加密 developer token。'); }
    if (!Buffer.isBuffer(encrypted) || !encrypted.length) throw failure('secure-storage-unavailable', 'Windows 安全存储返回了无效结果。');
    await fs.mkdir(path.dirname(file), {recursive: true});
    const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({version: 1, ciphertext: encrypted.toString('base64'), metadata: nextMetadata}), {flag: 'wx', mode: 0o600});
      await fs.rename(temporary, file);
    } catch { throw failure('storage-write-failed', '无法保存加密的 Apple Music 配置。'); }
    finally { encrypted.fill(0); await fs.unlink(temporary).catch(() => {}); }
    token = nextToken; metadata = nextMetadata; issue = null;
    return status();
  }
  return {
    initialize() { return enqueue(async () => {
      try {
        const stat = await fs.stat(file);
        if (stat.size > MAX_IMPORT_BYTES * 3) throw new Error('envelope too large');
        const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
        if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string' || !encryptionAvailable()) throw new Error('encryption unavailable');
        const loaded = safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'));
        const inspected = inspectDeveloperToken(loaded, {origin, now: now()});
        token = loaded;
        metadata = {...inspected, source: envelope.metadata?.source === 'signed-local' ? 'signed-local' : 'imported', validation: 'not-verified-by-apple'};
        issue = null;
      } catch (error) {
        token = null; metadata = null;
        issue = error.code === 'ENOENT' ? null : error.code === 'expired' ? 'developer-token-expired' : 'saved-config-unreadable';
      }
      return status();
    }); },
    status,
    getStatus: status,
    getDeveloperToken() {
      if (closed || !status().configured) throw failure('missing-config', '请先配置本程序的 Apple Music developer 凭据。');
      return token;
    },
    configureKey({teamId, keyId, path: privateKeyPath, lifetime = DEFAULT_TOKEN_LIFETIME}) {
      identifier(teamId, 'Team ID'); identifier(keyId, 'Key ID');
      return enqueue(async () => {
        let buffer;
        try {
          buffer = await readImport(privateKeyPath, '.p8 私钥');
          const signed = signDeveloperToken({teamId, keyId, privateKey: buffer, origin, lifetime, now: now()});
          const inspected = inspectDeveloperToken(signed, {origin, now: now()});
          return await persist(signed, {...inspected, source: 'signed-local', validation: 'not-verified-by-apple'});
        } finally { buffer?.fill(0); }
      });
    },
    importToken({path: tokenPath}) { return enqueue(async () => {
      let buffer;
      try {
        buffer = await readImport(tokenPath, 'developer token');
        const imported = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
        const inspected = inspectDeveloperToken(imported, {origin, now: now()});
        return await persist(imported, {...inspected, source: 'imported', validation: 'not-verified-by-apple'});
      } finally { buffer?.fill(0); }
    }); },
    clear() { return enqueue(async () => {
      try { await fs.unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw failure('storage-write-failed', '无法删除已保存的 Apple Music 配置。'); }
      token = null; metadata = null; issue = null; return status();
    }); },
    async close() { closed = true; await pending; token = null; metadata = null; }
  };
}

// Default production provider: a user-approved Cider LOCAL application token.
// This is not an Apple developer/user token. Never request Cider's account scope.
function createCiderCredentials({dataDir, safeStorage, now = () => Date.now()}) {
  const file = path.join(dataDir, 'apple-music', 'cider-connection.json');
  const allowedScopes = new Set(['playback', 'queue', 'library', 'audio']);
  let token = null, metadata = null, issue = null, closed = false, pending = Promise.resolve();
  const secure = () => {
    try { return safeStorage?.isEncryptionAvailable() === true && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'; }
    catch { return false; }
  };
  function validate(value, scopes) {
    if (typeof value !== 'string' || !/^[\x21-\x7e]{16,8192}$/.test(value)) throw failure('invalid-cider-token', 'Cider 未返回有效的本机应用配对凭据。');
    if (!Array.isArray(scopes) || !scopes.length || scopes.some(scope => !allowedScopes.has(scope))) throw failure('invalid-cider-scopes', 'Cider 未返回本程序请求的有限权限，请重新配对。');
    return [...new Set(scopes)];
  }
  const status = () => ({configured: !!token, credentials: metadata ? structuredClone(metadata) : null,
    encryptionAvailable: secure(), reasonCodes: issue ? [issue] : token ? [] : ['cider-not-paired']});
  function queue(operation) {
    if (closed) return Promise.reject(failure('closed', 'Cider 配对服务已关闭。'));
    const result = pending.then(operation).catch(error => { throw error.appleCredentialError ? error : failure('cider-storage-failed', '无法保存受 Windows 安全存储保护的 Cider 配对。'); });
    pending = result.catch(() => {}); return result;
  }
  return {
    status,
    initialize() { return queue(async () => {
      try {
        const stat = await fs.stat(file);
        if (stat.size > 65536) throw new Error('invalid envelope');
        const envelope = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!secure() || envelope.version !== 1 || envelope.provider !== 'cider' || typeof envelope.ciphertext !== 'string') throw new Error('invalid envelope');
        const loaded = safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'));
        const scopes = validate(loaded, envelope.metadata?.scopes);
        token = loaded;
        metadata = {provider: 'cider', scopes, pairedAt: Number.isSafeInteger(envelope.metadata?.pairedAt) ? envelope.metadata.pairedAt : null};
        issue = null;
      } catch (error) {
        token = null; metadata = null; issue = error.code === 'ENOENT' ? null : 'saved-cider-pairing-unreadable';
      }
      return status();
    }); },
    save({token: value, scopes}) {
      const granted = validate(value, scopes);
      return queue(async () => {
        if (!secure()) throw failure('secure-storage-unavailable', 'Windows 安全存储不可用，未保存 Cider 配对。');
        let ciphertext;
        const nextMetadata = {provider: 'cider', scopes: granted, pairedAt: now()};
        const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
        try {
          ciphertext = safeStorage.encryptString(value);
          if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) throw new Error('encryption failed');
          await fs.mkdir(path.dirname(file), {recursive: true});
          await fs.writeFile(temporary, JSON.stringify({version: 1, provider: 'cider', ciphertext: ciphertext.toString('base64'), metadata: nextMetadata}), {flag: 'wx', mode: 0o600});
          await fs.rename(temporary, file);
          token = value; metadata = nextMetadata; issue = null;
          return status();
        } finally {ciphertext?.fill(0); await fs.unlink(temporary).catch(() => {});}
      });
    },
    getToken() {
      if (closed || !token) throw failure('cider-not-paired', '请先在 Cider 中批准 STILL 的本机应用连接。');
      return token;
    },
    clear() { return queue(async () => {
      try { await fs.unlink(file); } catch (error) {if (error.code !== 'ENOENT') throw error;}
      token = null; metadata = null; issue = null; return status();
    }); },
    async close() { closed = true; await pending; token = null; metadata = null; }
  };
}

module.exports = {createCiderCredentials, createAppleCredentials, inspectDeveloperToken, signDeveloperToken, canonicalOrigin, MAX_TOKEN_LIFETIME, DEFAULT_TOKEN_LIFETIME};
