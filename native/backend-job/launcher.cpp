// Copyright (c) 2026 STILL contributors. SPDX-License-Identifier: MIT
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <tlhelp32.h>
#include <bcrypt.h>
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
// Diagnostic metadata never authorizes process creation, ownership or exit.
// The phase is selected by this source, never by command-line or file input.
enum class Phase { Arguments, BackendPaths, ParentIdentity, ParentOpen, ParentLiveness, ParentTime,
  Watchers, PrivateDirectories, PortableMarker, ExecutableOpen, ExecutableHash, ConfigOpen, ConfigHash,
  Environment, JobCreate, JobConfigure, CompletionCreate, CompletionAssociate, ChildCreate,
  ChildIdentity, CreatedNotification, CreatedAck, ParentRecheck, JobTransfer, ChildResume, ChildObserve, ExitHelper };
thread_local Phase currentPhase = Phase::Arguments;
const char* phaseName(Phase phase) {
  switch (phase) {
    case Phase::Arguments: return "arguments"; case Phase::BackendPaths: return "backend-paths";
    case Phase::ParentIdentity: return "parent-identity"; case Phase::ParentOpen: return "parent-open";
    case Phase::ParentLiveness: return "parent-liveness"; case Phase::ParentTime: return "parent-time";
    case Phase::Watchers: return "watchers"; case Phase::PrivateDirectories: return "private-directories";
    case Phase::PortableMarker: return "portable-marker"; case Phase::ExecutableOpen: return "executable-open";
    case Phase::ExecutableHash: return "executable-hash"; case Phase::ConfigOpen: return "config-open";
    case Phase::ConfigHash: return "config-hash"; case Phase::Environment: return "environment";
    case Phase::JobCreate: return "job-create"; case Phase::JobConfigure: return "job-configure";
    case Phase::CompletionCreate: return "completion-create"; case Phase::CompletionAssociate: return "completion-associate";
    case Phase::ChildCreate: return "child-create"; case Phase::ChildIdentity: return "child-identity";
    case Phase::CreatedNotification: return "created-notification"; case Phase::CreatedAck: return "created-ack";
    case Phase::ParentRecheck: return "parent-recheck"; case Phase::JobTransfer: return "job-transfer";
    case Phase::ChildResume: return "child-resume"; case Phase::ChildObserve: return "child-observe";
    case Phase::ExitHelper: return "exit-helper";
  }
  return "arguments";
}
struct DiagnosticFailure { Phase phase; unsigned line; const char* domain; DWORD status; bool hasStatus; };
// Read the native status at the failing boundary, before any cleanup can
// overwrite it. BCrypt returns NTSTATUS and must never use GetLastError.
#define require(ok) do { if (!(ok)) throw DiagnosticFailure{currentPhase, __LINE__, "validation", 0, false}; } while (false)
#define requireWin32(ok) do { if (!(ok)) { const DWORD failureStatus = GetLastError(); throw DiagnosticFailure{currentPhase, __LINE__, "win32", failureStatus, true}; } } while (false)
#define requireNtstatus(call) do { const NTSTATUS failureStatus = (call); if (failureStatus != 0) throw DiagnosticFailure{currentPhase, __LINE__, "ntstatus", static_cast<DWORD>(failureStatus), true}; } while (false)
#define requireWait(call, expected) do { const DWORD waitResult = (call); requireWin32(waitResult != WAIT_FAILED); require(waitResult == (expected)); } while (false)
struct Handle {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE item) : value(item) {}
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept : value(other.release()) {}
  Handle& operator=(Handle&& other) noexcept { reset(other.release()); return *this; }
  ~Handle() { reset(); }
  HANDLE get() const { return value; }
  HANDLE release() { HANDLE item = value; value = nullptr; return item; }
  void reset(HANDLE item = nullptr) { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = item; }
};
std::uint64_t timeValue(FILETIME value) { return (std::uint64_t(value.dwHighDateTime) << 32) | value.dwLowDateTime; }
std::uint64_t creationTime(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{};
  requireWin32(GetProcessTimes(process, &created, &exited, &kernel, &user) != FALSE); return timeValue(created);
}
bool equalPath(const std::wstring& left, const std::wstring& right) {
  return CompareStringOrdinal(left.c_str(), -1, right.c_str(), -1, TRUE) == CSTR_EQUAL;
}
std::wstring fullPath(const std::wstring& input) {
  require(!input.empty() && input.find_first_of(L"\r\n") == std::wstring::npos);
  DWORD size = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr); requireWin32(size > 0); require(size < 32760);
  std::wstring value(size, L'\0'); DWORD copied = GetFullPathNameW(input.c_str(), size, value.data(), nullptr);
  requireWin32(copied > 0); require(copied < size); value.resize(copied);
  while (value.size() > 3 && value.back() == L'\\') value.pop_back();
  // A private portable backend is on a local volume. No remote path is opened.
  require(value.size() > 3 && value[1] == L':' && value[2] == L'\\'); return value;
}
std::wstring finalPath(HANDLE file) {
  DWORD size = GetFinalPathNameByHandleW(file, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  requireWin32(size > 0); require(size < 32760); std::wstring value(size + 1, L'\0');
  DWORD copied = GetFinalPathNameByHandleW(file, value.data(), DWORD(value.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  requireWin32(copied > 0); require(copied < value.size()); value.resize(copied);
  if (value.rfind(L"\\\\?\\", 0) == 0) value.erase(0, 4); return value;
}
Handle privateFile(const std::wstring& value, bool directory = false) {
  Handle file(CreateFileW(value.c_str(), directory ? FILE_READ_ATTRIBUTES : GENERIC_READ,
    directory ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_READ, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr));
  requireWin32(file.get() && file.get() != INVALID_HANDLE_VALUE);
  BY_HANDLE_FILE_INFORMATION info{}; requireWin32(GetFileInformationByHandle(file.get(), &info) != FALSE);
  require((info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) == 0 &&
    ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0) == directory && equalPath(finalPath(file.get()), value));
  return file;
}
std::string utf8(const std::wstring& value) {
  int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), int(value.size()), nullptr, 0, nullptr, nullptr);
  require(length >= 0); std::string result(length, '\0');
  if (length) requireWin32(WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), int(value.size()), result.data(), length, nullptr, nullptr) == length);
  return result;
}
std::string json(const std::string& value) {
  std::string result = "\"";
  for (unsigned char ch : value) {
    if (ch == '"' || ch == '\\') { result += '\\'; result += char(ch); }
    else if (ch < 32) { char escaped[7]{}; std::snprintf(escaped, sizeof(escaped), "\\u%04x", unsigned(ch)); result += escaped; }
    else result += char(ch);
  }
  return result + '"';
}
std::string diagnosticFields(const DiagnosticFailure& failure) {
  return ",\"nativeFailure\":{\"schemaVersion\":1,\"phase\":" + json(phaseName(failure.phase)) +
    ",\"checkLine\":" + std::to_string(failure.line) + ",\"domain\":" + json(failure.domain) +
    ",\"status\":" + (failure.hasStatus ? std::to_string(failure.status) : "null") + "}";
}
std::string hashFile(HANDLE file) {
  BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
  requireNtstatus(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0));
  std::vector<unsigned char> object, buffer(65536);
  struct Cleanup { BCRYPT_ALG_HANDLE a; BCRYPT_HASH_HANDLE& h; ~Cleanup() { if (h) BCryptDestroyHash(h); BCryptCloseAlgorithmProvider(a, 0); } } cleanup{algorithm, hash};
  DWORD bytes = 0, length = 0; requireNtstatus(BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&length), sizeof(length), &bytes, 0));
  object.resize(length); unsigned char digest[32]{};
  requireNtstatus(BCryptCreateHash(algorithm, &hash, object.data(), length, nullptr, 0, 0));
  LARGE_INTEGER begin{}; requireWin32(SetFilePointerEx(file, begin, nullptr, FILE_BEGIN) != FALSE);
  for (;;) { DWORD count = 0; requireWin32(ReadFile(file, buffer.data(), DWORD(buffer.size()), &count, nullptr) != FALSE); if (!count) break;
    requireNtstatus(BCryptHashData(hash, buffer.data(), count, 0)); }
  requireNtstatus(BCryptFinishHash(hash, digest, sizeof(digest), 0));
  const char* digits = "0123456789abcdef"; std::string result; result.reserve(64);
  for (unsigned char byte : digest) { result += digits[byte >> 4]; result += digits[byte & 15]; } return result;
}
bool hex64(const std::string& value) {
  return value.size() == 64 && std::all_of(value.begin(), value.end(), [](char ch) { return (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f'); });
}
DWORD actualParentPid() {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)); requireWin32(snapshot.get() != INVALID_HANDLE_VALUE);
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry);
  requireWin32(Process32FirstW(snapshot.get(), &entry) != FALSE);
  do { if (entry.th32ProcessID == GetCurrentProcessId()) return entry.th32ParentProcessID; } while (Process32NextW(snapshot.get(), &entry));
  require(false);
}
void assertNonInheritable(HANDLE handle) {
  DWORD flags = 0; requireWin32(GetHandleInformation(handle, &flags) != FALSE); require((flags & HANDLE_FLAG_INHERIT) == 0);
}
struct Attributes {
  std::vector<unsigned char> memory; LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
  Attributes() {
    SIZE_T size = 0; InitializeProcThreadAttributeList(nullptr, 1, 0, &size); require(size > 0);
    memory.resize(size); value = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(memory.data());
    requireWin32(InitializeProcThreadAttributeList(value, 1, 0, &size) != FALSE);
  }
  ~Attributes() { if (value) DeleteProcThreadAttributeList(value); }
};
// Attribute values must survive CreateProcess, so update with the caller's
// stable HANDLE storage immediately before use (not the constructor parameter).
Handle createProcess(const std::wstring& executable, const std::wstring& directory, const std::wstring& argument,
  DWORD_PTR attribute, HANDLE& attributeHandle, bool suspended, Handle* primaryThread = nullptr, DWORD* pid = nullptr) {
  Attributes attributes;
  requireWin32(UpdateProcThreadAttribute(attributes.value, 0, attribute, &attributeHandle, sizeof(attributeHandle), nullptr, nullptr) != FALSE);
  STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes.value;
  startup.StartupInfo.dwFlags = STARTF_USESHOWWINDOW; startup.StartupInfo.wShowWindow = SW_HIDE;
  std::wstring command = L"\"" + executable + L"\" " + argument; PROCESS_INFORMATION information{};
  // JOB_LIST is atomic. There is deliberately no CreateProcess + Assign fallback.
  requireWin32(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE,
    EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | (suspended ? CREATE_SUSPENDED : 0),
    nullptr, directory.c_str(), &startup.StartupInfo, &information) != FALSE);
  // NULL process/thread SECURITY_ATTRIBUTES return non-inheritable handles.
  // Do not add fallible checks here: after successful creation a suspended
  // command helper must always be handed to its caller for exact rollback.
  Handle process(information.hProcess), thread(information.hThread);
  if (primaryThread) *primaryThread = std::move(thread); if (pid) *pid = information.dwProcessId; return process;
}
struct Channel {
  std::string nonce; unsigned sequence = 0;
  bool emit(const char* type, const std::string& fields = "") {
    std::string line = "{\"schemaVersion\":1,\"nonce\":" + json(nonce) + ",\"sequence\":" + std::to_string(++sequence) +
      ",\"type\":" + json(type) + fields + "}\n";
    DWORD written = 0; return WriteFile(GetStdHandle(STD_OUTPUT_HANDLE), line.data(), DWORD(line.size()), &written, nullptr) && written == line.size();
  }
};
struct Threads {
  std::atomic<bool> stop{false}, ack{false}, invalid{false}; std::atomic<unsigned> exits{0};
  Handle stopEvent{CreateEventW(nullptr, TRUE, FALSE, nullptr)};
  const DWORD stopEventError = stopEvent.get() ? ERROR_SUCCESS : GetLastError(); std::thread parent, input;
  ~Threads() {
    stop = true; SetEvent(stopEvent.get());
    if (input.joinable()) input.join();
    if (parent.joinable()) parent.join();
  }
  void start(HANDLE owner, const std::string& nonce) {
    if (!stopEvent.get()) throw DiagnosticFailure{currentPhase, __LINE__, "win32", stopEventError, true};
    parent = std::thread([this, owner] { HANDLE waits[]{owner, stopEvent.get()};
      if (WaitForMultipleObjects(2, waits, FALSE, INFINITE) == WAIT_OBJECT_0) {
        // Real parent termination, not stdin EOF or a timeout. Closing this
        // process also closes any pre-transfer Job; post-transfer it holds none.
        ExitProcess(0);
      }
    });
    input = std::thread([this, nonce] {
      std::string line; char character = 0; DWORD count = 0;
      while (!stop) {
        DWORD available = 0;
        if (!PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr)) break;
        if (!available) { if (WaitForSingleObject(stopEvent.get(), 10) == WAIT_OBJECT_0) break; continue; }
        // This is the sole reader and reads no more than PeekNamedPipe reported.
        // It cannot enter a new blocking read after cancellation, so join has
        // no CancelSynchronousIo-before-next-ReadFile race.
        if (stop || !ReadFile(GetStdHandle(STD_INPUT_HANDLE), &character, 1, &count, nullptr) || count != 1) break;
        if (character == '\n') {
          if (line == "ACK " + nonce) ack = true;
          else if (line == "EXIT " + nonce) ++exits;
          else invalid = true;
          line.clear();
        } else if (line.size() < 256 && character != '\r' && character != '\0') line += character;
        else { invalid = true; break; }
      }
      // EOF intentionally has no lifetime effect. Only owner HANDLE signal does.
    });
  }
};
int run(int argc, wchar_t** argv) {
  std::map<std::wstring, std::wstring> arguments; bool stopped = false;
  for (int index = 1; index < argc; ++index) {
    std::wstring name = argv[index];
    if (name == L"--start-stopped") { require(!stopped); stopped = true; continue; }
    require(index + 1 < argc && arguments.emplace(name, argv[index + 1]).second); ++index;
  }
  require(arguments.size() == 6);
  Channel channel{utf8(arguments.at(L"--nonce"))}; require(hex64(channel.nonce));
  try {
    currentPhase = Phase::BackendPaths;
    const std::wstring root = fullPath(arguments.at(L"--backend-dir"));
    const std::wstring executable = root + L"\\foobar2000.exe", profile = root + L"\\profile\\beefweb\\config.json";
    const std::string imageHash = utf8(arguments.at(L"--exe-sha256")), configHash = utf8(arguments.at(L"--config-sha256"));
    const std::string backendId = utf8(arguments.at(L"--backend-id"));
    require(hex64(imageHash) && hex64(configHash) && !backendId.empty() && backendId.size() <= 200);
    currentPhase = Phase::ParentIdentity;
    std::size_t parsed = 0; unsigned long ownerNumber = std::stoul(arguments.at(L"--parent-pid"), &parsed);
    require(parsed == arguments.at(L"--parent-pid").size() && ownerNumber > 0 && ownerNumber == actualParentPid());
    currentPhase = Phase::ParentOpen;
    Handle owner(OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_DUP_HANDLE, FALSE, DWORD(ownerNumber)));
    requireWin32(owner.get() != nullptr);
    currentPhase = Phase::ParentLiveness;
    requireWait(WaitForSingleObject(owner.get(), 0), WAIT_TIMEOUT);
    // A reused parent PID must have been born after this broker. Retain the
    // original kernel process handle for the complete broker lifetime.
    currentPhase = Phase::ParentTime;
    require(creationTime(owner.get()) <= creationTime(GetCurrentProcess()));
    currentPhase = Phase::Watchers;
    Threads threads; threads.start(owner.get(), channel.nonce);
    std::vector<Handle> locks;
    currentPhase = Phase::PrivateDirectories;
    locks.push_back(privateFile(root, true)); locks.push_back(privateFile(root + L"\\profile", true));
    locks.push_back(privateFile(root + L"\\profile\\beefweb", true));
    currentPhase = Phase::PortableMarker;
    locks.push_back(privateFile(root + L"\\portable_mode_enabled"));
    currentPhase = Phase::ExecutableOpen;
    locks.push_back(privateFile(executable));
    currentPhase = Phase::ExecutableHash;
    require(hashFile(locks.back().get()) == imageHash);
    currentPhase = Phase::ConfigOpen;
    locks.push_back(privateFile(profile));
    currentPhase = Phase::ConfigHash;
    require(hashFile(locks.back().get()) == configHash);
    currentPhase = Phase::Environment;
    requireWin32(SetEnvironmentVariableW(L"BEEFWEB_CONFIG_FILE", profile.c_str()) != FALSE);
    currentPhase = Phase::JobCreate;
    Handle job(CreateJobObjectW(nullptr, nullptr)); requireWin32(job.get() != nullptr); assertNonInheritable(job.get());
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{}; limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    currentPhase = Phase::JobConfigure;
    requireWin32(SetInformationJobObject(job.get(), JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE);
    currentPhase = Phase::CompletionCreate;
    Handle completion(CreateIoCompletionPort(INVALID_HANDLE_VALUE, nullptr, 0, 1)); requireWin32(completion.get() != nullptr); assertNonInheritable(completion.get());
    int completionIdentity = 0; JOBOBJECT_ASSOCIATE_COMPLETION_PORT association{&completionIdentity, completion.get()};
    currentPhase = Phase::CompletionAssociate;
    requireWin32(SetInformationJobObject(job.get(), JobObjectAssociateCompletionPortInformation, &association, sizeof(association)) != FALSE);
    Handle primaryThread; DWORD pid = 0; HANDLE localJob = job.get();
    currentPhase = Phase::ChildCreate;
    Handle child = createProcess(executable, root, stopped ? L"/hide /stop" : L"/hide", PROC_THREAD_ATTRIBUTE_JOB_LIST, localJob, true, &primaryThread, &pid);
    wchar_t imageName[32768]{}; DWORD imageLength = DWORD(std::size(imageName));
    currentPhase = Phase::ChildIdentity;
    requireWin32(QueryFullProcessImageNameW(child.get(), 0, imageName, &imageLength) != FALSE); require(equalPath(imageName, executable));
    const std::string startTime = std::to_string(creationTime(child.get()));
    const std::string identity = ",\"pid\":" + std::to_string(pid) + ",\"startTime\":" + json(startTime);
    currentPhase = Phase::CreatedNotification;
    require(channel.emit("created", identity + ",\"executable\":" + json(utf8(executable)) + ",\"profilePath\":" + json(utf8(profile)) +
      ",\"executableSha256\":" + json(imageHash) + ",\"backendId\":" + json(backendId) + ",\"parentPid\":" + std::to_string(ownerNumber) +
      ",\"atomicJobAssignment\":true,\"jobHandleInheritable\":false,\"suspended\":true"));
    currentPhase = Phase::CreatedAck;
    const ULONGLONG acknowledgementDeadline = GetTickCount64() + 15000;
    while (!threads.ack) { require(!threads.invalid && GetTickCount64() < acknowledgementDeadline); Sleep(5); }
    currentPhase = Phase::ParentRecheck;
    requireWait(WaitForSingleObject(owner.get(), 0), WAIT_TIMEOUT);
    HANDLE remoteJob = nullptr;
    currentPhase = Phase::JobTransfer;
    requireWin32(DuplicateHandle(GetCurrentProcess(), job.get(), owner.get(), &remoteJob, 0, FALSE, DUPLICATE_SAME_ACCESS) != FALSE);
    // Transfer before resume. After this line the broker never owns, queries,
    // reopens, or duplicates a live Job, including on /exit and on timeouts.
    job.reset(); localJob = nullptr;
    currentPhase = Phase::ChildResume;
    const DWORD resumeResult = ResumeThread(primaryThread.get());
    const DWORD resumeError = resumeResult == DWORD(-1) ? GetLastError() : ERROR_SUCCESS;
    if (resumeResult != 1) {
      const DiagnosticFailure failure{currentPhase, __LINE__, resumeResult == DWORD(-1) ? "win32" : "validation", resumeError, resumeResult == DWORD(-1)};
      channel.emit("failure", ",\"code\":\"STILL_BACKEND_STARTUP_UNCERTAIN\"" + diagnosticFields(failure));
      // Never resume/retry or force-close the parent handle. The caller must
      // report abnormalStartupExitRequired for this created, never-READY child.
      WaitForSingleObject(owner.get(), INFINITE); return 2;
    }
    primaryThread.reset();
    channel.emit("ready", identity + ",\"parentOwnsJob\":true,\"brokerOwnsJob\":false,\"jobHandleInheritable\":false");
    bool rootExited = false, rootNotification = false, emptyObserved = false, invalidReported = false;
    unsigned commands = 0; Handle helper;
    for (;;) {
      currentPhase = Phase::ChildObserve;
      if (!rootExited && WaitForSingleObject(child.get(), 0) == WAIT_OBJECT_0) {
        DWORD code = 0; requireWin32(GetExitCodeProcess(child.get(), &code) != FALSE); rootExited = true;
        channel.emit("child-exit", identity + ",\"processHandleSignaled\":true,\"exitCode\":" + std::to_string(code));
      }
      if (threads.invalid && !invalidReported) { invalidReported = true; channel.emit("failure", ",\"code\":\"STILL_BACKEND_JOB_PROTOCOL_INVALID\""); }
      if (!rootExited && commands != threads.exits.load()) {
        commands = threads.exits.load();
        if (!helper.get() || WaitForSingleObject(helper.get(), 0) == WAIT_OBJECT_0) {
          try {
            currentPhase = Phase::ExitHelper;
            HANDLE rootParent = child.get();
            // The OS inherits the exact root's Job via PARENT_PROCESS. No live
            // Job handle is duplicated to create the fixed private /exit helper.
            Handle helperThread;
            helper = createProcess(executable, root, L"/exit", PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, rootParent, true, &helperThread);
            emptyObserved = false;
            // A stale ACTIVE_PROCESS_ZERO can predate this new helper if the
            // root died between our outer check and CreateProcess. The helper
            // is still suspended: it has executed nothing and has no children.
            // Admit it only while the exact root HANDLE remains unsignaled.
            // An admitted suspended helper already keeps the Job nonempty, so
            // root death after this check cannot queue a pre-helper zero.
            if (WaitForSingleObject(child.get(), 0) != WAIT_TIMEOUT) {
              requireWin32(TerminateProcess(helper.get(), ERROR_CANCELLED) != FALSE);
              requireWait(WaitForSingleObject(helper.get(), INFINITE), WAIT_OBJECT_0);
            } else {
              DWORD helperResume = ResumeThread(helperThread.get());
              if (helperResume == DWORD(-1)) {
                // The only explicit termination is rollback of this exact,
                // newly-created helper whose initial thread never resumed.
                requireWin32(TerminateProcess(helper.get(), ERROR_CANCELLED) != FALSE);
                requireWait(WaitForSingleObject(helper.get(), INFINITE), WAIT_OBJECT_0);
              } else if (helperResume != 1) {
                channel.emit("failure", ",\"code\":\"STILL_BACKEND_JOB_PROTOCOL_INVALID\"");
              } else channel.emit("exit-requested", identity + ",\"graceful\":true");
            }
          } catch (...) { channel.emit("exit-requested", identity + ",\"graceful\":true,\"dispatched\":false"); }
        }
      }
      DWORD message = 0; ULONG_PTR key = 0; LPOVERLAPPED processId = nullptr;
      BOOL received = GetQueuedCompletionStatus(completion.get(), &message, &key, &processId, 25);
      while (received) {
        if (key == reinterpret_cast<ULONG_PTR>(&completionIdentity)) {
          if (message == JOB_OBJECT_MSG_NEW_PROCESS) { emptyObserved = false;
            if (reinterpret_cast<ULONG_PTR>(processId) == pid) rootNotification = true; }
          if (message == JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO && rootNotification) emptyObserved = true;
        }
        received = GetQueuedCompletionStatus(completion.get(), &message, &key, &processId, 0);
      }
      const bool helperExited = !helper.get() || WaitForSingleObject(helper.get(), 0) == WAIT_OBJECT_0;
      if (rootExited && helperExited && emptyObserved) {
        // ACTIVE_PROCESS_ZERO may be lost; then this branch is never reached.
        // A timeout never substitutes for it and never closes the parent Job.
        // CLOSE_SOURCE consumes the remote handle even on API error. It is
        // deliberately attempted once, only for the now-empty Job.
        DuplicateHandle(owner.get(), remoteJob, nullptr, nullptr, 0, FALSE, DUPLICATE_CLOSE_SOURCE);
        remoteJob = nullptr;
        channel.emit("tree-empty", identity + ",\"activeProcessZero\":true,\"rootHandleSignaled\":true");
        return 0;
      }
    }
  } catch (const DiagnosticFailure& failure) {
    channel.emit("failure", ",\"code\":\"STILL_BACKEND_JOB_LAUNCH_FAILED\"" + diagnosticFields(failure)); return 2;
  } catch (...) {
    // An unexpected C++ exception is still bounded and never serializes what().
    channel.emit("failure", ",\"code\":\"STILL_BACKEND_JOB_LAUNCH_FAILED\"" + diagnosticFields({currentPhase, 0, "validation", 0, false})); return 2;
  }
}
} // namespace

int wmain(int argc, wchar_t** argv) {
  try { return run(argc, argv); } catch (...) { return 2; }
}
