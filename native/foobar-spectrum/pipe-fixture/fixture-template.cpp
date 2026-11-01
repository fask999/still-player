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
/* EXTRACT:types-and-constants */
/* EXTRACT:production-encoder */
/* EXTRACT:production-security-and-io */

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
/* EXTRACT:production-pipe-loop */
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
