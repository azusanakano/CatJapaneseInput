#include "catj_context_model.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <span>

#include "utf8proc.h"

namespace mozc::catj {
namespace {

static_assert(UTF8PROC_VERSION_MAJOR == 2 && UTF8PROC_VERSION_MINOR == 11 &&
              UTF8PROC_VERSION_PATCH == 3);
static_assert(sizeof(double) == 8 && std::numeric_limits<double>::is_iec559);

constexpr std::size_t kMaxPoints = 128;
constexpr std::size_t kBuckets = 32'768;
constexpr std::size_t kEmbedding = 32;
constexpr std::size_t kFirst = 64;
constexpr std::size_t kSecond = 32;
constexpr std::size_t kInput = 10 * kEmbedding + 21;
constexpr std::size_t kFixedHeader = 88;
constexpr std::size_t kHashOffset = 16;
constexpr std::size_t kHashLength = 64;
constexpr std::size_t kModesOffset = 80;
constexpr std::uint32_t kFormatVersion = 1;
constexpr std::uint32_t kUnicodeVersion = 0x00110000;

enum Parameter : std::size_t {
  kEmbeddingWeights, kFirstWeights, kFirstBias, kSecondWeights, kSecondBias,
  kConversion, kPrediction, kParameterCount,
};

constexpr std::array<std::size_t, kParameterCount> kLengths = {
    kBuckets * kEmbedding, kInput * kFirst, kFirst, kFirst * kSecond, kSecond,
    kSecond, kSecond,
};
constexpr auto kOffsets = [] {
  std::array<std::size_t, kParameterCount + 1> offsets{};
  for (std::size_t i = 0; i < kParameterCount; ++i) {
    offsets[i + 1] = offsets[i] + kLengths[i];
  }
  return offsets;
}();
constexpr std::size_t kWeightsOffset = kFixedHeader + 8 * kParameterCount;
static_assert(ContextModel::kBinarySize == kWeightsOffset + kOffsets.back());

template <class T>
T ReadLittleEndian(std::string_view bytes) {
  T value = 0;
  for (std::size_t i = 0; i < sizeof(T); ++i) {
    value |= static_cast<T>(static_cast<unsigned char>(bytes[i])) << (i * 8);
  }
  return value;
}

std::uint8_t ModeBit(Mode mode) {
  switch (mode) {
    case Mode::kConversion:
      return 1;
    case Mode::kPrediction:
      return 2;
  }
  return 0;
}

bool IsAscii(std::string_view text) {
  return std::all_of(text.begin(), text.end(),
                    [](unsigned char byte) { return byte < 0x80; });
}

std::optional<std::string> ApplyMap(std::string_view text, int options) {
  if (IsAscii(text)) return std::string(text);
  if (text.size() > static_cast<std::size_t>(
                        std::numeric_limits<utf8proc_ssize_t>::max())) {
    return std::nullopt;
  }
  utf8proc_uint8_t* mapped = nullptr;
  const auto size = utf8proc_map(
      reinterpret_cast<const utf8proc_uint8_t*>(text.data()),
      static_cast<utf8proc_ssize_t>(text.size()), &mapped,
      static_cast<utf8proc_option_t>(options | UTF8PROC_STABLE));
  const std::unique_ptr<utf8proc_uint8_t, decltype(&std::free)> out(mapped,
                                                                   &std::free);
  if (size < 0) return std::nullopt;
  return std::string(reinterpret_cast<const char*>(out.get()), size);
}

// utf8proc needs at most 4 bytes to decode one scalar. A small explicit length
// makes this safe for non-NUL-terminated views and keeps embedded NULs.
utf8proc_ssize_t NextPoint(std::string_view text, utf8proc_int32_t* point) {
  return utf8proc_iterate(
      reinterpret_cast<const utf8proc_uint8_t*>(text.data()),
      static_cast<utf8proc_ssize_t>(std::min<std::size_t>(text.size(), 4)),
      point);
}

bool IsBounded(std::string_view text) {
  if (text.size() > kMaxPoints * 4) return false;
  std::size_t count = 0;
  while (!text.empty()) {
    utf8proc_int32_t point;
    const auto width = NextPoint(text, &point);
    if (width <= 0 || ++count > kMaxPoints) return false;
    text.remove_prefix(width);
  }
  return true;
}

bool IsHalfWidthKana(utf8proc_int32_t point) {
  return point >= 0xFF66 && point <= 0xFF9F;
}

bool Embed(std::string_view text, std::span<const std::int8_t> weights,
           double scale, std::span<double, kEmbedding> out) {
  std::array<std::uint32_t, kMaxPoints> points{};
  std::size_t size = 0;
  while (!text.empty()) {
    utf8proc_int32_t point;
    const auto width = NextPoint(text, &point);
    if (width <= 0 || size == points.size()) return false;
    points[size++] = static_cast<std::uint32_t>(point);
    text.remove_prefix(width);
  }
  if (size == 0) return true;

  // Sum by occurrence in integer space. Dividing once by the total gives the
  // same weighted average as the JS per-bucket occurrence frequencies.
  std::array<std::int32_t, kEmbedding> sums{};
  std::size_t grams = 0;
  for (std::size_t start = 0; start < size; ++start) {
    std::uint32_t hash = 2'166'136'261u;
    for (std::size_t end = start; end < std::min(start + 3, size); ++end) {
      hash = (hash ^ points[end]) * 16'777'619u;
      const std::size_t offset = (hash & (kBuckets - 1)) * kEmbedding;
      for (std::size_t i = 0; i < kEmbedding; ++i) {
        sums[i] += weights[offset + i];
      }
      ++grams;
    }
  }
  for (std::size_t i = 0; i < kEmbedding; ++i) {
    out[i] = static_cast<double>(sums[i]) / grams * scale;
  }
  return true;
}

template <std::size_t N, std::size_t M>
std::array<double, M> Dense(const std::array<double, N>& input,
                            std::span<const std::int8_t> weights,
                            std::span<const std::int8_t> bias,
                            double weight_scale, double bias_scale) {
  std::array<double, M> out{};
  for (std::size_t row = 0; row < M; ++row) {
    double sum = 0;
    for (std::size_t i = 0; i < N; ++i) {
      sum += weights[row * N + i] * input[i];
    }
    out[row] = std::max(sum * weight_scale + bias[row] * bias_scale, 0.0);
  }
  return out;
}

}  // namespace

std::optional<std::string> NormalizeNfc(std::string_view text) {
  return ApplyMap(text, UTF8PROC_COMPOSE);
}

std::optional<std::string> NormalizeReading(std::string_view text) {
  if (IsAscii(text)) return std::string(text);
  std::string wide;
  wide.reserve(text.size());
  while (!text.empty()) {
    utf8proc_int32_t point;
    auto width = NextPoint(text, &point);
    if (width <= 0) return std::nullopt;
    if (!IsHalfWidthKana(point)) {
      wide.append(text.substr(0, width));
      text.remove_prefix(width);
      continue;
    }
    // Restrict compatibility folding to consecutive half-width kana, which
    // may contain voiced marks. Leave other compatibility glyphs untouched.
    std::size_t run = width;
    while (run < text.size()) {
      width = NextPoint(text.substr(run), &point);
      if (width <= 0) return std::nullopt;
      if (!IsHalfWidthKana(point)) break;
      run += width;
    }
    const auto normalized = ApplyMap(text.substr(0, run),
                                     UTF8PROC_COMPAT | UTF8PROC_COMPOSE);
    if (!normalized) return std::nullopt;
    wide.append(*normalized);
    text.remove_prefix(run);
  }
  const auto decomposed = ApplyMap(wide, UTF8PROC_DECOMPOSE);
  if (!decomposed) return std::nullopt;
  std::string folded;
  folded.reserve(decomposed->size());
  std::string_view remaining = *decomposed;
  while (!remaining.empty()) {
    utf8proc_int32_t point;
    const auto width = NextPoint(remaining, &point);
    if (width <= 0) return std::nullopt;
    if ((point >= 0x30A1 && point <= 0x30F6) ||
        (point >= 0x30FD && point <= 0x30FE)) {
      utf8proc_uint8_t bytes[4];
      const auto size = utf8proc_encode_char(point - 0x60, bytes);
      folded.append(reinterpret_cast<const char*>(bytes), size);
    } else {
      folded.append(remaining.substr(0, width));
    }
    remaining.remove_prefix(width);
  }
  return NormalizeNfc(folded);
}

std::optional<std::string> BoundedFeature(std::string_view text) {
  if (text.empty() || !IsBounded(text)) return std::nullopt;
  auto normalized = NormalizeReading(text);
  if (!normalized || !IsBounded(*normalized)) return std::nullopt;
  return normalized;
}

std::unique_ptr<ContextModel> ContextModel::Load(
    std::string_view binary, std::string_view expected_dictionary_sha256) {
  if (binary.size() != kBinarySize || binary.substr(0, 8) != "CATJINT8" ||
      ReadLittleEndian<std::uint32_t>(binary.substr(8, 4)) != kFormatVersion ||
      ReadLittleEndian<std::uint32_t>(binary.substr(12, 4)) != kUnicodeVersion ||
      std::string_view(utf8proc_unicode_version()) != "17.0.0" ||
      expected_dictionary_sha256.size() != kHashLength ||
      !std::all_of(expected_dictionary_sha256.begin(),
                   expected_dictionary_sha256.end(), [](char c) {
                     return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
                   }) ||
      binary.substr(kHashOffset, kHashLength) != expected_dictionary_sha256) {
    return nullptr;
  }
  const auto modes = static_cast<std::uint8_t>(binary[kModesOffset]);
  const auto reserved = binary.substr(kModesOffset + 1,
                                      kFixedHeader - kModesOffset - 1);
  if ((modes & ~3u) != 0 || reserved.find_first_not_of('\0') != reserved.npos) {
    return nullptr;
  }
  std::array<double, kParameterCount> scales{};
  // Values that round to infinity as JS Float32 do are invalid. Use the
  // midpoint explicitly so no out-of-range C++ double-to-float cast is needed.
  const double largest_float_midpoint = std::ldexp(1.0, 128) - std::ldexp(1.0, 103);
  for (std::size_t i = 0; i < kParameterCount; ++i) {
    const auto bits = ReadLittleEndian<std::uint64_t>(
        binary.substr(kFixedHeader + i * 8, 8));
    scales[i] = std::bit_cast<double>(bits);
    if (!std::isfinite(scales[i]) || scales[i] <= 0 ||
        scales[i] * 127 >= largest_float_midpoint) {
      return nullptr;
    }
  }
  const auto weights = binary.substr(kWeightsOffset);
  if (weights.find(static_cast<char>(0x80)) != weights.npos) return nullptr;
  auto model = std::unique_ptr<ContextModel>(new ContextModel);
  model->trained_modes_ = modes;
  model->scales_ = scales;
  model->weights_.resize(weights.size());
  std::transform(weights.begin(), weights.end(), model->weights_.begin(),
                 [](char byte) { return std::bit_cast<std::int8_t>(byte); });
  return model;
}

bool ContextModel::Trained(Mode mode) const {
  return (trained_modes_ & ModeBit(mode)) != 0;
}

double ContextModel::Score(Mode mode, const CandidateFeatures& candidate,
                            const ContextLines& lines) const {
  if (!Trained(mode)) return 0;
  const double invalid = std::numeric_limits<double>::quiet_NaN();
  const auto weights = [this](Parameter p) {
    return std::span<const std::int8_t>(weights_).subspan(kOffsets[p], kLengths[p]);
  };
  const auto embedding = weights(kEmbeddingWeights);
  std::array<double, kInput> input{};
  const auto embed = [&](std::size_t slot, std::string_view text) {
    return Embed(text, embedding, scales_[kEmbeddingWeights],
                 std::span<double, kEmbedding>(input.data() + slot * kEmbedding,
                                               kEmbedding));
  };
  const std::array<std::string_view, 7> fields = {
      candidate.segment_reading, candidate.candidate_reading,
      candidate.candidate_value, candidate.previous_reading,
      candidate.previous_value, candidate.next_reading, candidate.next_value,
  };
  for (std::size_t i = 0; i < fields.size(); ++i) {
    const auto normalized = BoundedFeature(fields[i]);
    if (!normalized && i < 3) return invalid;
    if (normalized && !embed(lines.size() + i, *normalized)) return invalid;
  }
  const auto surface = NormalizeNfc(candidate.candidate_value);
  if (!surface) return invalid;
  std::size_t scalar = kInput - 21;
  for (std::size_t i = 0; i < lines.size(); ++i) {
    const auto& line = lines[i];
    if (!embed(i, line.text)) return invalid;
    input[scalar++] = line.state == LineState::kText;
    input[scalar++] = line.state == LineState::kEmpty;
    input[scalar++] = line.read_truncated;
    input[scalar++] = line.retention_truncated;
    input[scalar++] = line.state == LineState::kText &&
                      line.text.find(*surface) != line.text.npos;
  }
  const double index = static_cast<double>(candidate.candidate_index.value_or(0));
  const bool has_cost = candidate.candidate_cost && candidate.baseline_cost;
  if (has_cost && (!std::isfinite(*candidate.candidate_cost) ||
                   !std::isfinite(*candidate.baseline_cost))) {
    return invalid;
  }
  input[scalar++] = candidate.previous_fixed;
  input[scalar++] = candidate.next_fixed;
  input[scalar++] = candidate.candidate_index.has_value();
  input[scalar++] = index / (8.0 + index);
  input[scalar++] = has_cost;
  input[scalar] = has_cost
                      ? std::tanh((*candidate.candidate_cost - *candidate.baseline_cost) / 1024.0)
                      : 0;

  const auto first = Dense<kInput, kFirst>(input, weights(kFirstWeights),
                                           weights(kFirstBias), scales_[kFirstWeights],
                                           scales_[kFirstBias]);
  const auto second = Dense<kFirst, kSecond>(first, weights(kSecondWeights),
                                             weights(kSecondBias), scales_[kSecondWeights],
                                             scales_[kSecondBias]);
  const Parameter head = mode == Mode::kConversion ? kConversion : kPrediction;
  const auto head_weights = weights(head);
  double score = 0;
  for (std::size_t i = 0; i < kSecond; ++i) score += head_weights[i] * second[i];
  return scales_[head] * score;
}

}  // namespace mozc::catj
