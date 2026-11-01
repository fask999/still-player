// Read-only visualisation client. No decoder, playback commands or audio device API.
#include <foobar2000/SDK/foobar2000.h>
#include <foobar2000/SDK/vis.h>
#include "dsp.hpp"

#include <Windows.h>
#include <sddl.h>
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <iomanip>
#include <limits>
#include <locale>
#include <memory>
#include <mutex>
#include <optional>
#include <span>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

DECLARE_COMPONENT_VERSION("Still read-only spectrum", "1.0.0",
    "PCM from foobar2000 SDK visualisation only. RMS dBFS, not dB SPL.\n"
    "One read-only, same-user local named pipe snapshot per connection.");
VALIDATE_COMPONENT_FILENAME("foo_still_spectrum.dll");

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

struct SampleJob {
    uint64_t generation = 0;
    Track track;
    std::vector<double> pcm;
    double sample_rate = 0;
    size_t channels = 0;
    double stream_time = 0;
    Clock::time_point captured;
    int64_t captured_unix_ms = 0;
};

std::string new_session_id() {
    std::array<unsigned char, 16> bytes{};
    if (BCryptGenRandom(nullptr, bytes.data(), static_cast<ULONG>(bytes.size()),
        BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) throw std::runtime_error("session-rng");
    bytes[6] = static_cast<unsigned char>((bytes[6] & 0x0f) | 0x40);
    bytes[8] = static_cast<unsigned char>((bytes[8] & 0x3f) | 0x80);
    constexpr char hex[] = "0123456789abcdef";
    std::string out;
    for (size_t i = 0; i < bytes.size(); ++i) {
        if (i == 4 || i == 6 || i == 8 || i == 10) out += '-';
        const auto b = bytes[i];
        out += hex[b >> 4]; out += hex[b & 15];
    }
    return out;
}

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

class Runtime;
class SampleCallback : public main_thread_callback {
public:
    explicit SampleCallback(std::weak_ptr<Runtime> state) : state_(std::move(state)) {}
    void callback_run() override;
private:
    std::weak_ptr<Runtime> state_;
};

// Security setup has no fallback: only the process user and LocalSystem get access.
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

class Runtime : public std::enable_shared_from_this<Runtime> {
public:
    Runtime() : session_(new_session_id()), pid_(GetCurrentProcessId()),
        stop_event_(CreateEventW(nullptr, TRUE, FALSE, nullptr)),
        snapshot_(std::make_shared<const Snapshot>()) {
        if (!stop_event_.valid()) throw std::runtime_error("stop-event");
    }

    // Invoked through SampleCallback on the main thread, outside any global play callback.
    void sample_main() noexcept {
        try {
            if (stopping_.load()) return;
            if (!manager_.is_valid()) {
                manager_ = main_thread_callback_manager::get();
                analysis_thread_ = std::thread([self = shared_from_this()] { self->analysis_loop(); });
                try { pipe_thread_ = std::thread([self = shared_from_this()] { self->pipe_loop(); }); }
                catch (...) { stop_workers(); throw; }
            }
            auto control = playback_control::get();
            metadb_handle_ptr before;
            if (!control->is_playing() || !control->get_now_playing(before)) {
                release_stream_main();
                empty_main("stopped", "not-playing", std::nullopt);
                return;
            }
            Track track{ before->get_path(), before->get_subsong_index() };
            if (control->is_paused()) {
                release_stream_main();
                empty_main("paused", "paused", track);
                return;
            }
            if (!last_track_ || *last_track_ != track) {
                invalidate("unavailable", "track-changed");
                last_track_ = track;
            }
            if (reset_stream_.exchange(false) || !stream_.is_valid()) {
                release_stream_main();
                visualisation_manager::get()->create_stream(stream_, visualisation_manager::KStreamFlagNewFFT);
                stream_->request_backlog(1.0);
                stream_->set_channel_mode(visualisation_stream_v2::channel_mode_default);
            }
            const auto generation = generation_now();
            double end = 0;
            if (!stream_->get_absolute_time(end) || !std::isfinite(end) || end < 0) {
                empty_main("unavailable", "no-stream-time", track); return;
            }
            if (!origin_ || (last_seen_time_ && end < *last_seen_time_)) {
                origin_ = end;
                last_accepted_time_.reset();
            }
            last_seen_time_ = end;
            // Probe real PCM for its actual rate. Never infer the output rate from track metadata.
            audio_chunk_impl probe;
            if (end < 0.010 || !stream_->get_chunk_absolute(probe, end - 0.010, 0.005)
                || probe.is_empty()) {
                empty_main("unavailable", "no-pcm", track); return;
            }
            const auto rate = probe.get_srate();
            const auto channels = probe.get_channels();
            if (rate < 8000 || rate > 768000 || channels == 0 || channels > 32) {
                empty_main("unavailable", "unsupported-format", track); return;
            }
            const double seconds = static_cast<double>(still_spectrum::kFftSize) / rate;
            // No zero padding after startup/seek/resume; wait for a whole observed real window.
            if (end - *origin_ < seconds || end < seconds) {
                empty_main("unavailable", "insufficient-window", track); return;
            }
            // A stalled absolute stream time must not extend the life of an old sample.
            if (last_accepted_time_ && end <= *last_accepted_time_ + 1e-9) return;
            audio_chunk_impl chunk;
            if (!stream_->get_chunk_absolute(chunk, end - seconds, seconds)
                || chunk.get_sample_count() < still_spectrum::kFftSize
                || chunk.get_srate() != rate || chunk.get_channels() != channels) {
                empty_main("unavailable", "insufficient-pcm", track); return;
            }
            const size_t frames = chunk.get_sample_count();
            if (frames > static_cast<size_t>(rate) || chunk.get_data_size() < frames * channels
                || !chunk.get_data()) {
                empty_main("unavailable", "invalid-pcm", track); return;
            }
            SampleJob job;
            job.generation = generation;
            job.track = track;
            job.sample_rate = rate;
            job.channels = channels;
            job.stream_time = end;
            const auto* first = chunk.get_data() + (frames - still_spectrum::kFftSize) * channels;
            job.pcm.assign(first, first + still_spectrum::kFftSize * channels);
            metadb_handle_ptr after;
            if (!control->get_now_playing(after) || control->is_paused() || !control->is_playing()
                || Track{after->get_path(), after->get_subsong_index()} != track) {
                invalidate("unavailable", "track-changed"); return;
            }
            job.captured = Clock::now();
            job.captured_unix_ms = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count();
            {
                std::lock_guard lock(mutex_);
                if (stopping_.load() || generation != generation_) return;
                pending_job_ = std::move(job); // bounded to the newest single PCM window
                last_accepted_time_ = end;
            }
            wake_.notify_one();
        } catch (...) {
            release_stream_main();
            try { empty_main("unavailable", "sdk-error", std::nullopt); } catch (...) {}
        }
    }

    // Play callbacks only invalidate state. They never read playback_control or the stream.
    void invalidate(const char* status, const char* reason) noexcept {
        try {
            std::lock_guard lock(mutex_);
            ++generation_;
            pending_job_.reset();
            reset_stream_.store(true);
            replace_empty_locked(status, reason, std::nullopt);
        } catch (...) { stopping_.store(true); SetEvent(stop_event_.get()); }
        wake_.notify_one();
    }

    void callback_finished() noexcept { callback_queued_.store(false); }
    bool stopping() const noexcept { return stopping_.load(); }

    // Called by initquit on the main thread. Workers never wait for queued callbacks.
    void stop_workers() noexcept {
        stopping_.store(true);
        SetEvent(stop_event_.get());
        wake_.notify_all();
        if (analysis_thread_.joinable()) analysis_thread_.join();
        if (pipe_thread_.joinable()) pipe_thread_.join();
    }
    void cleanup_main() noexcept {
        release_stream_main();
        manager_.release();
    }

private:
    void release_stream_main() noexcept {
        stream_.release();
        origin_.reset(); last_seen_time_.reset(); last_accepted_time_.reset();
    }
    uint64_t generation_now() {
        std::lock_guard lock(mutex_);
        return generation_;
    }
    void replace_empty_locked(const char* status, const char* reason, std::optional<Track> track) {
        Snapshot s;
        s.status = status; s.reason = reason; s.track = std::move(track);
        s.generation = generation_; s.sequence = ++sequence_;
        snapshot_ = std::make_shared<const Snapshot>(std::move(s));
    }
    void empty_main(const char* status, const char* reason, std::optional<Track> track) {
        std::lock_guard lock(mutex_);
        pending_job_.reset();
        // Recover safely even if a host omitted its expected playback callback.
        ++generation_; // also rejects an in-flight FFT while the prior frame was unavailable
        replace_empty_locked(status, reason, std::move(track));
    }
    void expire_locked() {
        if (snapshot_->analysis && Clock::now() - snapshot_->captured >= kMaxAge)
            replace_empty_locked("stale", "sample-expired", snapshot_->track);
    }
    void analyze_job(SampleJob job) {
        try {
            auto result = still_spectrum::analyze_interleaved(
                std::span<const double>(job.pcm), job.sample_rate, job.channels);
            // Reject any nonfinite analyzer output before JSON serialization.
            if (!std::isfinite(result.sample_rate) || !std::isfinite(result.bin_hz)
                || !std::isfinite(result.window_seconds) || result.bands.size() != 48)
                throw std::runtime_error("invalid-analysis");
            for (const auto& b : result.bands)
                if (!std::isfinite(b.low_hz) || !std::isfinite(b.high_hz) || !std::isfinite(b.dbfs)
                    || b.dbfs < still_spectrum::kFloorDbfs || b.dbfs > 60.0)
                    throw std::runtime_error("invalid-analysis");
            std::lock_guard lock(mutex_);
            if (stopping_.load() || job.generation != generation_ || Clock::now() - job.captured >= kMaxAge)
                return;
            Snapshot s;
            s.status = "running"; s.reason = ""; s.generation = generation_;
            s.sequence = ++sequence_; s.track = std::move(job.track);
            s.analysis = std::move(result); s.captured = job.captured;
            s.captured_unix_ms = job.captured_unix_ms; s.stream_time = job.stream_time;
            snapshot_ = std::make_shared<const Snapshot>(std::move(s));
        } catch (...) {
            std::lock_guard lock(mutex_);
            if (!stopping_.load() && job.generation == generation_)
                replace_empty_locked("unavailable", "analysis-error", job.track);
        }
    }
    void analysis_loop() noexcept {
        try {
            auto next = Clock::now() + kPollPeriod;
            while (!stopping_.load()) {
                std::optional<SampleJob> job;
                {
                    std::unique_lock lock(mutex_);
                    wake_.wait_until(lock, next, [this] { return stopping_.load() || pending_job_.has_value(); });
                    if (stopping_.load()) break;
                    job.swap(pending_job_);
                    expire_locked();
                }
                if (job) analyze_job(std::move(*job));
                if (Clock::now() >= next) {
                    next = Clock::now() + kPollPeriod;
                    bool expected = false;
                    if (!stopping_.load() && callback_queued_.compare_exchange_strong(expected, true)) {
                        try {
                            // SDK explicitly permits add_callback from any thread.
                            manager_->add_callback(new service_impl_t<SampleCallback>(weak_from_this()));
                        } catch (...) { callback_queued_.store(false); }
                    }
                }
            }
        } catch (...) { invalidate("unavailable", "worker-error"); }
    }
    std::string current_json() {
        // Serialization can race invalidation; retry if a different immutable snapshot replaced it.
        for (;;) {
            std::shared_ptr<const Snapshot> s;
            {
                std::lock_guard lock(mutex_);
                expire_locked(); s = snapshot_;
            }
            auto json = serialize_snapshot(*s, session_, pid_);
            {
                std::lock_guard lock(mutex_);
                expire_locked();
                if (s == snapshot_) return json;
            }
            if (stopping_.load()) return {};
        }
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

    const std::string session_;
    const DWORD pid_;
    Handle stop_event_;
    // on_init queues the initial callback before the worker exists. Keep its slot
    // occupied until callback_finished(), including while that callback starts workers.
    std::atomic<bool> stopping_{false}, callback_queued_{true}, reset_stream_{true};
    std::mutex mutex_;
    std::condition_variable wake_;
    uint64_t generation_ = 0, sequence_ = 1;
    std::shared_ptr<const Snapshot> snapshot_;
    std::optional<SampleJob> pending_job_;
    std::thread analysis_thread_, pipe_thread_;
    // Main thread only, retained until worker join; workers only use manager_->add_callback.
    main_thread_callback_manager::ptr manager_;
    visualisation_stream_v2::ptr stream_;
    std::optional<Track> last_track_;
    std::optional<double> origin_, last_seen_time_, last_accepted_time_;
};

void SampleCallback::callback_run() {
    if (auto state = state_.lock()) {
        if (!state->stopping()) state->sample_main();
        state->callback_finished();
    }
}

class CleanupCallback : public main_thread_callback {
public:
    explicit CleanupCallback(std::weak_ptr<Runtime> state) : state_(std::move(state)) {}
    void callback_run() override {
        if (auto state = state_.lock()) state->cleanup_main();
    }
private:
    std::weak_ptr<Runtime> state_;
};

std::shared_ptr<Runtime> g_runtime; // accessed only on foobar2000's main thread
main_thread_callback::ptr g_cleanup;

class PlaybackCallbacks : public play_callback_static {
public:
    unsigned get_flags() override {
        return flag_on_playback_starting | flag_on_playback_new_track | flag_on_playback_stop
            | flag_on_playback_seek | flag_on_playback_pause | flag_on_playback_edited;
    }
    void on_playback_starting(play_control::t_track_command, bool paused) noexcept override {
        mark(paused ? "paused" : "unavailable", "starting");
    }
    void on_playback_new_track(metadb_handle_ptr) noexcept override { mark("unavailable", "new-track"); }
    void on_playback_stop(play_control::t_stop_reason) noexcept override { mark("stopped", "stopped"); }
    void on_playback_seek(double) noexcept override { mark("unavailable", "seek"); }
    void on_playback_pause(bool paused) noexcept override { mark(paused ? "paused" : "unavailable", paused ? "paused" : "resume"); }
    void on_playback_edited(metadb_handle_ptr) noexcept override { mark("unavailable", "track-edited"); }
    void on_playback_dynamic_info(const file_info&) noexcept override {}
    void on_playback_dynamic_info_track(const file_info&) noexcept override {}
    void on_playback_time(double) noexcept override {}
    void on_volume_change(float) noexcept override {}
private:
    static void mark(const char* status, const char* reason) noexcept {
        if (g_runtime) g_runtime->invalidate(status, reason);
    }
};
play_callback_static_factory_t<PlaybackCallbacks> g_playback_callbacks;

class Lifecycle : public initquit {
public:
    void on_init() override {
        try {
            g_runtime = std::make_shared<Runtime>();
            g_cleanup = new service_impl_t<CleanupCallback>(std::weak_ptr<Runtime>(g_runtime));
            main_thread_callback_add(new service_impl_t<SampleCallback>(std::weak_ptr<Runtime>(g_runtime)));
        } catch (...) { g_cleanup.release(); g_runtime.reset(); }
    }
    void on_quit() override {
        if (!g_runtime) return;
        g_runtime->stop_workers();
        // on_quit already runs on main. Invoke the cleanup callback here instead of
        // queuing work that could be abandoned by host teardown. No worker awaits it.
        g_cleanup->callback_run();
        g_cleanup.release();
        g_runtime.reset();
    }
};
initquit_factory_t<Lifecycle> g_lifecycle;
} // namespace
