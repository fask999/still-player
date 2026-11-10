# Desktop window placement

`src/main/window-placement.js` is a CommonJS module with no Electron import. Electron's main-process window and screen objects, settings operations and optional clock are injected. It does not read or write files itself.

## Settings schema

`desktop.windowPlacement` is either `null` (no saved placement) or:

```json
{
  "version": 1,
  "bounds": {"x": -1500, "y": -100, "width": 1000, "height": 800},
  "maximized": true,
  "displayId": 2,
  "workArea": {"x": -1600, "y": -200, "width": 1600, "height": 1160},
  "scaleFactor": 1.5
}
```

`version`, `bounds` and `maximized` are required. The other three fields are optional. `validateWindowPlacement(value)` returns an independent, JSON-serializable copy or throws. It accepts `null`; `undefined` is invalid. Objects must be plain data records with no unknown fields, accessors or symbol keys. All rectangle coordinates and dimensions must be safe integers: x/y within ±10,000,000; width/height within 1–1,000,000. `displayId` must be a safe integer. `scaleFactor` must be a finite number within 0.25–16. No physical coordinates, paths, display labels or arbitrary Electron objects are stored.

Settings own validation and atomic persistence. An update must replace only `desktop.windowPlacement` in the existing partial settings merge, preserving other settings. Malformed saved placement is treated as absent by the resolver. The strict helper is available for rejecting invalid settings patches before committing them.

## Main-process integration

After Electron app readiness, calculate constructor options:

```js
const {resolveWindowPlacement, createWindowPlacementController} = require('./window-placement');
const initial = resolveWindowPlacement({
  saved: settings.get().desktop.windowPlacement,
  displays: screen.getAllDisplays(),
  primaryDisplay: screen.getPrimaryDisplay()
});
const window = new BrowserWindow({...otherOptions, ...initial.options});
const placement = createWindowPlacementController({
  window, screen,
  getSaved: () => settings.get().desktop.windowPlacement,
  persist: value => settings.update({desktop: {windowPlacement: value}}),
  onError: error => logWindowPlacementError(error)
});
placement.restore();
```

`resolveWindowPlacement({saved,displays,primaryDisplay})` returns `{options,restoreMaximized,placement}`. `options` contains only x/y/width/height/minWidth/minHeight. `placement` is the normalized schema object. The default size is 1440×940 DIP, with minima of 480×680 DIP; both are clamped to the selected display's work area, including areas smaller than the minimum. Every restored normal rectangle lies wholly within one work area. Negative screen coordinates are valid.

A still-connected saved display ID takes precedence. Without it, the display with the largest work-area intersection is used; fully disconnected/offscreen positions center on the primary display. A display retaining its ID but changing origin/work area receives the same normal DIP size, clamped as necessary, with relative position preserved in the available room. Scale factors are recorded for diagnostics/topology change detection; the code does not multiply DIP dimensions by scale-factor ratios. Missing/invalid display fixtures fall back to a bounded synthetic work area only to keep the pure resolver total; this is not evidence of a real display.

`restore()` applies the resolved minimum, normal bounds and then maximization, returning the same resolved shape (or null if disposed/native application failed). Call it once after window creation at the existing show lifecycle point. It does not directly persist or attach another show handler. Main retains control of window visibility.

`capture()` samples `getNormalBounds()` and returns a placement copy. It skips hidden, minimized, fullscreen and destroyed windows and never calls `getBounds()`. User movement selects the display from current normal bounds instead of retaining a stale saved ID. Move/resize/maximize/unmaximize/restore/show events capture in memory and debounce persistence for 250 ms. `clock: {setTimeout,clearTimeout}` and `debounceMs` can be injected for tests.

Screen added/removed/metrics-changed events use a cached topology and stable placement. A move/resize arriving after screen metadata changes but before the screen event is ignored, preventing a transient OS relocation from replacing the user's normal size/display identity. Affected windows are moved/resized into a valid area, temporarily unmaximizing only when required and then restoring maximization. Changes to an unrelated display do not move or unmaximize the window. A hidden/minimized window defers native correction until show/restore without being shown or restored by the controller. Native events caused synchronously by correction are suppressed; normalized snapshot comparison prevents duplicate persistence.

`await flush()` cancels the timer, captures if safe, and drains serialized writes, including newer captures arriving during an in-flight write. It resolves to a boolean, reports write errors through `onError`, and leaves failed state dirty for a later explicit flush or later user event. A failure does not start an automatic retry loop. Persistence receives a copy and cannot mutate the controller's committed snapshot.

Main **must await `flush()` before destroying the window or closing settings** in its authorized quit lifecycle. The window close listener also starts a best-effort flush, but cannot make Electron await it. `dispose()` synchronously cancels the timer and removes only the controller's own listeners; it does not start writes. The closed event disposes automatically. An in-flight write may finish after disposal; main must perform its explicit flush first to drain all pending captures.

## Official Electron references

Verified 2026-11-08 against the official documentation (project Electron dependency: 45.1.0):

- [BrowserWindow.getNormalBounds](https://www.electronjs.org/docs/latest/api/browser-window#wingetnormalbounds): the returned rectangle represents the normal window state even while maximized, minimized or fullscreen. This is the source used for persisted geometry.
- [Display object](https://www.electronjs.org/docs/latest/api/structures/display): display bounds and work areas use DIP points; `scaleFactor` describes the output pixel scale. Display IDs may also identify virtual or temporarily unknown displays.
- [screen events and coordinate systems](https://www.electronjs.org/docs/latest/api/screen): topology is observed through display-added, display-removed and display-metrics-changed; changed metrics include bounds, workArea, scaleFactor and rotation. Screen APIs are used only after app readiness.
- [BaseWindow.setMinimumSize](https://www.electronjs.org/docs/latest/api/base-window#winsetminimumsizewidth-height): minimum dimensions are updated before applying smaller geometry so an earlier display's minimum cannot prevent fitting the smaller area.

Preserving normal DIP size across scale-factor changes is this application's policy inferred from these coordinate contracts, not an assertion that Electron promises identical native event ordering on every Windows driver.

## Verification and limits

`node --test tests/desktop-window-placement.test.js` tests schema corruption/accessors, display choice/negative coordinates, tiny/default/offscreen bounds, fixture sweeps, DIP changes, normal/maximized lifecycle, transient topology events, hidden/minimized deferral, debouncing, concurrent serialized writes, disk failures, retry, close and disposal. These use EventEmitter fixtures and an injected clock; no Electron GUI, actual display configuration, user data or system settings are touched.

Dedicated ESLint and Node syntax checks cover the new module/test. The parent desktop owner runs broader integration/build checks. Physical multi-monitor/DPI/taskbar/hotplug behavior and actual native asynchronous event timing are **not tested** by these fixtures. The module supplies geometry persistence only; it does not implement startup registration, taskbar or tray behavior.

Full command output is retained in `review-evidence/20261108-feature-desktop/window`.
