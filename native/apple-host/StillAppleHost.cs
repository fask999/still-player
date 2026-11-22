// Native .NET Framework WebView2 host. No credential/token/cookie access.
// The only page bridge is a fixed, shipped public-method whitelist.
using System;
using System.IO;
using System.Text;
using System.Drawing;
using System.Diagnostics;
using System.Collections;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// Pure app-local state. No WebView/profile/API access; shared by the real
// PermissionRequested handler and the native protocol fixtures.
class TemporaryAutoplayGrant {
  public const int PendingTimeoutMs = 20000;
  public long Epoch = -1, ExpiresAt;
  public int RpcId;
  public string Nonce;
  public bool Authorized, Revoked = true;
  public void Begin(long epoch, int rpcId, string nonce, long receivedAt) {Epoch = epoch; RpcId = rpcId; Nonce = nonce; ExpiresAt = receivedAt + PendingTimeoutMs; Authorized = false; Revoked = false;}
  public void Revoke() {Nonce = null; RpcId = 0; Authorized = false; Revoked = true;}
  public bool Confirm(long epoch, string nonce, long now, bool selectedPlaying) {
    if (Revoked || epoch != Epoch || nonce != Nonce || now >= ExpiresAt || !selectedPlaying) return false;
    Authorized = true;
    return true;
  }
  public string Decide(bool isAutoplay, bool sameCore, bool officialOrigin, long currentEpoch, bool nativeReady, bool pendingNonceMatches, long now) {
    if (!isAutoplay) return "deny-kind";
    if (!sameCore) return "deny-core";
    if (!officialOrigin) return "deny-origin";
    if (!nativeReady || currentEpoch != Epoch) return "deny-navigation";
    if (Revoked) return "deny-revoked";
    if (String.IsNullOrEmpty(Nonce)) return "deny-nonce";
    if (Authorized) return "allow-session";
    if (!pendingNonceMatches) return "deny-nonce";
    if (now >= ExpiresAt) return "deny-expired";
    return "allow-pending";
  }
  public static bool PreserveOnLogicalCancel(bool requested, bool hadPendingStart, bool authorized, bool sameEpoch) {
    return requested && !hadPendingStart && authorized && sameEpoch;
  }
  public static string ApplyTemporary(string decision, Action<bool> setSavesInProfile, Func<bool> getSavesInProfile, Action<bool> setAllow, Func<bool> stillValid = null) {
    try {
      setSavesInProfile(false);
      if (getSavesInProfile()) return "temporary-policy-unavailable";
      bool allow = decision == "allow-pending" || decision == "allow-session";
      if (allow && stillValid != null && !stillValid()) {setAllow(false); return "deny-revoked";}
      setAllow(allow);
      return decision;
    } catch {return "temporary-policy-unavailable";}
  }
}

sealed class PendingPageRequest {
  public readonly int Id;
  public readonly string Method, ItemId, Nonce;
  public readonly long Epoch, Deadline;
  public Task<string> Evaluation;
  public bool IsStart {get {return IsStartMethod(Method);}}
  public static bool IsStartMethod(string method) {return method == "play" || method == "resume";}

  public PendingPageRequest(int id, string method, string itemId, string nonce, long epoch, long deadline) {
    Id = id; Method = method; ItemId = itemId; Nonce = nonce; Epoch = epoch; Deadline = deadline;
  }

  public string FailureCode(long now) {
    if (now >= Deadline) return "host-timeout";
    if (Evaluation == null || !Evaluation.IsCompleted) return null;
    return Evaluation.Status == TaskStatus.RanToCompletion && Evaluation.Result == "true" ? null : "invalid-host-command";
  }
}

// All entries and their retirement paths are owned by the WinForms thread.
sealed class PendingPageRequests {
  public const int Capacity = 64;
  readonly Dictionary<int, PendingPageRequest> entries = new Dictionary<int, PendingPageRequest>();
  public bool IsEmpty {get {return entries.Count == 0;}}
  public bool IsFull {get {return entries.Count >= Capacity;}}
  public bool Contains(int id) {return entries.ContainsKey(id);}
  public bool HasStart {
    get {
      foreach (var entry in entries.Values) if (entry.IsStart) return true;
      return false;
    }
  }
  public bool TryAdd(PendingPageRequest request) {
    if (IsFull || Contains(request.Id)) return false;
    entries.Add(request.Id, request); return true;
  }
  PendingPageRequest Match(int id, string nonce, long epoch) {
    PendingPageRequest request;
    return entries.TryGetValue(id, out request) && request.Nonce == nonce && request.Epoch == epoch ? request : null;
  }
  public bool MatchesStart(int id, string nonce, long epoch) {
    var request = Match(id, nonce, epoch);
    return request != null && request.IsStart;
  }
  public PendingPageRequest Take(int id, string nonce, long epoch) {
    var request = Match(id, nonce, epoch);
    if (request != null) entries.Remove(id);
    return request;
  }
  public List<PendingPageRequest> DrainAll() {return Drain(null);}
  public List<PendingPageRequest> DrainStarts() {return Drain(request => request.IsStart);}
  public List<PendingPageRequest> DrainFailed(long now) {return Drain(request => request.FailureCode(now) != null);}
  List<PendingPageRequest> Drain(Predicate<PendingPageRequest> filter) {
    var retired = new List<PendingPageRequest>();
    foreach (var request in entries.Values) if (filter == null || filter(request)) retired.Add(request);
    foreach (var request in retired) entries.Remove(request.Id);
    return retired;
  }
}

