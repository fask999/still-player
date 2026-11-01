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
  public long Epoch = -1, ExpiresAt;
  public int RpcId;
  public string Nonce;
  public bool Authorized, Revoked = true;
  public void Begin(long epoch, int rpcId, string nonce, long now) {Epoch = epoch; RpcId = rpcId; Nonce = nonce; ExpiresAt = now + 20000; Authorized = false; Revoked = false;}
  public void Revoke() {Nonce = null; RpcId = 0; Authorized = false; Revoked = true;}
  public void Confirm(long epoch, string nonce, long now, bool selectedPlaying) {
    if (!Revoked && epoch == Epoch && nonce == Nonce && now <= ExpiresAt && selectedPlaying) Authorized = true;
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
    if (now > ExpiresAt) return "deny-expired";
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

class StillAppleHost : Form {
  readonly WebView2 view = new WebView2();
  readonly Label notice = new Label();
  readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 2097152, RecursionLimit = 30 };
  readonly string profile, bridgeSource;
  readonly bool initiallyVisible;
  readonly Dictionary<int, string> pending = new Dictionary<int, string>();
  readonly Dictionary<int, string> pendingMethods = new Dictionary<int, string>();
  readonly Dictionary<int, string> pendingItemIds = new Dictionary<int, string>();
  readonly HashSet<string> allowed = new HashSet<string> { "probe", "state", "search", "library", "queue", "play", "pause", "resume", "stop", "seek", "volume", "next", "previous", "cancel", "show", "hide", "close" };
  bool ready, shuttingDown;
  long navigationEpoch;
  ulong currentNavigationId;
  readonly TemporaryAutoplayGrant autoplay = new TemporaryAutoplayGrant();
  readonly Stopwatch autoplayClock = Stopwatch.StartNew();
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
      string nonce, method;
      bool pendingMatches = pending.TryGetValue(autoplay.RpcId, out nonce) && nonce == autoplay.Nonce &&
        pendingMethods.TryGetValue(autoplay.RpcId, out method) && (method == "play" || method == "resume");
      bool origin = sameCore && OfficialOrigin(args.Uri) && OfficialOrigin(view.CoreWebView2.Source);
      string decision = autoplay.Decide(isAutoplay, sameCore, origin, navigationEpoch, ready && !shuttingDown, pendingMatches, autoplayClock.ElapsedMilliseconds);
      autoplayDecision = decision;
      // Unrelated permissions retain normal browser behavior; this policy
      // never grants them or writes their state into a profile.
      if (!isAutoplay || !sameCore) {PublishAutoplayPolicy(); return;}
      autoplayDecision = TemporaryAutoplayGrant.ApplyTemporary(decision, value => args.SavesInProfile = value,
        () => args.SavesInProfile, allow => args.State = allow ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny,
        () => {
          if (requestEpoch != navigationEpoch || requestNonce != autoplay.Nonce || shuttingDown || view.IsDisposed || !Object.ReferenceEquals(sender, view.CoreWebView2)) return false;
          string currentNonce, currentMethod;
          bool currentPending = pending.TryGetValue(autoplay.RpcId, out currentNonce) && currentNonce == autoplay.Nonce && pendingMethods.TryGetValue(autoplay.RpcId, out currentMethod) && (currentMethod == "play" || currentMethod == "resume");
          string current = autoplay.Decide(true, true, OfficialOrigin(args.Uri) && OfficialOrigin(view.CoreWebView2.Source), navigationEpoch, ready, currentPending, autoplayClock.ElapsedMilliseconds);
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
    FormClosed += (sender, args) => view.Dispose();
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
        if (!OfficialOrigin(e.Uri)) {e.Cancel = true; return;}
        currentNavigationId = e.NavigationId; navigationEpoch++; ready = false;
        RevokeAutoplay();
        Output(new {type = "phase", phase = "loading"});
        RetirePendingStarts(); view.CoreWebView2.IsMuted = true;
      };
      view.CoreWebView2.NewWindowRequested += OpenAppleAuth;
      view.CoreWebView2.WebMessageReceived += MessageReceived;
      view.CoreWebView2.NavigationCompleted += NavigationCompleted;
      view.CoreWebView2.ProcessFailed += (s, e) => {ready = false; navigationEpoch++; RevokeAutoplay(); RetirePendingStarts(); Output(new {type = "error", code = "official-process-failed"});};
      view.CoreWebView2.Navigate("https://music.apple.com/cn/new");
      ReadCommands();
    } catch {Output(new {type = "error", code = "host-initialization-failed"}); shuttingDown = true; Close();}
  }
  async void NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs args) {
    if (args.NavigationId != currentNavigationId || shuttingDown) return;
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
    return !shuttingDown && !IsDisposed && !view.IsDisposed && epoch == navigationEpoch && navigationId == currentNavigationId &&
      view.CoreWebView2 != null && OfficialOrigin(view.CoreWebView2.Source);
  }
  static bool CanPublishReady(bool sdkReady, bool installed, long expectedEpoch, long actualEpoch, ulong completedId, ulong latestId, bool closing) {
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
          string captured = line;
          BeginInvoke(new Action(() => ProcessCommand(captured)));
        }
      } catch { }
      if (!shuttingDown && !IsDisposed) BeginInvoke(new Action(() => {shuttingDown = true; Close();}));
    });
  }
  void RetirePendingStarts() {
    // A response can already be queued in WebMessageReceived when a newer
    // pause/stop/cancel arrives. Retire its nonce before dispatching that newer
    // intent so the late old response cannot reopen the native audio gate.
    var retired = RetireStartRequests(pending, pendingMethods, pendingItemIds);
    if (retired.Count > 0 && view.CoreWebView2 != null) view.CoreWebView2.IsMuted = true;
    foreach (int requestId in retired) Reply(requestId, false, null, "cancelled");
  }
  static bool InvalidatesPendingStarts(string method) {
    return method == "play" || method == "resume" || method == "pause" || method == "stop" || method == "cancel" || method == "close";
  }
  static List<int> RetireStartRequests(Dictionary<int, string> requests, Dictionary<int, string> methods, Dictionary<int, string> items) {
    var retired = new List<int>();
    foreach (var entry in methods) if (entry.Value == "play" || entry.Value == "resume") retired.Add(entry.Key);
    foreach (int requestId in retired) {requests.Remove(requestId); methods.Remove(requestId); items.Remove(requestId);}
    return retired;
  }
  static bool TakePendingReply(int requestId, string responseNonce, Dictionary<int, string> requests,
      Dictionary<int, string> methods, Dictionary<int, string> items, out string method, out string itemId) {
    method = null; itemId = null; string expectedNonce;
    if (!requests.TryGetValue(requestId, out expectedNonce) || expectedNonce != responseNonce ||
        !methods.TryGetValue(requestId, out method) || !items.TryGetValue(requestId, out itemId)) return false;
    requests.Remove(requestId); methods.Remove(requestId); items.Remove(requestId); return true;
  }
  async void ProcessCommand(string line) {
    int id = 0; string method = null;
    try {
      var command = json.DeserializeObject(line) as Dictionary<string, object>;
      if (command == null || !command.ContainsKey("rpcId") || !command.ContainsKey("method")) throw new Exception();
      id = Convert.ToInt32(command["rpcId"]); method = command["method"] as string;
      if (id <= 0 || method == null || !allowed.Contains(method)) throw new Exception();
      bool hadPendingStart = pendingMethods.ContainsValue("play") || pendingMethods.ContainsValue("resume");
      bool preservePermission = method == "cancel" && command.ContainsKey("preservePlaybackPermission") && command["preservePlaybackPermission"] is bool && (bool)command["preservePlaybackPermission"] &&
        TemporaryAutoplayGrant.PreserveOnLogicalCancel(true, hadPendingStart, autoplay.Authorized, autoplay.Epoch == navigationEpoch);
      if ((method == "pause" || method == "stop" || method == "close" || method == "play" || method == "resume" || method == "cancel") && !preservePermission) RevokeAutoplay();
      if (InvalidatesPendingStarts(method)) RetirePendingStarts();
      if (method == "close") {
        navigationEpoch++; ready = false;
        var exited = new TaskCompletionSource<bool>();
        if (environment != null) environment.BrowserProcessExited += (s, e) => exited.TrySetResult(true);
        if (view.CoreWebView2 != null) view.CoreWebView2.IsMuted = true;
        var children = new List<Form>(); foreach (Form form in Application.OpenForms) if (form != this) children.Add(form);
        foreach (Form form in children) form.Close();
        view.Dispose(); ready = false;
        bool browserExited = await Task.WhenAny(exited.Task, Task.Delay(5000)) == exited.Task;
        Reply(id, true, new {closed = true, browserProcessExited = browserExited}, null);
        shuttingDown = true; Close(); return;
      }
      if (method == "show") {ShowInTaskbar = true; Opacity = 1; Show(); if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal; Activate(); Reply(id, true, new {shown = true}, null); return;}
      if (method == "hide") {Hide(); ShowInTaskbar = false; Reply(id, true, new {hidden = true}, null); return;}
      if (!ready) {Reply(id, false, null, "official-player-not-ready", "native-ready-guard"); return;}
      if (!OfficialOrigin(view.CoreWebView2.Source)) {Reply(id, false, null, "official-player-not-ready", "native-origin-guard"); return;}
      if (pending.Count >= 64) {Reply(id, false, null, "host-busy"); return;}
      if (method == "cancel" || method == "stop") {
        if (method == "stop" || pendingMethods.ContainsValue("play") || pendingMethods.ContainsValue("resume")) view.CoreWebView2.IsMuted = true;
      }
      string itemId = command.ContainsKey("id") ? command["id"] as string : null;
      if (method == "play" && (itemId == null || !Regex.IsMatch(itemId, "^[A-Za-z0-9._-]{1,200}$"))) {Reply(id, false, null, "invalid-item"); return;}
      // Keep the old item inaudible while a new item is validated/prepared.
      // Only the matching, playing result below may open this audio gate.
      if (method == "play" || method == "resume") view.CoreWebView2.IsMuted = true;
      string nonce = Guid.NewGuid().ToString("N"); pending[id] = nonce; pendingMethods[id] = method;
      pendingItemIds[id] = itemId;
      if (method == "play" || method == "resume") {autoplay.Begin(navigationEpoch, id, nonce, autoplayClock.ElapsedMilliseconds); autoplaySeen = false; autoplayDecision = autoplayConfigured ? "awaiting-request" : "handler-unavailable"; PublishAutoplayPolicy();}
      string payload = json.Serialize(command);
      string script = "Promise.resolve(window.__STILL_OFFICIAL_PUBLIC_BRIDGE__(" + payload + ")).then(result => window.chrome.webview.postMessage({kind:'still-public-rpc',rpcId:" + id + ",nonce:" + json.Serialize(nonce) + ",result})).catch(() => window.chrome.webview.postMessage({kind:'still-public-rpc',rpcId:" + id + ",nonce:" + json.Serialize(nonce) + ",result:{ok:false,code:'official-operation-failed'}}));";
      await view.CoreWebView2.ExecuteScriptAsync(script);
    } catch {if (id > 0) {pending.Remove(id); pendingMethods.Remove(id); pendingItemIds.Remove(id); Reply(id, false, null, "invalid-host-command");}}
  }
  void MessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs args) {
    if (!OfficialOrigin(args.Source) || !OfficialOrigin(view.CoreWebView2.Source)) return;
    try {
      var message = json.DeserializeObject(args.WebMessageAsJson) as Dictionary<string, object>;
      if (message == null || !message.ContainsKey("kind") || (string)message["kind"] != "still-public-rpc") return;
      int id = Convert.ToInt32(message["rpcId"]); string method, itemId;
      if (!message.ContainsKey("nonce") || !TakePendingReply(id, message["nonce"] as string, pending, pendingMethods, pendingItemIds, out method, out itemId)) return;
      var result = message["result"] as Dictionary<string, object>;
      if (result == null || !result.ContainsKey("ok")) {Reply(id, false, null, "official-invalid-response"); return;}
      bool ok = result["ok"] is bool && (bool)result["ok"];
      if (!ok && (method == "play" || method == "resume")) view.CoreWebView2.IsMuted = true;
      object value = result.ContainsKey("value") ? result["value"] : null;
      var record = value as Dictionary<string, object>;
      if (ok && (method == "play" || method == "resume")) view.CoreWebView2.IsMuted = !CanUnmute(method, itemId, record);
      if (method == "play" || method == "resume") {
        if (ok && CanUnmute(method, itemId, record)) autoplay.Confirm(navigationEpoch, message["nonce"] as string, autoplayClock.ElapsedMilliseconds, true);
        else RevokeAutoplay();
      }
      if (record != null) record["outputMuted"] = view.CoreWebView2.IsMuted;
      string code = result.ContainsKey("code") ? result["code"] as string : null;
      string origin = code == "official-player-not-ready" && result.ContainsKey("origin") && result["origin"] as string == "bridge-instance" ? "bridge-instance" : null;
      Reply(id, ok, value, code, origin);
    } catch {Output(new {type = "error", code = "official-invalid-response"});}
  }
  static bool CanUnmute(string method, string requestedId, Dictionary<string, object> value) {
    if (value == null || !value.ContainsKey("isPlaying") || !(value["isPlaying"] is bool) || !(bool)value["isPlaying"]) return false;
    string currentId = value.ContainsKey("currentTrackId") ? value["currentTrackId"] as string : null;
    if (currentId == null || !Regex.IsMatch(currentId, "^[A-Za-z0-9._-]{1,200}$")) return false;
    return method == "play" ? requestedId != null && currentId == requestedId : method == "resume";
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
      var requests = new Dictionary<int, string> {{1, "old-play"}, {2, "old-resume"}, {3, "probe"}};
      var methods = new Dictionary<int, string> {{1, "play"}, {2, "resume"}, {3, "probe"}};
      var items = new Dictionary<int, string> {{1, "fixture-A"}, {2, "fixture-A"}, {3, null}};
      var retired = InvalidatesPendingStarts(intent) ? RetireStartRequests(requests, methods, items) : new List<int>();
      string replyMethod, replyItem;
      bool latePlayRejected = !TakePendingReply(1, "old-play", requests, methods, items, out replyMethod, out replyItem);
      bool lateResumeRejected = !TakePendingReply(2, "old-resume", requests, methods, items, out replyMethod, out replyItem);
      bool probeRetained = TakePendingReply(3, "probe", requests, methods, items, out replyMethod, out replyItem) && replyMethod == "probe";
      requests[1] = "new-play"; methods[1] = "play"; items[1] = "fixture-B";
      bool oldNonceRejected = !TakePendingReply(1, "old-play", requests, methods, items, out replyMethod, out replyItem);
      bool newReplyAccepted = TakePendingReply(1, "new-play", requests, methods, items, out replyMethod, out replyItem) && CanUnmute(replyMethod, replyItem, selected);
      retirementChecks[intent] = retired.Count == 2 && latePlayRejected && lateResumeRejected && probeRetained && oldNonceRejected && newReplyAccepted;
    }
    bool retirementPassed = true; foreach (bool passed in retirementChecks.Values) retirementPassed &= passed;
    bool readOnlyPreservesGate = !InvalidatesPendingStarts("probe") && !InvalidatesPendingStarts("state") && !InvalidatesPendingStarts("search") && !InvalidatesPendingStarts("library") && !InvalidatesPendingStarts("queue");
    bool nativeReadyGatePassed = !CanPublishReady(false, true, 1, 1, 1, 1, false) && !CanPublishReady(true, false, 1, 1, 1, 1, false) &&
      !CanPublishReady(true, true, 1, 2, 1, 1, false) && !CanPublishReady(true, true, 2, 2, 1, 2, false) &&
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
    Console.WriteLine(serializer.Serialize(new {type = "protocol-self-test", fixtureOnly = true, rpcSeparated = separated,
      oldItemRemainsMuted = oldMuted, selectedPlayingItemCanUnmute = selectedAllowed, nonPlayingItemRemainsMuted = pausedMuted,
      staleStartRetirement = retirementChecks, staleStartRetirementPassed = retirementPassed, readOnlyPreservesGate = readOnlyPreservesGate, nativeReadyGatePassed = nativeReadyGatePassed,
      autoplayPolicyPassed = autoplayPolicyPassed, autoplayPolicyChecks = autoplayChecks}));
    return separated && oldMuted && selectedAllowed && pausedMuted && retirementPassed && readOnlyPreservesGate && nativeReadyGatePassed && autoplayPolicyPassed ? 0 : 1;
  }
  [STAThread] static int Main(string[] args) {
    Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
    if (args.Length == 1 && args[0] == "--protocol-self-test") return ProtocolSelfTest();
    if (args.Length < 2 || !Path.IsPathRooted(args[0]) || !Path.IsPathRooted(args[1])) return 2;
    try {Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new StillAppleHost(args[0], args[1], args.Length > 2 && args[2] == "--show")); return 0;}
    catch {Console.WriteLine("{\"type\":\"error\",\"code\":\"host-initialization-failed\"}"); return 1;}
  }
}
