#include "engine/catj_reranker.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <string_view>

#include "absl/functional/function_ref.h"
#include "catj/catj_context_model.h"
#include "converter/attribute.h"
#include "converter/candidate.h"
#include "converter/segments.h"

namespace mozc::engine {
namespace {

using ::mozc::converter::Attribute;
using ::mozc::converter::Candidate;

constexpr int kMaxSegments = 4;
constexpr int kSlots = 8;
constexpr uint32_t kProtected =
    Attribute::USER_DICTIONARY | Attribute::NO_MODIFICATION |
    Attribute::COMMAND_CANDIDATE | Attribute::SPELLING_CORRECTION |
    Attribute::TYPING_CORRECTION;
constexpr double kMinLead = 0.15;
constexpr double kMinGain = 0.15;

bool IsFixed(const Segment& segment) {
  return segment.segment_type() == Segment::FIXED_VALUE;
}

std::string_view HeadValue(const Segment* segment) {
  if (segment == nullptr || segment->candidates_size() == 0) return {};
  return segment->candidate(0).value;
}

}  // namespace

bool TryRerankCatjConversion(
    Segments& segments,
    absl::FunctionRef<double(const catj::CandidateFeatures&)> score,
    std::chrono::steady_clock::time_point deadline) {
  const auto expired = [deadline] {
    return std::chrono::steady_clock::now() >= deadline;
  };
  const size_t size = segments.conversion_segments_size();
  int considered_segments = 0;
  for (size_t index = 0; index < size; ++index) {
    if (expired() || considered_segments == kMaxSegments) return false;
    Segment& segment = *segments.mutable_conversion_segment(index);
    if (IsFixed(segment)) continue;

    std::array<int, kSlots> indices;
    int normal_slots = 0;
    for (int candidate_index = 0, end = static_cast<int>(segment.candidates_size());
         candidate_index < end && normal_slots < kSlots; ++candidate_index) {
      if (expired()) return false;
      const Candidate& candidate = segment.candidate(candidate_index);
      if ((candidate.attributes & kProtected) == 0) {
        indices[normal_slots++] = candidate_index;
      }
    }
    if (normal_slots < 2) continue;
    ++considered_segments;
    if (!catj::BoundedFeature(segment.key())) continue;

    const Segment* previous =
        index > 0 ? &segments.conversion_segment(index - 1) : nullptr;
    const Segment* next =
        index + 1 < size ? &segments.conversion_segment(index + 1) : nullptr;
    const Candidate& base = segment.candidate(indices[0]);
    std::array<int, kSlots> scored_indices;
    std::array<double, kSlots> scores;
    int count = 0;
    for (int slot = 0; slot < normal_slots; ++slot) {
      if (expired()) return false;
      const int candidate_index = indices[slot];
      const Candidate& candidate = segment.candidate(candidate_index);
      if (candidate.effective_converted_segment_count() != 1 ||
          (candidate.attributes & Attribute::PARTIALLY_KEY_CONSUMED) != 0 ||
          !catj::BoundedFeature(candidate.key) ||
          !catj::BoundedFeature(candidate.value)) {
        if (slot == 0) break;
        continue;
      }
      const double value = score(catj::CandidateFeatures{
          .segment_reading = segment.key(),
          .candidate_reading = candidate.key,
          .candidate_value = candidate.value,
          .previous_reading = previous == nullptr ? "" : previous->key(),
          .previous_value = HeadValue(previous),
          .next_reading = next == nullptr ? "" : next->key(),
          .next_value = HeadValue(next),
          .previous_fixed = previous != nullptr && IsFixed(*previous),
          .next_fixed = next != nullptr && IsFixed(*next),
          .candidate_index = static_cast<size_t>(candidate_index),
          .candidate_cost = static_cast<double>(candidate.cost),
          .baseline_cost = static_cast<double>(base.cost),
      });
      if (!std::isfinite(value)) {
        count = 0;
        break;
      }
      scored_indices[count] = candidate_index;
      scores[count++] = value;
    }
    if (count < 2) continue;

    const int best = static_cast<int>(
        std::max_element(scores.begin(), scores.begin() + count) - scores.begin());
    if (best == 0) continue;
    double second = -std::numeric_limits<double>::infinity();
    for (int slot = 0; slot < count; ++slot) {
      if (slot != best) second = std::max(second, scores[slot]);
    }
    if (scores[best] - second <= kMinLead || scores[best] - scores[0] <= kMinGain) {
      continue;
    }
    if (expired()) return false;
    for (int slot = best; slot > 0; --slot) {
      segment.swap_candidates(scored_indices[slot], scored_indices[slot - 1]);
    }
    return true;
  }
  return false;
}

}  // namespace mozc::engine

