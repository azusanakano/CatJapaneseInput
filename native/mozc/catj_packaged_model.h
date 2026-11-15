#ifndef MOZC_CATJ_CATJ_PACKAGED_MODEL_H_
#define MOZC_CATJ_CATJ_PACKAGED_MODEL_H_

#include <memory>
#include <string_view>

#include "catj_context_model.h"

namespace mozc::catj {

// Returns nullptr when the embedded model does not match the loaded dictionary.
std::shared_ptr<const ContextModel> LoadPackagedModel(
    std::string_view dictionary_data);

}  // namespace mozc::catj

#endif  // MOZC_CATJ_CATJ_PACKAGED_MODEL_H_
