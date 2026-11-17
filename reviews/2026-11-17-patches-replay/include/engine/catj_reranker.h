#ifndef MOZC_ENGINE_CATJ_RERANKER_H_
#define MOZC_ENGINE_CATJ_RERANKER_H_

#include <chrono>

#include "absl/functional/function_ref.h"
#include "catj/catj_context_model.h"
#include "converter/segments.h"

namespace mozc::engine {

// Reorders at most one newly generated segment, before assigning list IDs.
// Returns false without mutation if no eligible score beats both margins
// or the operation runs out of time.
bool TryRerankCatjConversion(
    Segments& segments,
    absl::FunctionRef<double(const catj::CandidateFeatures&)> score,
    std::chrono::steady_clock::time_point deadline);

}  // namespace mozc::engine

#endif  // MOZC_ENGINE_CATJ_RERANKER_H_

