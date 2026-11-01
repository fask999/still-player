'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const directory = path.resolve(__dirname, '../native/foobar-spectrum');

test('reader fixture mode precedes all runtime/native branches and has no live calls', () => {
  const source = fs.readFileSync(path.join(directory, 'SpectrumPipeReader.cs'), 'utf8');
  const main = source.slice(source.indexOf('static int Main('), source.indexOf('static bool ParseArgs('));
  assert.ok(main.indexOf('return ProtocolSelfTest()') < main.indexOf('new Thread('));
  assert.ok(main.indexOf('return ProtocolSelfTest()') < main.indexOf('TryRead(pid'));
  const selfTest = source.slice(source.indexOf('static int ProtocolSelfTest()'));
  assert.doesNotMatch(selfTest, /TryRead\(|NamedPipeClientStream\(|GetNamedPipeServerProcessId\(/);
  assert.match(selfTest, /new MemoryStream/);
  const live = source.slice(source.indexOf('static bool TryRead('), source.indexOf('static byte\[\] ReadBounded('));
  assert.ok(live.indexOf('GetNamedPipeServerProcessId(pipe.SafePipeHandle') < live.indexOf('ReadBounded(pipe)'));
  assert.match(live, /actualPid != expectedPid/); assert.match(live, /PipeDirection.In/);
  assert.match(source, /pipe.Connect\(150\)/); assert.match(source, /150 - \(int\)watch.ElapsedMilliseconds/);
  assert.match(source, /NativeMaxBytes = 60 \* 1024/); assert.match(source, /EnvelopeMaxBytes = 64 \* 1024/);
  assert.match(source, /Utf8.GetByteCount\(envelope\) \+ 1 <= EnvelopeMaxBytes/);
  assert.ok(main.includes('Console.Out.NewLine = "\\n";'));
  assert.doesNotMatch(source, /System\.Windows\.Forms|WebView|NAudio|AudioClient|Process\.Start|Process\.GetProcess/);
});
test('existing compiled reader is PE x64 console and fixed fixture self-test passes', t => {
  const file = path.join(directory, 'package/StillSpectrumReader.exe');
  if (process.platform !== 'win32') { t.skip('Windows .NET executable requires Windows; source checks remain active'); return; }
  assert.ok(fs.existsSync(file), 'Run native/foobar-spectrum/build-reader.ps1 -SelfTest with existing .NET Framework CSC');
  const bytes = fs.readFileSync(file), pe = bytes.readUInt32LE(0x3c);
  assert.equal(bytes.readUInt16LE(pe + 4), 0x8664); assert.equal(bytes.readUInt16LE(pe + 24 + 68), 3);
  // This is the ONLY executable invocation in these tests. No --pid, pipe server,
  // player process, authentication profile, or audio device is used.
  const result = spawnSync(file, ['--protocol-self-test'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout.replace(/^\uFEFF/, ''));
  assert.equal(report.protocolSelfTest, 'passed'); assert.ok(report.checks >= 26);
  assert.equal(report.fixturesOnly, true); assert.equal(report.pipeConnections, 0);
  assert.equal(report.processInspection, false); assert.equal(report.audioAccess, false);
});
