'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const raw=os.tmpdir(),canonical=fs.realpathSync(raw);
const created=fs.mkdtempSync(path.join(raw,'still-ci-canonical-proof-')),realCreated=fs.realpathSync(created);
if(path.dirname(realCreated).toLowerCase()!==canonical.toLowerCase()||!path.basename(realCreated).startsWith('still-ci-canonical-proof-'))throw Error('Unexpected probe boundary');
console.log(JSON.stringify({kind:'temp-path-proof',platform:process.platform,node:process.version,rawTemp:raw,canonicalTemp:canonical,created,canonicalCreated:realCreated,rawEqualsCanonical:raw.toLowerCase()===canonical.toLowerCase(),createdEqualsCanonical:created.toLowerCase()===realCreated.toLowerCase()}));
fs.rmdirSync(realCreated);
const results=[];for(const [mode,env]of [['default',{...process.env}],['canonical',{...process.env,TEMP:canonical,TMP:canonical,TMPDIR:canonical}]]){const r=cp.spawnSync(process.execPath,['--test','tests/apple-diagnostics.test.js'],{env,encoding:'utf8',windowsHide:true,timeout:60000});const out=(r.stdout||'')+(r.stderr||'');fs.writeFileSync('ci-temp-'+mode+'.log',out);const lines=out.split(/\r?\n/).filter(l=>/^(?:ℹ (?:tests|pass|fail|skipped)|# (?:tests|pass|fail|skipped)|✖|not ok|\s+code:|\s+Error:)/.test(l));const value={kind:'apple-diagnostics-ab',mode,exitCode:r.status,error:r.error?.message||null,lines};results.push(value);console.log(JSON.stringify(value));}
if(results[1].exitCode!==0)process.exitCode=1;
