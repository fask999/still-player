// STILL original component. See the scope statement in LICENSE.txt.
// A byte-bounded stdio adapter. It owns no decoder, player, URL or global key hook.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Windows.Foundation;
using Windows.Media;
using Windows.Storage.Streams;

[assembly: AssemblyTitle("STILL")]
[assembly: AssemblyProduct("STILL")]
[assembly: AssemblyDescription("STILL Windows system media controls bridge")]
[assembly: AssemblyCopyright("Copyright (c) 2026 STILL contributors")]
[assembly: AssemblyVersion("1.0.0.0")]

namespace Still.DesktopMedia {
    internal sealed class ProtocolException : Exception { }

    // Unlike permissive platform serializers, this rejects duplicate keys,
    // unpaired surrogates, arrays, excessive nesting/nodes and non-JSON numbers.
    internal sealed class Json {
        private readonly string text; private int at; private int nodes;
        private Json(string input) { text = input; }
        internal static Dictionary<string, object> Parse(string input) {
            Json parser = new Json(input); object result = parser.Value(0); parser.White();
            if (parser.at != input.Length || !(result is Dictionary<string, object>)) throw new ProtocolException();
            return (Dictionary<string, object>)result;
        }
        private void White() { while (at < text.Length && (text[at] == ' ' || text[at] == '\t' || text[at] == '\r' || text[at] == '\n')) at++; }
        private object Value(int depth) {
            if (++nodes > 100 || depth > 7) throw new ProtocolException(); White();
            if (at >= text.Length) throw new ProtocolException();
            char c = text[at];
            if (c == '"') return String();
            if (c == '{') {
                at++; White(); Dictionary<string, object> map = new Dictionary<string, object>(StringComparer.Ordinal);
                if (at < text.Length && text[at] == '}') { at++; return map; }
                while (true) {
                    White(); if (at >= text.Length || text[at] != '"') throw new ProtocolException(); string key = String();
                    White(); if (at >= text.Length || text[at++] != ':' || map.ContainsKey(key)) throw new ProtocolException();
                    map.Add(key, Value(depth + 1)); White(); if (at >= text.Length) throw new ProtocolException();
                    char end = text[at++]; if (end == '}') return map; if (end != ',') throw new ProtocolException();
                }
            }
            if (Take("true")) return true; if (Take("false")) return false; if (Take("null")) return null;
            int begin = at;
            if (text[at] == '-') at++;
            if (at >= text.Length) throw new ProtocolException();
            if (text[at] == '0') at++;
            else { if (text[at] < '1' || text[at] > '9') throw new ProtocolException(); while (at < text.Length && Digit(text[at])) at++; }
            if (at < text.Length && text[at] == '.') { at++; int fraction = at; while (at < text.Length && Digit(text[at])) at++; if (at == fraction) throw new ProtocolException(); }
            if (at < text.Length && (text[at] == 'e' || text[at] == 'E')) {
                at++; if (at < text.Length && (text[at] == '+' || text[at] == '-')) at++;
                int exponent = at; while (at < text.Length && Digit(text[at])) at++; if (at == exponent) throw new ProtocolException();
            }
            double number; if (!Double.TryParse(text.Substring(begin, at - begin), NumberStyles.Float, CultureInfo.InvariantCulture, out number) || Double.IsInfinity(number) || Double.IsNaN(number)) throw new ProtocolException();
            return number;
        }
        private bool Take(string token) { if (at + token.Length > text.Length || System.String.CompareOrdinal(text, at, token, 0, token.Length) != 0) return false; at += token.Length; return true; }
        private static bool Digit(char c) { return c >= '0' && c <= '9'; }
        private string String() {
            at++; StringBuilder value = new StringBuilder(); bool closed = false;
            while (at < text.Length) {
                char c = text[at++]; if (c == '"') { closed = true; break; } if (c < 0x20) throw new ProtocolException();
                if (c == '\\') {
                    if (at >= text.Length) throw new ProtocolException(); c = text[at++];
                    switch (c) {
                        case '"': case '\\': case '/': break;
                        case 'b': c = '\b'; break; case 'f': c = '\f'; break; case 'n': c = '\n'; break; case 'r': c = '\r'; break; case 't': c = '\t'; break;
                        case 'u':
                            if (at + 4 > text.Length) throw new ProtocolException(); int code;
                            if (!Int32.TryParse(text.Substring(at, 4), NumberStyles.AllowHexSpecifier, CultureInfo.InvariantCulture, out code)) throw new ProtocolException();
                            at += 4; c = (char)code; break;
                        default: throw new ProtocolException();
                    }
                }
                value.Append(c);
            }
            if (!closed) throw new ProtocolException(); string result = value.ToString();
            for (int i = 0; i < result.Length; i++) {
                if (Char.IsHighSurrogate(result[i])) { if (++i >= result.Length || !Char.IsLowSurrogate(result[i])) throw new ProtocolException(); }
                else if (Char.IsLowSurrogate(result[i])) throw new ProtocolException();
            }
            return result;
        }
        internal static string Quote(string value) {
            StringBuilder output = new StringBuilder("\"");
            foreach (char c in value) {
                if (c == '"' || c == '\\') output.Append('\\').Append(c);
                else if (c < 0x20) output.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                else output.Append(c);
            }
            return output.Append('"').ToString();
        }
    }

