// Standalone synthetic fixtures. No foobar2000 SDK, Windows API, audio device,
// player, file decoder or third-party library is linked or initialized.
#include "dsp.hpp"

#include <algorithm>
#include <functional>
#include <iostream>
#include <string>
#include <string_view>

namespace {
using still_spectrum::Band;
using still_spectrum::FrameAnalysis;
using still_spectrum::kFftSize;
constexpr double pi = std::numbers::pi_v<double>;
constexpr double sine_dbfs = -3.010299956639812;
// All three Hann bins fit inside one 48-band logarithmic band at 48 kHz.
// The fixture explicitly checks this before asserting an individual-band RMS.
constexpr std::size_t calibration_bin = 100;
int passed = 0;
int failed = 0;

void require(bool condition, std::string_view message) {
    if (!condition) throw std::runtime_error(std::string(message));
}

void near(double actual, double expected, double tolerance, std::string_view message) {
    if (!std::isfinite(actual) || std::abs(actual - expected) > tolerance) {
        throw std::runtime_error(std::string(message) + ": got " + std::to_string(actual) +
                                 ", expected " + std::to_string(expected));
    }
}

template <typename Exception = std::invalid_argument, typename Callback>
void rejects(Callback callback) {
    try { callback(); }
    catch (const Exception&) { return; }
    throw std::runtime_error("expected input validation exception");
}

void check(std::string_view name, const std::function<void()>& callback) {
    try {
        callback();
        ++passed;
        std::cout << "PASS " << name << '\n';
    } catch (const std::exception& error) {
        ++failed;
        std::cerr << "FAIL " << name << ": " << error.what() << '\n';
    }
}

template <typename Sample = double>
std::vector<Sample> tone(std::size_t bin, double amplitude = 1.0,
                         std::size_t channels = 1) {
    std::vector<Sample> samples(kFftSize * channels);
    for (std::size_t n = 0; n < kFftSize; ++n) {
        const Sample value = static_cast<Sample>(amplitude *
            std::sin(2.0 * pi * static_cast<double>(bin * n) / static_cast<double>(kFftSize)));
        for (std::size_t c = 0; c < channels; ++c) samples[n * channels + c] = value;
    }
    return samples;
}

template <still_spectrum::PcmSample Sample>
FrameAnalysis analyze(const std::vector<Sample>& samples, double rate = 48000.0,
                      std::size_t channels = 1) {
    return still_spectrum::analyze_interleaved(std::span<const Sample>(samples), rate, channels);
}

double displayed_power(const FrameAnalysis& result) {
    double power = 0.0;
    for (const auto& band : result.bands) {
        if (band.has_bins && band.dbfs > still_spectrum::kFloorDbfs) {
            power += std::pow(10.0, band.dbfs / 10.0);
        }
    }
    return power;
}

double peak_dbfs(const FrameAnalysis& result) {
    double peak = still_spectrum::kFloorDbfs;
    for (const auto& band : result.bands) peak = std::max(peak, band.dbfs);
    return peak;
}

std::size_t band_containing_bin(const FrameAnalysis& result, std::size_t bin) {
    const double frequency = static_cast<double>(bin) * result.bin_hz;
    std::size_t match = result.bands.size();
    for (std::size_t i = 0; i < result.bands.size(); ++i) {
        const auto& band = result.bands[i];
        if (frequency >= band.low_hz && (frequency < band.high_hz ||
            (i + 1 == result.bands.size() && frequency == band.high_hz))) {
            require(match == result.bands.size(), "bin must not belong to multiple bands");
            match = i;
        }
    }
    require(match < result.bands.size(), "fixture bin is outside displayed bands");
    require(result.bands[match].has_bins, "occupied fixture band marked missing");
    return match;
}

std::size_t require_hann_lobe_in_one_band(const FrameAnalysis& result, std::size_t bin) {
    const auto main_band = band_containing_bin(result, bin);
    require(band_containing_bin(result, bin - 1) == main_band &&
            band_containing_bin(result, bin + 1) == main_band,
            "RMS calibration fixture's three Hann bins must share one band");
    return main_band;
}

void all_at_floor(const FrameAnalysis& result) {
    for (const auto& band : result.bands) {
        require(band.dbfs == still_spectrum::kFloorDbfs, "silence must be exactly at floor");
    }
}

void same_levels(const FrameAnalysis& left, const FrameAnalysis& right, double tolerance) {
    require(left.bands.size() == right.bands.size(), "band counts differ");
    for (std::size_t i = 0; i < left.bands.size(); ++i) {
        near(left.bands[i].dbfs, right.bands[i].dbfs, tolerance, "band levels differ");
        require(left.bands[i].has_bins == right.bands[i].has_bins, "bin support differs");
    }
}

std::vector<double> wideband_fixture() {
    // Deterministic separated tones, all lobes inside 20 Hz..16 kHz at 32 kHz.
    // This exercises many bands without treating a random noise realization as
    // an exactly known RMS reference.
    std::vector<double> samples(kFftSize);
    for (std::size_t n = 0; n < kFftSize; ++n) {
        for (std::size_t i = 0; i < 64; ++i) {
            const double amplitude = 0.015 / static_cast<double>(1 + i % 5);
            const double bin = static_cast<double>(20 + 23 * i);
            samples[n] += amplitude * std::sin(2.0 * pi * bin * static_cast<double>(n) /
                                               static_cast<double>(kFftSize) + 0.17 * static_cast<double>(i));
        }
    }
    return samples;
}

double window_weighted_mean_square(const std::vector<double>& samples) {
    double numerator = 0.0;
    double denominator = 0.0;
    for (std::size_t n = 0; n < kFftSize; ++n) {
        // sin^2 is an independent expression for the periodic Hann.
        const double s = std::sin(pi * static_cast<double>(n) / static_cast<double>(kFftSize));
        const double w = s * s;
        numerator += samples[n] * samples[n] * w * w;
        denominator += w * w;
    }
    near(denominator, 3.0 * static_cast<double>(kFftSize) / 8.0, 1.0e-9, "Hann energy");
    return numerator / denominator;
}
} // namespace

