#include "catj_context.h"

#include <algorithm>
#include <array>
#include <cstddef>
#include <iterator>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "utf8proc.h"

namespace mozc::catj {
namespace {

constexpr std::size_t kReadUnits = 1024;
constexpr std::size_t kRetainPoints = 128;
using Points = std::vector<utf8proc_int32_t>;

char16_t UnitAt(std::string_view bytes, std::size_t index) {
  return static_cast<unsigned char>(bytes[index]) |
         (static_cast<unsigned char>(bytes[index + 1]) << 8);
}

bool IsHighSurrogate(char16_t unit) { return unit >= 0xd800 && unit <= 0xdbff; }
bool IsLowSurrogate(char16_t unit) { return unit >= 0xdc00 && unit <= 0xdfff; }

std::optional<Points> DecodeUtf16(std::u16string_view text) {
  Points result;
  result.reserve(text.size());
  for (std::size_t i = 0; i < text.size(); ++i) {
    const char16_t high = text[i];
    if (IsHighSurrogate(high)) {
      if (++i == text.size() || !IsLowSurrogate(text[i])) return std::nullopt;
      result.push_back(0x10000 + ((high - 0xd800) << 10) + (text[i] - 0xdc00));
    } else if (IsLowSurrogate(high)) {
      return std::nullopt;
    } else {
      result.push_back(high);
    }
  }
  return result;
}

std::optional<Points> DecodeUtf8(std::string_view text) {
  Points result;
  for (std::size_t i = 0; i < text.size();) {
    utf8proc_int32_t value;
    const auto length = utf8proc_iterate(
        reinterpret_cast<const utf8proc_uint8_t*>(text.data() + i),
        static_cast<utf8proc_ssize_t>(text.size() - i), &value);
    if (length <= 0) return std::nullopt;
    result.push_back(value);
    i += length;
  }
  return result;
}

std::string EncodeUtf8(std::span<const utf8proc_int32_t> points) {
  std::string result;
  for (const auto point : points) {
    utf8proc_uint8_t buffer[4];
    const auto count = utf8proc_encode_char(point, buffer);
    result.append(reinterpret_cast<const char*>(buffer), count);
  }
  return result;
}

std::vector<std::size_t> ClusterStarts(std::span<const utf8proc_int32_t> text) {
  std::vector<std::size_t> result{0};
  utf8proc_int32_t state = 0;
  for (std::size_t i = 1; i < text.size(); ++i) {
    if (utf8proc_grapheme_break_stateful(text[i - 1], text[i], &state)) {
      result.push_back(i);
    }
  }
  return result;
}

std::size_t ConfirmedStart(const Points& line) {
  auto possible = ClusterStarts(line);
  possible.erase(possible.begin());
  // These prefixes model the lookbehind state for GB9c, GB11 and GB12/13.
  constexpr std::array<utf8proc_int32_t, 2> kIndic = {0x915, 0x94d};
  constexpr std::array<utf8proc_int32_t, 1> kPictograph = {0x1f600};
  constexpr std::array<utf8proc_int32_t, 1> kRegional = {0x1f1e6};
  for (const auto prefix : std::array<std::span<const utf8proc_int32_t>, 3>{
           kIndic, kPictograph, kRegional}) {
    if (possible.empty()) break;
    Points prefixed(prefix.begin(), prefix.end());
    prefixed.insert(prefixed.end(), line.begin(), line.end());
    const auto known = ClusterStarts(prefixed);
    std::erase_if(possible, [&](std::size_t index) {
      return !std::binary_search(known.begin(), known.end(), index + prefix.size());
    });
  }
  return possible.empty() ? line.size() : possible.front();
}

std::span<const utf8proc_int32_t> RetainSuffix(
    std::span<const utf8proc_int32_t> line) {
  if (line.size() <= kRetainPoints) return line;
  const auto boundaries = ClusterStarts(line);
  const auto start = std::lower_bound(boundaries.begin(), boundaries.end(),
                                      line.size() - kRetainPoints);
  return start == boundaries.end() ? line.last(0) : line.subspan(*start);
}

}  // namespace

ContextLines ExtractedContext::lines() const & {
  ContextLines views;
  for (std::size_t i = 0; i < views.size(); ++i) {
    const Line& line = lines_[i];
    views[i] = {line.state, line.text, line.read_truncated,
                line.retention_truncated};
  }
  return views;
}

ExtractedContext ExtractContext(std::string_view bytes, bool left_clipped) {
  ExtractedContext result;
  if (bytes.size() % 2 != 0) return result;
  std::size_t start = bytes.size() > 2 * kReadUnits ? bytes.size() - 2 * kReadUnits : 0;
  left_clipped |= start > 0;
  if (left_clipped && start < bytes.size() && IsLowSurrogate(UnitAt(bytes, start)) &&
      (start == 0 || IsHighSurrogate(UnitAt(bytes, start - 2)))) {
    start += 2;
  }

  std::u16string acquired;
  acquired.reserve((bytes.size() - start) / 2);
  for (std::size_t i = start; i < bytes.size(); i += 2) acquired.push_back(UnitAt(bytes, i));

  std::u16string_view remaining(acquired);
  for (auto& slot : result.lines_) slot.read_truncated = left_clipped;
  for (auto it = result.lines_.rbegin(); it != result.lines_.rend(); ++it) {
    auto& slot = *it;
    const auto newline = remaining.find_last_of(u"\r\n\u2028\u2029");
    const bool leftmost = newline == std::u16string_view::npos;
    const auto line = leftmost ? remaining : remaining.substr(newline + 1);
    slot.read_truncated = leftmost && left_clipped;
    auto points = DecodeUtf16(line);
    if (points) {
      std::span<const utf8proc_int32_t> complete(*points);
      if (slot.read_truncated) complete = complete.subspan(ConfirmedStart(*points));
      if (!slot.read_truncated || !complete.empty()) {
        const auto retained = RetainSuffix(complete);
        if (const auto normalized = NormalizeNfc(EncodeUtf8(retained))) {
          const auto normalized_points = DecodeUtf8(*normalized);
          if (normalized_points) {
            const auto kept = RetainSuffix(*normalized_points);
            slot.retention_truncated = retained.size() < complete.size() ||
                                       kept.size() < normalized_points->size();
            if (!kept.empty()) {
              slot.text = EncodeUtf8(kept);
              slot.state = LineState::kText;
            } else if (!slot.retention_truncated) {
              slot.state = LineState::kEmpty;
            }
          }
        }
      }
    }
    if (leftmost) break;
    const bool crlf = remaining[newline] == u'\n' && newline > 0 && remaining[newline - 1] == u'\r';
    remaining = remaining.substr(0, newline - static_cast<std::size_t>(crlf));
  }
  return result;
}

}  // namespace mozc::catj
