# STILL spectrum: numerical contract and validation

`dsp.hpp` is a C++20, standard-library-only, header-only analyzer in
`namespace still_spectrum`. It does not initialize audio, decode files, start
foobar2000, access a device, or depend on the foobar2000 SDK. The spectrum is
computed from supplied PCM samples; no randomized bars or gain normalization
are used.

## API and integration

```cpp
#include "dsp.hpp"

// T must be float or double. The samples are interleaved complete PCM frames.
still_spectrum::FrameAnalysis frame = still_spectrum::analyze_interleaved(
    std::span<const float>(pcm), sample_rate, channels);

// An explicit frame count must describe exactly the supplied span.
auto explicit_frame = still_spectrum::analyze_interleaved(
    std::span<const double>(pcm64), sample_frames, channels, sample_rate);
```

Both overloads analyze exactly the latest **4096 real frames**. Earlier frames
are discarded without reading or validating their sample values. An incomplete
window is rejected; the analyzer never zero pads or marks missing samples as a
4096-frame measurement. Constants `kFftSize = 4096`, `kBandCount = 48`,
`kFloorDbfs = -100`, and `kFloorPower = 1e-10` are public `inline constexpr` values.

`FrameAnalysis` has `sample_rate`, `channels`, `fft_size`, `window_frames`,
`window_seconds`, `bin_hz`, and `std::vector<Band> bands`. Each `Band` has
`low_hz`, `high_hz`, `dbfs`, and `has_bins`. `has_bins` describes frequency-bin
support, not whether audio is audible. Thus a silent supported band has
`has_bins == true` and `dbfs == -100`; an unresolved band has
`has_bins == false` and `dbfs == -100`.

