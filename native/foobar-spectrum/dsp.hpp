#pragma once

// Standard-library-only C++20 spectrum analysis. Call on an analysis worker,
// never an audio callback: this function allocates its result and may throw.
#include <array>
#include <cmath>
#include <complex>
#include <concepts>
#include <cstddef>
#include <limits>
#include <numbers>
#include <span>
#include <stdexcept>
#include <type_traits>
#include <vector>

namespace still_spectrum {

inline constexpr std::size_t kFftSize = 4096;
inline constexpr std::size_t kBandCount = 48;
inline constexpr double kFloorDbfs = -100.0;
inline constexpr double kFloorPower = 1.0e-10;
inline constexpr double kLowHz = 20.0;
inline constexpr double kHighHz = 20000.0;
inline constexpr double kMinSampleRate = 8000.0;
inline constexpr double kMaxSampleRate = 768000.0;
inline constexpr std::size_t kMaxChannels = 32;
// Conservative arithmetic bound, not a PCM clipping limit. Together with N and
// the channel limit this keeps FFT butterflies, squared magnitudes and sums
// finite in IEEE double even for intentionally over-range input.
inline constexpr double kMaxSampleMagnitude = 0x1p+490;

struct Band {
    double low_hz = 0.0;
    double high_hz = 0.0;
    double dbfs = kFloorDbfs;
    bool has_bins = false;
};

struct FrameAnalysis {
    double sample_rate = 0.0;
    std::size_t channels = 0;
    std::size_t fft_size = kFftSize;
    std::size_t window_frames = kFftSize;
    double window_seconds = 0.0;
    double bin_hz = 0.0;
    std::vector<Band> bands;
};

template <typename Sample>
concept PcmSample = std::same_as<Sample, float> || std::same_as<Sample, double>;

namespace detail {

inline void validate_format(double sample_rate, std::size_t channels) {
    if (!std::isfinite(sample_rate) || sample_rate < kMinSampleRate ||
        sample_rate > kMaxSampleRate || std::floor(sample_rate) != sample_rate) {
        throw std::invalid_argument("sample rate must be an integer from 8000 to 768000 Hz");
    }
    if (channels == 0 || channels > kMaxChannels) {
        throw std::invalid_argument("channel count must be from 1 to 32");
    }
}

inline void fft_in_place(std::array<std::complex<double>, kFftSize>& values) {
    static_assert(kFftSize >= 4 && (kFftSize & (kFftSize - 1)) == 0);
    for (std::size_t i = 1, j = 0; i < kFftSize; ++i) {
        std::size_t bit = kFftSize >> 1;
        for (; (j & bit) != 0; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            const auto temporary = values[i];
            values[i] = values[j];
            values[j] = temporary;
        }
    }
    for (std::size_t length = 2; length <= kFftSize; length <<= 1) {
        const double angle = -2.0 * std::numbers::pi_v<double> / static_cast<double>(length);
        const std::complex<double> step(std::cos(angle), std::sin(angle));
        for (std::size_t begin = 0; begin < kFftSize; begin += length) {
            std::complex<double> rotation(1.0, 0.0);
            for (std::size_t j = 0; j < length / 2; ++j) {
                const auto even = values[begin + j];
                const auto odd = values[begin + j + length / 2] * rotation;
                values[begin + j] = even + odd;
                values[begin + j + length / 2] = even - odd;
                rotation *= step;
            }
        }
    }
}

inline double power_to_dbfs(double power) {
    // No upper clipping, AGC, envelope or temporal smoothing. Real values above
    // nominal full scale may legitimately produce positive dBFS.
    return power <= kFloorPower ? kFloorDbfs : 10.0 * std::log10(power);
}

} // namespace detail

// sample_frames describes the entire span, not the requested FFT length.
// Both overloads use exactly the most recent 4096 complete frames. Samples in
// discarded older frames are not read or validated. No zero padding is used.
template <PcmSample Sample>
[[nodiscard]] FrameAnalysis analyze_interleaved(std::span<const Sample> samples,
                                               std::size_t sample_frames,
                                               std::size_t channels,
                                               double sample_rate) {
    detail::validate_format(sample_rate, channels);
    if (sample_frames > (std::numeric_limits<std::size_t>::max)() / channels) {
        throw std::length_error("interleaved frame/channel size would overflow");
    }
    if (samples.size() != sample_frames * channels) {
        throw std::invalid_argument("span size does not match frame/channel size");
    }
    if (sample_frames < kFftSize) {
        throw std::invalid_argument("4096 real sample frames are required");
    }
    const std::size_t first_sample = (sample_frames - kFftSize) * channels;
    const std::size_t window_samples = kFftSize * channels;
    for (std::size_t i = 0; i < window_samples; ++i) {
        const double value = static_cast<double>(samples[first_sample + i]);
        if (!std::isfinite(value) || std::abs(value) > kMaxSampleMagnitude) {
            throw std::invalid_argument("analysis window has a non-finite or unsafe-magnitude sample");
        }
    }

    std::array<double, kFftSize> window{};
    double window_energy = 0.0;
    for (std::size_t n = 0; n < kFftSize; ++n) {
        // Periodic Hann: denominator is N, not N-1.
        window[n] = 0.5 - 0.5 * std::cos(2.0 * std::numbers::pi_v<double> *
                                       static_cast<double>(n) / static_cast<double>(kFftSize));
        window_energy += window[n] * window[n];
    }

    std::array<double, kFftSize / 2 + 1> mean_bin_power{};
    std::array<std::complex<double>, kFftSize> transformed{};
    // PSD[k] = m[k] |FFT(x*w)[k]|^2 / (sample_rate * sum(w^2)).
    // Integrated bin power is PSD[k] * (sample_rate/N), equivalently the
    // expression below. Normalize by energy, never coherent gain sum(w)^2.
    const double scale = 1.0 / (static_cast<double>(kFftSize) * window_energy *
                                static_cast<double>(channels));
    for (std::size_t channel = 0; channel < channels; ++channel) {
        for (std::size_t n = 0; n < kFftSize; ++n) {
            transformed[n] = std::complex<double>(
                static_cast<double>(samples[first_sample + n * channels + channel]) * window[n], 0.0);
        }
        detail::fft_in_place(transformed);
        for (std::size_t k = 0; k <= kFftSize / 2; ++k) {
            // DC and Nyquist have no distinct negative-frequency partner.
            const double multiplicity = (k == 0 || k == kFftSize / 2) ? 1.0 : 2.0;
            mean_bin_power[k] += std::norm(transformed[k]) * scale * multiplicity;
        }
    }

    FrameAnalysis result;
    result.sample_rate = sample_rate;
    result.channels = channels;
    result.window_seconds = static_cast<double>(kFftSize) / sample_rate;
    result.bin_hz = sample_rate / static_cast<double>(kFftSize);
    result.bands.resize(kBandCount);
    const double upper_hz = (sample_rate / 2.0 < kHighHz) ? sample_rate / 2.0 : kHighHz;
    const double log_range = std::log(upper_hz / kLowHz);
    std::array<double, kBandCount + 1> edges{};
    edges.front() = kLowHz;
    edges.back() = upper_hz;
    for (std::size_t i = 1; i < kBandCount; ++i) {
        edges[i] = kLowHz * std::exp(log_range * static_cast<double>(i) /
                                   static_cast<double>(kBandCount));
    }
    for (std::size_t i = 0; i < kBandCount; ++i) {
        result.bands[i].low_hz = edges[i];
        result.bands[i].high_hz = edges[i + 1];
    }

    std::array<double, kBandCount> band_power{};
    std::size_t band_index = 0;
    // DC is deliberately excluded. Each positive-frequency bin is assigned by
    // its center exactly once to [low, high); the last upper edge is inclusive.
    // Empty low-frequency bands are explicitly missing, not interpolated.
    for (std::size_t k = 1; k <= kFftSize / 2; ++k) {
        const double frequency = static_cast<double>(k) * result.bin_hz;
        if (frequency < kLowHz) continue;
        if (frequency > upper_hz) break;
        while (band_index + 1 < kBandCount && frequency >= edges[band_index + 1]) ++band_index;
        result.bands[band_index].has_bins = true;
        band_power[band_index] += mean_bin_power[k];
    }
    for (std::size_t i = 0; i < kBandCount; ++i) {
        result.bands[i].dbfs = detail::power_to_dbfs(band_power[i]);
    }
    return result;
}

template <PcmSample Sample>
[[nodiscard]] FrameAnalysis analyze_interleaved(std::span<const Sample> samples,
                                               double sample_rate,
                                               std::size_t channels) {
    detail::validate_format(sample_rate, channels);
    if (samples.size() % channels != 0) {
        throw std::invalid_argument("span contains an incomplete interleaved frame");
    }
    return analyze_interleaved(samples, samples.size() / channels, channels, sample_rate);
}

} // namespace still_spectrum
