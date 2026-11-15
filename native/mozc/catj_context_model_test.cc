#include "catj_context_model.h"

#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <string>
#include <string_view>

namespace {

using mozc::catj::BoundedFeature;
using mozc::catj::CandidateFeatures;
using mozc::catj::ContextLines;
using mozc::catj::ContextModel;
using mozc::catj::LineState;
using mozc::catj::Mode;
using mozc::catj::NormalizeNfc;
using mozc::catj::NormalizeReading;

void Check(bool condition, std::string_view description) {
  if (condition) return;
  std::cerr << description << '\n';
  std::exit(EXIT_FAILURE);
}

int Run(const std::filesystem::path& path) {
  std::ifstream input(path, std::ios::binary);
  Check(input.is_open(), "cannot open model fixture");
  std::string bytes(ContextModel::kBinarySize, '\0');
  input.read(bytes.data(), bytes.size());
  Check(input.gcount() == bytes.size() && input.peek() == EOF,
        "model fixture size mismatch");
  const std::string hash(64, 'a');
  auto model = ContextModel::Load(bytes, hash);
  Check(model && model->Trained(Mode::kConversion) &&
            model->Trained(Mode::kPrediction),
        "valid blob rejected");
  Check(!ContextModel::Load(bytes, std::string(64, 'b')), "wrong hash accepted");
  Check(!ContextModel::Load(std::string_view(bytes).substr(1), hash),
        "truncated blob accepted");
  auto corrupt = bytes;
  corrupt[80] = 4;
  Check(!ContextModel::Load(corrupt, hash), "unknown head accepted");
  corrupt[80] = 3;
  corrupt[144] = static_cast<char>(0x80);
  Check(!ContextModel::Load(corrupt, hash), "noncanonical -128 accepted");
  corrupt = bytes;
  corrupt.replace(88, 8, 8, '\0');
  Check(!ContextModel::Load(corrupt, hash), "zero scale accepted");

  Check(NormalizeReading("カイﾄｳ・カ\u3099・ヷ・ヾ・Ａ") ==
            "かいとう・が・わ\u3099・ゞ・Ａ",
        "kana folding did not match the training path");
  Check(NormalizeNfc(std::string("a\0e\xCC\x81", 5)) ==
            std::string("a\0é", 4),
        "NFC truncated embedded NUL");
  Check(!BoundedFeature(std::string(129, 'a')) &&
            !BoundedFeature(std::string("\xED\xA0\x80")) &&
            !BoundedFeature(std::string(127, 'q') + "\u0344"),
        "invalid or overlong feature accepted");

  std::cout << std::setprecision(17);
  for (const Mode mode : {Mode::kConversion, Mode::kPrediction}) {
    for (const std::string_view earlier : {"アンケートへの回答を集めます。",
                                          "肉を解凍します。"}) {
      const ContextLines lines = {{
          {LineState::kText, earlier},
          {LineState::kText, "作業は明日進めます。"},
          {LineState::kEmpty, ""},
      }};
      CandidateFeatures features;
      features.segment_reading = "かいとう";
      features.baseline_cost = 1200;
      features.candidate_reading = "カイﾄｳ";
      features.candidate_value = "回答";
      features.candidate_index = 0;
      features.candidate_cost = 1200;
      const double baseline = model->Score(mode, features, lines);
      features.candidate_reading = "かいとう";
      features.candidate_value = "解凍";
      features.candidate_index = 1;
      features.candidate_cost = 1250;
      const double alternate = model->Score(mode, features, lines);
      Check(std::isfinite(baseline) && std::isfinite(alternate),
            "valid pair yielded a nonfinite score");
      std::cout << baseline << '\n' << alternate << '\n';
    }
  }
  return EXIT_SUCCESS;
}

}  // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
#else
int main(int argc, char** argv) {
#endif
  if (argc != 2) return EXIT_FAILURE;
  return Run(argv[1]);
}
