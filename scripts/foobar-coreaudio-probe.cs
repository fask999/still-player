// Build with Windows .NET Framework csc.exe; no NuGet / SDK needed.
// Initialize allocates an audio stream/buffer; no mode calls Start or writes audio.
// The probe changes no device setting. Do not run audio modes without authorization.
// A shared Initialize succeeding at rest, DEVICE_IN_USE during foobar playback,
// and succeeding again after stop is evidence of exclusive endpoint ownership.
using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Text.RegularExpressions;
using System.Collections.Generic;
using System.Text;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int flow, uint state, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
    [PreserveSig] int RegisterEndpointNotificationCallback(IntPtr client);
    [PreserveSig] int UnregisterEndpointNotificationCallback(IntPtr client);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, uint context, IntPtr args, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
    [PreserveSig] int OpenPropertyStore(uint access, out IntPtr store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out uint state);
}
[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient {
    [PreserveSig] int Initialize(int shareMode, uint flags, long duration, long periodicity, IntPtr format, ref Guid session);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint frames);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long normal, out long minimum);
    [PreserveSig] int Start(); [PreserveSig] int Stop(); [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}
[StructLayout(LayoutKind.Sequential, Pack=2)]
struct WaveFormat { public ushort tag, channels; public uint rate, bytesPerSecond; public ushort blockAlign, bits, extra; }
[StructLayout(LayoutKind.Sequential, Pack=2)]
struct WaveExtensible { public WaveFormat wave; public ushort validBits; public uint mask; public Guid subFormat; }

