// TEST FIXTURE ONLY. Fixed bands and fictional track; no PCM is read or analyzed.
// Four marked blocks are mechanically inserted without editing any production byte.
#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <Windows.h>
#include <sddl.h>
#include "dsp.hpp"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cwchar>
#include <iomanip>
#include <iostream>
#include <locale>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {
using Clock = std::chrono::steady_clock;
using namespace std::chrono_literals;
constexpr auto kPollPeriod = 50ms;
constexpr auto kMaxAge = 250ms;
constexpr DWORD kPipeDeadlineMs = 100;
constexpr size_t kMaxJsonBytes = 60 * 1024; // room for the reader's envelope below Node's 64 KiB cap

class Handle {
public:
    explicit Handle(HANDLE h = nullptr) noexcept : value_(h) {}
    ~Handle() { reset(); }
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    HANDLE get() const noexcept { return value_; }
    bool valid() const noexcept { return value_ && value_ != INVALID_HANDLE_VALUE; }
    void reset(HANDLE h = nullptr) noexcept {
        if (valid()) CloseHandle(value_);
        value_ = h;
    }
private:
    HANDLE value_;
};

struct Track {
    std::string path;
    uint32_t subsong = 0;
    bool operator==(const Track&) const = default;
};

struct Snapshot {
    std::string status = "unavailable";
    std::string reason = "initializing";
    uint64_t generation = 0;
    uint64_t sequence = 1;
    std::optional<Track> track;
    std::optional<still_spectrum::FrameAnalysis> analysis;
    Clock::time_point captured{};
    int64_t captured_unix_ms = 0;
    double stream_time = 0;
};


std::string json_string(const std::string& in) {
    constexpr char hex[] = "0123456789abcdef";
    std::string out = "\"";
    for (const unsigned char c : in) {
        if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char>(c); }
        else if (c < 32) {
            out += "\\u00"; out += hex[c >> 4]; out += hex[c & 15];
        } else out += static_cast<char>(c);
    }
    return out + '"';
}

// Only the pipe worker serializes; a non-running frame never carries cached measurements.
std::string serialize_snapshot(const Snapshot& s, const std::string& session, DWORD pid) {
    const bool running = s.status == "running" && s.analysis.has_value();
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << std::setprecision(12)
        << "{\"schemaVersion\":1,\"source\":\"foobar2000\","
        << "\"analyzer\":\"sdk-visualisation-pcm\",\"status\":" << json_string(s.status)
        << ",\"reason\":" << (running ? "null" : json_string(s.reason))
        << ",\"sequence\":" << s.sequence << ",\"sessionId\":" << json_string(session)
        << ",\"backendPid\":" << pid << ",\"generation\":" << s.generation << ",\"track\":";
    if (s.track) out << "{\"path\":" << json_string(s.track->path)
        << ",\"subsong\":" << s.track->subsong << '}';
    else out << "null";
    out << ",\"capturedAtUnixMs\":";
    if (running) out << s.captured_unix_ms; else out << "null";
    out << ",\"ageMs\":";
    if (running) out << std::max<int64_t>(0, std::chrono::duration_cast<std::chrono::milliseconds>(
        Clock::now() - s.captured).count()); else out << "null";
    out << ",\"streamTimeSeconds\":";
    if (running) out << s.stream_time; else out << "null";
    out << ",\"sampleRate\":";
    if (running) out << s.analysis->sample_rate; else out << "null";
    out << ",\"channels\":";
    if (running) out << s.analysis->channels; else out << "null";
    out << ",\"fftSize\":4096,\"window\":\"hann-periodic\","
        << "\"calibration\":\"rms-full-scale-1\",\"floorDbfs\":-100,\"binHz\":";
    if (running) out << s.analysis->bin_hz; else out << "null";
    out << ",\"windowSeconds\":";
    if (running) out << s.analysis->window_seconds; else out << "null";
    out << ",\"bands\":[";
    if (running) {
        bool first = true;
        for (const auto& band : s.analysis->bands) {
            if (!first) out << ',';
            first = false;
            out << "{\"lowHz\":" << band.low_hz << ",\"highHz\":" << band.high_hz
                << ",\"dbfs\":" << band.dbfs << ",\"hasBins\":"
                << (band.has_bins ? "true" : "false") << '}';
        }
    }
    out << "]}\n";
    return out.str();
}

