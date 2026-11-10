using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

// Original STILL read-only holder. No playback, process creation, Job,
// directory enumeration, source write, delete, registry or UI operation.
internal static class StillCueReadLease {
    private const int MaxLine = 196608, MaxPath = 2048, MaxDirectories = 512;
    private const ulong MaxCueBytes = 1048576, MaxFileBytes = 9007199254740991;
    private const uint ShareRead = 1, ReadAttributes = 0x80, GenericRead = 0x80000000;
    private const uint OpenReparse = 0x00200000, BackupSemantics = 0x02000000;
    private const uint UnsafeFileAttributes = 0x10 | 0x40 | 0x400 | 0x1000 | 0x4000 | 0x10000 | 0x40000 | 0x400000;
    private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly CultureInfo Invariant = CultureInfo.InvariantCulture;
    private static readonly Regex Hex64 = new Regex("\\A[a-f0-9]{64}\\z", RegexOptions.CultureInvariant);
    private static readonly Regex Decimal = new Regex("\\A(?:0|[1-9][0-9]{0,15})\\z", RegexOptions.CultureInvariant);
    private static readonly Regex Reserved = new Regex("\\A(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\\.|\\z)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly HashSet<string> AudioExtensions = new HashSet<string>(new string[] {
        ".wav", ".wave", ".flac", ".ape", ".wv", ".aif", ".aiff", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".tta", ".tak", ".dff", ".dsf"
    }, StringComparer.OrdinalIgnoreCase);

    [StructLayout(LayoutKind.Sequential)] private struct Time { public uint Low, High; public ulong Value { get { return ((ulong)High << 32) | Low; } } }
    [StructLayout(LayoutKind.Sequential)] private struct Info {
        public uint Attributes; public Time Creation, Access, Write;
        public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        public ulong Size { get { return ((ulong)SizeHigh << 32) | SizeLow; } }
        public ulong Index { get { return ((ulong)IndexHigh << 32) | IndexLow; } }
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFileAttributesW(string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFullPathNameW(string name, uint size, StringBuilder buffer, IntPtr part);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder buffer, uint size, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern uint GetDriveTypeW(string root);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetVolumeInformationW(string root, StringBuilder name, uint nameSize, out uint serial, out uint componentLength, out uint flags, StringBuilder fileSystem, uint fileSystemSize);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetFileInformationByHandle(IntPtr handle, out Info info);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint GetFileType(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool SetFilePointerEx(IntPtr handle, long distance, out long position, uint method);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ReadFile(IntPtr handle, byte[] bytes, uint size, out uint read, IntPtr overlap);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr handle, out Time creation, out Time exit, out Time kernel, out Time user);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForMultipleObjects(uint count, IntPtr[] handles, bool all, uint timeout);
    [DllImport("ntdll.dll")] private static extern int NtQueryInformationProcess(IntPtr process, int kind, IntPtr info, uint size, out uint returned);

    private sealed class Rejected : Exception { public readonly string Code; public Rejected(string code) { Code = code; } }
    private static void Require(bool value, string code) { if (!value) throw new Rejected(code); }
    private static string Extended(string path) { return "\\\\?\\" + path; }
    private static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
    private static string Hash(byte[] bytes) { using (SHA256 sha = SHA256.Create()) return Hex(sha.ComputeHash(bytes)); }
    private static bool EqualPath(string a, string b) { return String.Equals(a.TrimEnd('\\'), b.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase); }
    private static string Parent(string value) { int at = value.LastIndexOf('\\'); return at == 2 ? value.Substring(0, 3) : value.Substring(0, at); }
    private static string Canonical(string value, bool directory) {
        Require(value != null && value.Length >= 3 && value.Length <= MaxPath &&
            ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z')) && value[1] == ':' && value[2] == '\\', "PATH");
        Require(directory || !value.EndsWith("\\", StringComparison.Ordinal), "PATH");
        for (int i = 0; i < value.Length; i++) Require(value[i] >= 32 && value[i] != 127 && "<>\"|?*/".IndexOf(value[i]) < 0 && (value[i] != ':' || i == 1), "PATH");
        string remainder = value.Substring(3);
        if (remainder.Length > 0) foreach (string part in remainder.Split('\\')) {
            Require(part.Length > 0 && part != "." && part != ".." && !part.EndsWith(".", StringComparison.Ordinal) && !part.EndsWith(" ", StringComparison.Ordinal) && !Reserved.IsMatch(part), "PATH");
        }
        StringBuilder buffer = new StringBuilder(32768);
        uint length = GetFullPathNameW(value, (uint)buffer.Capacity, buffer, IntPtr.Zero);
        Require(length > 0 && length < buffer.Capacity && String.Equals(value, buffer.ToString(), StringComparison.OrdinalIgnoreCase), "PATH");
        uint drive = GetDriveTypeW(value.Substring(0, 3));
        Require(drive == 2 || drive == 3, "PATH"); // local removable or fixed drives only
        // This admission contract relies on NTFS's volume + 64-bit file IDs.
        // Unknown file systems (including ReFS's different 128-bit identity
        // contract) are rejected rather than silently weakening root binding.
        uint serial, componentLength, flags; StringBuilder fileSystem = new StringBuilder(32);
        Require(GetVolumeInformationW(value.Substring(0, 3), null, 0, out serial, out componentLength, out flags, fileSystem, (uint)fileSystem.Capacity) && fileSystem.ToString() == "NTFS", "PATH");
        return buffer.ToString();
    }
    private static string DecodePath(string token, bool directory) {
        Require(token.Length <= 12000 && token.Length % 4 == 0 && Regex.IsMatch(token, "\\A[A-Za-z0-9+/]*={0,2}\\z", RegexOptions.CultureInvariant), "INPUT");
        byte[] bytes = Convert.FromBase64String(token);
        Require(Convert.ToBase64String(bytes) == token, "INPUT");
        return Canonical(Utf8.GetString(bytes), directory);
    }
    private static ulong Number(string value, ulong max) { ulong parsed; Require(Decimal.IsMatch(value) && UInt64.TryParse(value, NumberStyles.None, Invariant, out parsed), "INPUT"); parsed = UInt64.Parse(value, Invariant); Require(parsed <= max, "INPUT"); return parsed; }
    private static string ReadLine(Stream input, int limit) {
        byte[] bytes = new byte[limit]; int used = 0;
        while (true) {
            int next = input.ReadByte();
            if (next < 0) { Require(used == 0, "PROTOCOL"); return null; }
            if (next == 10) return Encoding.ASCII.GetString(bytes, 0, used);
            Require((next == 9 || next >= 32) && next < 127 && used < limit, "PROTOCOL"); bytes[used++] = (byte)next;
        }
    }
    private sealed class ParentMonitor {
        private readonly IntPtr handle; private readonly ManualResetEvent stop; private readonly Thread watcher; private bool closed;
        public readonly uint Pid; public readonly ulong Birth, ChildBirth;
        public ParentMonitor(string argument) {
            Pid = (uint)Number(argument, UInt32.MaxValue); Require(Pid > 0 && Pid != GetCurrentProcessId() && IntPtr.Size == 8, "PARENT");
            // PROCESS_BASIC_INFORMATION x64: inherited kernel parent PID@40.
            IntPtr basic = Marshal.AllocHGlobal(48);
            try {
                uint returned; Require(NtQueryInformationProcess(new IntPtr(-1), 0, basic, 48, out returned) == 0 && returned == 48 && Marshal.ReadIntPtr(basic, 40).ToInt64() == Pid, "PARENT");
            } finally { Marshal.FreeHGlobal(basic); }
            handle = OpenProcess(0x00101000, false, Pid); Require(handle != IntPtr.Zero, "PARENT");
            try {
                Time birth, exit, kernel, user, child, ignored;
                Require(WaitForSingleObject(handle, 0) == 258, "PARENT");
                Require(GetProcessTimes(handle, out birth, out exit, out kernel, out user), "PARENT");
                Require(GetProcessTimes(new IntPtr(-1), out child, out ignored, out kernel, out user), "PARENT");
                // A PID reused after this child was created cannot satisfy this
                // ordering. The open kernel HANDLE then binds the same object.
                Birth = birth.Value; ChildBirth = child.Value;
                Require(Birth > 0 && Birth < ChildBirth && exit.Value == 0 && WaitForSingleObject(handle, 0) == 258, "PARENT");
                stop = new ManualResetEvent(false);
                watcher = new Thread(delegate() {
                    uint result = WaitForMultipleObjects(2, new IntPtr[] {handle, stop.SafeWaitHandle.DangerousGetHandle()}, false, UInt32.MaxValue);
                    if (result != 1) Environment.Exit(3); // only this holder exits; no CLOSED claim
                });
                watcher.IsBackground = true; watcher.Start();
            } catch { CloseHandle(handle); throw; }
        }
        public bool IsDead { get { return !closed && WaitForSingleObject(handle, 0) == 0; } }
        public void Close() {
            if (closed) return;
            stop.Set(); Require(watcher.Join(2000), "CLOSE");
            Require(CloseHandle(handle), "CLOSE"); stop.Dispose(); closed = true;
        }
    }
    private sealed class Expected {
        public uint Volume; public ulong Index, Size;
        public static Expected Parse(string token, bool file) {
            string[] parts = token.Split(':');
            Require(parts.Length == (file ? 3 : 2) && Regex.IsMatch(parts[0], "\\A[a-f0-9]{8}\\z") && Regex.IsMatch(parts[1], "\\A[a-f0-9]{16}\\z"), "INPUT");
            Expected result = new Expected {Volume = UInt32.Parse(parts[0], NumberStyles.HexNumber, Invariant), Index = UInt64.Parse(parts[1], NumberStyles.HexNumber, Invariant)};
            Require(result.Index != 0, "IDENTITY"); if (file) result.Size = Number(parts[2], MaxFileBytes); return result;
        }
        public bool Matches(Info info, bool file) { return Volume == info.Volume && Index == info.Index && (!file || Size == info.Size); }
    }
    private sealed class Request {
        public string Nonce, Binding, ContentHash, Root; public string[] Paths; public Expected RootIdentity; public Expected[] Files;
        public static Request Parse(string line) {
            Require(line != null, "INPUT"); string[] parts = line.Split('\t');
            Require(parts.Length >= 13 && parts[0] == "ACQUIRE1" && Hex64.IsMatch(parts[1]) && Hex64.IsMatch(parts[2]) && Hex64.IsMatch(parts[3]), "INPUT");
            Require(parts[4] == "utf-8" || parts[4] == "utf-16le" || parts[4] == "utf-16be" || parts[4] == "gb18030", "INPUT");
            Require(Number(parts[5], 99) > 0, "INPUT"); int references = (int)Number(parts[6], 32);
            Require(references > 0 && parts.Length == 11 + references * 2, "INPUT");
            Require(Hash(Utf8.GetBytes(String.Join("\t", parts, 3, parts.Length - 3))) == parts[2], "INPUT");
            Request result = new Request {Nonce = parts[1], Binding = parts[2], ContentHash = parts[3], Root = DecodePath(parts[7], true), RootIdentity = Expected.Parse(parts[8], false), Paths = new string[references + 1], Files = new Expected[references + 1]};
            HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase); int total = result.Root.Length;
            for (int i = 0; i < result.Paths.Length; i++) {
                string name = DecodePath(parts[9 + i * 2], false); Expected expected = Expected.Parse(parts[10 + i * 2], true);
                Require(name.StartsWith(result.Root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase) && seen.Add(name), "PATH");
                int dot = name.LastIndexOf('.'); Require(dot >= name.LastIndexOf('\\') && (i == 0 ? String.Equals(name.Substring(dot), ".cue", StringComparison.OrdinalIgnoreCase) : AudioExtensions.Contains(name.Substring(dot))), "PATH");
                Require(i != 0 || expected.Size > 0 && expected.Size <= MaxCueBytes, "INPUT");
                result.Paths[i] = name; result.Files[i] = expected; total += name.Length;
            }
            Require(total <= 32768, "INPUT"); return result;
        }
    }
    private sealed class Held {
        public readonly string Path; public readonly bool Directory; public readonly IntPtr Handle; public readonly Info Initial;
        public Held(string path, bool directory) {
            Path = path; Directory = directory;
            uint attributes = GetFileAttributesW(Extended(path)); Require(attributes != UInt32.MaxValue && (directory ? (attributes & 0x410) == 0x10 : (attributes & UnsafeFileAttributes) == 0), "PATH");
            Handle = CreateFileW(Extended(path), directory ? 0x81 : GenericRead | ReadAttributes, ShareRead, IntPtr.Zero, 3, OpenReparse | (directory ? BackupSemantics : 0), IntPtr.Zero);
            Require(Handle != new IntPtr(-1) && Handle != IntPtr.Zero, "SHARING");
            try { Initial = Inspect(Handle); VerifyName(Handle); }
            catch { CloseHandle(Handle); throw; }
        }
        private Info Inspect(IntPtr handle) {
            Require(GetFileType(handle) == 1, "IO"); Info info = GetInfo(handle);
            Require(Directory ? (info.Attributes & 0x410) == 0x10 : (info.Attributes & UnsafeFileAttributes) == 0 && info.Links == 1 && info.Size <= MaxFileBytes, "IDENTITY");
            Require(info.Index != 0, "IDENTITY"); return info;
        }
        private void VerifyName(IntPtr handle) {
            StringBuilder buffer = new StringBuilder(32768); uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
            Require(length > 0 && length < buffer.Capacity && EqualPath(buffer.ToString(), Extended(Path)), "PATH");
        }
        private static Info GetInfo(IntPtr handle) { Info info; Require(GetFileInformationByHandle(handle, out info), "IO"); return info; }
        private void Same(Info current) {
            Require(current.Volume == Initial.Volume && current.Index == Initial.Index && current.Creation.Value == Initial.Creation.Value &&
                (Directory || current.Size == Initial.Size && current.Write.Value == Initial.Write.Value && current.Attributes == Initial.Attributes), "IDENTITY");
        }
        public void Verify() {
            Same(Inspect(Handle)); VerifyName(Handle);
            IntPtr named = CreateFileW(Extended(Path), ReadAttributes, ShareRead, IntPtr.Zero, 3, OpenReparse | (Directory ? BackupSemantics : 0), IntPtr.Zero);
            Require(named != new IntPtr(-1) && named != IntPtr.Zero, "IDENTITY");
            try { Same(Inspect(named)); VerifyName(named); } finally { Require(CloseHandle(named), "CLOSE"); }
        }
        public string Metadata() {
            return Initial.Volume.ToString("x8", Invariant) + ":" + Initial.Index.ToString("x16", Invariant) + ":" + Initial.Size.ToString(Invariant) + ":" +
                Initial.Creation.Value.ToString("x16", Invariant) + ":" + Initial.Write.Value.ToString("x16", Invariant) + ":" + Initial.Attributes.ToString("x8", Invariant) + ":1";
        }
    }
    private sealed class Lease {
        public readonly Request Request; public readonly List<Held> Directories = new List<Held>(), Files = new List<Held>();
        public Lease(Request request) { Request = request; }
        public void Acquire() {
            // Preserve distinct spellings until root object IDs have been
            // checked; case-sensitive directories must not merge lock paths.
            HashSet<string> paths = new HashSet<string>(StringComparer.Ordinal);
            foreach (string file in Request.Paths) {
                string current = Parent(file);
                while (true) { paths.Add(current); if (current.Length == 3) break; current = Parent(current); }
            }
            paths.Add(Request.Root); Require(paths.Count <= MaxDirectories, "PATH");
            List<string> ordered = new List<string>(paths);
            ordered.Sort(delegate(string a, string b) { int depth = a.Length.CompareTo(b.Length); return depth == 0 ? StringComparer.OrdinalIgnoreCase.Compare(a, b) : depth; });
            bool rootSeen = false;
            foreach (string directory in ordered) {
                Held held = new Held(directory, true); Directories.Add(held);
                if (EqualPath(directory, Request.Root)) { Require(Request.RootIdentity.Matches(held.Initial, false), "IDENTITY"); rootSeen = true; }
            }
            Require(rootSeen, "IDENTITY");
            for (int i = 0; i < Request.Paths.Length; i++) { Held held = new Held(Request.Paths[i], false); Files.Add(held); Require(Request.Files[i].Matches(held.Initial, true), "IDENTITY"); }
            Verify();
        }
        private string CueHash() {
            Held cue = Files[0]; byte[] buffer = new byte[65536]; ulong total = 0; long position;
            try {
                Require(SetFilePointerEx(cue.Handle, 0, out position, 0) && position == 0, "IO");
                using (SHA256 sha = SHA256.Create()) {
                    while (true) {
                        uint count; Require(ReadFile(cue.Handle, buffer, (uint)buffer.Length, out count, IntPtr.Zero), "IO");
                        if (count == 0) break; total += count;
                        Require(total <= MaxCueBytes && total <= cue.Initial.Size, "HASH"); sha.TransformBlock(buffer, 0, (int)count, null, 0);
                    }
                    Require(total == cue.Initial.Size, "HASH"); sha.TransformFinalBlock(new byte[0], 0, 0); return Hex(sha.Hash);
                }
            } finally { Array.Clear(buffer, 0, buffer.Length); }
        }
        public void Verify() {
            foreach (Held directory in Directories) directory.Verify(); foreach (Held file in Files) file.Verify();
            Require(CueHash() == Request.ContentHash, "HASH");
            foreach (Held file in Files) file.Verify(); foreach (Held directory in Directories) directory.Verify();
        }
        public string Metadata() { string[] rows = new string[Files.Count]; for (int i = 0; i < rows.Length; i++) rows[i] = Files[i].Metadata(); return String.Join("\t", rows); }
        public int Close() {
            int count = 0; bool success = true;
            for (int i = Files.Count - 1; i >= 0; i--) { success &= CloseHandle(Files[i].Handle); count++; } Files.Clear();
            for (int i = Directories.Count - 1; i >= 0; i--) { success &= CloseHandle(Directories[i].Handle); count++; } Directories.Clear();
            Require(success, "CLOSE"); return count;
        }
    }
    private static int Main(string[] args) {
        Lease lease = null; Request request = null; StreamWriter output = null; ParentMonitor parent = null;
        try {
            Require(args.Length == 3 && args[0] == "--stdio-read-lease-v1" && args[1] == "--parent-pid", "INPUT");
            parent = new ParentMonitor(args[2]);
            Stream input = Console.OpenStandardInput(); output = new StreamWriter(Console.OpenStandardOutput(), Utf8); output.AutoFlush = true;
            request = Request.Parse(ReadLine(input, MaxLine)); lease = new Lease(request); lease.Acquire();
            output.WriteLine("READY1\t" + request.Nonce + "\t" + request.Binding + "\t" + GetCurrentProcessId().ToString(Invariant) + "\t" + parent.Pid.ToString(Invariant) + "\t" + parent.Birth.ToString("x16", Invariant) + "\t" + parent.ChildBirth.ToString("x16", Invariant) + "\t" + lease.Files.Count.ToString(Invariant) + "\t" + lease.Directories.Count.ToString(Invariant) + "\t" + request.ContentHash + "\t" + lease.Metadata());
            ulong sequence = 0;
            for (int commands = 0; commands < 4096; commands++) {
                string line = ReadLine(input, 256); Require(line != null, "EOF"); string[] fields = line.Split('\t');
                Require(fields.Length == 3 && fields[1] == request.Nonce, "PROTOCOL"); ulong next = Number(fields[2], UInt32.MaxValue);
                Require(next > sequence, "PROTOCOL"); sequence = next;
                if (fields[0] == "CLOSE1") {
                    int closed = lease.Close(); parent.Close();
                    output.WriteLine("CLOSED1\t" + request.Nonce + "\t" + request.Binding + "\t" + sequence.ToString(Invariant) + "\t" + closed.ToString(Invariant) + "\t0"); return 0;
                }
                Require(fields[0] == "CHECK1", "PROTOCOL"); lease.Verify();
                output.WriteLine("CHECKED1\t" + request.Nonce + "\t" + request.Binding + "\t" + sequence.ToString(Invariant) + "\t" + request.ContentHash + "\t" + lease.Metadata());
            }
            throw new Rejected("PROTOCOL");
        } catch (Rejected error) {
            bool parentDead = parent != null && parent.IsDead;
            try { if (output != null && request != null) output.WriteLine("ERROR1\t" + request.Nonce + "\t" + request.Binding + "\t" + (parentDead ? "PARENT" : error.Code)); } catch { }
            return parentDead ? 3 : 2;
        } catch {
            try { if (output != null && request != null) output.WriteLine("ERROR1\t" + request.Nonce + "\t" + request.Binding + "\tIO"); } catch { }
            return 4;
        } finally {
            try { if (lease != null) lease.Close(); } catch { }
            try { if (parent != null) parent.Close(); } catch { }
            try { if (output != null) output.Dispose(); } catch { }
        }
    }
}