    internal static class Schema {
        internal const int MaxLineBytes = 720000, MaxArtworkBytes = 524288;
        internal static void Keys(Dictionary<string, object> map, string required, string optional) {
            HashSet<string> allowed = new HashSet<string>((required + "," + optional).Split(','), StringComparer.Ordinal);
            foreach (string key in required.Split(',')) if (key.Length > 0 && !map.ContainsKey(key)) throw new ProtocolException();
            foreach (string key in map.Keys) if (!allowed.Contains(key)) throw new ProtocolException();
        }
        internal static Dictionary<string, object> Object(object value) { Dictionary<string, object> map = value as Dictionary<string, object>; if (map == null) throw new ProtocolException(); return map; }
        internal static string Text(object value, int max, bool token) {
            string result = value as string; if (result == null || result.Length > max || (token && result.Length == 0)) throw new ProtocolException();
            foreach (char c in result) if ((c < 0x20 && c != '\t' && c != '\n') || (token && !(Char.IsLetterOrDigit(c) && c < 128) && c != '-' && c != '_' && c != '.')) throw new ProtocolException();
            return result;
        }
        internal static double Number(object value, double max, bool integer) {
            if (!(value is double)) throw new ProtocolException(); double result = (double)value;
            if (result < 0 || result > max || (integer && result != Math.Truncate(result))) throw new ProtocolException(); return result;
        }
        internal static bool Boolean(object value) { if (!(value is bool)) throw new ProtocolException(); return (bool)value; }
        internal static bool IsHexToken(string value) { if (value.Length != 32) return false; foreach (char c in value) if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false; return true; }
        internal static byte[] Artwork(Dictionary<string, object> art) {
            Keys(art, "mimeType,dataBase64", ""); string mime = Text(art["mimeType"], 32, false), encoded = Text(art["dataBase64"], 699052, false);
            if (mime != "image/png" && mime != "image/jpeg") throw new ProtocolException();
            byte[] bytes; try { bytes = Convert.FromBase64String(encoded); } catch { throw new ProtocolException(); }
            if (bytes.Length == 0 || bytes.Length > MaxArtworkBytes || Convert.ToBase64String(bytes) != encoded) throw new ProtocolException();
            bool png = bytes.Length >= 24 && bytes[0] == 137 && bytes[1] == 80 && bytes[2] == 78 && bytes[3] == 71 && bytes[4] == 13 && bytes[5] == 10 && bytes[6] == 26 && bytes[7] == 10 && bytes[12] == 73 && bytes[13] == 72 && bytes[14] == 68 && bytes[15] == 82;
            bool jpeg = bytes.Length >= 4 && bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255 && bytes[bytes.Length - 2] == 255 && bytes[bytes.Length - 1] == 217;
            if ((mime == "image/png" && !png) || (mime == "image/jpeg" && !jpeg)) throw new ProtocolException();
            // The shell decodes the image; limit dimensions too, to bound decoded
            // memory. Parse headers only, without loading an image decoder here.
            int width = 0, height = 0;
            if (png) { width = Big32(bytes, 16); height = Big32(bytes, 20); }
            else {
                int i = 2;
                while (i + 3 < bytes.Length) {
                    if (bytes[i++] != 255) throw new ProtocolException(); while (i < bytes.Length && bytes[i] == 255) i++;
                    if (i >= bytes.Length) throw new ProtocolException(); int marker = bytes[i++];
                    if (marker == 217 || marker == 218) break;
                    if (marker == 1 || (marker >= 208 && marker <= 215)) continue;
                    if (i + 1 >= bytes.Length) throw new ProtocolException(); int length = (bytes[i] << 8) | bytes[i + 1];
                    if (length < 2 || i + length > bytes.Length) throw new ProtocolException();
                    if ((marker >= 192 && marker <= 195) || (marker >= 197 && marker <= 199) || (marker >= 201 && marker <= 203) || (marker >= 205 && marker <= 207)) {
                        if (length < 8) throw new ProtocolException(); height = (bytes[i + 3] << 8) | bytes[i + 4]; width = (bytes[i + 5] << 8) | bytes[i + 6]; break;
                    }
                    i += length;
                }
            }
            if (width < 1 || height < 1 || width > 4096 || height > 4096 || (long)width * height > 16777216) throw new ProtocolException();
            return bytes;
        }
        private static int Big32(byte[] bytes, int i) { uint value = ((uint)bytes[i] << 24) | ((uint)bytes[i + 1] << 16) | ((uint)bytes[i + 2] << 8) | bytes[i + 3]; return value > Int32.MaxValue ? -1 : (int)value; }
    }