The analyzer allocates its result, performs FFTs, and may throw exceptions. Call
it from the spectrum analysis worker, **not from the audio callback**. Copy or
otherwise transfer the required PCM window out of the callback through the
component's existing bounded handoff; publication and scheduling belong to the
component. This header has no locks, mutable static data, global audio state,
cross-call caches, smoothing, or retained frames. Concurrent calls with stable
separate input spans do not share mutable data. Scratch arrays are fixed size
(approximately 112 KiB on the calling thread's stack), plus 48 output bands.
Complexity is `O(channels * 4096 * log2(4096))` and input validation scans only
the selected `4096 * channels` samples.

The window duration is 4096 / sample_rate seconds: 85.333 ms at 48 kHz,
92.880 ms at 44.1 kHz, and 512 ms at 8 kHz. These are the data horizon, **not
measured end-to-end latency**; capture, scheduling, transport and presentation
add their own delay. Bin spacing is sample_rate / 4096: 11.71875 Hz at 48 kHz
and 187.5 Hz at 768 kHz. Bin spacing does not imply independent resolution
finer than the Hann main lobe. The constant window makes the low-frequency
resolution limits explicit. Native throughput and end-to-end latency have not
been measured in this environment.

## PCM validation

Sample rates are finite integer values from 8000 through 768000 Hz, inclusive;
channel counts are integers from 1 through 32. The explicit overload checks
`sample_frames * channels` for `size_t` overflow before multiplication or sample
access, then requires exact agreement with the span size. The inferred overload
rejects spans ending in a partial interleaved frame. Both reject fewer than
4096 frames.

Every sample in the selected window must be finite. NaN, either infinity, and
finite magnitudes greater than `kMaxSampleMagnitude = 2^490` are rejected with
`std::invalid_argument`. The conservative magnitude bound prevents overflow in
FFT butterflies, squared magnitudes and sums, including the 32-channel case;
it does not clip or compress ordinary PCM. Values above nominal amplitude 1
are accepted and can yield positive dBFS. Frame-count multiplication overflow
throws `std::length_error`; other validation failures throw
`std::invalid_argument`. Ordinary allocation failure can throw `std::bad_alloc`.
As with every `std::span`, its storage must remain valid and unchanged for the
duration of a call; validating an arbitrary pointer's memory is not possible.

## Window, PSD, channels and RMS calibration

Let N = 4096. For channel c and n = 0 through N-1:

```text
w[n]   = 0.5 - 0.5*cos(2*pi*n/N)             periodic Hann
W2     = sum_n w[n]^2                       equals 3*N/8
Xc[k]  = sum_n xc[n]*w[n]*exp(-j*2*pi*k*n/N) unnormalized forward DFT
m[k]   = 1 for k = 0 or N/2; 2 otherwise
PSD_c[k] = m[k]*abs(Xc[k])^2 / (sample_rate * W2)
df     = sample_rate / N
P[k]   = mean_over_channels(PSD_c[k] * df)
       = sum_c(m[k]*abs(Xc[k])^2 / (N*W2*channels))
```

The implementation uses the last expression to integrate each PSD bin without
an unnecessary sample-rate divide/multiply. The FFT is an in-place iterative
radix-2 Cooley-Tukey transform with bit reversal. Only bins 0 through N/2 enter
the one-sided power calculation. The DC and Nyquist bins are not doubled.
Channels are transformed separately and **their powers are averaged**. There
is no summation of PCM channels before the FFT, so opposite-phase stereo cannot
cancel. Identical stereo has the same level as mono; a single active channel
in stereo has half the mean power, a reduction of 3.0102999566 dB.

Power integrated over all bins satisfies the window-weighted Parseval relation:

```text
sum_k P[k] = mean_over_channels(sum_n(xc[n]^2 * w[n]^2) / W2)
```

This is a window-weighted local mean square, not an assertion that every finite
nonstationary waveform has the same unweighted time-domain RMS. A bin-centered
sine away from DC/Nyquist with peak amplitude A has total power A^2/2 after
integration of its Hann main lobe. The Hann energy correction is required;
coherent-gain normalization by `sum(w)^2` would be a different calibration.
A central bin alone contains 1/3 of the mean square of a full-scale sine, with
1/12 in each adjacent bin. A band boundary may split those bins, so an arbitrary
tone's maximum individual band need not equal its total RMS.

The native individual-band calibration fixture uses bin 100 at 48 kHz
(1171.875 Hz). It explicitly verifies that bins 99, 100 and 101 all belong to
band 28, bounded by approximately 1124.68265 and 1298.76326 Hz, before expecting
that band's power to be 1/2. A separate regression deliberately uses bin 128
(1500 Hz), whose Hann lobe crosses the 1499.7884186649 Hz edge. Its band 29
contains bin 127 with power 1/12; band 30 contains bins 128 and 129 with power
5/12. Its correct peak-band level is -3.8021124171 dBFS, while the summed
displayed power is still 1/2. The analyzer must retain that split instead of
raising a band to the tone's total RMS or copying its energy elsewhere.

For each displayed band b:

```text
P_band[b] = sum of P[k] for its assigned bins
dbfs[b]   = max(-100, 10*log10(P_band[b]))
           (zero power maps directly to -100)
```

The reference is digital amplitude 1: `20*log10(RMS/1)` equals
`10*log10(mean_square/1^2)`. A full-scale peak-amplitude-1 sine is
**-3.0102999566 dBFS RMS**. A peak-amplitude-0.5 sine is -9.0308998699 dBFS RMS.
A constant amplitude 1, when integrating DC and its window side lobe, or the
alternating +/-1 Nyquist waveform has total RMS 1 and therefore 0 dBFS under
this definition. This explicit RMS convention is not a peak-bin readout or an
AES full-scale-sine-relative level. It is **not dB SPL**: acoustic pressure,
speaker/headphone gain and hardware calibration are unavailable.

The -100 dBFS floor is a display floor (power 1e-10), not artificial background
energy. Do not sum values reconstructed from floor-clamped bands as exact
physical power. No AGC, frequency compensation, log-band width normalization,
randomness, envelope follower, time smoothing or retained peak is applied.
An all-zero selected window produces exactly -100 for every band immediately.
The consumer can map that floor to a zero-height bar; missing bands remain
missing. Any UI presentation smoothing must not prevent immediate silence.

## Frequency bands, Nyquist and DC

The 49 edges are
`e[i] = 20 * exp(log(min(20000, sample_rate/2)/20) * i/48)`, with exact first
and last values forced to 20 and `min(20000, sample_rate/2)`. Thus there are 48
contiguous logarithmic bands, none above Nyquist. A bin belongs by its center
frequency `k * df` to `[low_hz, high_hz)`. The last band includes its upper
edge, so a Nyquist bin at that edge is included exactly once.

There is no overlap, fractional redistribution, interpolation, copying of an
adjacent value, division by a bin count, or extrapolation into missing bins.
Some low bands have no centers at this FFT size; they are deliberately marked
`has_bins == false`. Above 40 kHz sample rate, the display excludes FFT bins
above 20 kHz. Centers below 20 Hz are also excluded, so the sum of displayed
band powers is not generally the full-band source power.

DC (`k = 0`) is excluded from the display and is never described as a 20 Hz
measurement. The algorithm does not subtract a sample mean or high-pass the
signal: a DC offset really does create periodic-Hann leakage into bin 1. At
48 kHz, that 11.71875 Hz bin is below the displayed range; at 192 kHz, the
46.875 Hz side lobe is in range. For a constant amplitude-1 input the excluded
DC bin contains 2/3 power and the bin-1 side lobe contains 1/3 power. This is a
documented consequence of the selected window, not generated bass. DC removal
would alter the measurement contract and is not silently performed.

## Checks and limitations as of 2026-11-01

`dsp-tests.cpp` is a standalone executable that includes the production header.
It uses only synthetic fixtures. Its cases cover FS and half sine, the float
template, identical/opposite-phase/stereo-silent/different-frequency channels,
32 channels, deterministic wideband/window-energy integration, exact silence,
no upper gain clipping, floor behavior, DC, Nyquist, all supported rate
boundaries, honest missing bins, metadata, latest-window selection, malformed
spans, non-finite samples, unsafe finite magnitudes, and size overflow.

`tests/spectrum-dsp.test.js` has an installed-compiler guard. When a compiler is
present it compiles that real C++ executable and runs it; build or runtime
failure fails the test rather than silently switching algorithms. When absent,
the native test is explicitly **skipped / unavailable**. It probes installed
`cl`, `clang++`, and `g++` on Windows. It never downloads a compiler.

Separately labelled JS tests use direct DFT sums at analytically known occupied
bins, a `sin^2` expression for Hann, and independent time-domain energy. They
verify the mathematical definitions and fixture expectations only. The API
source-presence check verifies source availability only. Neither type executes
or certifies `dsp.hpp`.

Initial local result was 6 passed, 0 failed and 1 native skip because all three
compiler probes returned `ENOENT`. A later configured MSVC/Windows SDK
environment enabled actual native compilation. The first native run produced
18 passed and 4 failed cases: the original tests incorrectly expected a bin-128
tone's entire Hann lobe in one displayed band. Its total-power checks already
passed. The individual-band calibration fixture was corrected as described
above, and the deliberately split-bin regression was added. The production
`dsp.hpp` and its numerical formula were unchanged in this repair. First-failure
status, output and fixture source are preserved rather than overwritten.

**Current actual result:** `node --test tests/spectrum-dsp.test.js` yielded
**8 passed, 0 failed, 0 skipped**, including actual compilation and execution
of the production header through **23 passed, 0 failed native C++ fixtures**.
The compiler is MSVC 19.44.35229 for x64, selected from the task's BuildTools
directory, with Windows SDK 10.0.26100.0. The build used C++20, `/W4`, `/EHsc`
and `/permissive-`; build exit and native run exit were both zero, with no
warning diagnostics in the captured compiler output. `node --check` also
passed. Only child-process `PATH`, `INCLUDE` and `LIB` were set from
`leader-dsp-build-environment.json`; no system configuration was changed by
these checks.

Native throughput, host component integration, hardware capture and visual
presentation remain unverified by this bounded DSP task. No GUI, foobar2000,
Electron or audio device was started for these checks.

Evidence is in `review-evidence/spectrum-20261101/dsp/`:

- `node-dsp-fixtures.log`: original compiler-unavailable Node test run.
- `first-native-failed-status.json`, `first-native-failed-node.log`, and
  `first-native-failed-dsp-tests.cpp`: retained first native failure evidence.
- `band-boundary-independent-reference.json`: independent arithmetic derivation
  of both fixture tones' three-bin band membership, not a production run.
- `native-fixed-node-tests.log`: current successful Node/native test run.
- `native-fixed-cpp-fixtures.log`: actual native executable output.
- `native-test-status.json`: actual compiler probe, command, build/run output,
  success status, and SHA-256 hashes of the sources compiled and tested.
- `handoff.json`: final source hashes and actual check results.

From the `Still` directory, rerun with
`node --test tests/spectrum-dsp.test.js`. To run the synthetic native fixture
directly in an already configured compiler environment:

```text
cl /nologo /std:c++20 /EHsc /W4 /permissive- native/foobar-spectrum/dsp-tests.cpp /Fe:dsp-tests.exe
./dsp-tests.exe

g++ -std=c++20 -O2 -Wall -Wextra -Wpedantic -Werror native/foobar-spectrum/dsp-tests.cpp -o dsp-tests
./dsp-tests
```

## Primary mathematical references

The following official project references were read on 2026-11-01; no code or
third-party numerical library is copied or linked:

- [SciPy `periodogram`](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.periodogram.html)
  documents PSD units, window-energy scaling, and combining negative-frequency
  contributions for a real one-sided spectrum. The RMS/bin-power expressions
  above state this component's explicit integration convention.
- [SciPy `windows.hann`](https://docs.scipy.org/doc/scipy/reference/generated/scipy.signal.windows.hann.html)
  distinguishes the periodic spectral-analysis window from a symmetric filter
  window. This implementation explicitly uses the periodic denominator N.

The fixture identities and numeric dBFS values above also follow directly from
the displayed equations and are checked independently by the JS reference.
