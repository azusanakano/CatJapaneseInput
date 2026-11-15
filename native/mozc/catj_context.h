#ifndef MOZC_CATJ_CATJ_CONTEXT_H_
#define MOZC_CATJ_CATJ_CONTEXT_H_

#include <array>
#include <string>
#include <string_view>

#include "catj_context_model.h"

namespace mozc::catj {

class ExtractedContext {
 public:
  ContextLines lines() const &;
  ContextLines lines() const && = delete;

 private:
  struct Line {
    LineState state = LineState::kUnavailable;
    std::string text;
    bool read_truncated = false;
    bool retention_truncated = false;
  };
  std::array<Line, 3> lines_;

  friend ExtractedContext ExtractContext(std::string_view, bool);
};

// Decode the TSF capture, keeping the current line and up to two prior lines.
ExtractedContext ExtractContext(std::string_view preceding_utf16le,
                                bool left_clipped);

}  // namespace mozc::catj

#endif  // MOZC_CATJ_CATJ_CONTEXT_H_