    internal sealed class Snapshot {
        internal string Session, Source, State, Title, Artist, Album; internal long Sequence; internal double Position, Duration;
        internal readonly Dictionary<string, bool> Capabilities = new Dictionary<string, bool>(StringComparer.Ordinal); internal byte[] Artwork;
        internal static Snapshot Parse(Dictionary<string, object> map) {
            Schema.Keys(map, "schemaVersion,sessionId,sequence,source,state,metadata,position,duration,capabilities", "");
            if (Schema.Number(map["schemaVersion"], 1, true) != 1) throw new ProtocolException();
            Snapshot result = new Snapshot(); result.Session = Schema.Text(map["sessionId"], 128, true); result.Sequence = (long)Schema.Number(map["sequence"], 9007199254740991, true);
            result.Source = map["source"] == null ? null : Schema.Text(map["source"], 5, true);
            if (result.Source != null && result.Source != "local" && result.Source != "apple") throw new ProtocolException();
            result.State = Schema.Text(map["state"], 11, true);
            if (result.State != "playing" && result.State != "paused" && result.State != "stopped" && result.State != "unavailable") throw new ProtocolException();
            if ((result.State == "playing" || result.State == "paused") && result.Source == null) throw new ProtocolException();
            result.Position = Schema.Number(map["position"], 31536000, false); result.Duration = Schema.Number(map["duration"], 31536000, false);
            if (result.Position > result.Duration) throw new ProtocolException();
            Dictionary<string, object> metadata = Schema.Object(map["metadata"]); Schema.Keys(metadata, "title,artist,album", "artwork");
            result.Title = Schema.Text(metadata["title"], 1024, false); result.Artist = Schema.Text(metadata["artist"], 1024, false); result.Album = Schema.Text(metadata["album"], 1024, false);
            if (metadata.ContainsKey("artwork") && metadata["artwork"] != null) result.Artwork = Schema.Artwork(Schema.Object(metadata["artwork"]));
            Dictionary<string, object> caps = Schema.Object(map["capabilities"]); Schema.Keys(caps, "play,pause,stop,next,previous,seek", "");
            foreach (KeyValuePair<string, object> cap in caps) { bool enabled = Schema.Boolean(cap.Value); if (enabled && (result.Source == null || result.State == "unavailable")) throw new ProtocolException(); result.Capabilities.Add(cap.Key, enabled); }
            if (result.Capabilities["seek"] && result.Duration <= 0) throw new ProtocolException();
            return result;
        }
        internal bool Allows(string action, double? position) {
            bool enabled; return Capabilities.TryGetValue(action, out enabled) && enabled && (action != "seek" || (position.HasValue && position.Value >= 0 && position.Value <= Duration && !Double.IsNaN(position.Value) && !Double.IsInfinity(position.Value)));
        }
    }