int main() {
    check("full-scale sine: integrated RMS and occupied band are -3.0103 dBFS", [] {
        const auto result = analyze(tone(calibration_bin));
        (void)require_hann_lobe_in_one_band(result, calibration_bin);
        near(displayed_power(result), 0.5, 1.0e-10, "FS sine power");
        near(peak_dbfs(result), sine_dbfs, 1.0e-8, "FS sine band RMS");
    });
    check("half-amplitude sine is -9.0309 dBFS", [] {
        const auto result = analyze(tone(calibration_bin, 0.5));
        (void)require_hann_lobe_in_one_band(result, calibration_bin);
        near(displayed_power(result), 0.125, 1.0e-10, "half sine power");
        near(peak_dbfs(result), sine_dbfs + 20.0 * std::log10(0.5), 1.0e-8, "half sine band RMS");
    });
    check("float input uses the real production template", [] {
        near(displayed_power(analyze(tone<float>(128, 0.5))), 0.125, 1.0e-8, "float power");
    });
    check("identical stereo averages channel power", [] {
        same_levels(analyze(tone(128)), analyze(tone(128, 1.0, 2), 48000.0, 2), 1.0e-8);
    });
    check("opposite-phase stereo cannot cancel", [] {
        auto samples = tone(128, 1.0, 2);
        for (std::size_t n = 0; n < kFftSize; ++n) samples[n * 2 + 1] = -samples[n * 2];
        same_levels(analyze(tone(128)), analyze(samples, 48000.0, 2), 1.0e-8);
    });
    check("one silent stereo channel reduces power by 3.0103 dB", [] {
        auto samples = tone(calibration_bin, 1.0, 2);
        for (std::size_t n = 0; n < kFftSize; ++n) samples[n * 2 + 1] = 0.0;
        const auto result = analyze(samples, 48000.0, 2);
        (void)require_hann_lobe_in_one_band(result, calibration_bin);
        near(displayed_power(result), 0.25, 1.0e-10, "one active channel power");
        near(peak_dbfs(result), 2.0 * sine_dbfs, 1.0e-8, "one active channel RMS");
    });
    check("different stereo spectra retain both tones", [] {
        const auto left = tone(128, 0.7);
        const auto right = tone(512, 0.3);
        std::vector<double> samples(kFftSize * 2);
        for (std::size_t n = 0; n < kFftSize; ++n) {
            samples[2 * n] = left[n];
            samples[2 * n + 1] = right[n];
        }
        near(displayed_power(analyze(samples, 48000.0, 2)), (0.7 * 0.7 + 0.3 * 0.3) / 4.0,
             1.0e-10, "independent stereo power");
    });
    check("deterministic wideband integrates to independent windowed time-domain energy", [] {
        const auto samples = wideband_fixture();
        const auto result = analyze(samples, 32000.0);
        near(displayed_power(result), window_weighted_mean_square(samples), 1.0e-10, "Parseval power");
        const auto visible = std::count_if(result.bands.begin(), result.bands.end(),
            [](const Band& band) { return band.dbfs > -80.0; });
        require(visible >= 20, "wideband fixture must exercise many bands");
    });
    check("silence is immediate and deterministic after a loud frame", [] {
        const auto loud = analyze(tone(128));
        require(peak_dbfs(loud) > -4.0, "loud fixture failed");
        const std::vector<double> silence(kFftSize);
        const auto first = analyze(silence);
        const auto second = analyze(silence);
        all_at_floor(first);
        same_levels(first, second, 0.0);
    });
    check("no upper clipping or AGC", [] {
        const auto result = analyze(tone(calibration_bin, 2.0));
        (void)require_hann_lobe_in_one_band(result, calibration_bin);
        near(peak_dbfs(result), sine_dbfs + 20.0 * std::log10(2.0), 1.0e-8,
             "over-range source must retain its level");
    });
    check("Hann lobe crossing a log-band edge retains exact 1/12 and 5/12 powers", [] {
        const auto result = analyze(tone(128));
        const auto lower_band = band_containing_bin(result, 127);
        const auto main_band = band_containing_bin(result, 128);
        require(lower_band == 29 && main_band == 30, "1500 Hz fixture band positions changed");
        require(band_containing_bin(result, 129) == main_band, "upper side lobe belongs to main band");
        near(result.bands[lower_band].high_hz, 1499.7884186649114, 1.0e-8, "crossed log-band edge");
        near(std::pow(10.0, result.bands[lower_band].dbfs / 10.0), 1.0 / 12.0, 1.0e-10,
             "lower side lobe power");
        near(std::pow(10.0, result.bands[main_band].dbfs / 10.0), 5.0 / 12.0, 1.0e-10,
             "main plus upper side lobe power");
        near(peak_dbfs(result), 10.0 * std::log10(5.0 / 12.0), 1.0e-8,
             "band-split sine must not be raised to full integrated RMS");
        near(displayed_power(result), 0.5, 1.0e-10, "split bands retain total sine power");
        for (std::size_t i = 0; i < result.bands.size(); ++i) {
            if (i != lower_band && i != main_band) {
                require(result.bands[i].dbfs == still_spectrum::kFloorDbfs,
                        "energy must not be copied into unrelated bands");
            }
        }
    });
    check("sub-floor signal remains at floor", [] { all_at_floor(analyze(tone(128, 1.0e-8))); });
    check("Nyquist has single-sided multiplicity one and is included at last edge", [] {
        std::vector<double> alternating(kFftSize);
        for (std::size_t n = 0; n < kFftSize; ++n) alternating[n] = n % 2 == 0 ? 1.0 : -1.0;
        const auto result = analyze(alternating, 32000.0);
        near(displayed_power(result), 1.0, 1.0e-10, "Nyquist power must not double");
        near(result.bands.back().dbfs, 0.0, 1.0e-8, "Nyquist band RMS");
        require(result.bands.back().has_bins, "last edge must include Nyquist");
    });
    check("DC bin is excluded; periodic Hann leakage is not fabricated bass", [] {
        const std::vector<double> dc(kFftSize, 1.0);
        all_at_floor(analyze(dc, 48000.0)); // DC and its Hann side lobe lie below 20 Hz.
        // At 192 kHz, Hann's real bin-1 leakage is inside the display range.
        // Its power is 1/3, while the excluded DC bin carries 2/3.
        near(displayed_power(analyze(dc, 192000.0)), 1.0 / 3.0, 1.0e-10, "DC side lobe");
    });
    check("all supported rates have finite bounded edges and exact metadata", [] {
        const std::vector<double> silence(kFftSize);
        for (const double rate : {8000.0, 32000.0, 40000.0, 44100.0, 48000.0, 192000.0, 768000.0}) {
            const auto result = analyze(silence, rate);
            require(result.bands.size() == still_spectrum::kBandCount, "band count");
            near(result.sample_rate, rate, 0.0, "sample rate metadata");
            require(result.channels == 1 && result.fft_size == kFftSize &&
                    result.window_frames == kFftSize, "window metadata");
            near(result.window_seconds, static_cast<double>(kFftSize) / rate, 0.0, "window duration");
            near(result.bin_hz, rate / static_cast<double>(kFftSize), 0.0, "bin spacing");
            near(result.bands.front().low_hz, 20.0, 0.0, "lower edge");
            near(result.bands.back().high_hz, std::min(20000.0, rate / 2.0), 0.0, "upper edge");
            for (std::size_t i = 0; i < result.bands.size(); ++i) {
                const auto& band = result.bands[i];
                require(std::isfinite(band.low_hz) && std::isfinite(band.high_hz) &&
                        band.low_hz < band.high_hz && band.high_hz <= rate / 2.0,
                        "invalid or above-Nyquist band");
                if (i > 0) near(band.low_hz, result.bands[i - 1].high_hz, 0.0, "contiguous edges");
                bool actual_bin = false;
                for (std::size_t k = 1; k <= kFftSize / 2; ++k) {
                    const double frequency = static_cast<double>(k) * result.bin_hz;
                    actual_bin = actual_bin || (frequency >= band.low_hz &&
                        (frequency < band.high_hz || (i + 1 == result.bands.size() && frequency == band.high_hz)));
                }
                require(actual_bin == band.has_bins, "empty-bin support must be truthful");
            }
        }
    });
    check("unresolved low bands are explicitly empty even while a real tone is present", [] {
        const auto result = analyze(tone(48), 768000.0);
        std::size_t missing = 0;
        for (const auto& band : result.bands) {
            if (!band.has_bins) {
                ++missing;
                require(band.dbfs == still_spectrum::kFloorDbfs, "empty band gained signal");
            }
        }
        require(missing > 0, "high-rate low bands should have no resolved bins");
    });
    check("latest 4096 real frames are selected without old-sample contamination", [] {
        auto history = tone(128);
        history.insert(history.end(), kFftSize, 0.0);
        history.front() = std::numeric_limits<double>::quiet_NaN(); // discarded, intentionally unread.
        all_at_floor(analyze(history));
        all_at_floor(still_spectrum::analyze_interleaved(std::span<const double>(history),
                                                       2 * kFftSize, 1, 48000.0));
    });
    check("largest channel count is normalized, not summed", [] {
        near(displayed_power(analyze(tone(128, 1.0, 32), 48000.0, 32)), 0.5, 1.0e-10,
             "32-channel average");
    });
    check("empty, short, partial and mismatched spans are rejected", [] {
        rejects([&] { (void)analyze(std::vector<double>{}); });
        rejects([&] { (void)analyze(std::vector<double>(kFftSize - 1)); });
        rejects([&] { (void)analyze(std::vector<double>(2 * kFftSize + 1), 48000.0, 2); });
        const std::vector<double> samples(kFftSize);
        rejects([&] { (void)still_spectrum::analyze_interleaved(std::span<const double>(samples),
                                                              kFftSize + 1, 1, 48000.0); });
    });
    check("invalid sample rates and channel counts are rejected", [] {
        const std::vector<double> samples(kFftSize);
        for (double rate : {0.0, -48000.0, 7999.0, 768001.0, 44100.5,
                            std::numeric_limits<double>::infinity(),
                            std::numeric_limits<double>::quiet_NaN()}) {
            rejects([&] { (void)analyze(samples, rate); });
        }
        for (std::size_t channels : {std::size_t(0), std::size_t(33)}) {
            rejects([&] { (void)analyze(samples, 48000.0, channels); });
        }
    });
    check("NaN, infinity and unsafe finite magnitudes are rejected", [] {
        for (const double invalid : {std::numeric_limits<double>::quiet_NaN(),
                                     std::numeric_limits<double>::infinity(),
                                     -std::numeric_limits<double>::infinity(),
                                     2.0 * still_spectrum::kMaxSampleMagnitude}) {
            auto samples = tone(128);
            samples[kFftSize - 1] = invalid;
            rejects([&] { (void)analyze(samples); });
        }
        auto samples = tone<float>(128);
        samples.front() = std::numeric_limits<float>::quiet_NaN();
        rejects([&] { (void)analyze(samples); });
    });
    check("safe large finite input produces finite output without overflow", [] {
        const auto result = analyze(tone(128, still_spectrum::kMaxSampleMagnitude));
        for (const auto& band : result.bands) require(std::isfinite(band.dbfs), "overflow in output");
    });
    check("frame/channel multiplication overflow is checked before any read", [] {
        rejects<std::length_error>([] {
            (void)still_spectrum::analyze_interleaved(std::span<const double>{},
                std::numeric_limits<std::size_t>::max(), 2, 48000.0);
        });
    });
    std::cout << "Native C++ synthetic DSP fixtures: " << passed << " passed, " << failed << " failed\n";
    return failed == 0 ? 0 : 1;
}
