#include "catj_context.h"
#include "catj_context_model.h"

#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <iterator>
#include <optional>
#include <sstream>
#include <string>
#include <vector>

std::string Unhex(std::string_view value) {
  if (value == "-") return {};
  std::string bytes;
  auto digit = [](char c) { return c <= '9' ? c - '0' : c - 'a' + 10; };
  for (std::size_t i = 0; i + 1 < value.size(); i += 2) {
    bytes.push_back(static_cast<char>(digit(value[i]) * 16 + digit(value[i + 1])));
  }
  return bytes;
}

int wmain(int argc, wchar_t** argv) {
  using namespace mozc::catj;
  if (argc != 2) return 2;
  std::ifstream input(std::filesystem::path(argv[1]), std::ios::binary);
  const std::string binary((std::istreambuf_iterator<char>(input)), {});
  const auto base = ContextModel::Load(binary, std::string(64, 'a'));
  if (!base) return 3;
  std::cout << std::setprecision(17);
  std::string line;
  while (std::getline(std::cin, line)) {
    std::istringstream fields(line);
    char command;
    fields >> command;
    if (command == 'B') {
      std::size_t offset;
      std::string replacement;
      fields >> offset >> replacement;
      std::string changed = binary;
      changed.replace(offset, Unhex(replacement).size(), Unhex(replacement));
      const auto model = ContextModel::Load(changed, std::string(64, 'a'));
      std::cout << !!model;
      if (model) {
        CandidateFeatures candidate;
        candidate.segment_reading = candidate.candidate_reading = candidate.candidate_value = "a";
        for (const Mode mode : {Mode::kConversion, Mode::kPrediction}) {
          std::cout << ' ' << model->Trained(mode) << ' ' << model->Score(mode, candidate, ContextLines{});
        }
      }
    } else if (command == 'T') {
      std::size_t length;
      fields >> length;
      auto changed = binary;
      changed.resize(length);
      std::cout << !!ContextModel::Load(changed, std::string(64, 'a'));
    } else if (command == 'H') {
      std::string hash;
      fields >> hash;
      std::cout << !!ContextModel::Load(binary, Unhex(hash));
    } else if (command == 'S') {
      int mode, clipped, previous_fixed, next_fixed;
      std::string raw_context;
      fields >> mode >> clipped >> raw_context >> previous_fixed >> next_fixed;
      std::vector<std::string> strings;
      for (int i = 0; i < 7; ++i) {
        std::string text;
        fields >> text;
        strings.push_back(Unhex(text));
      }
      std::string index, cost, baseline;
      fields >> index >> cost >> baseline;
      if (!fields) return 4;
      CandidateFeatures candidate;
      candidate.segment_reading = strings[0];
      candidate.candidate_reading = strings[1];
      candidate.candidate_value = strings[2];
      candidate.previous_reading = strings[3];
      candidate.previous_value = strings[4];
      candidate.next_reading = strings[5];
      candidate.next_value = strings[6];
      candidate.previous_fixed = previous_fixed;
      candidate.next_fixed = next_fixed;
      if (index != "-") candidate.candidate_index = std::stoull(index);
      if (cost != "-") candidate.candidate_cost = std::stod(cost);
      if (baseline != "-") candidate.baseline_cost = std::stod(baseline);
      const auto context = ExtractContext(Unhex(raw_context), clipped);
      std::cout << base->Score(mode == 0 ? Mode::kConversion : Mode::kPrediction, candidate, context.lines());
    } else {
      return 5;
    }
    std::cout << '\n';
  }
}