class PipeSecurity {
public:
    PipeSecurity() {
        Handle token;
        HANDLE raw = nullptr;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw))
            throw std::runtime_error("pipe-token");
        token.reset(raw);
        DWORD bytes = 0;
        GetTokenInformation(token.get(), TokenUser, nullptr, 0, &bytes);
        if (!bytes) throw std::runtime_error("pipe-token-size");
        std::vector<unsigned char> info(bytes);
        if (!GetTokenInformation(token.get(), TokenUser, info.data(), bytes, &bytes))
            throw std::runtime_error("pipe-token-user");
        LPWSTR sid = nullptr;
        if (!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(info.data())->User.Sid, &sid))
            throw std::runtime_error("pipe-sid");
        std::wstring sddl;
        try { sddl = L"D:P(A;;GRGW;;;SY)(A;;GRGW;;;" + std::wstring(sid) + L")"; }
        catch (...) { LocalFree(sid); throw; }
        LocalFree(sid);
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(),
            SDDL_REVISION_1, &descriptor_, nullptr)) throw std::runtime_error("pipe-dacl");
        attributes_ = { sizeof(SECURITY_ATTRIBUTES), descriptor_, FALSE };
    }
    ~PipeSecurity() { if (descriptor_) LocalFree(descriptor_); }
    SECURITY_ATTRIBUTES* get() noexcept { return &attributes_; }
private:
    PSECURITY_DESCRIPTOR descriptor_ = nullptr;
    SECURITY_ATTRIBUTES attributes_{};
};

// Cancel and drain before OVERLAPPED/buffer/event destruction. No main-thread dependency.
bool finish_io(HANDLE pipe, OVERLAPPED& operation, HANDLE stop, DWORD timeout, DWORD& transferred) {
    const HANDLE waits[] = { stop, operation.hEvent };
    if (WaitForMultipleObjects(2, waits, FALSE, timeout) == WAIT_OBJECT_0 + 1)
        return GetOverlappedResult(pipe, &operation, &transferred, FALSE) != FALSE;
    CancelIoEx(pipe, &operation);
    GetOverlappedResult(pipe, &operation, &transferred, TRUE);
    return false;
}


std::wstring own_image_path() {
    std::wstring value(32768, L'\0');
    const DWORD length = GetModuleFileNameW(nullptr, value.data(), static_cast<DWORD>(value.size()));
    if (!length || length == value.size()) throw std::runtime_error("fixture-image-path");
    value.resize(length); return value;
}
void verify_owned_fixture_target(DWORD target, const std::wstring& expected) {
    // Only the explicit harness-owned A PID is queried. No enumeration or guessed PID.
    if (!target || target == GetCurrentProcessId() || _wcsicmp(expected.c_str(), own_image_path().c_str()) != 0)
        throw std::runtime_error("fixture-target-arguments");
    Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, target));
    if (!process.valid()) throw std::runtime_error("fixture-target-open");
    std::wstring image(32768, L'\0'); DWORD size = static_cast<DWORD>(image.size()), code = 0;
    if (!QueryFullProcessImageNameW(process.get(), 0, image.data(), &size) ||
        !GetExitCodeProcess(process.get(), &code) || code != STILL_ACTIVE)
        throw std::runtime_error("fixture-target-not-live");
    image.resize(size);
    if (_wcsicmp(image.c_str(), expected.c_str()) != 0) throw std::runtime_error("fixture-target-image-mismatch");
}