class StillAppleHost : Form {
  // Page-forwarded JS commands wait at most 20 seconds. Allow margin for
  // dispatch without retaining an unresponsive page's requests indefinitely.
  const int PageRequestTimeoutMs = 25000;
  readonly WebView2 view = new WebView2();
  readonly Label notice = new Label();
  readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 2097152, RecursionLimit = 30 };
  readonly string profile, bridgeSource;
  readonly bool initiallyVisible;
  readonly PendingPageRequests pending = new PendingPageRequests();
  readonly Timer requestTimer = new Timer { Interval = 250 };
  readonly HashSet<string> allowed = new HashSet<string> { "probe", "state", "search", "library", "queue", "play", "pause", "resume", "stop", "seek", "volume", "order", "next", "previous", "cancel", "show", "hide", "close" };
  bool ready, closing, shuttingDown;
  long navigationEpoch;
  ulong? currentNavigationId;
  readonly TemporaryAutoplayGrant autoplay = new TemporaryAutoplayGrant();
  readonly Stopwatch clock = Stopwatch.StartNew();
  bool autoplayConfigured, autoplaySeen;
  string autoplayDecision = "not-seen";
  CoreWebView2Environment environment;
  static bool OfficialOrigin(string value) {
    Uri uri; return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == "https" && uri.Host == "music.apple.com" && uri.Port == 443 && uri.UserInfo.Length == 0;
  }
  static bool AppleAuthOrigin(string value) {
    if (value == "about:blank" || String.IsNullOrEmpty(value)) return true;
    Uri uri; return Uri.TryCreate(value, UriKind.Absolute, out uri) && uri.Scheme == "https" && uri.Port == 443 && uri.UserInfo.Length == 0 && (uri.Host == "apple.com" || uri.Host.EndsWith(".apple.com", StringComparison.OrdinalIgnoreCase));
  }
  void Output(object value) {
    string line = json.Serialize(value);
    if (Encoding.UTF8.GetByteCount(line) > 2097152) line = "{\"type\":\"error\",\"code\":\"host-response-too-large\"}";
    Console.Out.WriteLine(line); Console.Out.Flush();
  }
  void Reply(int id, bool ok, object value, string code, string origin = null) {
    Output(new { type = "response", rpcId = id, ok = ok, value = value, code = code, origin = origin });
  }
  void PublishAutoplayPolicy() {Output(new {type = "autoplay-policy", configured = autoplayConfigured, seen = autoplaySeen, decision = autoplayDecision});}
  void RevokeAutoplay() {autoplay.Revoke(); if (autoplayDecision != "temporary-policy-unavailable" && autoplayDecision != "handler-unavailable") autoplayDecision = "revoked"; PublishAutoplayPolicy();}
  void PermissionRequested(object sender, CoreWebView2PermissionRequestedEventArgs args) {
    try {
      if (!autoplayConfigured) {autoplayDecision = "handler-unavailable"; PublishAutoplayPolicy(); return;}
      bool isAutoplay = args.PermissionKind == CoreWebView2PermissionKind.Autoplay;
      long requestEpoch = navigationEpoch; string requestNonce = autoplay.Nonce;
      if (isAutoplay) autoplaySeen = true;
      bool sameCore = !view.IsDisposed && view.CoreWebView2 != null && Object.ReferenceEquals(sender, view.CoreWebView2);
      bool pendingMatches = pending.MatchesStart(autoplay.RpcId, autoplay.Nonce, navigationEpoch);
      bool origin = sameCore && OfficialOrigin(args.Uri) && OfficialOrigin(view.CoreWebView2.Source);
      string decision = autoplay.Decide(isAutoplay, sameCore, origin, navigationEpoch, ready && !shuttingDown, pendingMatches, clock.ElapsedMilliseconds);
      autoplayDecision = decision;
      // Unrelated permissions retain normal browser behavior; this policy
      // never grants them or writes their state into a profile.
      if (!isAutoplay || !sameCore) {PublishAutoplayPolicy(); return;}
      autoplayDecision = TemporaryAutoplayGrant.ApplyTemporary(decision, value => args.SavesInProfile = value,
        () => args.SavesInProfile, allow => args.State = allow ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny,
        () => {
          if (requestEpoch != navigationEpoch || requestNonce != autoplay.Nonce || shuttingDown || view.IsDisposed || !Object.ReferenceEquals(sender, view.CoreWebView2)) return false;
          bool currentPending = pending.MatchesStart(autoplay.RpcId, autoplay.Nonce, navigationEpoch);
          string current = autoplay.Decide(true, true, OfficialOrigin(args.Uri) && OfficialOrigin(view.CoreWebView2.Source), navigationEpoch, ready, currentPending, clock.ElapsedMilliseconds);
          return current == "allow-pending" || current == "allow-session";
        });
      PublishAutoplayPolicy();
    } catch {autoplayDecision = "temporary-policy-unavailable"; PublishAutoplayPolicy();}
  }
  StillAppleHost(string profile, string bridgeFile, bool show) {
    this.profile = profile; bridgeSource = File.ReadAllText(bridgeFile, Encoding.UTF8); initiallyVisible = show;
    Text = "Apple Music · 官方会话";
    ShowInTaskbar = show; Opacity = show ? 1 : 0;
    StartPosition = FormStartPosition.CenterScreen;
    Rectangle area = Screen.PrimaryScreen.WorkingArea;
    Size = new Size(Math.Min(1100, area.Width), Math.Min(780, area.Height));
    notice.Text = "Apple 官方会话 · https://music.apple.com · 请自行登录；在 STILL 选择播放前，此窗口音频保持静音。";
    notice.AutoSize = false; notice.Height = 45; notice.Dock = DockStyle.Top;
    notice.Padding = new Padding(12, 9, 12, 4);
    view.Dock = DockStyle.Fill; Controls.Add(view); Controls.Add(notice);
    Shown += Initialize;
    FormClosing += (sender, args) => {
      if (!shuttingDown) {args.Cancel = true; Hide(); ShowInTaskbar = false;}
    };
    requestTimer.Tick += (sender, args) => RetireFailedRequests();
    FormClosed += (sender, args) => {requestTimer.Dispose(); view.Dispose();};
  }
  async void Initialize(object sender, EventArgs args) {
    try {
      environment = await CoreWebView2Environment.CreateAsync(null, profile, null);
      await view.EnsureCoreWebView2Async(environment);
      view.CoreWebView2.IsMuted = true;
      try {view.CoreWebView2.PermissionRequested += PermissionRequested; autoplayConfigured = true;}
      catch {autoplayDecision = "handler-unavailable";}
      PublishAutoplayPolicy();
      view.CoreWebView2.NavigationStarting += (s, e) => {
        if (closing || shuttingDown || !OfficialOrigin(e.Uri)) {e.Cancel = true; return;}
        RetirePage(e.NavigationId, "official-player-not-ready", "native-ready-guard");
      };
      view.CoreWebView2.NewWindowRequested += OpenAppleAuth;
      view.CoreWebView2.WebMessageReceived += MessageReceived;
      view.CoreWebView2.NavigationCompleted += NavigationCompleted;
      view.CoreWebView2.ProcessFailed += (s, e) => {
        if (closing || shuttingDown) return;
        RetirePage(null, "official-process-failed");
        Output(new {type = "error", code = "official-process-failed"});
      };
      view.CoreWebView2.Navigate("https://music.apple.com/cn/new");
      ReadCommands();
    } catch {Output(new {type = "error", code = "host-initialization-failed"}); shuttingDown = true; Close();}
  }
  async void NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs args) {
    if (args.NavigationId != currentNavigationId || closing || shuttingDown) return;
    long epoch = navigationEpoch;
    ready = false;
    if (!args.IsSuccess || !OfficialOrigin(view.CoreWebView2.Source)) {Output(new {type = "error", code = "official-navigation-failed"}); return;}
    try {
      bool sdkReady = false;
      for (int attempt = 0; attempt < 80; attempt++) {
        if (!CurrentNavigation(epoch, args.NavigationId)) return;
        string found = await view.CoreWebView2.ExecuteScriptAsync("(() => { try { if (typeof window.MusicKit?.getInstance !== 'function') return false; const player = window.MusicKit.getInstance(); return !!player && typeof player.play === 'function' && typeof player.api?.music === 'function'; } catch { return false; } })()");
        if (!CurrentNavigation(epoch, args.NavigationId)) return;
        if (found == "true") {sdkReady = true; break;}
        await Task.Delay(250);
      }
      if (!CurrentNavigation(epoch, args.NavigationId)) return;
      if (!sdkReady) {Output(new {type = "error", code = "official-player-not-ready", origin = "native-sdk-ready-timeout"}); return;}
      await view.CoreWebView2.ExecuteScriptAsync("window.__STILL_OFFICIAL_PUBLIC_BRIDGE__ = " + bridgeSource + ";");
      if (!CurrentNavigation(epoch, args.NavigationId)) return;
      string installed = await view.CoreWebView2.ExecuteScriptAsync("typeof window.__STILL_OFFICIAL_PUBLIC_BRIDGE__ === 'function'");
      if (!CurrentNavigation(epoch, args.NavigationId)) return;
      if (installed != "true") {Output(new {type = "error", code = "official-bridge-unavailable"}); return;}
      if (!CanPublishReady(sdkReady, installed == "true", epoch, navigationEpoch, args.NavigationId, currentNavigationId, shuttingDown)) return;
      ready = true;
      Output(new {type = "ready", runtime = environment.BrowserVersionString, origin = "https://music.apple.com", outputMuted = view.CoreWebView2.IsMuted});
      if (!initiallyVisible) {Hide(); ShowInTaskbar = false;}
    } catch {if (CurrentNavigation(epoch, args.NavigationId)) Output(new {type = "error", code = "official-bridge-unavailable"});}
  }
  bool CurrentNavigation(long epoch, ulong navigationId) {
    return !closing && !shuttingDown && !IsDisposed && !view.IsDisposed && epoch == navigationEpoch && navigationId == currentNavigationId &&
      view.CoreWebView2 != null && OfficialOrigin(view.CoreWebView2.Source);
  }
  static bool CanPublishReady(bool sdkReady, bool installed, long expectedEpoch, long actualEpoch, ulong completedId, ulong? latestId, bool closing) {
    return sdkReady && installed && expectedEpoch == actualEpoch && completedId == latestId && !closing;
  }
  async void OpenAppleAuth(object sender, CoreWebView2NewWindowRequestedEventArgs args) {
    args.Handled = true;
    if (!AppleAuthOrigin(args.Uri)) return;
    var deferral = args.GetDeferral();
    var form = new Form {Text = "Apple 官方登录", StartPosition = FormStartPosition.CenterParent, Size = new Size(650, 760)};
    var browser = new WebView2 {Dock = DockStyle.Fill};
    var address = new Label {Dock = DockStyle.Top, Height = 32, Text = "Apple 官方登录 · 请在此窗口自行操作", Padding = new Padding(8)};
    form.Controls.Add(browser); form.Controls.Add(address);
    try {
      form.Show(this);
      await browser.EnsureCoreWebView2Async(environment);
      browser.CoreWebView2.IsMuted = true;
      browser.CoreWebView2.NavigationStarting += (s, e) => {if (!AppleAuthOrigin(e.Uri)) e.Cancel = true;};
      browser.CoreWebView2.SourceChanged += (s, e) => {
        Uri uri; if (Uri.TryCreate(browser.CoreWebView2.Source, UriKind.Absolute, out uri) && uri.Scheme == "https") address.Text = "Apple 官方登录 · " + uri.GetLeftPart(UriPartial.Authority);
      };
      browser.CoreWebView2.NewWindowRequested += (s, e) => {e.Handled = true;};
      browser.CoreWebView2.WindowCloseRequested += (s, e) => form.Close();
      form.FormClosed += (s, e) => browser.Dispose();
      args.NewWindow = browser.CoreWebView2;
    } catch {form.Close();}
    finally {deferral.Complete();}
  }
  void ReadCommands() {
    Task.Run(() => {
      try {
        string line;
        while ((line = Console.In.ReadLine()) != null) {
          if (line.Length > 65536) {Output(new {type = "error", code = "host-command-too-large"}); continue;}
          string captured = line; long receivedAt = clock.ElapsedMilliseconds;
          BeginInvoke(new Action(() => ProcessCommand(captured, receivedAt)));
        }
      } catch { }
      try {
        BeginInvoke(new Action(() => {
          if (closing || shuttingDown) return;
          try {BeginClosing();} catch (IOException) { }
          finally {shuttingDown = true; Close();}
        }));
      } catch (InvalidOperationException) { }
    });
  }
  void MuteNativeOutput() {
    // A failed browser process can make its Core unusable during retirement.
    try {if (!view.IsDisposed && view.CoreWebView2 != null) view.CoreWebView2.IsMuted = true;} catch { }
  }
  void RetirePage(ulong? nextNavigationId, string code, string origin = null) {
    ready = false; currentNavigationId = nextNavigationId; navigationEpoch++;
    var retired = pending.DrainAll();
    requestTimer.Stop();
    MuteNativeOutput(); RevokeAutoplay();
    if (nextNavigationId.HasValue) Output(new {type = "phase", phase = "loading"});
    foreach (var request in retired) Reply(request.Id, false, null, request.IsStart ? "cancelled" : code, request.IsStart ? null : origin);
  }
  void BeginClosing() {
    closing = true;
    RetirePage(null, "host-exited");
  }
  void RetirePendingStarts() {
    // A response can already be queued in WebMessageReceived when a newer
    // pause/stop/cancel arrives. Retire its nonce before dispatching that newer
    // intent so the late old response cannot reopen the native audio gate.
    var retired = pending.DrainStarts();
    if (retired.Count > 0) MuteNativeOutput();
    foreach (var request in retired) Reply(request.Id, false, null, "cancelled");
  }
  static bool InvalidatesPendingStarts(string method) {
    return PendingPageRequest.IsStartMethod(method) || method == "pause" || method == "stop" || method == "cancel" || method == "close";
  }
  void FailPendingRequest(PendingPageRequest request, string code) {
    FailPendingRequest(request, code, () => {MuteNativeOutput(); RevokeAutoplay();}, (id, reason) => Reply(id, false, null, reason));
  }
  static void FailPendingRequest(PendingPageRequest request, string code, Action silenceStart, Action<int, string> reject) {
    if (request.IsStart) silenceStart();
    reject(request.Id, code);
  }
  void RetireFailedRequests() {
    if (!pending.IsEmpty) {
      long now = clock.ElapsedMilliseconds;
      foreach (var request in pending.DrainFailed(now)) FailPendingRequest(request, request.FailureCode(now));
    }
    if (pending.IsEmpty) requestTimer.Stop();
  }
  static void ObserveEvaluationFault(Task<string> evaluation) {
    // The observer carries no request or Form reference across retirement.
    evaluation.Exception.Handle(failure => true);
  }
  static void TrackEvaluation(PendingPageRequest request, Task<string> evaluation) {
    request.Evaluation = evaluation;
    evaluation.ContinueWith(ObserveEvaluationFault, System.Threading.CancellationToken.None,
      TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
  }
  async void ProcessCommand(string line, long receivedAt) {
    if (closing || shuttingDown) return;
    int id = 0;
    PendingPageRequest request = null;
    try {
      var command = json.DeserializeObject(line) as Dictionary<string, object>;
      if (command == null || !command.ContainsKey("rpcId")) throw new Exception();
      id = Convert.ToInt32(command["rpcId"]);
      // A second invocation of an active ID cannot reply on its first owner's behalf.
      if (pending.Contains(id)) return;
      string method = command["method"] as string;
      if (id <= 0 || method == null || !allowed.Contains(method)) throw new Exception();
      RetireFailedRequests();
      bool isStart = PendingPageRequest.IsStartMethod(method);
      if (isStart && clock.ElapsedMilliseconds >= receivedAt + TemporaryAutoplayGrant.PendingTimeoutMs) {
        Reply(id, false, null, "host-timeout");
        return;
      }
      if (method == "close") {
        try {
          BeginClosing();
          var exited = new TaskCompletionSource<bool>();
          if (environment != null) environment.BrowserProcessExited += (s, e) => exited.TrySetResult(true);
          var children = new List<Form>(); foreach (Form form in Application.OpenForms) if (form != this) children.Add(form);
          foreach (Form form in children) form.Close();
          view.Dispose();
          bool browserExited = await Task.WhenAny(exited.Task, Task.Delay(5000)) == exited.Task;
          Reply(id, true, new {closed = true, browserProcessExited = browserExited}, null);
        } finally {shuttingDown = true; Close();}
        return;
      }
      bool hadPendingStart = pending.HasStart;
      if (method == "order") {
        object order;
        if (!command.TryGetValue("order", out order) || !(order is int) || (int)order < 0 || (int)order > 5) {Reply(id, false, null, "invalid-input"); return;}
        if (hadPendingStart) {Reply(id, false, null, "official-control-unavailable"); return;}
      }
      bool preservePermission = method == "cancel" && command.ContainsKey("preservePlaybackPermission") && command["preservePlaybackPermission"] is bool && (bool)command["preservePlaybackPermission"] &&
        TemporaryAutoplayGrant.PreserveOnLogicalCancel(true, hadPendingStart, autoplay.Authorized, autoplay.Epoch == navigationEpoch);
      if (InvalidatesPendingStarts(method)) {
        if (!preservePermission) RevokeAutoplay();
        RetirePendingStarts();
      }
      if (method == "show") {ShowInTaskbar = true; Opacity = 1; Show(); if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal; Activate(); Reply(id, true, new {shown = true}, null); return;}
      if (method == "hide") {Hide(); ShowInTaskbar = false; Reply(id, true, new {hidden = true}, null); return;}
      if (!ready) {Reply(id, false, null, "official-player-not-ready", "native-ready-guard"); return;}
      if (!OfficialOrigin(view.CoreWebView2.Source)) {Reply(id, false, null, "official-player-not-ready", "native-origin-guard"); return;}
      if (method == "stop") view.CoreWebView2.IsMuted = true;
      if (pending.IsFull) {Reply(id, false, null, "host-busy"); return;}
      string itemId = command.ContainsKey("id") ? command["id"] as string : null;
      if (method == "play" && (itemId == null || !Regex.IsMatch(itemId, "^[A-Za-z0-9._-]{1,200}$"))) {Reply(id, false, null, "invalid-item"); return;}
      // Keep the old item inaudible while a new item is validated/prepared.
      // Only the matching, playing result below may open this audio gate.
      if (isStart) view.CoreWebView2.IsMuted = true;
      string nonce = Guid.NewGuid().ToString("N");
      long now = clock.ElapsedMilliseconds;
      request = new PendingPageRequest(id, method, itemId, nonce, navigationEpoch, now + PageRequestTimeoutMs);
      if (!pending.TryAdd(request)) return;
      requestTimer.Start();
      if (request.IsStart) {autoplay.Begin(request.Epoch, id, nonce, receivedAt); autoplaySeen = false; autoplayDecision = autoplayConfigured ? "awaiting-request" : "handler-unavailable"; PublishAutoplayPolicy();}
      string payload = json.Serialize(command);
      string envelope = "{kind:'still-public-rpc',rpcId:" + id + ",nonce:" + json.Serialize(nonce) + ",";
      string script = "(() => { Promise.resolve().then(() => window.__STILL_OFFICIAL_PUBLIC_BRIDGE__(" + payload +
        ")).then(result => window.chrome.webview.postMessage(" + envelope + "result})).catch(() => window.chrome.webview.postMessage(" +
        envelope + "result:{ok:false,code:'official-operation-failed'}})); return true; })()";
      // Evaluate only the launch script. A stuck evaluation or page Promise
      // can outlive its RPC, so neither drives a host continuation.
      TrackEvaluation(request, view.CoreWebView2.ExecuteScriptAsync(script));
    } catch {
      if (request != null) {
        if (pending.Take(request.Id, request.Nonce, request.Epoch) != null) FailPendingRequest(request, "invalid-host-command");
      } else if (id > 0) Reply(id, false, null, "invalid-host-command");
    }
  }
  void MessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs args) {
    PendingPageRequest request = null;
    try {
      if (!ready || closing || shuttingDown || !OfficialOrigin(args.Source) || !OfficialOrigin(view.CoreWebView2.Source)) return;
      var message = json.DeserializeObject(args.WebMessageAsJson) as Dictionary<string, object>;
      if (message == null || !message.ContainsKey("kind") || (string)message["kind"] != "still-public-rpc") return;
      int id = Convert.ToInt32(message["rpcId"]);
      if (!message.ContainsKey("nonce")) return;
      request = pending.Take(id, message["nonce"] as string, navigationEpoch);
      if (request == null) return;
      string failure = request.FailureCode(clock.ElapsedMilliseconds);
      if (failure != null) {FailPendingRequest(request, failure); return;}
      var result = message["result"] as Dictionary<string, object>;
      if (result == null || !result.ContainsKey("ok")) {FailPendingRequest(request, "official-invalid-response"); return;}
      bool ok = result["ok"] is bool && (bool)result["ok"];
      object value = result.ContainsKey("value") ? result["value"] : null;
      var record = value as Dictionary<string, object>;
      if (request.IsStart) {
        bool selectedPlaying = ok && CanUnmute(request.Method, request.ItemId, record);
        if (selectedPlaying) {
          long now = clock.ElapsedMilliseconds;
          if (!autoplay.Confirm(request.Epoch, request.Nonce, now, true)) {
            FailPendingRequest(request, now >= autoplay.ExpiresAt ? "host-timeout" : "official-operation-failed");
            return;
          }
          view.CoreWebView2.IsMuted = false;
        } else {
          view.CoreWebView2.IsMuted = true;
          RevokeAutoplay();
        }
      }
      if (record != null) record["outputMuted"] = view.CoreWebView2.IsMuted;
      string code = result.ContainsKey("code") ? result["code"] as string : null;
      string origin = code == "official-player-not-ready" && result.ContainsKey("origin") && result["origin"] as string == "bridge-instance" ? "bridge-instance" : null;
      Reply(id, ok, value, code, origin);
    } catch {
      if (request != null) FailPendingRequest(request, "official-invalid-response");
      else Output(new {type = "error", code = "official-invalid-response"});
    }
  }
  static bool CanUnmute(string method, string requestedId, Dictionary<string, object> value) {
    if (value == null || !value.ContainsKey("isPlaying") || !(value["isPlaying"] is bool) || !(bool)value["isPlaying"]) return false;
    string currentId = value.ContainsKey("currentTrackId") ? value["currentTrackId"] as string : null;
    if (currentId == null || !Regex.IsMatch(currentId, "^[A-Za-z0-9._-]{1,200}$")) return false;
    return method == "play" ? requestedId != null && currentId == requestedId : method == "resume";
  }
  static Dictionary<string, bool> PageRpcLifetimeChecks() {
    var checks = new Dictionary<string, bool>();
    checks["coversNodeDeadline"] = PageRequestTimeoutMs > 20000;
    string[] methods = {"probe", "state", "search", "library", "queue", "volume", "play", "resume"};
    foreach (string boundary in new string[] {"navigation", "processFailure", "close", "timeout"}) {
      var requests = new PendingPageRequests();
      bool passed = true;
      for (int epoch = 1; epoch <= 3; epoch++) {
        long deadline = epoch * PageRequestTimeoutMs;
        string nonce = "fixture-epoch-" + epoch;
        for (int id = 1; id <= PendingPageRequests.Capacity; id++) {
          passed &= requests.TryAdd(new PendingPageRequest(id, methods[(id - 1) % methods.Length], null, nonce, epoch, deadline));
        }
        passed &= requests.IsFull && !requests.TryAdd(new PendingPageRequest(65, "probe", null, nonce, epoch, deadline));
        if (boundary == "timeout") passed &= requests.DrainFailed(deadline - 1).Count == 0;
        var retired = boundary == "timeout" ? requests.DrainFailed(deadline) : requests.DrainAll();
        passed &= retired.Count == PendingPageRequests.Capacity && requests.IsEmpty;
        passed &= requests.Take(1, nonce, epoch) == null;
        var next = new PendingPageRequest(1, "probe", null, "fixture-new", epoch + 1, deadline + PageRequestTimeoutMs);
        passed &= requests.TryAdd(next) && requests.Take(1, nonce, epoch + 1) == null &&
          requests.Take(1, next.Nonce, epoch) == null && Object.ReferenceEquals(requests.Take(1, next.Nonce, epoch + 1), next);
      }
      checks[boundary + "ReclaimsCapacity"] = passed;
    }

    var pending = new PendingPageRequests();
    var abandoned = new PendingPageRequest(1, "play", "old-item", "fixture-old", 1, PageRequestTimeoutMs);
    var hanging = new TaskCompletionSource<string>();
    TrackEvaluation(abandoned, hanging.Task);
    pending.TryAdd(abandoned);
    checks["hangingEvaluationExpires"] = pending.DrainFailed(PageRequestTimeoutMs - 1).Count == 0 &&
      pending.DrainFailed(PageRequestTimeoutMs).Count == 1 && pending.IsEmpty && !hanging.Task.IsCompleted;

    var current = new PendingPageRequest(1, "resume", "new-item", "fixture-new", 1, 2 * PageRequestTimeoutMs);
    var duplicate = new PendingPageRequest(1, "play", "wrong-item", "fixture-duplicate", 1, 2 * PageRequestTimeoutMs);
    checks["duplicateIdKeepsOriginal"] = pending.TryAdd(current) && !pending.TryAdd(duplicate) &&
      pending.MatchesStart(1, current.Nonce, current.Epoch) && !pending.MatchesStart(1, duplicate.Nonce, duplicate.Epoch);
    hanging.SetException(new InvalidOperationException("Fixture script failure after retirement"));
    checks["lateEvaluationAndReplyCannotRetireReplacement"] = pending.DrainFailed(PageRequestTimeoutMs).Count == 0 &&
      pending.Take(1, abandoned.Nonce, abandoned.Epoch) == null &&
      Object.ReferenceEquals(pending.Take(1, current.Nonce, current.Epoch), current) && pending.IsEmpty;

    var failed = new PendingPageRequest(2, "search", null, "fixture-fault", 1, PageRequestTimeoutMs);
    var badLaunch = new PendingPageRequest(3, "probe", null, "fixture-bad-launch", 1, PageRequestTimeoutMs);
    var launched = new PendingPageRequest(4, "state", null, "fixture-launch", 1, PageRequestTimeoutMs);
    var faulted = new TaskCompletionSource<string>();
    TrackEvaluation(failed, faulted.Task);
    TrackEvaluation(badLaunch, Task.FromResult("null"));
    TrackEvaluation(launched, Task.FromResult("true"));
    pending.TryAdd(failed); pending.TryAdd(badLaunch); pending.TryAdd(launched);
    faulted.SetException(new InvalidOperationException("Fixture script failure while pending"));
    var faulty = pending.DrainFailed(1);
    checks["evaluationFailureRetiresOnlyItsRequests"] = faulty.Count == 2 && faulty.Contains(failed) && faulty.Contains(badLaunch) &&
      failed.FailureCode(1) == "invalid-host-command" && badLaunch.FailureCode(1) == "invalid-host-command" &&
      Object.ReferenceEquals(pending.Take(4, launched.Nonce, launched.Epoch), launched) && launched.FailureCode(1) == null && pending.IsEmpty;

    var grant = new TemporaryAutoplayGrant();
    grant.Begin(1, 10, "fixture-authorized", 0);
    grant.Confirm(1, "fixture-authorized", 1, true);
    bool muted = false, replied = false;
    Action silence = () => {muted = true; grant.Revoke();};
    var silentRead = new PendingPageRequest(11, "search", null, "fixture-read", 1, PageRequestTimeoutMs);
    TrackEvaluation(silentRead, Task.FromResult("true"));
    pending.TryAdd(silentRead);
    foreach (var request in pending.DrainFailed(PageRequestTimeoutMs)) {
      FailPendingRequest(request, request.FailureCode(PageRequestTimeoutMs), silence,
        (id, code) => {replied = id == silentRead.Id && code == "host-timeout";});
    }
    checks["readTimeoutPreservesAuthorizedPlayback"] = replied && !muted &&
      grant.Decide(true, true, true, 1, true, false, PageRequestTimeoutMs) == "allow-session";
    grant.Begin(1, current.Id, current.Nonce, PageRequestTimeoutMs);
    pending.TryAdd(current);
    var matchingExpired = pending.Take(current.Id, current.Nonce, current.Epoch);
    replied = false;
    FailPendingRequest(matchingExpired, matchingExpired.FailureCode(current.Deadline), silence,
      (id, code) => {replied = muted && grant.Revoked && id == current.Id && code == "host-timeout";});
    checks["matchingReplyAtDeadlineFailsClosedBeforeReply"] = replied && pending.IsEmpty;

    long receivedAt = 1000, admittedAt = 4000;
    long audioDeadline = receivedAt + TemporaryAutoplayGrant.PendingTimeoutMs;
    var lateStart = new PendingPageRequest(12, "play", "fixture-item", "fixture-late-start", 1, admittedAt + PageRequestTimeoutMs);
    pending.TryAdd(lateStart);
    grant.Begin(lateStart.Epoch, lateStart.Id, lateStart.Nonce, receivedAt);
    checks["autoplayDeadlineStartsBeforeUiDispatch"] = grant.ExpiresAt == audioDeadline &&
      grant.Decide(true, true, true, lateStart.Epoch, true, true, audioDeadline - 1) == "allow-pending" &&
      grant.Decide(true, true, true, lateStart.Epoch, true, true, audioDeadline) == "deny-expired";
    var matchingLateStart = pending.Take(lateStart.Id, lateStart.Nonce, lateStart.Epoch);
    checks["expiredGrantCannotAuthorizeMatchedStart"] = Object.ReferenceEquals(matchingLateStart, lateStart) &&
      lateStart.FailureCode(audioDeadline) == null && !grant.Confirm(lateStart.Epoch, lateStart.Nonce, audioDeadline, true) &&
      !grant.Confirm(lateStart.Epoch, lateStart.Nonce, audioDeadline + 1, true) && !grant.Authorized;
    checks["unexpiredGrantAuthorizesOnlyNextExactStart"] = !grant.Confirm(lateStart.Epoch, "fixture-wrong", audioDeadline - 1, true) &&
      !grant.Confirm(lateStart.Epoch + 1, lateStart.Nonce, audioDeadline - 1, true) &&
      !grant.Confirm(lateStart.Epoch, lateStart.Nonce, audioDeadline - 1, false) &&
      grant.Confirm(lateStart.Epoch, lateStart.Nonce, audioDeadline - 1, true);
    return checks;
  }
  static int ProtocolSelfTest() {
    // Synthetic fixtures only: no WebView2 instance, account or audio stream.
    var serializer = new JavaScriptSerializer();
    var command = serializer.DeserializeObject("{\"rpcId\":17,\"method\":\"play\",\"id\":\"fixture-B\"}") as Dictionary<string, object>;
    bool separated = Convert.ToInt32(command["rpcId"]) == 17 && (string)command["id"] == "fixture-B";
    var oldItem = new Dictionary<string, object> {{"isPlaying", true}, {"currentTrackId", "fixture-A"}};
    var selected = new Dictionary<string, object> {{"isPlaying", true}, {"currentTrackId", "fixture-B"}};
    var paused = new Dictionary<string, object> {{"isPlaying", false}, {"currentTrackId", "fixture-B"}};
    bool oldMuted = !CanUnmute("play", "fixture-B", oldItem), selectedAllowed = CanUnmute("play", "fixture-B", selected), pausedMuted = !CanUnmute("play", "fixture-B", paused);
    var retirementChecks = new Dictionary<string, bool>();
    foreach (string intent in new string[] {"pause", "stop", "cancel", "play", "resume", "close"}) {
      var requests = new PendingPageRequests();
      var probe = new PendingPageRequest(3, "probe", null, "probe", 1, PageRequestTimeoutMs);
      requests.TryAdd(new PendingPageRequest(1, "play", "fixture-A", "old-play", 1, PageRequestTimeoutMs));
      requests.TryAdd(new PendingPageRequest(2, "resume", "fixture-A", "old-resume", 1, PageRequestTimeoutMs));
      requests.TryAdd(probe);
      var retired = InvalidatesPendingStarts(intent) ? requests.DrainStarts() : new List<PendingPageRequest>();
      bool latePlayRejected = requests.Take(1, "old-play", 1) == null;
      bool lateResumeRejected = requests.Take(2, "old-resume", 1) == null;
      bool probeRetained = Object.ReferenceEquals(requests.Take(3, "probe", 1), probe);
      requests.TryAdd(new PendingPageRequest(1, "play", "fixture-B", "new-play", 1, PageRequestTimeoutMs));
      bool oldNonceRejected = requests.Take(1, "old-play", 1) == null;
      var matching = requests.Take(1, "new-play", 1);
      bool newReplyAccepted = matching != null && CanUnmute(matching.Method, matching.ItemId, selected);
      retirementChecks[intent] = retired.Count == 2 && latePlayRejected && lateResumeRejected && probeRetained && oldNonceRejected && newReplyAccepted;
    }
    bool retirementPassed = true; foreach (bool passed in retirementChecks.Values) retirementPassed &= passed;
    bool readOnlyPreservesGate = !InvalidatesPendingStarts("probe") && !InvalidatesPendingStarts("state") && !InvalidatesPendingStarts("search") && !InvalidatesPendingStarts("library") && !InvalidatesPendingStarts("queue");
    bool nativeReadyGatePassed = !CanPublishReady(false, true, 1, 1, 1, 1, false) && !CanPublishReady(true, false, 1, 1, 1, 1, false) &&
      !CanPublishReady(true, true, 1, 2, 1, 1, false) && !CanPublishReady(true, true, 2, 2, 1, 2, false) &&
      !CanPublishReady(true, true, 2, 2, 1, null, false) &&
      !CanPublishReady(true, true, 1, 1, 1, 1, true) && CanPublishReady(true, true, 2, 2, 2, 2, false);
    var permission = new TemporaryAutoplayGrant(); permission.Begin(7, 17, "fixture-nonce", 1000);
    var autoplayChecks = new Dictionary<string, bool>();
    autoplayChecks["pendingExact"] = permission.Decide(true, true, true, 7, true, true, 1001) == "allow-pending";
    autoplayChecks["wrongOrigin"] = permission.Decide(true, true, false, 7, true, true, 1001) == "deny-origin";
    autoplayChecks["wrongCore"] = permission.Decide(true, false, true, 7, true, true, 1001) == "deny-core";
    autoplayChecks["wrongNonce"] = permission.Decide(true, true, true, 7, true, false, 1001) == "deny-nonce";
    autoplayChecks["expired"] = permission.Decide(true, true, true, 7, true, true, 22000) == "deny-expired";
    autoplayChecks["otherKind"] = permission.Decide(false, true, true, 7, true, true, 1001) == "deny-kind";
    autoplayChecks["navigation"] = permission.Decide(true, true, true, 8, true, true, 1001) == "deny-navigation";
    autoplayChecks["notReady"] = permission.Decide(true, true, true, 7, false, true, 1001) == "deny-navigation";
    permission.Confirm(7, "wrong-nonce", 1002, true);
    autoplayChecks["wrongConfirm"] = !permission.Authorized;
    permission.Confirm(7, "fixture-nonce", 1002, true);
    autoplayChecks["naturalContinuation"] = permission.Decide(true, true, true, 7, true, false, 999999) == "allow-session";
    autoplayChecks["logicalControlPreserves"] = TemporaryAutoplayGrant.PreserveOnLogicalCancel(true, false, permission.Authorized, true);
    autoplayChecks["pendingCannotPreserve"] = !TemporaryAutoplayGrant.PreserveOnLogicalCancel(true, true, true, true);
    autoplayChecks["realCancelCannotPreserve"] = !TemporaryAutoplayGrant.PreserveOnLogicalCancel(false, false, true, true);
    permission.Revoke();
    autoplayChecks["stoppedRevoked"] = permission.Decide(true, true, true, 7, true, false, 1003) == "deny-revoked";
    var writes = new List<string>(); bool saves = true;
    string applied = TemporaryAutoplayGrant.ApplyTemporary("allow-pending", value => {saves = value; writes.Add("temporary");}, () => saves,
      allow => {writes.Add(allow ? "allow" : "deny");});
    autoplayChecks["temporaryBeforeAllow"] = applied == "allow-pending" && !saves && writes.Count == 2 && writes[0] == "temporary" && writes[1] == "allow";
    bool stateCalled = false;
    applied = TemporaryAutoplayGrant.ApplyTemporary("allow-pending", value => {throw new NotSupportedException();}, () => true, allow => {stateCalled = true;});
    autoplayChecks["unsupportedTemporaryNoGrant"] = applied == "temporary-policy-unavailable" && !stateCalled;
    applied = TemporaryAutoplayGrant.ApplyTemporary("allow-pending", value => {}, () => true, allow => {stateCalled = true;});
    autoplayChecks["temporaryReadbackNoGrant"] = applied == "temporary-policy-unavailable" && !stateCalled;
    bool allowedAfterRevocation = true;
    applied = TemporaryAutoplayGrant.ApplyTemporary("allow-pending", value => {}, () => false, allow => {allowedAfterRevocation = allow;}, () => false);
    autoplayChecks["revokedBeforeAllow"] = applied == "deny-revoked" && !allowedAfterRevocation;
    autoplayChecks["exactOriginGuard"] = OfficialOrigin("https://music.apple.com/cn/") && !OfficialOrigin("https://music.apple.com.evil.invalid/") && !OfficialOrigin("http://music.apple.com/");
    bool autoplayPolicyPassed = true; foreach (bool passed in autoplayChecks.Values) autoplayPolicyPassed &= passed;
    var rpcLifetimeChecks = PageRpcLifetimeChecks();
    bool rpcLifetimePassed = true; foreach (bool passed in rpcLifetimeChecks.Values) rpcLifetimePassed &= passed;
    Console.WriteLine(serializer.Serialize(new {type = "protocol-self-test", fixtureOnly = true, rpcSeparated = separated,
      oldItemRemainsMuted = oldMuted, selectedPlayingItemCanUnmute = selectedAllowed, nonPlayingItemRemainsMuted = pausedMuted,
      staleStartRetirement = retirementChecks, staleStartRetirementPassed = retirementPassed, readOnlyPreservesGate = readOnlyPreservesGate, nativeReadyGatePassed = nativeReadyGatePassed,
      autoplayPolicyPassed = autoplayPolicyPassed, autoplayPolicyChecks = autoplayChecks, rpcLifetimePassed = rpcLifetimePassed, rpcLifetimeChecks = rpcLifetimeChecks}));
    return separated && oldMuted && selectedAllowed && pausedMuted && retirementPassed && readOnlyPreservesGate && nativeReadyGatePassed && autoplayPolicyPassed && rpcLifetimePassed ? 0 : 1;
  }
  [STAThread] static int Main(string[] args) {
    Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
    if (args.Length == 1 && args[0] == "--protocol-self-test") return ProtocolSelfTest();
    if (args.Length < 2 || !Path.IsPathRooted(args[0]) || !Path.IsPathRooted(args[1])) return 2;
    try {Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new StillAppleHost(args[0], args[1], args.Length > 2 && args[2] == "--show")); return 0;}
    catch {Console.WriteLine("{\"type\":\"error\",\"code\":\"host-initialization-failed\"}"); return 1;}
  }
}
