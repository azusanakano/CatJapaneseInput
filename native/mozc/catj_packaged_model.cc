#include "catj_packaged_model.h"

#include <windows.h>
#include <bcrypt.h>

#include <array>
#include <limits>
#include <memory>
#include <string>
#include <string_view>

#include "base/embedded_file.h"

namespace mozc::catj {
namespace {

#include "catj/catj_model_data.inc"

std::string Sha256(std::string_view bytes) {
  if (bytes.empty() || bytes.size() > (std::numeric_limits<ULONG>::max)()) {
    return {};
  }
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (!BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(
          &algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0))) {
    return {};
  }
  std::array<UCHAR, 32> digest;
  const auto status = BCryptHash(
      algorithm, nullptr, 0,
      reinterpret_cast<PUCHAR>(const_cast<char*>(bytes.data())),
      static_cast<ULONG>(bytes.size()), digest.data(),
      static_cast<ULONG>(digest.size()));
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!BCRYPT_SUCCESS(status)) return {};

  static constexpr char kHex[] = "0123456789abcdef";
  std::string result;
  result.reserve(2 * digest.size());
  for (UCHAR byte : digest) {
    result.push_back(kHex[byte >> 4]);
    result.push_back(kHex[byte & 15]);
  }
  return result;
}

}  // namespace

std::shared_ptr<const ContextModel> LoadPackagedModel(
    std::string_view dictionary_data) {
  const std::string digest = Sha256(dictionary_data);
  if (digest.empty()) return nullptr;
  const auto binary = LoadEmbeddedFile(kCatjContextModel);
  return ContextModel::Load(std::string_view(binary.data(), binary.size()), digest);
}

}  // namespace mozc::catj