    [ComImport, Guid("ddb0472d-c911-4a1f-86d9-dc3d71a95f5a"), InterfaceType(ComInterfaceType.InterfaceIsIInspectable)]
    internal interface ISystemMediaTransportControlsInterop {
        IntPtr GetForWindow(IntPtr window, ref Guid iid);
    }

    internal sealed class HiddenWindow : Form {
        internal HiddenWindow() { Text = "STILL"; ShowInTaskbar = false; FormBorderStyle = FormBorderStyle.FixedToolWindow; Width = 1; Height = 1; }
        protected override void SetVisibleCore(bool value) { base.SetVisibleCore(false); }
    }

    internal sealed class NativeSession : IDisposable {
        private SystemMediaTransportControls controls; private IRandomAccessStream artStream; private MemoryStream artBytes;
        private readonly Action<string, double?> command;
        internal NativeSession(IntPtr window, Action<string, double?> onCommand) {
            command = onCommand; uint owner; GetWindowThreadProcessId(window, out owner);
            if (owner != (uint)Process.GetCurrentProcess().Id || GetAncestor(window, 2) != window) throw new ProtocolException();
            ISystemMediaTransportControlsInterop factory = (ISystemMediaTransportControlsInterop)WindowsRuntimeMarshal.GetActivationFactory(typeof(SystemMediaTransportControls));
            Guid iid = new Guid("99fa3ff4-1742-42a6-902e-087d41f965ec"); IntPtr pointer = factory.GetForWindow(window, ref iid);
            try { controls = (SystemMediaTransportControls)Marshal.GetObjectForIUnknown(pointer); } finally { if (pointer != IntPtr.Zero) Marshal.Release(pointer); }
            controls.IsEnabled = false;
            controls.ButtonPressed += Button; controls.PlaybackPositionChangeRequested += Seek;
            controls.IsFastForwardEnabled = controls.IsRewindEnabled = controls.IsRecordEnabled = controls.IsChannelUpEnabled = controls.IsChannelDownEnabled = false;
        }
        private void Button(SystemMediaTransportControls sender, SystemMediaTransportControlsButtonPressedEventArgs args) {
            string action = null;
            switch (args.Button) {
                case SystemMediaTransportControlsButton.Play: action = "play"; break; case SystemMediaTransportControlsButton.Pause: action = "pause"; break;
                case SystemMediaTransportControlsButton.Stop: action = "stop"; break; case SystemMediaTransportControlsButton.Next: action = "next"; break;
                case SystemMediaTransportControlsButton.Previous: action = "previous"; break;
            }
            if (action != null) command(action, null);
        }
        private void Seek(SystemMediaTransportControls sender, PlaybackPositionChangeRequestedEventArgs args) { command("seek", args.RequestedPlaybackPosition.TotalSeconds); }
        internal void Apply(Snapshot snapshot) {
            controls.IsPlayEnabled = snapshot.Capabilities["play"]; controls.IsPauseEnabled = snapshot.Capabilities["pause"]; controls.IsStopEnabled = snapshot.Capabilities["stop"];
            controls.IsNextEnabled = snapshot.Capabilities["next"]; controls.IsPreviousEnabled = snapshot.Capabilities["previous"];
            SystemMediaTransportControlsDisplayUpdater updater = controls.DisplayUpdater; updater.ClearAll(); updater.Type = MediaPlaybackType.Music;
            updater.MusicProperties.Title = snapshot.Title; updater.MusicProperties.Artist = snapshot.Artist; updater.MusicProperties.AlbumTitle = snapshot.Album;
            IRandomAccessStream oldStream = artStream; MemoryStream oldBytes = artBytes; artStream = null; artBytes = null;
            if (snapshot.Artwork != null) {
                artBytes = new MemoryStream(snapshot.Artwork, false); artStream = artBytes.AsRandomAccessStream();
                updater.Thumbnail = RandomAccessStreamReference.CreateFromStream(artStream);
            }
            updater.Update(); if (oldStream != null) oldStream.Dispose(); if (oldBytes != null) oldBytes.Dispose();
            controls.UpdateTimelineProperties(new SystemMediaTransportControlsTimelineProperties {
                StartTime = TimeSpan.Zero, EndTime = TimeSpan.FromSeconds(snapshot.Duration), Position = TimeSpan.FromSeconds(snapshot.Position),
                MinSeekTime = snapshot.Capabilities["seek"] ? TimeSpan.Zero : TimeSpan.FromSeconds(snapshot.Position),
                MaxSeekTime = TimeSpan.FromSeconds(snapshot.Capabilities["seek"] ? snapshot.Duration : snapshot.Position)
            });
            controls.PlaybackStatus = snapshot.State == "playing" ? MediaPlaybackStatus.Playing : snapshot.State == "paused" ? MediaPlaybackStatus.Paused : snapshot.State == "stopped" ? MediaPlaybackStatus.Stopped : MediaPlaybackStatus.Closed;
            controls.IsEnabled = snapshot.Source != null && snapshot.State != "unavailable";
        }
        public void Dispose() {
            if (controls == null) return;
            try { controls.IsEnabled = false; controls.PlaybackStatus = MediaPlaybackStatus.Closed; controls.ButtonPressed -= Button; controls.PlaybackPositionChangeRequested -= Seek; controls.DisplayUpdater.ClearAll(); controls.DisplayUpdater.Update(); }
            catch { /* Process exit still destroys this process-owned SMTC object. */ }
            controls = null; if (artStream != null) artStream.Dispose(); if (artBytes != null) artBytes.Dispose(); artStream = null; artBytes = null;
        }
        [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
        [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    }

    internal sealed class Host : IDisposable {
        private readonly string generation; private readonly bool test; private readonly Process parent;
        private readonly BlockingCollection<string> output = new BlockingCollection<string>(64);
        private readonly object gate = new object(); private readonly Queue<long> commandTimes = new Queue<long>();
        private readonly Stopwatch time = Stopwatch.StartNew(); private long lastInput, stoppedAt = -1, lastId;
        private Snapshot snapshot; private NativeSession native; private HiddenWindow window; private System.Threading.Timer watchdog;
        private volatile bool stopped, ready; private int exitCode, disposalStarted;
        internal Host(string token, bool protocolTest, Process parentProcess) { generation = token; test = protocolTest; parent = parentProcess; }
        internal int Run() {
            Thread writer = new Thread(WriteOutput); writer.IsBackground = true; writer.Start();
            watchdog = new System.Threading.Timer(Watch, null, 250, 250);
            if (!test) {
                int appIdResult = SetCurrentProcessExplicitAppUserModelID("Still.Desktop.MediaControls"); if (appIdResult < 0) Marshal.ThrowExceptionForHR(appIdResult);
                window = new HiddenWindow(); IntPtr handle = window.Handle;
            }
            Thread reader = new Thread(ReadInput); reader.IsBackground = true; reader.Start();
            if (test) { while (!stopped) Thread.Sleep(20); }
            else Application.Run(window);
            Stop(exitCode);
            Dispose(); output.CompleteAdding(); writer.Join(300); return exitCode;
        }
        private void WriteOutput() {
            try { using (Stream stream = Console.OpenStandardOutput()) foreach (string message in output.GetConsumingEnumerable()) { byte[] bytes = new UTF8Encoding(false, true).GetBytes(message + "\n"); stream.Write(bytes, 0, bytes.Length); stream.Flush(); } }
            catch { Stop(2); }
        }
        private void Send(string content) {
            if (stopped) return; string message = "{\"v\":1,\"generation\":" + Json.Quote(generation) + "," + content + "}";
            try { if (Encoding.UTF8.GetByteCount(message) > 8192 || !output.TryAdd(message)) Stop(2); } catch { Stop(2); }
        }
        private void ReadInput() {
            try {
                using (Stream input = new BufferedStream(Console.OpenStandardInput(), 8192)) {
                    Queue<long> rates = new Queue<long>();
                    while (!stopped) {
                        using (MemoryStream line = new MemoryStream()) {
                            int next; while ((next = input.ReadByte()) != -1 && next != 10) { if (line.Length >= Schema.MaxLineBytes) throw new ProtocolException(); line.WriteByte((byte)next); }
                            if (next == -1) { if (line.Length != 0) throw new ProtocolException(); Stop(0); return; }
                            long now = time.ElapsedMilliseconds; while (rates.Count > 0 && now - rates.Peek() >= 1000) rates.Dequeue(); if (rates.Count >= 40) throw new ProtocolException(); rates.Enqueue(now);
                            Dictionary<string, object> message = Json.Parse(new UTF8Encoding(false, true).GetString(line.ToArray())); Interlocked.Exchange(ref lastInput, now);
                            if (test) Handle(message); else window.Invoke(new Action(delegate { Handle(message); }));
                        }
                    }
                }
            } catch { if (!stopped) { Send("\"type\":\"error\",\"code\":\"invalid-message\""); Stop(2); } }
        }
        private void Handle(Dictionary<string, object> message) {
            string type = message.ContainsKey("type") ? Schema.Text(message["type"], 12, true) : "";
            Schema.Keys(message, "v,type,id,generation" + (type == "update" ? ",snapshot" : ""), "");
            if (Schema.Number(message["v"], 1, true) != 1 || Schema.Text(message["generation"], 32, true) != generation) throw new ProtocolException();
            long id = (long)Schema.Number(message["id"], 9007199254740991, true); if (id <= lastId) throw new ProtocolException(); lastId = id;
            string idJson = ",\"id\":" + id.ToString(CultureInfo.InvariantCulture);
            if (!ready) {
                if (type != "hello") throw new ProtocolException();
                if (!test) native = new NativeSession(window.Handle, EmitCommand); ready = true;
                Send("\"type\":\"ready\"" + idJson + ",\"backend\":\"native-smtc\",\"protocolTest\":" + (test ? "true" : "false")); return;
            }
            if (type == "update") {
                Snapshot next = Snapshot.Parse(Schema.Object(message["snapshot"]));
                lock (gate) {
                    if (snapshot != null && next.Sequence <= snapshot.Sequence) throw new ProtocolException();
                    if (native != null) native.Apply(next); snapshot = next;
                }
                Send("\"type\":\"ack\"" + idJson + ",\"sessionId\":" + Json.Quote(next.Session) + ",\"sequence\":" + next.Sequence.ToString(CultureInfo.InvariantCulture));
            } else if (type == "ping") Send("\"type\":\"pong\"" + idJson);
            else if (type == "shutdown") { Send("\"type\":\"bye\"" + idJson); Stop(0); }
            else throw new ProtocolException();
        }
        private void EmitCommand(string action, double? position) {
            lock (gate) {
                if (!ready || stopped || snapshot == null || !snapshot.Allows(action, position)) return;
                long now = time.ElapsedMilliseconds; while (commandTimes.Count > 0 && now - commandTimes.Peek() >= 1000) commandTimes.Dequeue(); if (commandTimes.Count >= 20) return; commandTimes.Enqueue(now);
                Send("\"type\":\"command\",\"action\":" + Json.Quote(action) + ",\"sessionId\":" + Json.Quote(snapshot.Session) + ",\"sequence\":" + snapshot.Sequence.ToString(CultureInfo.InvariantCulture) + (action == "seek" ? ",\"position\":" + position.Value.ToString("R", CultureInfo.InvariantCulture) : ""));
            }
        }
        private void Watch(object unused) {
            try {
                if (stopped) { if (stoppedAt >= 0 && time.ElapsedMilliseconds - stoppedAt > 2000) Environment.Exit(exitCode); return; }
                if (parent.HasExited || time.ElapsedMilliseconds - Interlocked.Read(ref lastInput) > (ready ? 15000 : 5000)) Stop(2);
            } catch { Stop(2); }
        }
        private void Stop(int code) {
            lock (gate) { if (stopped) return; stoppedAt = time.ElapsedMilliseconds; exitCode = code; stopped = true; }
            if (window != null) { try { window.BeginInvoke(new Action(delegate { if (native != null) native.Dispose(); window.Close(); })); } catch { } }
        }
        public void Dispose() { if (Interlocked.Exchange(ref disposalStarted, 1) != 0) return; if (watchdog != null) watchdog.Dispose(); if (native != null) native.Dispose(); if (window != null) window.Dispose(); parent.Dispose(); }
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern int SetCurrentProcessExplicitAppUserModelID(string appId);
    }

    internal static class Program {
        [StructLayout(LayoutKind.Sequential)] private struct BasicInfo { internal IntPtr ExitStatus, Peb, Affinity, Priority, UniquePid, ParentPid; }
        [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr process, int infoClass, ref BasicInfo info, int length, out int returned);
        [STAThread] private static int Main(string[] args) {
            // This branch creates no window, WinRT activation factory or SMTC.
            if (args.Length == 1 && args[0] == "--self-test") return SelfTest();
            try {
                if (args.Length != 5 || (args[0] != "--stdio" && args[0] != "--protocol-test") || args[1] != "--parent-pid" || args[3] != "--generation" || !Schema.IsHexToken(args[4])) return 2;
                int parentId; if (!Int32.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out parentId) || parentId < 1) return 2;
                BasicInfo info = new BasicInfo(); int returned;
                if (NtQueryInformationProcess(Process.GetCurrentProcess().Handle, 0, ref info, Marshal.SizeOf(typeof(BasicInfo)), out returned) < 0 || info.ParentPid.ToInt64() != parentId) return 2;
                Process parent = Process.GetProcessById(parentId); IntPtr pinnedParentHandle = parent.Handle;
                using (Host host = new Host(args[4], args[0] == "--protocol-test", parent)) return host.Run();
            } catch { return 2; }
        }
        private static int SelfTest() {
            int passed = 0;
            try {
                string[] rejected = {"{\"a\":1,\"a\":2}", "{\"a\":[1]}", "{\"a\":NaN}", "{\"a\":01}", "{\"a\":1e999}", "{\"a\":\"\\ud800\"}", "{\"a\":true} trailing", "{\"a\":{\"b\":{\"c\":{\"d\":{\"e\":{\"f\":{\"g\":{\"h\":0}}}}}}}}"};
                foreach (string value in rejected) { bool failed = false; try { Json.Parse(value); } catch (ProtocolException) { failed = true; } if (!failed) return 1; passed++; }
                Dictionary<string, object> good = Json.Parse("{\"title\":\"STILL · 静室\",\"number\":1.25,\"boolean\":false,\"empty\":null}"); if ((string)good["title"] != "STILL · 静室") return 1; passed++;
                Snapshot snapshot = Snapshot.Parse(Json.Parse("{\"schemaVersion\":1,\"sessionId\":\"test-1\",\"sequence\":1,\"source\":\"apple\",\"state\":\"paused\",\"metadata\":{\"title\":\"\",\"artist\":\"\",\"album\":\"\"},\"position\":0,\"duration\":10,\"capabilities\":{\"play\":true,\"pause\":false,\"stop\":false,\"next\":false,\"previous\":false,\"seek\":false}}"));
                if (!snapshot.Allows("play", null) || snapshot.Allows("pause", null) || snapshot.Allows("seek", 1) || snapshot.Allows("next", null)) return 1; passed++;
                bool badArt = false; try { Schema.Artwork(Json.Parse("{\"mimeType\":\"image/png\",\"dataBase64\":\"aHR0cHM6Ly9leGFtcGxlLmNvbQ==\"}")); } catch (ProtocolException) { badArt = true; } if (!badArt) return 1; passed++;
                Console.WriteLine("{\"selfTest\":\"passed\",\"checks\":" + passed.ToString(CultureInfo.InvariantCulture) + ",\"smtcRegistered\":false,\"windowCreated\":false}"); return 0;
            } catch { return 1; }
        }
    }
}
