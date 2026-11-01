// Read-only x64 console helper. No playback, capture, device or GUI API.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

internal static class SpectrumPipeReader {
    const int NativeMaxBytes = 60 * 1024;
    const int EnvelopeMaxBytes = 64 * 1024;
    static readonly ManualResetEvent Stopping = new ManualResetEvent(false);
    static readonly object PipeLock = new object();
    static NamedPipeClientStream CurrentPipe;
    static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = NativeMaxBytes, RecursionLimit = 16 };

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint serverProcessId);

    static int Main(string[] args) {
        // This branch MUST precede stdin monitoring, pipe construction and P/Invoke.
        // Only in-memory constant fixtures are used by protocol acceptance checks.
        if (args.Length == 1 && args[0] == "--protocol-self-test") return ProtocolSelfTest();
        uint pid; int interval;
        if (!ParseArgs(args, out pid, out interval)) { Console.Error.WriteLine("invalid-arguments"); return 2; }
        Console.OutputEncoding = new UTF8Encoding(false);
        Console.Out.NewLine = "\n"; // Envelope budget includes this exact one-byte terminator.
        var stdin = new Thread(delegate() {
            try { var input = Console.OpenStandardInput(); var bytes = new byte[32]; while (input.Read(bytes, 0, bytes.Length) > 0) {} }
            catch { /* Parent transport closed. */ }
            finally {
                Stopping.Set();
                lock (PipeLock) { if (CurrentPipe != null) CurrentPipe.Dispose(); }
            }
        });
        stdin.IsBackground = true; stdin.Start();
        while (!Stopping.WaitOne(0)) {
            try {
                string frame; string reason; uint actualPid;
                if (TryRead(pid, out actualPid, out frame, out reason))
                    Console.WriteLine(frame);
                else if (!Stopping.WaitOne(0)) Unavailable(reason);
                Console.Out.Flush();
            } catch (IOException) { return 0; } // Parent stdout has closed.
            catch (ObjectDisposedException) { return 0; }
            if (Stopping.WaitOne(interval)) break;
        }
        return 0;
    }

    static bool ParseArgs(string[] args, out uint pid, out int interval) {
        pid = 0; interval = 50;
        if ((args.Length != 2 && args.Length != 4) || args[0] != "--pid" || !UInt32.TryParse(args[1], NumberStyles.None, CultureInfo.InvariantCulture, out pid) || pid == 0) return false;
        return args.Length == 2 || (args[2] == "--interval-ms" && Int32.TryParse(args[3], NumberStyles.None, CultureInfo.InvariantCulture, out interval) && interval >= 40 && interval <= 250);
    }

    static void Unavailable(string reason) {
        // Only internally selected constants reach this output. No raw exceptions.
        Console.WriteLine("{\"protocol\":1,\"kind\":\"unavailable\",\"reason\":\"" + reason + "\"}");
    }

    static string FrameEnvelope(uint pid, string frame) {
        string envelope = "{\"protocol\":1,\"kind\":\"frame\",\"serverPid\":" + pid.ToString(CultureInfo.InvariantCulture) + ",\"frame\":" + frame + "}";
        // Include LF in the transport budget; serialization can expand strings.
        return Utf8.GetByteCount(envelope) + 1 <= EnvelopeMaxBytes ? envelope : null;
    }

    static bool TryRead(uint expectedPid, out uint actualPid, out string frame, out string reason) {
        actualPid = 0; frame = null; reason = "component-not-connected";
        // The fixed, local pipe cannot be changed through arguments or frame data.
        var pipe = new NamedPipeClientStream(".", "Still.FoobarSpectrum.v1." + expectedPid.ToString(CultureInfo.InvariantCulture), PipeDirection.In, PipeOptions.Asynchronous);
        try {
            lock (PipeLock) { if (Stopping.WaitOne(0)) return false; CurrentPipe = pipe; }
            pipe.Connect(150);
            // Verify the kernel identity on EVERY connection, BEFORE reading bytes.
            if (!GetNamedPipeServerProcessId(pipe.SafePipeHandle, out actualPid) || actualPid != expectedPid) {
                reason = "server-pid-mismatch"; return false;
            }
            byte[] bytes;
            try { bytes = ReadBounded(pipe); }
            catch (TimeoutException) { reason = "read-timeout"; return false; }
            catch (InvalidDataException) { reason = "malformed-frame"; return false; }
            string decoded;
            try { decoded = Utf8.GetString(bytes); }
            catch (DecoderFallbackException) { reason = "malformed-frame"; return false; }
            object value;
            if (!ParseFrame(decoded, expectedPid, out value)) { reason = "malformed-frame"; return false; }
            // Re-serialize the validated JSON value, never concatenate raw pipe text.
            frame = FrameEnvelope(actualPid, Json.Serialize(value));
            if (frame == null) { reason = "malformed-frame"; return false; }
            return true;
        } catch (TimeoutException) { return false; }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
        catch (ObjectDisposedException) { return false; }
        catch { return false; } // Unsupported OS/native API: controlled unavailable only.
        finally {
            lock (PipeLock) { if (Object.ReferenceEquals(CurrentPipe, pipe)) CurrentPipe = null; }
            pipe.Dispose();
        }
    }

    static byte[] ReadBounded(Stream pipe) {
        // One snapshot, then EOF. Deadline applies to the WHOLE read, including
        // a slow sender or a server that never closes after its LF.
        var watch = System.Diagnostics.Stopwatch.StartNew();
        using (var output = new MemoryStream()) {
            var chunk = new byte[4096];
            while (true) {
                int remaining = 150 - (int)watch.ElapsedMilliseconds;
                if (remaining <= 0) throw new TimeoutException();
                var pending = pipe.BeginRead(chunk, 0, chunk.Length, null, null);
                int length;
                try {
                    if (!pending.AsyncWaitHandle.WaitOne(remaining)) throw new TimeoutException();
                    length = pipe.EndRead(pending);
                } finally { pending.AsyncWaitHandle.Close(); }
                if (length == 0) break;
                if (output.Length + length > NativeMaxBytes) throw new InvalidDataException();
                output.Write(chunk, 0, length);
            }
            if (output.Length == 0) throw new InvalidDataException();
            return output.ToArray();
        }
    }

    static bool Keys(IDictionary<string, object> value, params string[] names) {
        if (value == null || value.Count != names.Length) return false;
        foreach (var name in names) if (!value.ContainsKey(name)) return false;
        return true;
    }
    static bool Number(object value, double low, double high) {
        if (!(value is int || value is long || value is double || value is decimal)) return false;
        double n = Convert.ToDouble(value, CultureInfo.InvariantCulture);
        return !Double.IsNaN(n) && !Double.IsInfinity(n) && n >= low && n <= high;
    }
    static bool Integer(object value, double low, double high) { return Number(value, low, high) && Math.Floor(Convert.ToDouble(value)) == Convert.ToDouble(value); }
    static bool Near(object value, double expected) { return Number(value, 0, 1000000) && Math.Abs(Convert.ToDouble(value) - expected) <= Math.Max(1e-7, Math.Abs(expected) * 1e-8); }
    static bool NullNumber(object value) { return value == null || Number(value, 0, 9007199254740991); }
    static bool LocalPath(object value) {
        var text = value as string;
        if (text == null || text.Length == 0 || text.Length > 32768 || text.IndexOfAny(new char[] {'\0', '\r', '\n'}) >= 0) return false;
        if (text.StartsWith("file://", StringComparison.OrdinalIgnoreCase)) text = text.Substring(7);
        text = text.Replace('/', '\\');
        if (System.Text.RegularExpressions.Regex.IsMatch(text, @"\A[A-Za-z]:\\")) return true;
        var unc = System.Text.RegularExpressions.Regex.Match(text, @"\A\\\\([^\\]+)\\([^\\]+)(?:\\|\z)");
        if (!unc.Success) return false;
        for (int i = 1; i <= 2; ++i) {
            string part = unc.Groups[i].Value;
            if (part == "." || part == ".." || System.Text.RegularExpressions.Regex.IsMatch(part, "[<>:\"|?*\\x00-\\x1f]")) return false;
        }
        return true;
    }
    static bool ParseFrame(string text, uint expectedPid, out object value) {
        value = null;
        try {
            // Exactly one JSON document; a second line/document or trailing garbage
            // is rejected by DeserializeObject. All fields are schema checked.
            var f = Json.DeserializeObject(text) as IDictionary<string, object>;
            if (!Keys(f, "schemaVersion", "source", "analyzer", "status", "reason", "sequence", "sessionId", "backendPid", "generation", "track", "capturedAtUnixMs", "ageMs", "streamTimeSeconds", "sampleRate", "channels", "fftSize", "window", "calibration", "floorDbfs", "binHz", "windowSeconds", "bands")) return false;
            Guid sessionId;
            if (!Integer(f["schemaVersion"], 1, 1) || !Object.Equals(f["source"], "foobar2000") || !Object.Equals(f["analyzer"], "sdk-visualisation-pcm") ||
                !Integer(f["backendPid"], expectedPid, expectedPid) || !Integer(f["sequence"], 1, 9007199254740991) || !Integer(f["generation"], 0, 9007199254740991) ||
                !(f["sessionId"] is string) || !Guid.TryParseExact((string)f["sessionId"], "D", out sessionId) ||
                !Integer(f["fftSize"], 4096, 4096) || !Object.Equals(f["window"], "hann-periodic") || !Object.Equals(f["calibration"], "rms-full-scale-1") || !Number(f["floorDbfs"], -100, -100)) return false;
            string status = f["status"] as string;
            if (status != "running" && status != "paused" && status != "stopped" && status != "unavailable" && status != "stale") return false;
            if (f["reason"] != null && (!(f["reason"] is string) || !System.Text.RegularExpressions.Regex.IsMatch((string)f["reason"], "\\A[a-z][a-z0-9-]{0,63}\\z"))) return false;
            if (!NullNumber(f["capturedAtUnixMs"]) || !NullNumber(f["ageMs"]) || !NullNumber(f["streamTimeSeconds"])) return false;
            var track = f["track"] as IDictionary<string, object>;
            if (f["track"] != null && (!Keys(track, "path", "subsong") || !LocalPath(track["path"]) || !Integer(track["subsong"], 0, UInt32.MaxValue))) return false;
            var bands = f["bands"] as object[];
            if (bands == null) return false;
            if (status != "running") {
                if (bands.Length != 0 || f["sampleRate"] != null || f["channels"] != null || f["binHz"] != null || f["windowSeconds"] != null ||
                    f["capturedAtUnixMs"] != null || f["ageMs"] != null || f["streamTimeSeconds"] != null) return false;
            } else {
                if (track == null || f["reason"] != null || f["capturedAtUnixMs"] == null || f["ageMs"] == null || f["streamTimeSeconds"] == null ||
                    !Integer(f["sampleRate"], 8000, 768000) || !Integer(f["channels"], 1, 32) || bands.Length != 48) return false;
                double rate = Convert.ToDouble(f["sampleRate"]), upper = Math.Min(20000, rate / 2), bin = rate / 4096;
                if (!Near(f["binHz"], bin) || !Near(f["windowSeconds"], 4096 / rate)) return false;
                for (int i = 0; i < 48; ++i) {
                    var b = bands[i] as IDictionary<string, object>;
                    double low = 20 * Math.Exp(Math.Log(upper / 20) * i / 48), high = i == 47 ? upper : 20 * Math.Exp(Math.Log(upper / 20) * (i + 1) / 48);
                    if (!Keys(b, "lowHz", "highHz", "dbfs", "hasBins") || !Near(b["lowHz"], low) || !Near(b["highHz"], high) ||
                        !Number(b["lowHz"], 20, upper) || !Number(b["highHz"], 20, upper) || !Number(b["dbfs"], -100, 60) || !(b["hasBins"] is bool)) return false;
                    bool hasBins = false;
                    for (int k = 1; k <= 2048; ++k) if (k * bin >= Convert.ToDouble(b["lowHz"]) && (k * bin < Convert.ToDouble(b["highHz"]) || (i == 47 && k * bin <= Convert.ToDouble(b["highHz"])))) { hasBins = true; break; }
                    if ((bool)b["hasBins"] != hasBins || (!hasBins && !Number(b["dbfs"], -100, -100))) return false;
                }
            }
            value = f; return true;
        } catch { return false; }
    }

    static int ProtocolSelfTest() {
        int checks = 0;
        Action<bool> check = delegate(bool ok) { if (!ok) throw new InvalidOperationException("fixture-failed"); ++checks; };
        try {
            uint pid; int interval; object parsed;
            check(ParseArgs(new string[] {"--pid", "651"}, out pid, out interval) && pid == 651 && interval == 50);
            check(!ParseArgs(new string[] {"--pid", "0"}, out pid, out interval));
            check(!ParseArgs(new string[] {"--pid", "651", "--interval-ms", "39"}, out pid, out interval));
            check(!ParseArgs(new string[] {"--pid", "651", "--pipe", "arbitrary"}, out pid, out interval));
            var f = new Dictionary<string, object> {
                {"schemaVersion", 1}, {"source", "foobar2000"}, {"analyzer", "sdk-visualisation-pcm"}, {"status", "running"}, {"reason", null},
                {"sequence", 1}, {"sessionId", "11111111-2222-4333-8444-555555555555"}, {"backendPid", 651}, {"generation", 0},
                {"track", new Dictionary<string, object> {{"path", "C:\\Fixture\\tone.wav"}, {"subsong", 0}}},
                {"capturedAtUnixMs", 1000000}, {"ageMs", 10}, {"streamTimeSeconds", 1.0}, {"sampleRate", 48000}, {"channels", 2},
                {"fftSize", 4096}, {"window", "hann-periodic"}, {"calibration", "rms-full-scale-1"}, {"floorDbfs", -100},
                {"binHz", 48000.0 / 4096}, {"windowSeconds", 4096.0 / 48000}, {"bands", null}
            };
            var bands = new object[48];
            for (int i = 0; i < 48; ++i) {
                double low = 20 * Math.Exp(Math.Log(1000) * i / 48), high = i == 47 ? 20000 : 20 * Math.Exp(Math.Log(1000) * (i + 1) / 48);
                bool has = false;
                for (int k = 1; k <= 2048; ++k) if (k * (48000.0 / 4096) >= low && (k * (48000.0 / 4096) < high || (i == 47 && k * (48000.0 / 4096) <= high))) { has = true; break; }
                bands[i] = new Dictionary<string, object> {{"lowHz", low}, {"highHz", high}, {"dbfs", has ? -3.0103 : -100}, {"hasBins", has}};
            }
            f["bands"] = bands;
            string valid = Json.Serialize(f);
            check(ParseFrame(valid, 651, out parsed));
            check(!ParseFrame(valid, 652, out parsed));
            check(!ParseFrame(valid + "\n{}", 651, out parsed));
            check(!ParseFrame("{", 651, out parsed));
            f["sequence"] = 0; check(!ParseFrame(Json.Serialize(f), 651, out parsed)); f["sequence"] = 1;
            f["source"] = "loopback"; check(!ParseFrame(Json.Serialize(f), 651, out parsed)); f["source"] = "foobar2000";
            ((Dictionary<string, object>)bands[47])["highHz"] = 24001; check(!ParseFrame(Json.Serialize(f), 651, out parsed));
            bool bounded = false;
            try { ReadBounded(new MemoryStream(new byte[NativeMaxBytes + 1])); } catch (InvalidDataException) { bounded = true; }
            check(bounded);
            check(ReadBounded(new MemoryStream(new byte[NativeMaxBytes])).Length == NativeMaxBytes);
            check(Utf8.GetString(ReadBounded(new MemoryStream(Utf8.GetBytes(valid)))) == valid);
            check(FrameEnvelope(651, valid) != null);
            check(FrameEnvelope(651, new String('x', EnvelopeMaxBytes)) == null);
            int envelopeOverhead = Utf8.GetByteCount(FrameEnvelope(651, "")) + 1;
            check(FrameEnvelope(651, new String('x', EnvelopeMaxBytes - envelopeOverhead)) != null);
            check(FrameEnvelope(651, new String('x', EnvelopeMaxBytes - envelopeOverhead + 1)) == null);
            check(LocalPath("C:\\Fixture\\tone.wav"));
            check(LocalPath("file://C:/Fixture/tone.wav"));
            check(LocalPath("\\\\server\\share\\tone.wav"));
            check(!LocalPath("\\tone.wav"));
            check(!LocalPath("C:tone.wav"));
            check(!LocalPath("tone.wav"));
            check(!LocalPath("\\\\server"));
            check(!LocalPath("\\\\?\\C:\\tone.wav"));
            Console.WriteLine("{\"protocolSelfTest\":\"passed\",\"checks\":" + checks + ",\"fixturesOnly\":true,\"pipeConnections\":0,\"processInspection\":false,\"audioAccess\":false}");
            return 0;
        } catch { Console.Error.WriteLine("protocol-self-test-failed"); return 1; }
    }
}
