#ifndef MOZC_CATJ_CATJ_CONTEXT_MODEL_H_
#define MOZC_CATJ_CATJ_CONTEXT_MODEL_H_

#include <array>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace mozc::catj {

enum class Mode { kConversion, kPrediction };
enum class LineState { kUnavailable, kEmpty, kText };

struct ContextLine {
  LineState state = LineState::kUnavailable;
  std::string_view text;
  bool read_truncated = false;
  bool retention_truncated = false;
};

// Oldest line first. Text contains no more than 128 code points in NFC.
using ContextLines = std::array<ContextLine, 3>;

struct CandidateFeatures {
  std::string_view segment_reading;
  std::string_view candidate_reading;
  std::string_view candidate_value;
  std::string_view previous_reading;
  std::string_view previous_value;
  std::string_view next_reading;
  std::string_view next_value;
  bool previous_fixed = false;
  bool next_fixed = false;
  std::optional<std::size_t> candidate_index;
  std::optional<double> candidate_cost;
  std::optional<double> baseline_cost;
};

// Malformed UTF-8 yields nullopt. BoundedFeature also rejects empty text and
// text exceeding 128 code points before or after reading normalization.
std::optional<std::string> NormalizeNfc(std::string_view text);
std::optional<std::string> NormalizeReading(std::string_view text);
std::optional<std::string> BoundedFeature(std::string_view text);

// Immutable weights from tools/mozc/export-model.mjs. The fixed envelope size
// allows callers to bound reads before constructing an owning model.
class ContextModel final {
 public:
  static constexpr std::size_t kBinarySize = 1'072'752;

  static std::unique_ptr<ContextModel> Load(
      std::string_view binary, std::string_view expected_dictionary_sha256);

  bool Trained(Mode mode) const;

  // Untrained mode yields zero. Invalid required features produce NaN so
  // the caller can retain the original order for the group.
  double Score(Mode mode, const CandidateFeatures& candidate,
               const ContextLines& lines) const;

 private:
  ContextModel() = default;

  std::uint8_t trained_modes_ = 0;
  std::array<double, 7> scales_{};
  std::vector<std::int8_t> weights_;
};

}  // namespace mozc::catj

#endif  // MOZC_CATJ_CATJ_CONTEXT_MODEL_H_
