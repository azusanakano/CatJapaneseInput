#include "catj_context.h"

#include <cstdlib>
#include <iostream>
#include <string>
#include <string_view>

namespace {

using mozc::catj::ExtractContext;
using mozc::catj::LineState;

std::string Utf16Le(std::u16string_view text) {
  std::string result;
  for (const char16_t unit : text) {
    result.push_back(static_cast<char>(unit & 0xff));
    result.push_back(static_cast<char>(unit >> 8));
  }
  return result;
}

void Require(bool ok, const char* description) {
  if (!ok) {
    std::cerr << description << '\n';
    std::exit(1);
  }
}

}  // namespace

int main() {
  {
    const auto context = ExtractContext(Utf16Le(u"old\r\nbefore\u2028\u2029now"), false);
    const auto lines = context.lines();
    Require(lines[0].text == "before" && lines[1].state == LineState::kEmpty &&
                lines[2].text == "now", "CRLF and empty line slots");
  }
  {
    const auto context = ExtractContext(Utf16Le(u"\nnow"), true);
    const auto lines = context.lines();
    Require(lines[0].state == LineState::kUnavailable &&
                lines[1].state == LineState::kUnavailable &&
                lines[1].read_truncated && lines[2].text == "now", "clipped CRLF");
  }
  {
    std::u16string invalid = u"previous\n";
    invalid.push_back(0xd800);
    invalid += u"\ncurrent";
    const auto context = ExtractContext(Utf16Le(invalid), false);
    const auto lines = context.lines();
    Require(lines[0].text == "previous" && lines[1].state == LineState::kUnavailable &&
                lines[2].text == "current", "malformed UTF-16 invalidates only its line");
  }
  {
    const auto context = ExtractContext(Utf16Le(std::u16string(1100, u'x')), false);
    const auto lines = context.lines();
    Require(lines[1].state == LineState::kUnavailable && lines[1].read_truncated &&
                lines[2].text == std::string(128, 'x') && lines[2].read_truncated &&
                lines[2].retention_truncated, "UTF-16 read and code point retention limits");
  }
  {
    const std::u16string text = u"\U0001F468\u200D\U0001F469\u200D\U0001F467" +
                                std::u16string(127, u'x');
    const auto context = ExtractContext(Utf16Le(text), false);
    Require(context.lines()[2].text == std::string(127, 'x'), "keep emoji cluster intact");
  }
  {
    const auto context = ExtractContext(Utf16Le(u"\U0001F1EF\U0001F1F5\U0001F1E8x"), true);
    Require(context.lines()[2].text == "x", "clipped regional indicator parity");
  }
  {
    const auto context = ExtractContext(Utf16Le(u"\u304B\u3099"), false);
    Require(context.lines()[2].text == "\xE3\x81\x8C", "NFC converts a decomposed kana");
    const auto expanded = ExtractContext(Utf16Le(std::u16string(127, u'q') + u"\u0344"), false);
    Require(expanded.lines()[2].text == std::string(126, 'q') + "\xCC\x88\xCC\x81" &&
                expanded.lines()[2].retention_truncated, "retention binds again after NFC");
  }
  {
    const auto context = ExtractContext("x", false);
    Require(context.lines()[2].state == LineState::kUnavailable, "odd wire byte count");
    const auto empty = ExtractContext("", false);
    Require(empty.lines()[2].state == LineState::kEmpty, "empty acquired document");
  }
}
