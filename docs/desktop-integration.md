# Desktop integration contract (STILL 1.1.0)

The modules below are passive on import, use CommonJS, and never create renderer audio. They take real player/source readbacks and controlled coordinator callbacks. The renderer remains muted. Browsing `selectedSource` is never used to select a playback engine.

## Files and ownership

- Main: `desktop-integration.js`, `desktop-preferences.js`, `desktop-power.js`, `desktop-shortcuts.js`, `desktop-artwork.js`, `window-placement.js`, `sleep-timer.js`, `media-controls.js`, `media-controls-native.js` under `src/main`.
- Renderer: `desktop-controls.js`, `desktop-controls.css`. See `desktop-controls-renderer.md` for the mount contract.
- Runtime: `native/desktop-media/bin/StillMediaControls.exe`, `LICENSE.txt`, `NOTICE.txt`, `runtime-manifest.json`; source/build/protocol documentation stays in `native/desktop-media` and `desktop-media-native.md`.
- No npm dependency additions. The helper builds with the Windows .NET Framework compiler and installed Windows SDK metadata. Runtime uses Windows-provided .NET Framework/WinRT; framework assemblies are not copied into the package.

The overall release requires Windows 10/11 x64 with **.NET Framework 4.8 or later**, matching the frozen native helper notice. An older minimum documented for an individual Apple host component does not lower the application's overall minimum. The helper notice/runtime manifest do not need modification for this release-wide requirement.

This group does not edit the shared main/preload/settings/index/packaging files. The sole integration writer must add the following wiring and include the exact runtime allowlist. The repository's global `*.exe` ignore requires an explicit exception for the helper binary before a later authorized release commit.

## Settings

Import `DESKTOP_DEFAULTS`, `validateDesktopPreference` and `validateDesktopPreferences` (or `mergeDesktopPreferences`) from `desktop-preferences.js`. Add `desktop: DESKTOP_DEFAULTS` to the existing defaults. Desktop values are:

```js
{
  preventSleep: true,
  systemMediaControls: true,
  globalShortcutsEnabled: false,
  hotkeyToggle: '', hotkeyNext: '', hotkeyPrevious: '', hotkeyShowWindow: '',
  windowPlacement: null
}
```

The settings service must validate each desktop patch key with `validateDesktopPreference`, then validate the complete merged desktop section with `validateDesktopPreferences` so duplicate shortcuts spanning multiple partial patches reject before the atomic write. Existing settings sections keep their current merge and atomic persistence. New defaults are backfilled for old files. `windowPlacement` has its own strict versioned schema, documented in `desktop-window-placement.md`. No arbitrary native path, URL, command, hotkey event or timer deadline is persisted. The timer is intentionally per application session; restarting cannot trigger an old stop.

Shortcuts allow Ctrl/Alt with optional Shift and a small key-name allowlist. They normalize modifier order, reject media keys and Windows session/window commands, and reject duplicates. Defaults are empty and registration is disabled. Only owned successful registrations are unregistered. Registration failure returns a per-action status and does not disable playback. `globalShortcut.unregisterAll()` is never used. SMTC is the sole multimedia-key consumer; Electron must not additionally register `MediaPlayPause`, `MediaNextTrack`, `MediaPreviousTrack` or `MediaStop`.

## Main lifecycle

After settings initialization and `app.whenReady()`:

```js
const {desktopWindowOptions, createDesktopIntegration} = require('./desktop-integration');
const initial = desktopWindowOptions({settings: settings.get(), screen});
mainWindow = new BrowserWindow({...otherOptions, ...initial.options});
// Electron dependencies: screen, powerSaveBlocker, globalShortcut, net, nativeImage.
const {createDesktopArtworkReader} = require('./desktop-artwork');
desktop = createDesktopIntegration({
  window: mainWindow, screen, settings, powerSaveBlocker, globalShortcut,
  runtimeRoot: root, // packaged application source root containing native/desktop-media
  mediaManifestSha256: reviewedMediaManifestSha256, // trusted runtime-assets registry value
  enabled: !smokeMode, readOnly: false,
  getPlayer: () => handlers['player:state'](),
  getSources: () => handlers['source:status'](),
  performAction, stopAndRelease,
  getArtwork: createDesktopArtworkReader({net, nativeImage}),
  emit,
  onError: ({code}) => runtimeLog.record('desktop-integration', {code})
});
desktop.restoreWindow(); // before normal show; applies normal bounds then maximize
```

