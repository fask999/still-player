'use strict';

// Source-contract checks only: these do not replace an MSVC build or live host tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'native', 'foobar-spectrum');
const source = fs.readFileSync(path.join(root, 'component.cpp'), 'utf8');
const project = fs.readFileSync(path.join(root, 'foo_still_spectrum.vcxproj'), 'utf8');
const build = fs.readFileSync(path.join(root, 'build.ps1'), 'utf8');
const sdk = path.join(root, 'vendor', 'foobar2000-SDK-2026-10-01');
function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `missing code boundaries: ${from} / ${to}`);
  return source.slice(start, end);
}

test('native source uses actual SDK visualisation PCM and no alternate producer', () => {
  assert.match(source, /visualisation_manager::get\(\)->create_stream\(stream_/);
  assert.match(source, /stream_->request_backlog\(1\.0\)/);
  assert.match(source, /set_channel_mode\(visualisation_stream_v2::channel_mode_default\)/);
  assert.equal((source.match(/stream_->get_chunk_absolute\(/g) || []).length, 2);
  assert.doesNotMatch(source, /(?:make_fake_\w+|get_spectrum_absolute|chunk_to_spectrum|input_decoder|input_entry|IAudioClient|IAudioCaptureClient|IMMDeviceEnumerator|waveInOpen|waveOutOpen|CoCreateInstance)\s*\(/);
  assert.doesNotMatch(source, /(?:CreateFile[AW]?|ReadFile|fopen|ifstream|system|ShellExecute[AW]?|CreateProcess[AW]?)\s*\(/);
});

test('main sampling verifies actual PCM format, complete window and identity twice', () => {
  const sample = section('void sample_main()', '// Play callbacks only invalidate');
  assert.match(sample, /rate = probe\.get_srate\(\)/);
  assert.match(sample, /chunk\.get_srate\(\) != rate \|\| chunk\.get_channels\(\) != channels/);
  assert.match(sample, /chunk\.get_sample_count\(\) < still_spectrum::kFftSize/);
  assert.match(sample, /end - \*origin_ < seconds/);
  assert.match(sample, /end <= \*last_accepted_time_ \+ 1e-9/);
  assert.match(sample, /get_now_playing\(before\)/);
  assert.match(sample, /get_now_playing\(after\)/);
  assert.match(sample, /after->get_subsong_index\(\)/);
  assert.doesNotMatch(sample, /analyze_interleaved|serialize_snapshot/);
});

test('global playback callbacks only invalidate and never query SDK state', () => {
  const callbacks = section('class PlaybackCallbacks', 'play_callback_static_factory_t');
  assert.doesNotMatch(callbacks, /playback_control|visualisation_|get_now_playing|->get_path|->get_subsong_index/);
  for (const name of ['new_track', 'stop', 'seek', 'pause', 'starting', 'edited']) {
    assert.match(callbacks, new RegExp(`on_playback_${name}\\(`));
  }
  assert.match(callbacks, /g_runtime->invalidate\(status, reason\)/);
});

test('analysis and transport workers never access playback, stream or source files', () => {
  const analysis = section('void analyze_job(', 'std::string current_json()');
  const pipe = section('void pipe_loop()', 'const std::string session_');
  for (const worker of [analysis, pipe]) {
    assert.doesNotMatch(worker, /playback_control|visualisation_manager|stream_->|get_now_playing|metadb_handle/);
  }
  assert.match(analysis, /still_spectrum::analyze_interleaved/);
  assert.match(analysis, /job\.generation != generation_/);
  assert.match(analysis, /Clock::now\(\) - job\.captured >= kMaxAge/);
  assert.match(analysis, /std::make_shared<const Snapshot>/);
  assert.match(analysis, /b\.dbfs > 60\.0/);
});

test('invalidation drops queued PCM and advances the same generation used at commit', () => {
  const invalidation = section('void invalidate(', 'void callback_finished()');
  assert.match(invalidation, /std::lock_guard lock\(mutex_\)/);
  assert.match(invalidation, /\+\+generation_/);
  assert.match(invalidation, /pending_job_\.reset\(\)/);
  assert.match(invalidation, /replace_empty_locked\(status, reason, std::nullopt\)/);
  const empty = section('void empty_main(', 'void expire_locked()');
  assert.match(empty, /\+\+generation_/);
});

test('freshness uses a monotonic 250 ms deadline and serialization rechecks snapshot identity', () => {
  assert.match(source, /using Clock = std::chrono::steady_clock/);
  assert.match(source, /kMaxAge = 250ms/);
  assert.match(source, /Clock::now\(\) - snapshot_->captured >= kMaxAge/);
  const current = section('std::string current_json()', 'void pipe_loop()');
  assert.equal((current.match(/expire_locked\(\)/g) || []).length, 2);
  assert.match(current, /if \(s == snapshot_\) return json/);
});

test('wire metadata identifies calibration and only running data has measurements', () => {
  const json = section('std::string serialize_snapshot(', 'class Runtime;');
  for (const field of ['schemaVersion', 'source', 'analyzer', 'sessionId', 'backendPid', 'generation', 'sequence',
    'track', 'subsong', 'capturedAtUnixMs', 'ageMs', 'streamTimeSeconds', 'sampleRate', 'channels', 'binHz', 'windowSeconds',
    'fftSize', 'window', 'calibration', 'floorDbfs', 'bands', 'lowHz', 'highHz', 'dbfs', 'hasBins']) {
    assert.ok(json.includes(`\\"${field}\\"`), `missing wire field ${field}`);
  }
  assert.match(json, /sdk-visualisation-pcm/);
  assert.match(json, /hann-periodic/);
  assert.match(json, /rms-full-scale-1/);
  assert.match(json, /s\.status == "running" && s\.analysis\.has_value\(\)/);
  assert.match(json, /running \? "null" : json_string\(s\.reason\)/);
  assert.match(json, /if \(running\) \{[\s\S]*for \(const auto& band/);
  assert.match(json, /out << "\]\}\\n"/);
});

test('pipe endpoint is fixed to the host PID and denies remote or competing servers', () => {
  assert.match(source, /pid_\(GetCurrentProcessId\(\)\)/);
  assert.match(source, /Still\.FoobarSpectrum\.v1\./);
  for (const flag of ['PIPE_ACCESS_OUTBOUND', 'FILE_FLAG_OVERLAPPED', 'FILE_FLAG_FIRST_PIPE_INSTANCE', 'PIPE_REJECT_REMOTE_CLIENTS']) {
    assert.ok(source.includes(flag), `missing ${flag}`);
  }
  assert.match(source, /TOKEN_QUERY/);
  assert.match(source, /TokenUser/);
  assert.match(source, /D:P\(A;;GRGW;;;SY\)\(A;;GRGW;;;/);
  assert.match(source, /BCryptGenRandom/);
  assert.match(source, /i == 4 \|\| i == 6 \|\| i == 8 \|\| i == 10/);
  assert.match(source, /generation_ = 0, sequence_ = 1/);
});

test('pipe I/O is bounded, cancelled and drained without a client-controlled flush', () => {
  assert.match(source, /kPipeDeadlineMs = 100/);
  const finish = section('bool finish_io(', 'class Runtime :');
  assert.match(finish, /WaitForMultipleObjects\(2, waits, FALSE, timeout\)/);
  assert.match(finish, /CancelIoEx\(pipe, &operation\)/);
  assert.match(finish, /GetOverlappedResult\(pipe, &operation, &transferred, TRUE\)/);
  assert.doesNotMatch(source, /FlushFileBuffers\s*\(/);
  assert.doesNotMatch(source, /ReadFile\s*\(/);
});

test('native payload leaves space for the reader envelope under Node 64 KiB', () => {
  assert.match(source, /kMaxJsonBytes = 60 \* 1024/);
  const pipe = section('void pipe_loop()', 'const std::string session_');
  assert.match(pipe, /json\.size\(\) > kMaxJsonBytes/);
  assert.ok(pipe.indexOf('json.size() > kMaxJsonBytes') < pipe.indexOf('WriteFile('));
  assert.match(pipe, /PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 0, 0/);
});

test('startup snapshot is legal and its prequeued callback owns the initial queue slot', () => {
  const snapshot = section('struct Snapshot {', 'struct SampleJob {');
  assert.match(snapshot, /uint64_t sequence = 1;/);
  assert.match(source, /generation_ = 0, sequence_ = 1/);
  assert.match(source, /callback_queued_\{true\}/);
  const lifecycle = section('class Lifecycle :', 'initquit_factory_t');
  assert.match(lifecycle, /main_thread_callback_add\(new service_impl_t<SampleCallback>/);
});

test('shutdown joins workers without waiting for main callbacks; queued work holds weak ownership', () => {
  assert.match(source, /std::weak_ptr<Runtime> state_/);
  assert.match(source, /callback_queued_\.compare_exchange_strong/);
  assert.match(source, /if \(!state->stopping\(\)\) state->sample_main\(\)/);
  const stop = section('void stop_workers()', 'void cleanup_main()');
  assert.ok(stop.indexOf('stopping_.store(true)') < stop.indexOf('analysis_thread_.join()'));
  assert.match(stop, /SetEvent\(stop_event_\.get\(\)\)/);
  assert.match(stop, /wake_\.notify_all\(\)/);
  assert.doesNotMatch(stop, /add_callback|run_synchronously|callback_run|mutex_/);
  const quit = section('void on_quit()', 'initquit_factory_t');
  assert.ok(quit.indexOf('stop_workers()') < quit.indexOf('callback_run()'));
  assert.ok(quit.indexOf('callback_run()') < quit.indexOf('g_runtime.reset()'));
  assert.doesNotMatch(source, /\.detach\s*\(/);
});

test('x64 C++20 project references intact SDK inputs and produces only its package', () => {
  for (const field of ['Release|x64', 'v143', 'stdcpp20', 'DynamicLibrary', 'foo_still_spectrum', 'MultiThreadedDLL']) {
    assert.ok(project.includes(field), `missing build contract ${field}`);
  }
  assert.match(project, /<FloatingPointModel>Precise<\/FloatingPointModel>/);
  assert.match(project, /package\\<\/OutDir>/);
  assert.doesNotMatch(project, /PostBuildEvent|user-components|foobar2000\.exe|profile\\/i);
  const refs = [...project.matchAll(/ProjectReference Include="\$\(SdkRoot\)([^"]+)"/g)].map(m => m[1]);
  assert.equal(refs.length, 3);
  for (const relative of refs) assert.ok(fs.existsSync(path.join(sdk, ...relative.split('\\'))), relative);
  assert.ok(fs.existsSync(path.join(sdk, 'foobar2000', 'shared', 'shared-x64.lib')));
  assert.ok(fs.existsSync(path.join(sdk, 'sdk-license.txt')));
  assert.match(project, /Copy SourceFiles="\$\(SdkRoot\)sdk-license\.txt"/);
  assert.match(project, /Copy SourceFiles="\$\(SdkRoot\)pfc\\pfc-license\.txt"/);
  assert.match(project, /<SetConfiguration>Configuration=Release FB2K;IntDir=/);
  for (const name of ['pfc', 'foobar2000_SDK', 'foobar2000_component_client']) {
    assert.ok(project.includes(`build\\obj\\${name}\\</SetConfiguration>`), `missing reference intermediate isolation: ${name}`);
  }
});

test('build probe returns before any build and never installs or deploys tooling', () => {
  const checkIndex = build.indexOf('if ($CheckOnly) { return }');
  const executeIndex = build.indexOf('& $selected.msbuild @buildArgs');
  assert.ok(checkIndex >= 0 && executeIndex > checkIndex);
  assert.match(build, /if \(\$missing\.Count\) \{[\s\S]*exit 2/);
  assert.doesNotMatch(build, /Invoke-WebRequest|Start-Process|winget|choco|scoop|Set-ExecutionPolicy|Remove-Item/);
  assert.match(build, /WindowsTargetPlatformVersion=/);
  assert.match(build, /VCToolsVersion=/);
});

test('build isolates user and directory imports and rejects SDK command hooks', () => {
  for (const guard of ['empty-msbuild-user', '/p:UserRootDir=', '/p:ImportDirectoryBuildProps=false',
    '/p:ImportDirectoryBuildTargets=false', '/p:VCTargetsPath=', '/p:ForceImportAfterCppTargets=',
    '/p:CustomBeforeMicrosoftCommonTargets=', '/p:CustomAfterMicrosoftCommonTargets=']) {
    assert.ok(build.includes(guard), `missing MSBuild isolation guard ${guard}`);
  }
  assert.match(build, /Get-ChildItem -LiteralPath \$emptyUserRoot -Force/);
  assert.match(build, /local-name\(\)="PostBuildEvent"/);
  assert.match(build, /local-name\(\)="Exec"/);
  assert.match(build, /local-name\(\)="Command"/);
  assert.match(build, /Unexpected SDK project import/);
  for (const relative of ['pfc/pfc.vcxproj', 'foobar2000/SDK/foobar2000_SDK.vcxproj',
    'foobar2000/foobar2000_component_client/foobar2000_component_client.vcxproj']) {
    const sdkProject = fs.readFileSync(path.join(sdk, ...relative.split('/')), 'utf8');
    assert.doesNotMatch(sdkProject, /<(?:Exec|Command|PreBuildEvent|PreLinkEvent|PostBuildEvent|CustomBuild|CustomBuildStep|Copy|Delete)\b/);
    for (const [, imported] of sdkProject.matchAll(/<Import Project="([^"]+)"/g)) {
      assert.ok(['$(VCTargetsPath)\\Microsoft.Cpp.Default.props', '$(VCTargetsPath)\\Microsoft.Cpp.props',
        '$(VCTargetsPath)\\Microsoft.Cpp.targets', '$(UserRootDir)\\Microsoft.Cpp.$(Platform).user.props'].includes(imported), imported);
    }
  }
});

test('build confines all persistent outputs and copies only its package whitelist', () => {
  for (const outputGuard of ['/p:BuildProjectReferences=false', '/p:PreferredToolArchitecture=x64', '/p:SolutionDir=', '/p:OutDir=', '/p:IntDir=',
    'Assert-NativePath', 'ReparsePoint', 'build-plan.json']) assert.ok(build.includes(outputGuard), outputGuard);
  assert.match(build, /'obj\\' \+ \$_\.name/);
  assert.match(build, /\$packageFiles = @\('foo_still_spectrum\.dll', 'foobar2000-sdk-license\.txt', 'pfc-license\.txt', 'COMPONENT-DETAILS\.md'\)/);
  assert.match(build, /Copy-Item -LiteralPath \(Join-Path \$buildOutput \$file\) -Destination \(Join-Path \$packageRoot \$file\)/);
  assert.doesNotMatch(build, /foo_sample|\/quit|user-components/);
});
