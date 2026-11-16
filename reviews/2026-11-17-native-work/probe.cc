#include "catj_context.h"
#include "catj_context_model.h"
#include "utf8proc.h"

#include <iostream>
#include <optional>
#include <string>
#include <string_view>

std::string Unhex(std::string_view value) {
  std::string bytes;
  auto digit = [](char c) { return c <= '9' ? c - '0' : c - 'a' + 10; };
  for (std::size_t i = 0; i + 1 < value.size(); i += 2) {
    bytes.push_back(static_cast<char>(digit(value[i]) * 16 + digit(value[i + 1])));
  }
  return bytes;
}

std::string Hex(std::string_view value) {
  constexpr char digits[] = "0123456789abcdef";
  std::string out;
  for (unsigned char byte : value) {
    out += digits[byte >> 4];
    out += digits[byte & 15];
  }
  return out;
}

std::string HexResult(const std::optional<std::string>& result) {
  return result ? Hex(*result) : "!";
}

int main() {
  using namespace mozc::catj;
  std::string command;
  while (std::getline(std::cin, command)) {
    if (command.size() < 2) return 2;
    const std::string bytes = Unhex(std::string_view(command).substr(2));
    if (command[0] == 'C') {
      const auto context = ExtractContext(bytes, command[1] == '1');
      bool first = true;
      for (const auto& line : context.lines()) {
        if (!first) std::cout << '\t';
        first = false;
        std::cout << static_cast<int>(line.state) << ',' << line.read_truncated
                  << ',' << line.retention_truncated << ',' << Hex(line.text);
      }
    } else if (command[0] == 'N') {
      std::cout << HexResult(NormalizeNfc(bytes)) << '\t'
                << HexResult(NormalizeReading(bytes)) << '\t'
                << HexResult(BoundedFeature(bytes));
    } else if (command[0] == 'G') {
      utf8proc_int32_t previous = -1, state = 0;
      std::size_t index = 0;
      std::cout << 0;
      for (std::size_t offset = 0; offset < bytes.size(); ++index) {
        utf8proc_int32_t point;
        const auto width = utf8proc_iterate(
            reinterpret_cast<const utf8proc_uint8_t*>(bytes.data() + offset),
            static_cast<utf8proc_ssize_t>(bytes.size() - offset), &point);
        if (width <= 0) return 3;
        if (previous >= 0 && utf8proc_grapheme_break_stateful(previous, point, &state)) {
          std::cout << ',' << index;
        }
        previous = point;
        offset += width;
      }
      std::cout << ',' << index;
    } else {
      return 4;
    }
    std::cout << '\n';
  }
}
