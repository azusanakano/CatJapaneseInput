#include "catj_packaged_model.h"
#include <iostream>
#include <string>
int main() {
  constexpr char kDictionary[] = "catj-review-dictionary\0with-null";
  const std::string dictionary(kDictionary, sizeof(kDictionary) - 1);
  const auto matching = mozc::catj::LoadPackagedModel(dictionary);
  const auto wrong = mozc::catj::LoadPackagedModel("wrong-dictionary");
  const auto empty = mozc::catj::LoadPackagedModel("");
  if (!matching || wrong || empty || !matching->Trained(mozc::catj::Mode::kConversion) ||
      !matching->Trained(mozc::catj::Mode::kPrediction)) return 1;
  std::cout << "Matching dictionary including embedded NUL accepted; mismatch and empty rejected.\n";
}