class FixtureServer {
public:
    explicit FixtureServer(DWORD target) : pid_(target), stop_event_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {
        if (!stop_event_.valid()) throw std::runtime_error("fixture-event");
    }
    ~FixtureServer() { hold(); }
    void start() {
        if (thread_.joinable()) return;
        ResetEvent(stop_event_.get()); stopping_.store(false);
        thread_ = std::thread([this] { pipe_loop(); });
    }
    void hold() {
        stopping_.store(true); SetEvent(stop_event_.get());
        if (thread_.joinable()) thread_.join();
    }
    void set_mode(int mode) { mode_.store(mode); generation_.fetch_add(1); }
private:
    std::string current_json() {
        Snapshot snapshot;
        snapshot.sequence = sequence_.fetch_add(1) + 1;
        snapshot.generation = generation_.load();
        snapshot.track = Track{ "C:\\__STILL_PIPE_FIXTURE__\\tone.fixture", 0 };
        const int mode = mode_.load();
        snapshot.status = mode == 0 ? "running" : mode == 1 ? "paused" : "unavailable";
        snapshot.reason = mode == 0 ? "" : mode == 1 ? "paused" : "no-pcm";
        if (mode == 0) {
            // Protocol-only constants. No FFT call, media read, playback or device access.
            still_spectrum::FrameAnalysis frame;
            frame.sample_rate = 48000; frame.channels = 2; frame.bin_hz = 48000.0 / 4096;
            frame.window_seconds = 4096.0 / 48000;
            for (int i = 0; i < 48; ++i) {
                still_spectrum::Band band;
                band.low_hz = 20 * std::exp(std::log(1000.0) * i / 48);
                band.high_hz = i == 47 ? 20000 : 20 * std::exp(std::log(1000.0) * (i + 1) / 48);
                for (int k = 1; k <= 2048; ++k) {
                    const double frequency = k * frame.bin_hz;
                    if (frequency >= band.low_hz && (frequency < band.high_hz || (i == 47 && frequency <= band.high_hz))) {
                        band.has_bins = true; break;
                    }
                }
                band.dbfs = band.has_bins ? -24.0 : -100.0;
                frame.bands.push_back(band);
            }
            snapshot.analysis = std::move(frame);
            snapshot.captured = Clock::now();
            snapshot.captured_unix_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count();
            snapshot.stream_time = 1.0 + static_cast<double>(snapshot.sequence) / 20.0;
        }
        return serialize_snapshot(snapshot, session_, pid_);
    }
    void pipe_loop() noexcept {
        try {
            PipeSecurity security;
            const std::wstring name = L"\\\\.\\pipe\\Still.FoobarSpectrum.v1." + std::to_wstring(pid_);
            while (!stopping_.load()) {
                Handle pipe(CreateNamedPipeW(name.c_str(), PIPE_ACCESS_OUTBOUND | FILE_FLAG_OVERLAPPED
                    | FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT
                    | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 0, 0, security.get()));
                if (!pipe.valid()) return; // fail closed, including an already claimed endpoint
                Handle event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
                if (!event.valid()) return;
                OVERLAPPED op{}; op.hEvent = event.get();
                bool connected = ConnectNamedPipe(pipe.get(), &op) != FALSE;
                DWORD bytes = 0;
                if (!connected) {
                    const auto error = GetLastError();
                    if (error == ERROR_PIPE_CONNECTED) connected = true;
                    else if (error == ERROR_IO_PENDING)
                        connected = finish_io(pipe.get(), op, stop_event_.get(), kPipeDeadlineMs, bytes);
                }
                if (!connected || stopping_.load()) continue;
                auto json = current_json();
                if (json.empty() || json.size() > kMaxJsonBytes || stopping_.load()) continue;
                ResetEvent(event.get());
                op = {}; op.hEvent = event.get();
                const bool wrote = WriteFile(pipe.get(), json.data(), static_cast<DWORD>(json.size()), nullptr, &op) != FALSE;
                const bool complete = wrote
                    ? GetOverlappedResult(pipe.get(), &op, &bytes, FALSE) != FALSE
                    : (GetLastError() == ERROR_IO_PENDING &&
                        finish_io(pipe.get(), op, stop_event_.get(), kPipeDeadlineMs, bytes));
                if (complete && bytes == json.size()) {
                    // A small bounded drain interval lets the read-once client consume buffered bytes.
                    // FlushFileBuffers would let a slow client block shutdown indefinitely.
                    WaitForSingleObject(stop_event_.get(), 50);
                }
                DisconnectNamedPipe(pipe.get());
            }
        } catch (...) { /* no insecure fallback, no SDK calls on this thread */ }
    }