`runtimeRoot` here is the source/app root containing `src` and `native`, not necessarily the directory holding the Electron executable. In the current main this is `root`. The client resolves and verifies only its fixed `native/desktop-media/bin` files beneath that root.

`mediaManifestSha256` is required for production helper startup. Obtain it from the existing trusted reviewed-runtime registry; do not compute it from the adjacent manifest at launch time and pass that same mutable digest as an approval. `desktop-integration` forwards it as the native client's required `expectedManifestSha256`; absent/invalid/mismatched pins fail closed before spawn. The local manifest's fixed inventory and per-file SHA checks are additional integrity checks after the trusted manifest digest matches.

Feed `desktop.observePlayer(mappedPlayer)` from the accepted actual-player readback path (`rememberPlayer` / diagnostic observer), `desktop.observeSources(sourceSnapshot)` from actual source observations, and `desktop.observeSettings(settingsSnapshot)` after committed settings changes. Do not feed renderer intentions, selection changes, fixture playback states or raw old poll results. The module independently rejects decreasing player generations/revisions. The power request is held only for an available, confirmed, nonstale `playing` state with an actual local/Apple source, uses `prevent-app-suspension` (display may turn off), checks `isStarted`, and releases on pause/stop/error/shutdown. If observations cease, a 10-second freshness watchdog releases it.

Merge `desktop.handlers` with the existing handler table **before** registering the trusted sender IPC wrapper. Add only these channels to preload:

- `desktop:status {}` returns the bounded runtime state.
- `desktop:sleepTimer:set {minutes}` accepts exactly one integer `minutes` in 1–1440.
- `desktop:sleepTimer:cancel {}` accepts no extra fields.

Add event `desktop` to preload's event allowlist. Add `desktop:status` to read-only/recovery/smoke read channels; writes remain blocked by existing runtime policy. Existing `settings:update` is the only persistence channel. No renderer API accepts native handles, artwork bytes/paths, source generations or arbitrary coordinator commands. A disabled/read-only desktop instance cannot register helpers/shortcuts, request power or arm timers.

At **the beginning** of every normal/fatal/caught startup/renderer exit shutdown, call `desktop.beginShutdown()` before starting backend drain or closing settings. Its synchronous part aborts timer work and invalidates media actions, releases the power request and unregisters only this module's shortcuts. Await its returned promise before `settings.close()` / window destruction so final normal placement and the bounded helper exit finish. `dispose` is an idempotent alias and can be passed as an unbound callback. The existing app owns `before-quit`, close policy and actual process exit; this module adds no competing quit listener and never changes OS power settings.

## Controlled command callbacks (required integration)

`performAction({action,source,generation,position?,origin})` accepts only `play|pause|toggle|stop|next|previous|seek`. Route with `coordinator.commandForCurrentSource(source,generation,method,...args)`. `play` means resume this already paused current source (map to `toggle`), not a new library play request. `pause` maps to `pause`; remaining names map directly. `seek` takes one finite bounded position. Return the actual mapped player readback. The desktop side rereads sources/player, checks explicit capabilities, rejects old source/generation events and rechecks its session before requesting the action. The coordinator must still perform the final synchronous source/generation check so an intervening user command wins. Do not invoke an adapter directly.

`stopAndRelease({source,generation,signal,isCurrent,origin:'sleep-timer'})` is a stronger callback: it must synchronously claim/verify the expected coordinator source+generation, cancel prior pending commits, stop, verify stopped readback and perform the existing exact-endpoint `releaseOutput`/owned-process release lifecycle under the same coordinator cancellation context. Check context after every await and before a destructive action; bridge the timer signal so cancelling/rearming/quit cannot later stop a replacement playback. Return `{released:true,evidence,state:<mapped actual player>}` only after real output release evidence. A stopped label alone must not return success. The generic existing `player:stop` handler does not supply this stronger guarantee and is insufficient for this callback. If context changes, reject with `STILL_CONTEXT_CHANGED`/`STILL_CANCELLED`; the UI then explains that the scheduled stop did not continue. An unavailable/uncertain/conflicting readback also refuses to make a destructive guess.