class CoreAudioProbe {
    class Options { public string Endpoint, Mode; public uint Rate; public ushort Bits; public int HoldMs; public bool ValidateOnly; }
    static string Hex(int hr) { return "0x" + unchecked((uint)hr).ToString("X8"); }
    static string Quote(string value) {
        StringBuilder json = new StringBuilder("\"");
        foreach (char c in value) {
            if (c == '\\' || c == '"') json.Append('\\').Append(c);
            else if (c < 32) json.Append("\\u").Append(((int)c).ToString("x4"));
            else json.Append(c);
        }
        return json.Append('"').ToString();
    }
    // This interface keeps the measurement and reporting logic testable without
    // constructing a COM object. Only NativeSharedProbeCalls accesses Windows.
    internal interface ISharedProbeCalls {
        void CreateEnumerator();
        int GetDevice(string endpoint);
        int Activate();
        void CastAudioClient();
        int GetMixFormat(out IntPtr format);
        WaveFormat ReadMixFormat(IntPtr format);
        int Initialize(IntPtr format);
        bool HasAudioClient { get; }
        bool HasDevice { get; }
        bool HasEnumerator { get; }
        void FreeMixFormat(IntPtr format);
        void ReleaseAudioClient();
        void ReleaseDevice();
        void ReleaseEnumerator();
    }
    sealed class NativeSharedProbeCalls : ISharedProbeCalls {
        IMMDeviceEnumerator enumerator; IMMDevice device; object audioObject; IAudioClient client;
        public void CreateEnumerator() { enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator(); }
        public int GetDevice(string endpoint) { return enumerator.GetDevice(endpoint, out device); }
        public int Activate() {
            Guid iid = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
            return device.Activate(ref iid, 23, IntPtr.Zero, out audioObject);
        }
        public void CastAudioClient() { client = (IAudioClient)audioObject; }
        public int GetMixFormat(out IntPtr format) { return client.GetMixFormat(out format); }
        public WaveFormat ReadMixFormat(IntPtr format) { return (WaveFormat)Marshal.PtrToStructure(format, typeof(WaveFormat)); }
        public int Initialize(IntPtr format) {
            Guid session = Guid.Empty;
            // Preserve exactly the original shared-mode call and native format.
            return client.Initialize(0, 0, 1000000, 0, format, ref session);
        }
        public bool HasAudioClient { get { return audioObject != null; } }
        public bool HasDevice { get { return device != null; } }
        public bool HasEnumerator { get { return enumerator != null; } }
        public void FreeMixFormat(IntPtr format) { Marshal.FreeCoTaskMem(format); }
        public void ReleaseAudioClient() { Marshal.ReleaseComObject(audioObject); audioObject = null; client = null; }
        public void ReleaseDevice() { Marshal.ReleaseComObject(device); device = null; }
        public void ReleaseEnumerator() { Marshal.ReleaseComObject(enumerator); enumerator = null; }
    }
    internal sealed class SharedReleaseReport {
        internal string Endpoint, Stage = "CreateDeviceEnumerator", FailureStage, HresultSource = "not-called", Error;
        internal int Hresult = unchecked((int)0x80004005);
        internal bool ClientActivated, InitializeCalled, Initialized, CleanupComplete, Released;
        internal WaveFormat MixFormat;
        internal readonly List<string> NativeResults = new List<string>(), CleanupFailures = new List<string>();
        internal bool NativeResult(string stage, int hr) {
            Hresult = hr; HresultSource = "native-return"; FailureStage = hr == 0 ? null : stage;
            NativeResults.Add("{\"stage\":" + Quote(stage) + ",\"hresult\":" + Quote(Hex(hr)) + "}");
            return hr == 0;
        }
        internal void Release(string resource, Action action) {
            try { action(); }
            catch (Exception ex) {
                // Cleanup never replaces a primary native or managed failure.
                CleanupFailures.Add("{\"resource\":" + Quote(resource) + ",\"hresult\":" + Quote(Hex(ex.HResult)) + ",\"error\":" + Quote(ex.Message) + "}");
            }
        }
        internal int ExitCode { get { return Error != null || CleanupFailures.Count > 0 || (FailureStage != null && FailureStage != "Initialize") ? 1 : 0; } }
        internal string ToJson() {
            return "{\"schemaVersion\":2,\"at\":" + Quote(DateTime.UtcNow.ToString("o")) + ",\"endpoint\":" + Quote(Endpoint) +
                ",\"operation\":\"Initialize\",\"mode\":\"shared\",\"stage\":" + Quote(Stage) + ",\"failureStage\":" + (FailureStage == null ? "null" : Quote(FailureStage)) +
                ",\"hresult\":" + Quote(Hex(Hresult)) + ",\"hresultSource\":" + Quote(HresultSource) + ",\"nativeResults\":[" + String.Join(",", NativeResults.ToArray()) + "]" +
                ",\"formatKind\":\"Windows shared mix format\",\"mixRate\":" + MixFormat.rate + ",\"mixBits\":" + MixFormat.bits + ",\"mixChannels\":" + MixFormat.channels +
                ",\"clientActivated\":" + (ClientActivated ? "true" : "false") + ",\"initializeCalled\":" + (InitializeCalled ? "true" : "false") +
                ",\"initialized\":" + (Initialized ? "true" : "false") + ",\"deviceInUse\":" +
                (HresultSource == "native-return" && Stage == "Initialize" && unchecked((uint)Hresult) == 0x8889000A ? "true" : "false") +
                ",\"cleanupComplete\":" + (CleanupComplete ? "true" : "false") + ",\"released\":" + (Released ? "true" : "false") +
                ",\"cleanupFailures\":[" + String.Join(",", CleanupFailures.ToArray()) + "],\"startCalled\":false,\"actualDacRate\":null" +
                ",\"threadApartment\":" + Quote(System.Threading.Thread.CurrentThread.GetApartmentState().ToString()) + (Error == null ? "" : ",\"error\":" + Quote(Error)) + "}";
        }
    }
    internal static SharedReleaseReport MeasureSharedRelease(string endpoint, ISharedProbeCalls calls) {
        SharedReleaseReport report = new SharedReleaseReport { Endpoint = endpoint };
        IntPtr format = IntPtr.Zero;
        try {
            calls.CreateEnumerator();
            report.Stage = "GetDevice";
            if (!report.NativeResult(report.Stage, calls.GetDevice(endpoint))) return report;
            report.Stage = "Activate";
            if (!report.NativeResult(report.Stage, calls.Activate())) return report;
            report.ClientActivated = true;
            report.Stage = "CastAudioClient"; calls.CastAudioClient();
            report.Stage = "GetMixFormat";
            if (!report.NativeResult(report.Stage, calls.GetMixFormat(out format))) return report;
            report.Stage = "ReadMixFormat"; report.MixFormat = calls.ReadMixFormat(format);
            report.Stage = "Initialize"; report.InitializeCalled = true;
            report.Initialized = report.NativeResult(report.Stage, calls.Initialize(format));
        } catch (Exception ex) {
            report.Hresult = ex.HResult; report.HresultSource = "managed-exception";
            report.FailureStage = report.Stage; report.Error = ex.Message;
        } finally {
            // Attempt every acquired resource, then report. No stdout precedes cleanup.
            if (format != IntPtr.Zero) report.Release("MixFormat", () => calls.FreeMixFormat(format));
            if (calls.HasAudioClient) report.Release("AudioClient", calls.ReleaseAudioClient);
            if (calls.HasDevice) report.Release("Device", calls.ReleaseDevice);
            if (calls.HasEnumerator) report.Release("Enumerator", calls.ReleaseEnumerator);
            report.CleanupComplete = true; report.Released = report.CleanupFailures.Count == 0;
        }
        return report;
    }
    static int SharedReleaseCheck(Options options) {
        SharedReleaseReport report = MeasureSharedRelease(options.Endpoint, new NativeSharedProbeCalls());
        Console.WriteLine(report.ToJson());
        // Preserve old shared Initialize return behavior: native Initialize
        // failures report their HRESULT with exit 0; exceptions/cleanup use exit 1.
        return report.ExitCode;
    }
    static Options Parse(string[] args) {
        bool validateOnly = args.Length > 0 && args[0] == "--validate-only";
        int offset = validateOnly ? 1 : 0, count = args.Length - offset;
        if (count > 5) throw new ArgumentException("too many arguments");
        string endpoint = count > 0 ? args[offset] : "{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}";
        string mode = count > 1 ? args[offset + 1] : "shared";
        if (!Regex.IsMatch(endpoint, @"^\{0\.0\.0\.00000000\}\.\{[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\}$"))
            throw new ArgumentException("endpoint must be an explicit CoreAudio render endpoint ID");
        if (mode != "shared" && mode != "support" && mode != "hold" && mode != "exclusive-check" && mode != "state")
            throw new ArgumentException("mode must be shared, support, hold, exclusive-check or state");
        uint rate = mode == "exclusive-check" ? 48000U : 44100U;
        ushort bits = 16; int holdMs = 30000;
        if (count > 2 && (!UInt32.TryParse(args[offset + 2], out rate) || rate < 8000 || rate > 768000))
            throw new ArgumentException("rate must be an integer in 8000..768000");
        if (count > 3 && (!UInt16.TryParse(args[offset + 3], out bits) || (bits != 16 && bits != 24 && bits != 32)))
            throw new ArgumentException("PCM bits must be 16, 24 or 32");
        if (count > 4 && mode != "hold") throw new ArgumentException("duration is only accepted in hold mode");
        if (count > 4 && (!Int32.TryParse(args[offset + 4], out holdMs) || holdMs < 1000 || holdMs > 60000))
            throw new ArgumentException("hold duration must be 1000..60000 milliseconds");
        if (mode == "exclusive-check" && rate != 48000)
            throw new ArgumentException("exclusive-check requires 48000 Hz stereo PCM; bits must be explicitly supported");
        return new Options { Endpoint = endpoint, Mode = mode, Rate = rate, Bits = bits, HoldMs = holdMs, ValidateOnly = validateOnly };
    }
    static bool Cleanup(Action action, ref string error, ref int hr) {
        try { action(); return true; }
        catch (Exception ex) { error = (error == null ? "" : error + "; ") + "release failed: " + ex.Message; hr = ex.HResult; return false; }
    }
    static int ExclusiveCheck(Options options) {
        IMMDeviceEnumerator enumerator = null; IMMDevice device = null; object audioObject = null;
        IntPtr format = IntPtr.Zero, closest = IntPtr.Zero;
        int hr = unchecked((int)0x80004005), supportHr = unchecked((int)0x80004005), firstHr = unchecked((int)0x80004005);
        bool initialized = false, released = false, alignmentRetried = false;
        string error = null, acquiredAt = null; long duration = 0; uint alignedFrames = 0;
        try {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            Marshal.ThrowExceptionForHR(enumerator.GetDevice(options.Endpoint, out device));
            Guid iid = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
            Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out audioObject));
            IAudioClient client = (IAudioClient)audioObject;
            ushort align = (ushort)(2 * options.Bits / 8);
            WaveFormat wave = new WaveFormat { tag = 65534, channels = 2, rate = 48000, bits = options.Bits, blockAlign = align, bytesPerSecond = 48000U * align, extra = 22 };
            format = Marshal.AllocCoTaskMem(Marshal.SizeOf(typeof(WaveExtensible)));
            Marshal.StructureToPtr(new WaveExtensible { wave = wave, validBits = options.Bits, mask = 3,
                subFormat = new Guid("00000001-0000-0010-8000-00AA00389B71") }, format, false);
            supportHr = client.IsFormatSupported(1, format, out closest);
            hr = supportHr;
            if (supportHr == 0) {
                long normal, minimum;
                Marshal.ThrowExceptionForHR(client.GetDevicePeriod(out normal, out minimum));
                duration = Math.Max(normal, minimum);
                if (duration <= 0) throw new InvalidOperationException("device did not expose a positive period");
                Guid session = Guid.Empty;
                firstHr = client.Initialize(1, 0, duration, duration, format, ref session); hr = firstHr;
                if (unchecked((uint)hr) == 0x88890019) {
                    // The failed client supplies the required frame alignment. Retry once on a fresh
                    // client, preserving exactly the format that IsFormatSupported accepted.
                    Marshal.ThrowExceptionForHR(client.GetBufferSize(out alignedFrames));
                    if (alignedFrames == 0) throw new InvalidOperationException("aligned buffer size is zero");
                    duration = (10000000L * alignedFrames + 24000) / 48000;
                    Marshal.ReleaseComObject(audioObject); audioObject = null; client = null;
                    Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23, IntPtr.Zero, out audioObject));
                    client = (IAudioClient)audioObject; alignmentRetried = true;
                    hr = client.Initialize(1, 0, duration, duration, format, ref session);
                }
                initialized = hr == 0;
                if (initialized) acquiredAt = DateTime.UtcNow.ToString("o");
                GC.KeepAlive(client);
            }
        } catch (Exception ex) { hr = ex.HResult; error = ex.Message; }
        finally {
            released = true;
            // Use non-short-circuit accumulation so every release is attempted even
            // when an earlier resource reports a cleanup error.
            if (closest != IntPtr.Zero) released &= Cleanup(() => Marshal.FreeCoTaskMem(closest), ref error, ref hr);
            if (format != IntPtr.Zero) released &= Cleanup(() => Marshal.FreeCoTaskMem(format), ref error, ref hr);
            if (audioObject != null) released &= Cleanup(() => Marshal.ReleaseComObject(audioObject), ref error, ref hr);
            if (device != null) released &= Cleanup(() => Marshal.ReleaseComObject(device), ref error, ref hr);
            if (enumerator != null) released &= Cleanup(() => Marshal.ReleaseComObject(enumerator), ref error, ref hr);
        }
        string releasedAt = DateTime.UtcNow.ToString("o");
        // This is deliberately emitted only after releasing every COM object. No Start,
        // GetService, render samples, default-device lookup or format fallback is used.
        Console.WriteLine("{\"at\":" + Quote(releasedAt) + ",\"endpoint\":" + Quote(options.Endpoint) +
            ",\"operation\":\"Initialize\",\"mode\":\"exclusive-check\",\"requestedRate\":48000,\"requestedBits\":" + options.Bits + ",\"channels\":2" +
            ",\"formatDescriptor\":\"WAVEFORMATEXTENSIBLE/PCM\",\"requestedPCMFormat\":{\"sampleRate\":48000,\"bits\":" + options.Bits + ",\"channels\":2},\"formatSupportHresult\":" + Quote(Hex(supportHr)) +
            ",\"formatSupported\":" + (supportHr == 0 ? "true" : "false") + ",\"hresult\":" + Quote(Hex(hr)) +
            ",\"firstInitializeHresult\":" + Quote(Hex(firstHr)) + ",\"initialized\":" + (initialized ? "true" : "false") +
            ",\"ready\":" + (initialized && released && error == null ? "true" : "false") + ",\"released\":" + (released ? "true" : "false") +
            ",\"acquiredAt\":" + (acquiredAt == null ? "null" : Quote(acquiredAt)) + ",\"releasedAt\":" + Quote(releasedAt) +
            ",\"alignmentRetried\":" + (alignmentRetried ? "true" : "false") + ",\"alignedFrames\":" + alignedFrames + ",\"bufferDuration100ns\":" + duration +
            ",\"startCalled\":false,\"actualDacRate\":null" + (error == null ? "" : ",\"error\":" + Quote(error)) + "}");
        return error != null ? 1 : initialized && released ? 0 : 2;
    }
    [STAThread] static int Main(string[] args) {
        Options options;
        try { options = Parse(args); }
        catch (Exception ex) { Console.WriteLine("{\"validationFailed\":true,\"deviceAccessAttempted\":false,\"error\":" + Quote(ex.Message) + "}"); return 64; }
        if (options.ValidateOnly) {
            Console.WriteLine("{\"validated\":true,\"deviceAccessAttempted\":false,\"endpoint\":" + Quote(options.Endpoint) + ",\"mode\":" + Quote(options.Mode) +
                ",\"requestedRate\":" + options.Rate + ",\"requestedBits\":" + options.Bits + ",\"holdMs\":" + options.HoldMs + "}"); return 0;
        }
        if (options.Mode == "exclusive-check") return ExclusiveCheck(options);
        if (options.Mode == "shared") return SharedReleaseCheck(options);
        string endpoint = options.Endpoint, mode = options.Mode;
        IMMDeviceEnumerator enumerator = null; IMMDevice device = null; object audioObject = null;
        IntPtr format = IntPtr.Zero, closest = IntPtr.Zero;
        try {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            int hr = enumerator.GetDevice(endpoint, out device);
            if (mode == "state") {
                uint deviceState = 0; int stateHr = hr;
                if (hr == 0) stateHr = device.GetState(out deviceState);
                bool notFound = unchecked((uint)hr) == 0x80070490;
                Console.WriteLine("{\"at\":" + Quote(DateTime.UtcNow.ToString("o")) + ",\"endpoint\":" + Quote(endpoint) +
                    ",\"operation\":\"GetState\",\"mode\":\"state\",\"deviceFound\":" + (hr == 0 ? "true" : "false") +
                    ",\"deviceNotFound\":" + (notFound ? "true" : "false") + ",\"state\":" + (hr == 0 && stateHr == 0 ? deviceState.ToString() : "null") +
                    ",\"active\":" + (hr == 0 && stateHr == 0 && (deviceState & 1) != 0 ? "true" : "false") +
                    ",\"disabled\":" + ((deviceState & 2) != 0 ? "true" : "false") + ",\"notPresent\":" + ((deviceState & 4) != 0 ? "true" : "false") +
                    ",\"unplugged\":" + ((deviceState & 8) != 0 ? "true" : "false") + ",\"hresult\":" + Quote(Hex(stateHr)) +
                    ",\"clientActivated\":false,\"initializeCalled\":false,\"startCalled\":false,\"actualDacRate\":null}");
                return stateHr == 0 || notFound ? 0 : 1;
            }
            Marshal.ThrowExceptionForHR(hr);
            Guid iid = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
            hr = device.Activate(ref iid, 23, IntPtr.Zero, out audioObject); Marshal.ThrowExceptionForHR(hr);
            IAudioClient client = (IAudioClient)audioObject;
            if (mode == "support" || mode == "hold") {
                uint rate = options.Rate;
                ushort bits = options.Bits;
                // The first real 48k/16 stereo WAVEFORMATEX query was rejected by
                // this endpoint. Query the identical PCM values with the explicit
                // extensible descriptor; support is still measured, never assumed.
                bool extensible = true;
                WaveFormat wave = new WaveFormat { tag = extensible ? (ushort)65534 : (ushort)1, channels = 2, rate = rate,
                    bits = bits, blockAlign = (ushort)(2 * bits / 8), bytesPerSecond = rate * (uint)(2 * bits / 8), extra = extensible ? (ushort)22 : (ushort)0 };
                format = Marshal.AllocCoTaskMem(extensible ? Marshal.SizeOf(typeof(WaveExtensible)) : Marshal.SizeOf(typeof(WaveFormat)));
                if (extensible) Marshal.StructureToPtr(new WaveExtensible { wave = wave, validBits = bits, mask = 3,
                    subFormat = new Guid("00000001-0000-0010-8000-00AA00389B71") }, format, false);
                else Marshal.StructureToPtr(wave, format, false);
                if (mode == "hold") {
                    int holdMs = options.HoldMs;
                    Guid session = Guid.Empty;
                    // Initialize an exclusive buffer but never call Start or obtain a render client.
                    // Keep the COM client alive until stdin release or the bounded timeout.
                    hr = client.Initialize(1, 0, 1000000, 1000000, format, ref session);
                    Console.WriteLine("{\"at\":" + Quote(DateTime.UtcNow.ToString("o")) + ",\"endpoint\":" + Quote(endpoint) +
                        ",\"operation\":\"Initialize\",\"mode\":\"exclusive-hold\",\"formatDescriptor\":\"WAVEFORMATEXTENSIBLE/PCM\",\"requestedRate\":" + rate +
                        ",\"requestedBits\":" + bits + ",\"channels\":2,\"hresult\":" + Quote(Hex(hr)) +
                        ",\"initialized\":" + (hr == 0 ? "true" : "false") + ",\"ready\":" + (hr == 0 ? "true" : "false") +
                        ",\"startCalled\":false,\"maxHoldMs\":" + holdMs + ",\"actualDacRate\":null}");
                    Console.Out.Flush();
                    if (hr != 0) return 2;
                    bool stdinRelease = Task.Factory.StartNew(() => Console.ReadLine()).Wait(holdMs);
                    GC.KeepAlive(client);
                    Console.WriteLine("{\"at\":" + Quote(DateTime.UtcNow.ToString("o")) + ",\"endpoint\":" + Quote(endpoint) +
                        ",\"operation\":\"release-requested\",\"reason\":" + Quote(stdinRelease ? "stdin" : "timeout") + "}");
                } else {
                hr = client.IsFormatSupported(1, format, out closest);
                Console.WriteLine("{\"at\":" + Quote(DateTime.UtcNow.ToString("o")) + ",\"endpoint\":" + Quote(endpoint) +
                    ",\"operation\":\"IsFormatSupported\",\"mode\":\"exclusive\",\"formatDescriptor\":\"WAVEFORMATEXTENSIBLE/PCM\",\"requestedRate\":" + rate +
                    ",\"requestedBits\":" + bits + ",\"channels\":2,\"hresult\":" + Quote(Hex(hr)) +
                    ",\"supported\":" + (hr == 0 ? "true" : "false") + ",\"actualDacRate\":null}");
                }
            }
            return 0;
        } catch (Exception ex) {
            Console.WriteLine("{\"endpoint\":" + Quote(endpoint) + ",\"error\":" + Quote(ex.Message) + ",\"hresult\":" + Quote(Hex(ex.HResult)) + "}"); return 1;
        } finally {
            if (closest != IntPtr.Zero) Marshal.FreeCoTaskMem(closest);
            if (format != IntPtr.Zero) Marshal.FreeCoTaskMem(format);
            if (audioObject != null) Marshal.ReleaseComObject(audioObject);
            if (device != null) Marshal.ReleaseComObject(device);
            if (enumerator != null) Marshal.ReleaseComObject(enumerator);
            if (mode == "hold") Console.WriteLine("{\"at\":" + Quote(DateTime.UtcNow.ToString("o")) + ",\"endpoint\":" + Quote(endpoint) + ",\"operation\":\"released\",\"startCalled\":false}");
        }
    }
}