    const std::string session_ = "11111111-2222-4333-8444-555555555555";
    const DWORD pid_;
    Handle stop_event_;
    std::atomic<bool> stopping_{false};
    std::atomic<int> mode_{0};
    std::atomic<uint64_t> generation_{1}, sequence_{0};
    std::thread thread_;
};

void event(const char* name, DWORD target, bool spoof) {
    std::cout << "{\"event\":" << json_string(name) << ",\"fixtureOnly\":true,\"pid\":"
        << GetCurrentProcessId() << ",\"targetPid\":" << target
        << ",\"spoof\":" << (spoof ? "true" : "false") << "}\n" << std::flush;
}
} // namespace

int wmain(int argc, wchar_t** argv) {
    try {
        bool spoof = false;
        DWORD target = GetCurrentProcessId();
        if (argc == 2 && std::wcscmp(argv[1], L"--self") == 0) {}
        else if (argc == 5 && std::wcscmp(argv[1], L"--spoof-owned-fixture-pid") == 0 &&
            std::wcscmp(argv[3], L"--expect-fixture-exe") == 0) {
            wchar_t* end = nullptr; const unsigned long value = std::wcstoul(argv[2], &end, 10);
            if (!value || !end || *end != L'\0') throw std::runtime_error("fixture-target-pid");
            target = static_cast<DWORD>(value); spoof = true;
            verify_owned_fixture_target(target, argv[4]);
        } else throw std::runtime_error("fixture-arguments");
        FixtureServer server(target); server.start(); event("started", target, spoof);
        const auto deadline = Clock::now() + 25s; // strictly less than 30 seconds per fixture process
        std::string pending;
        const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
        while (Clock::now() < deadline) {
            DWORD available = 0;
            if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) {
                if (GetLastError() == ERROR_BROKEN_PIPE) { server.hold(); event("stdin-eof", target, spoof); return 0; }
                throw std::runtime_error("fixture-stdin-not-owned-pipe");
            }
            if (!available) { std::this_thread::sleep_for(5ms); continue; }
            char bytes[256]; DWORD count = 0;
            if (!ReadFile(input, bytes, std::min<DWORD>(available, sizeof(bytes)), &count, nullptr) || !count)
                throw std::runtime_error("fixture-stdin-read");
            pending.append(bytes, count);
            if (pending.size() > 1024) throw std::runtime_error("fixture-command-budget");
            for (size_t newline; (newline = pending.find('\n')) != std::string::npos;) {
                const auto command = pending.substr(0, newline); pending.erase(0, newline + 1);
                if (command == "quit") { server.hold(); event("bye", target, spoof); return 0; }
                if (command == "hold") { server.hold(); event("held", target, spoof); }
                else if (command == "pause") { server.set_mode(1); event("paused", target, spoof); }
                else if (command == "nodata") { server.set_mode(2); event("no-data", target, spoof); }
                else if (command == "resume") { server.set_mode(0); server.start(); event("resumed", target, spoof); }
                else throw std::runtime_error("fixture-command");
            }
        }
        server.hold(); event("self-deadline", target, spoof); return 124;
    } catch (const std::exception& error) {
        std::cerr << "fixture-error:" << error.what() << '\n'; return 2;
    }
}