If both actual `source` and observed `lastSource` are absent, the desktop timer fails closed even when `state==='stopped'`. It does not infer a local engine, a missing output resource or successful release from this DTO. Only the atomic main/coordinator callback can establish output-release evidence for a source it can authoritatively validate.

The timer uses a monotonic elapsed deadline, not the renderer or mutable wall clock. Wall-clock deadline is display information only. At expiry it reads the then-current actual source and generation; switching the browsing source does nothing. Once firing, cancellation invalidates the callback's signal/current predicate. The timer never calls Windows sleep, shutdown, restart, lock, screen APIs, startup registration or shell commands.

## Media, artwork and duplicate ownership

The WinRT helper owns its own hidden top-level HWND, because Microsoft's desktop `GetForWindow` requires a window belonging to the calling process. It never receives the Electron HWND and never plays/decode audio. It publishes actual metadata, timeline, state and enabled capabilities; emitted commands are tagged with the current playback session and sequence. New source/generation/track identity rotates the session immediately. Progress-only revisions do not invalidate a legitimate just-delivered command. Apple commands require explicit per-method capability; no current real source disables control. Source selection does not redirect a media command.

`createDesktopArtworkReader` accepts only canonical internal `still-cover://art/<cache-file>` and hash-only `still-apple-art://art/<sha256>` URLs. It reads through already authorized protocol handlers, bounds input to 8 MiB, converts an image to at most 512 px JPEG/512 KiB with injected `nativeImage`, and supplies bytes (never a path/remote URL) to the helper. Errors clear/omit artwork without failing transport. The media controller discards late images after track/source/session changes.

The controller selects the first admitted internal URL from `coverLargeUrl`, `coverUrl`, then `coverThumbnailUrl`. This uses the existing bounded large-image cache when present rather than rejecting a legitimate large original while a usable variant is available. Remote or file URLs in those DTO fields are skipped before the artwork reader is called; there is no new URL/path channel.

The dedicated foobar profile must not independently publish a competing SMTC session or consume the same media keys. Its profile/configuration remains owned by the backend/packaging integration group; this desktop group never alters an external or user foobar installation. Actual Windows SMTC visibility, session identity/duplication, locked-session/headset control and timeline/artwork rendering remain acceptance checks, not claims established by pure protocol tests.

## Official references and verification limits

- [Electron powerSaveBlocker](https://www.electronjs.org/docs/latest/api/power-save-blocker): `prevent-app-suspension` keeps the system active while allowing the screen to turn off; `isStarted` is the readback used here.
- [Electron globalShortcut](https://www.electronjs.org/docs/latest/api/global-shortcut): registration may fail when a binding is already taken; APIs run after app readiness.
- [Microsoft desktop SMTC GetForWindow](https://learn.microsoft.com/en-us/windows/win32/api/systemmediatransportcontrolsinterop/nf-systemmediatransportcontrolsinterop-isystemmediatransportcontrolsinterop-getforwindow): the top-level HWND must belong to the caller.
- [Microsoft SMTC timeline properties](https://learn.microsoft.com/en-us/uwp/api/windows.media.systemmediatransportcontrolstimelineproperties): reported timeline values are supplied from the actual adapter readback.

Run the desktop `node --test` suites and targeted ESLint, native build/self-test and no-registration protocol test. These establish module/IPC/lifecycle/serialization properties, not real screen topology, Windows media flyout/lock screen/headset behavior, actual OS power requests, keyboard registration or DAC release. The user's explicit “别 computeruse” instruction prohibits desktop/browser UI automation and screenshots; no such operations were used. System-affecting native SMTC/shortcut/power/audio probes require a separate explicit scope coordinated by the CEO.

On 2026-11-08, a separately approved minimal non-UI normal-mode probe verified the frozen helper's real `GetForWindow` registration: trusted manifest pin, one `start`/`ready`, then `dispose` and observed process exit code 0. No snapshot/update, metadata, fabricated playing state, keyboard input, audio, power request or other application's media session access occurred. The helper kept `IsEnabled=false`; a subsequent exact-process check found no residue. Evidence is under `review-evidence/20261108-feature-desktop/leader/native-registration-probe.{json,log}` and `native-registration-residual.json`. This closes desktop COM registration/owned-exit feasibility only; it does not establish media card presentation or actual playback controls.
