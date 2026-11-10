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
using System.Security.Cryptography;

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
    class Options { public string Endpoint, Mode, IdentityScope; public uint Rate; public ushort Bits; public int HoldMs; public bool ValidateOnly; }
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
        int GetId(out string endpoint);
        int GetState(out uint state);
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
        public int GetId(out string endpoint) { return device.GetId(out endpoint); }
        public int GetState(out uint state) { return device.GetState(out state); }
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
        internal string Endpoint, ObservedEndpoint, Stage = "CreateDeviceEnumerator", FailureStage, HresultSource = "not-called", Error;
        internal int Hresult = unchecked((int)0x80004005);
        internal bool StateOnly, DeviceFound, DeviceStateKnown, ClientActivated, InitializeCalled, Initialized, CleanupComplete, Released;
        internal uint DeviceState;
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
        internal int ExitCode { get {
            if (Error != null || CleanupFailures.Count > 0) return 1;
            if (StateOnly && FailureStage == "GetDevice" && unchecked((uint)Hresult) == 0x80070490) return 0;
            return FailureStage != null && FailureStage != "Initialize" ? 1 : 0;
        } }
        internal string ToJson() {
            return "{\"schemaVersion\":3,\"at\":" + Quote(DateTime.UtcNow.ToString("o")) + ",\"endpoint\":" + Quote(Endpoint) +
                ",\"observedEndpoint\":" + (ObservedEndpoint == null ? "null" : Quote(ObservedEndpoint)) +
                ",\"operation\":" + Quote(StateOnly ? "GetState" : "Initialize") + ",\"mode\":" + Quote(StateOnly ? "state" : "shared") +
                ",\"stage\":" + Quote(Stage) + ",\"failureStage\":" + (FailureStage == null ? "null" : Quote(FailureStage)) +
                ",\"hresult\":" + Quote(Hex(Hresult)) + ",\"hresultSource\":" + Quote(HresultSource) + ",\"nativeResults\":[" + String.Join(",", NativeResults.ToArray()) + "]" +
                ",\"deviceFound\":" + (DeviceFound ? "true" : "false") + ",\"deviceNotFound\":" +
                (HresultSource == "native-return" && FailureStage == "GetDevice" && unchecked((uint)Hresult) == 0x80070490 ? "true" : "false") +
                ",\"endpointState\":" + (DeviceStateKnown ? DeviceState.ToString() : "null") + ",\"state\":" + (DeviceStateKnown ? DeviceState.ToString() : "null") +
                ",\"active\":" + (DeviceStateKnown && DeviceState == 1 ? "true" : "false") +
                ",\"disabled\":" + (DeviceStateKnown && DeviceState == 2 ? "true" : "false") +
                ",\"notPresent\":" + (DeviceStateKnown && DeviceState == 4 ? "true" : "false") +
                ",\"unplugged\":" + (DeviceStateKnown && DeviceState == 8 ? "true" : "false") +
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
        return MeasureEndpoint(endpoint, calls, false);
    }
    internal static SharedReleaseReport MeasureEndpoint(string endpoint, ISharedProbeCalls calls, bool stateOnly) {
        SharedReleaseReport report = new SharedReleaseReport { Endpoint = endpoint, StateOnly = stateOnly };
        IntPtr format = IntPtr.Zero;
        try {
            calls.CreateEnumerator();
            report.Stage = "GetDevice";
            if (!report.NativeResult(report.Stage, calls.GetDevice(endpoint))) return report;
            report.DeviceFound = true;
            report.Stage = "GetId";
            if (!report.NativeResult(report.Stage, calls.GetId(out report.ObservedEndpoint))) return report;
            if (!String.Equals(endpoint, report.ObservedEndpoint, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("GetDevice returned a different endpoint identity");
            report.Stage = "GetState";
            if (!report.NativeResult(report.Stage, calls.GetState(out report.DeviceState))) return report;
            report.DeviceStateKnown = true;
            // Identity and connection are observed before activating any audio
            // client. An absent/inactive endpoint is not an availability proof.
            if (stateOnly || report.DeviceState != 1) return report;
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
    static int EndpointStateCheck(Options options) {
        SharedReleaseReport report = MeasureEndpoint(options.Endpoint, new NativeSharedProbeCalls(), true);
        Console.WriteLine(report.ToJson());
        return report.ExitCode;
    }

    // The identity path uses its own read-only COM and PnP calls. No audio
    // client is activated, and no instance ID or container ID leaves the helper.
    static class ReadOnlyIdentity {
        [ComImport, Guid("1BE09788-6894-4089-8586-9A2A6C265AC5"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IMMEndpoint { [PreserveSig] int GetDataFlow(out int flow); }
        [StructLayout(LayoutKind.Sequential)]
        struct PropertyKey {
            public Guid Format; public uint Id;
            public PropertyKey(string format, uint id) { Format = new Guid(format); Id = id; }
        }
        // x64 PROPVARIANT contains a two-pointer union member. Allocate the
        // entire native structure even though we read only vt and its pointer.
        [StructLayout(LayoutKind.Explicit, Size=24)]
        struct PropVariant {
            [FieldOffset(0)] public ushort Type;
            [FieldOffset(8)] public IntPtr Pointer;
        }
        [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        interface IPropertyStore {
            [PreserveSig] int GetCount(out uint count);
            [PreserveSig] int GetAt(uint index, out PropertyKey key);
            [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        }
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [DllImport("ole32.dll", ExactSpelling=true)] static extern int PropVariantClear(ref PropVariant value);
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [DllImport("cfgmgr32.dll", ExactSpelling=true, CharSet=CharSet.Unicode)]
        static extern uint CM_Locate_DevNodeW(out uint node, string instance, uint flags);
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [DllImport("cfgmgr32.dll", ExactSpelling=true)] static extern uint CM_Get_Parent(out uint parent, uint node, uint flags);
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [DllImport("cfgmgr32.dll", ExactSpelling=true, CharSet=CharSet.Unicode)]
        static extern uint CM_Get_Device_IDW(uint node, StringBuilder instance, uint length, uint flags);
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [DllImport("cfgmgr32.dll", ExactSpelling=true)]
        static extern uint CM_Get_DevNode_PropertyW(uint node, ref PropertyKey key, out uint type, [Out] byte[] value, ref uint length, uint flags);
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [DllImport("cfgmgr32.dll", ExactSpelling=true, CharSet=CharSet.Unicode)]
        static extern uint CM_Get_Device_Interface_List_SizeW(out uint length, ref Guid interfaceClass, string instance, uint flags);
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        [DllImport("cfgmgr32.dll", ExactSpelling=true, CharSet=CharSet.Unicode)]
        static extern uint CM_Get_Device_Interface_ListW(ref Guid interfaceClass, string instance, [Out] byte[] value, uint length, uint flags);

        static readonly PropertyKey EndpointGuid = new PropertyKey("1DA5D803-D492-4EDD-8C23-E0C0FFEE7F0E", 4);
        static readonly PropertyKey InstanceId = new PropertyKey("78C34FC8-104A-4ACA-9EA4-524D52996E57", 256);
        static readonly PropertyKey ContainerId = new PropertyKey("8C7ED206-3F8A-4827-B3AB-AE9E1FAEFC6C", 2);
        static readonly PropertyKey HardwareIds = new PropertyKey("A45C254E-DF1C-4EFD-8020-67D146A850E0", 3);
        static readonly PropertyKey Capabilities = new PropertyKey("A45C254E-DF1C-4EFD-8020-67D146A850E0", 17);
        static readonly PropertyKey EnumeratorName = new PropertyKey("A45C254E-DF1C-4EFD-8020-67D146A850E0", 24);
        static readonly PropertyKey Service = new PropertyKey("A45C254E-DF1C-4EFD-8020-67D146A850E0", 6);
        static readonly PropertyKey ClassGuid = new PropertyKey("A45C254E-DF1C-4EFD-8020-67D146A850E0", 10);
        static readonly PropertyKey LocationPaths = new PropertyKey("A45C254E-DF1C-4EFD-8020-67D146A850E0", 37);
        static readonly PropertyKey LastArrivalDate = new PropertyKey("83DA6326-97A6-4088-9453-A1923F573B29", 102);
        static readonly PropertyKey DriverVersion = new PropertyKey("A8B865DD-2E3D-4094-AD97-E593A70C75D6", 3);
        static readonly Regex UsbInstance = new Regex(@"\AUSB\\(VID_[0-9A-F]{4}&PID_[0-9A-F]{4})(&MI_[0-9A-F]{2})?\\([A-Z0-9_.&-]{1,160})\z", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        static readonly Regex UsbPort = new Regex(@"(?:\A|#)USBROOT\([0-9A-F]{1,8}\)(?:#USB\([0-9A-F]{1,8}\))+\z", RegexOptions.CultureInvariant);
        static readonly Regex UsbInterfaceTail = new Regex(@"\A#USBMI\([0-9A-F]{1,8}\)\z", RegexOptions.CultureInvariant);
        static readonly Guid AudioSetupClass = new Guid("4D36E96C-E325-11CE-BFC1-08002BE10318");
        static readonly Guid EndpointSetupClass = new Guid("C166523C-FE0C-4A94-A586-F1A80CFBBF3E");
        static readonly Guid AudioRenderInterface = new Guid("E6327CAD-DCEC-4949-AE8A-991E976A79D2");
        const uint DevGuid = 0xD, DevUInt32 = 0x7, DevFileTime = 0x10, DevString = 0x12, DevStringList = 0x2012, UniqueId = 0x10;
        enum IdentityStage { Endpoint, GetId, GetState, EndpointProperties, RenderInterface, UsbChain, UsbDriver, UsbIdentity, Topology, Arrival, Reenumeration, Cleanup }
        sealed class Progress { internal IdentityStage Stage; }
        sealed class UsbObservation { internal string[] Fields; internal bool Unique; }
        sealed class Observation { internal string Endpoint, Digest; internal Guid Guid; internal bool Unique; }

        static void Require(bool condition) { if (!condition) throw new InvalidOperationException("USB endpoint identity unverified"); }
        static bool Same(string left, string right) { return String.Equals(left, right, StringComparison.OrdinalIgnoreCase); }
        static string VariantString(IntPtr pointer) {
            for (int length = 0; length < 512; length++)
                if (Marshal.ReadInt16(pointer, length * 2) == 0) return Marshal.PtrToStringUni(pointer, length);
            throw new InvalidOperationException("endpoint property exceeds limit");
        }
        static T ReadEndpointProperty<T>(IPropertyStore store, PropertyKey key, ushort type, Func<IntPtr, T> read) {
            PropVariant value = new PropVariant();
            try {
                Require(store.GetValue(ref key, out value) == 0 && value.Type == type && value.Pointer != IntPtr.Zero);
                return read(value.Pointer);
            } finally { Require(PropVariantClear(ref value) == 0); }
        }
        static string ReadEndpointInstanceCandidate(IPropertyStore store, string observed) {
            PropertyKey key = InstanceId;
            PropVariant value = new PropVariant();
            string candidate = "SWD\\MMDEVAPI\\" + observed;
            try {
                Require(store.GetValue(ref key, out value) == 0);
                // The exact active GetId can supply a candidate when this
                // property is explicitly empty. The candidate has no identity
                // authority until the present devnode and interface are read.
                if (value.Type == 0) return candidate;
                Require(value.Type == 31 && value.Pointer != IntPtr.Zero);
                string reported = VariantString(value.Pointer);
                Require(Same(reported, observed) || Same(reported, candidate));
                return candidate;
            } finally { Require(PropVariantClear(ref value) == 0); }
        }
        static string ReadPresentRenderInterface(string actualInstance) {
            Guid render = AudioRenderInterface;
            uint characters;
            // PRESENT=0 plus the exact device-instance filter. Size and list
            // lengths are WCHAR counts; the backing buffer is UTF-16 bytes.
            Require(CM_Get_Device_Interface_List_SizeW(out characters, ref render, actualInstance, 0) == 0 && characters >= 3 && characters <= 2048);
            byte[] bytes = new byte[characters * 2];
            Require(CM_Get_Device_Interface_ListW(ref render, actualInstance, bytes, characters, 0) == 0);
            string list = Encoding.Unicode.GetString(bytes);
            int end = list.IndexOf('\0');
            Require(end > 4 && end + 1 < list.Length && list.Substring(end).Trim('\0').Length == 0);
            string link = list.Substring(0, end);
            Require(link.StartsWith("\\\\?\\", StringComparison.Ordinal) && !Regex.IsMatch(link, @"[\x00-\x1F\x7F]"));
            return link.ToUpperInvariant();
        }
        static byte[] ReadNodeProperty(uint node, PropertyKey key, uint expectedType) {
            byte[] buffer = new byte[4096]; uint length = (uint)buffer.Length, type;
            Require(CM_Get_DevNode_PropertyW(node, ref key, out type, buffer, ref length, 0) == 0 &&
                type == expectedType && length > 0 && length <= buffer.Length);
            Array.Resize(ref buffer, (int)length);
            return buffer;
        }
        static string NodeString(uint node, PropertyKey key) {
            byte[] bytes = ReadNodeProperty(node, key, DevString);
            Require(bytes.Length >= 4 && bytes.Length % 2 == 0);
            string value = Encoding.Unicode.GetString(bytes);
            Require(value[value.Length - 1] == '\0' && value.IndexOf('\0') == value.Length - 1);
            return value.Substring(0, value.Length - 1);
        }
        static Guid NodeContainer(uint node) { return new Guid(ReadNodeProperty(node, ContainerId, DevGuid)); }
        static uint Locate(string id) {
            uint node = 0;
            // CM_LOCATE_DEVNODE_NORMAL only. No phantom or cancel-removal flag.
            Require(!String.IsNullOrEmpty(id) && id.Length < 256 && CM_Locate_DevNodeW(out node, id, 0) == 0);
            return node;
        }
        static string NodeId(uint node) {
            StringBuilder value = new StringBuilder(256);
            Require(CM_Get_Device_IDW(node, value, (uint)value.Capacity, 0) == 0 && value.Length > 0);
            return value.ToString();
        }
        static string Driver(uint node) {
            string version = NodeString(node, DriverVersion);
            Require(Regex.IsMatch(version, @"\A[0-9]{1,10}(\.[0-9]{1,10}){1,3}\z"));
            return version;
        }
        static string[] NodeStringList(uint node, PropertyKey key) {
            byte[] bytes = ReadNodeProperty(node, key, DevStringList);
            Require(bytes.Length >= 6 && bytes.Length % 2 == 0);
            string text = Encoding.Unicode.GetString(bytes).ToUpperInvariant();
            Require(text.EndsWith("\0\0", StringComparison.Ordinal));
            string[] rows = text.Substring(0, text.Length - 2).Split('\0');
            Require(rows.Length <= 32);
            foreach (string row in rows) Require(row.Length > 0 && row.Length <= 512 && !Regex.IsMatch(row, @"[\x00-\x1F\x7F]"));
            return rows;
        }
        static string Hardware(uint node, string baseId) {
            string[] items = NodeStringList(node, HardwareIds);
            Require(Array.IndexOf(items, "USB\\" + baseId) >= 0);
            foreach (string item in items) Require(Regex.IsMatch(item, @"\AUSB\\[A-Z0-9_&-]{1,200}\z"));
            return String.Join("\n", items);
        }
        static string Arrival(uint node) {
            byte[] value = ReadNodeProperty(node, LastArrivalDate, DevFileTime);
            Require(value.Length == 8 && BitConverter.ToInt64(value, 0) > 0);
            return BitConverter.ToUInt64(value, 0).ToString("X16");
        }
        static bool SameUsbTopology(string[] physical, string[] function, bool composite) {
            foreach (string port in physical) {
                if (!UsbPort.IsMatch(port)) continue;
                foreach (string child in function) {
                    if (!composite && child == port) return true;
                    if (composite && child.StartsWith(port, StringComparison.Ordinal) && UsbInterfaceTail.IsMatch(child.Substring(port.Length))) return true;
                }
            }
            return false;
        }
        static string[] ReadWindowsUsbScope(uint endpointNode, uint functionNode, uint physicalNode, string functionBase, Progress progress) {
            progress.Stage = IdentityStage.UsbDriver;
            string service = NodeString(functionNode, Service).ToUpperInvariant();
            Require((service == "USBAUDIO" || service == "USBAUDIO2") && new Guid(ReadNodeProperty(functionNode, ClassGuid, DevGuid)) == AudioSetupClass);
            string functionHardware = Hardware(functionNode, functionBase);
            progress.Stage = IdentityStage.Topology;
            string[] physicalPaths = NodeStringList(physicalNode, LocationPaths), functionPaths = NodeStringList(functionNode, LocationPaths);
            Require(SameUsbTopology(physicalPaths, functionPaths, physicalNode != functionNode));
            Array.Sort(physicalPaths, StringComparer.Ordinal); Array.Sort(functionPaths, StringComparer.Ordinal);
            progress.Stage = IdentityStage.Arrival;
            return new string[] {service, functionHardware, String.Join("\n", physicalPaths), String.Join("\n", functionPaths),
                Arrival(endpointNode), Arrival(functionNode), Arrival(physicalNode)};
        }
        static UsbObservation ReadPhysicalUsb(uint node, Guid container, bool windowsEndpoint, Progress progress) {
            uint endpointNode = node, functionNode = 0;
            string functionId = null, functionDriver = null, model = null, functionBase = null;
            HashSet<uint> visited = new HashSet<uint>();
            for (int depth = 0; depth < 12; depth++) {
                progress.Stage = IdentityStage.UsbChain;
                Require(visited.Add(node));
                string id = NodeId(node).ToUpperInvariant();
                Match usb = UsbInstance.Match(id);
                if (usb.Success) {
                    Require(Same(NodeString(node, EnumeratorName), "USB") && NodeContainer(node) == container);
                    if (functionId == null) {
                        if (windowsEndpoint) Require(depth == 1);
                        functionNode = node; functionId = id; functionDriver = Driver(node); model = usb.Groups[1].Value;
                        functionBase = model + usb.Groups[2].Value;
                    }
                    Require(model == usb.Groups[1].Value);
                    if (!usb.Groups[2].Success) {
                        if (windowsEndpoint) Require(depth == (functionNode == node ? 1 : 2));
                        progress.Stage = IdentityStage.UsbIdentity;
                        byte[] capability = ReadNodeProperty(node, Capabilities, DevUInt32);
                        Require(capability.Length == 4);
                        uint flags = BitConverter.ToUInt32(capability, 0);
                        bool unique = (flags & UniqueId) != 0 && !usb.Groups[3].Value.Contains("&");
                        Require(windowsEndpoint || unique);
                        List<string> fields = new List<string> {functionId, functionDriver, id, Driver(node), Hardware(node, model)};
                        Require(Locate(id) == node);
                        if (windowsEndpoint) {
                            Require(Locate(functionId) == functionNode);
                            fields.Add(flags.ToString("X8"));
                            fields.AddRange(ReadWindowsUsbScope(endpointNode, functionNode, node, functionBase, progress));
                        }
                        return new UsbObservation {Fields = fields.ToArray(), Unique = unique};
                    }
                } else Require(functionId == null && !id.StartsWith("USB\\", StringComparison.Ordinal));
                uint parent;
                Require(CM_Get_Parent(out parent, node, 0) == 0);
                node = parent;
            }
            throw new InvalidOperationException("USB parent chain exceeds limit");
        }

        static bool Release(Action cleanup) {
            try { cleanup(); return true; } catch { return false; }
        }
        static Observation Observe(Options options, bool windowsEndpoint, Progress progress) {
            IMMDeviceEnumerator enumerator = null; IMMDevice device = null; IPropertyStore store = null;
            IntPtr storePointer = IntPtr.Zero;
            bool complete = false, clean = true;
            try {
                progress.Stage = IdentityStage.Endpoint;
                enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
                Require(enumerator.GetDevice(options.Endpoint, out device) == 0 && device != null);
                uint state; int flow; string observed; Guid guid;
                progress.Stage = IdentityStage.GetId;
                Require(device.GetId(out observed) == 0 && Same(observed, options.Endpoint));
                progress.Stage = IdentityStage.GetState;
                Require(device.GetState(out state) == 0 && state == 1);
                Require(((IMMEndpoint)device).GetDataFlow(out flow) == 0 && flow == 0);
                progress.Stage = IdentityStage.EndpointProperties;
                Require(device.OpenPropertyStore(0, out storePointer) == 0 && storePointer != IntPtr.Zero);
                store = (IPropertyStore)Marshal.GetObjectForIUnknown(storePointer);
                string guidText = ReadEndpointProperty(store, EndpointGuid, 31, VariantString);
                Guid expected = new Guid(options.Endpoint.Substring(options.Endpoint.LastIndexOf('{')));
                Require(Guid.TryParse(guidText, out guid) && guid != Guid.Empty && guid == expected);
                string instance = ReadEndpointInstanceCandidate(store, observed);
                Guid container = ReadEndpointProperty(store, ContainerId, 72, pointer => (Guid)Marshal.PtrToStructure(pointer, typeof(Guid)));
                Require(container != Guid.Empty && container != new Guid("00000000-0000-0000-FFFF-FFFFFFFFFFFF"));
                progress.Stage = IdentityStage.RenderInterface;
                uint endpointNode = Locate(instance);
                string actualInstance = NodeId(endpointNode);
                Require(Same(actualInstance, instance) && Same(NodeString(endpointNode, EnumeratorName), "SWD") &&
                    new Guid(ReadNodeProperty(endpointNode, ClassGuid, DevGuid)) == EndpointSetupClass && NodeContainer(endpointNode) == container);
                string renderInterface = ReadPresentRenderInterface(actualInstance);
                UsbObservation usb = ReadPhysicalUsb(endpointNode, container, windowsEndpoint, progress);
                string confirmedEndpoint;
                progress.Stage = IdentityStage.Reenumeration;
                Require(device.GetId(out confirmedEndpoint) == 0 && Same(confirmedEndpoint, observed) &&
                    device.GetState(out state) == 0 && state == 1 && Locate(instance) == endpointNode);
                string canonical = (windowsEndpoint ? "still-windows-endpoint-v1\0" : "still-usb-identity-v1\0") + observed.ToUpperInvariant() + "\0" +
                    actualInstance.ToUpperInvariant() + "\0" + renderInterface + "\0" + container.ToString("D") + "\0" + String.Join("\0", usb.Fields);
                string digest;
                using (SHA256 hash = SHA256.Create()) digest = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(canonical))).Replace("-", "").ToLowerInvariant();
                complete = true;
                return new Observation {Endpoint = observed, Digest = digest, Guid = guid, Unique = usb.Unique};
            }
            finally {
                if (store != null) clean &= Release(() => Marshal.ReleaseComObject(store));
                if (storePointer != IntPtr.Zero) clean &= Release(() => Marshal.Release(storePointer));
                if (device != null) clean &= Release(() => Marshal.ReleaseComObject(device));
                if (enumerator != null) clean &= Release(() => Marshal.ReleaseComObject(enumerator));
                if (complete && !clean) {progress.Stage = IdentityStage.Cleanup; Require(false);}
            }
        }
        internal static int Check(Options options) {
            bool windowsEndpoint = options.IdentityScope == "windows-endpoint";
            Progress progress = new Progress();
            Observation observation;
            try {
                observation = Observe(options, windowsEndpoint, progress);
                if (windowsEndpoint) {
                    // A new enumerator and complete PnP observation must agree
                    // after the first observation's handles have been released.
                    Observation second = Observe(options, true, progress);
                    progress.Stage = IdentityStage.Reenumeration;
                    Require(observation.Digest == second.Digest && Same(observation.Endpoint, second.Endpoint) && observation.Guid == second.Guid);
                }
            } catch {
                Console.WriteLine("{\"schemaVersion\":2,\"mode\":\"identity\",\"code\":\"STILL_DAC_IDENTITY_UNVERIFIED\",\"failureStage\":" + Quote(progress.Stage.ToString()) + "}");
                return 1;
            }
            string endpointProof = windowsEndpoint ? "true" : "false";
            Console.WriteLine("{\"schemaVersion\":2,\"mode\":\"identity\",\"operation\":\"ReadUsbEndpointIdentity\",\"scope\":" + Quote(options.IdentityScope) + ",\"endpoint\":" + Quote(options.Endpoint) +
                ",\"observedEndpoint\":" + Quote(observation.Endpoint) + ",\"endpointGuid\":" + Quote(observation.Guid.ToString("D")) +
                ",\"endpointState\":1,\"dataFlow\":\"render\",\"identitySha256\":" + Quote(observation.Digest) +
                ",\"usbUniqueInstance\":" + (observation.Unique ? "true" : "false") + ",\"topologyVerified\":" + endpointProof +
                ",\"arrivalVerified\":" + endpointProof + ",\"freshReadVerified\":" + endpointProof +
                ",\"containerMatched\":true,\"cleanupComplete\":true,\"clientActivated\":false,\"initializeCalled\":false,\"startCalled\":false}");
            return 0;
        }
    }

    static Options Parse(string[] args) {
        bool validateOnly = args.Length > 0 && args[0] == "--validate-only";
        int offset = validateOnly ? 1 : 0, count = args.Length - offset;
        if (count > 5) throw new ArgumentException("too many arguments");
        string endpoint = count > 0 ? args[offset] : "{0.0.0.00000000}.{016F9F0C-AFE4-4072-9018-CCEBB576B4CB}";
        string mode = count > 1 ? args[offset + 1] : "shared";
        if (!Regex.IsMatch(endpoint, @"^\{0\.0\.0\.00000000\}\.\{[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\}$"))
            throw new ArgumentException("endpoint must be an explicit CoreAudio render endpoint ID");
        if (mode != "shared" && mode != "support" && mode != "hold" && mode != "exclusive-check" && mode != "state" && mode != "identity")
            throw new ArgumentException("mode must be shared, support, hold, exclusive-check, state or identity");
        if (mode == "identity") {
            string scope = count == 3 ? args[offset + 2] : null;
            if ((scope != "hardware-instance" && scope != "windows-endpoint") ||
                !Regex.IsMatch(endpoint, @"\A\{0\.0\.0\.00000000\}\.\{[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\}\z") ||
                new Guid(endpoint.Substring(endpoint.LastIndexOf('{'))) == Guid.Empty) throw new ArgumentException("identity requires a concrete render endpoint and one explicit scope");
            return new Options {Endpoint = endpoint, Mode = mode, IdentityScope = scope, ValidateOnly = validateOnly};
        }
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
        if (options.Mode == "state") return EndpointStateCheck(options);
        if (options.Mode == "identity") return ReadOnlyIdentity.Check(options);
        string endpoint = options.Endpoint, mode = options.Mode;
        IMMDeviceEnumerator enumerator = null; IMMDevice device = null; object audioObject = null;
        IntPtr format = IntPtr.Zero, closest = IntPtr.Zero;
        try {
            enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            int hr = enumerator.GetDevice(endpoint, out device);
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
