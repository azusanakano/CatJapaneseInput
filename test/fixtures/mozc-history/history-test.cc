#include <windows.h>
#include <msctf.h>
#include <wrl/client.h>
#include <cstdint>
#include <iostream>

// The isolated method needs only these operations of wil::com_ptr_nothrow.
// Use the SDK's owning COM pointer; the full Mozc build uses WIL.
namespace wil {
template <class T> using com_ptr_nothrow = Microsoft::WRL::ComPtr<T>;
}

unsigned failures = 0;
void Check(bool condition, const char* message) {
  std::cout << (condition ? "PASS " : "FAIL ") << message << '\n';
  if (!condition) ++failures;
}

constexpr TfClientId kClientId = 123;
unsigned unrelated_calls = 0;
unsigned requested_text = 0;
unsigned wrong_client = 0;

#define COM_LIFETIME \
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID, void** out) override { \
    *out = nullptr; return E_NOINTERFACE; \
  } \
  ULONG STDMETHODCALLTYPE AddRef() override { return ++references; } \
  ULONG STDMETHODCALLTYPE Release() override { return --references; } \
  ULONG references = 1
#define UNUSED_METHOD(name, args) \
  HRESULT STDMETHODCALLTYPE name args override { ++unrelated_calls; return E_NOTIMPL; }

class Context final : public ITfContext {
 public:
  COM_LIFETIME;
  HRESULT write_result = S_OK;
  BOOL own_edit = FALSE;
  HRESULT STDMETHODCALLTYPE InWriteSession(TfClientId id, BOOL* own) override {
    if (id != kClientId) ++wrong_client;
    *own = own_edit;
    return write_result;
  }
  UNUSED_METHOD(RequestEditSession, (TfClientId, ITfEditSession*, DWORD, HRESULT*));
  UNUSED_METHOD(GetSelection, (TfEditCookie, ULONG, ULONG, TF_SELECTION*, ULONG*));
  UNUSED_METHOD(SetSelection, (TfEditCookie, ULONG, const TF_SELECTION*));
  UNUSED_METHOD(GetStart, (TfEditCookie, ITfRange**));
  UNUSED_METHOD(GetEnd, (TfEditCookie, ITfRange**));
  UNUSED_METHOD(GetActiveView, (ITfContextView**));
  UNUSED_METHOD(EnumViews, (IEnumTfContextViews**));
  UNUSED_METHOD(GetStatus, (TF_STATUS*));
  UNUSED_METHOD(GetProperty, (REFGUID, ITfProperty**));
  UNUSED_METHOD(GetAppProperty, (REFGUID, ITfReadOnlyProperty**));
  UNUSED_METHOD(TrackProperties, (const GUID**, ULONG, const GUID**, ULONG, ITfReadOnlyProperty**));
  UNUSED_METHOD(EnumProperties, (IEnumTfProperties**));
  UNUSED_METHOD(GetDocumentMgr, (ITfDocumentMgr**));
  UNUSED_METHOD(CreateRangeBackup, (TfEditCookie, ITfRange*, ITfRangeBackup**));
};

class Ranges final : public IEnumTfRanges {
 public:
  COM_LIFETIME;
  HRESULT skip_result = S_FALSE;
  HRESULT STDMETHODCALLTYPE Skip(ULONG count) override {
    if (count != 1) ++unrelated_calls;
    return skip_result;
  }
  UNUSED_METHOD(Clone, (IEnumTfRanges**));
  HRESULT STDMETHODCALLTYPE Next(ULONG, ITfRange**, ULONG*) override {
    ++requested_text;
    return E_NOTIMPL;
  }
  UNUSED_METHOD(Reset, ());
};

class Record final : public ITfEditRecord {
 public:
  COM_LIFETIME;
  BOOL selection_changed = FALSE;
  HRESULT selection_result = S_OK;
  HRESULT text_result = S_OK;
  bool null_ranges = false;
  Ranges ranges;
  HRESULT STDMETHODCALLTYPE GetSelectionStatus(BOOL* changed) override {
    *changed = selection_changed;
    return selection_result;
  }
  HRESULT STDMETHODCALLTYPE GetTextAndPropertyUpdates(
      DWORD flags, const GUID** properties, ULONG property_count,
      IEnumTfRanges** out) override {
    if (flags != TF_GTP_INCL_TEXT || properties || property_count) ++unrelated_calls;
    *out = nullptr;
    if (SUCCEEDED(text_result) && !null_ranges) {
      ranges.AddRef();
      *out = &ranges;
    }
    return text_result;
  }
};

class TipThreadContext {
 public:
  std::int32_t revision = 0;
  void IncrementFocusRevision() { ++revision; }
};
class TipTextService {
 public:
  TipThreadContext thread;
  TipThreadContext* GetThreadContext() { return &thread; }
  TfClientId GetClientID() const { return kClientId; }
};

HRESULT downstream_result = S_OK;
unsigned downstream_calls = 0;
unsigned ui_updates = 0;
HRESULT OnEndEditImpl(TipTextService*, ITfContext*, TfEditCookie,
                      ITfEditRecord*, bool* update_ui) {
  ++downstream_calls;
  *update_ui = true;
  return downstream_result;
}
class TipEditSessionImpl {
 public:
  static HRESULT OnEndEdit(TipTextService*, ITfContext*, TfEditCookie, ITfEditRecord*);
  static void UpdateUI(TipTextService*, ITfContext*, TfEditCookie) { ++ui_updates; }
};

// CATJ_ACTUAL_ON_END_EDIT

int main() {
  TipTextService service;
  auto expect = [&](Context& context, Record& record, bool invalidate,
                    const char* description) {
    const auto before = service.thread.revision;
    const auto calls = downstream_calls;
    const auto ui = ui_updates;
    const HRESULT result = TipEditSessionImpl::OnEndEdit(&service, &context, 17, &record);
    Check(service.thread.revision == before + (invalidate ? 1 : 0), description);
    Check(result == downstream_result && downstream_calls == calls + 1 &&
          ui_updates == ui + 1, "composition/UI handling and HRESULT are preserved");
    Check(record.ranges.references == 1, "edit-range enumerator is released");
  };

  Context external;
  Record move;
  move.selection_changed = TRUE;
  expect(external, move, true, "moving the caret invalidates old conversion history");
  Record deletion;
  deletion.ranges.skip_result = S_OK;
  expect(external, deletion, true, "text deletion without selection movement invalidates history");
  Record insertion;
  insertion.selection_changed = TRUE;
  insertion.ranges.skip_result = S_OK;
  expect(external, insertion, true, "an application insertion invalidates history once");
  Record no_change;
  expect(external, no_change, false, "empty or property-only edits retain continuous input history");

  Context ime;
  ime.own_edit = TRUE;
  expect(ime, insertion, false, "the IME's own composition and commit keep continuous history");
  expect(ime, no_change, false, "the IME's own no-op does not leave a deferred reset");
  expect(external, move, true, "an external edit after an IME edit is still detected");

  Context unknown;
  unknown.own_edit = TRUE;
  unknown.write_result = E_FAIL;
  expect(unknown, insertion, true, "failed ownership lookup cannot authorize history reuse");
  Record unknown_selection;
  unknown_selection.selection_result = E_FAIL;
  expect(external, unknown_selection, true, "failed selection lookup invalidates history");
  Record unknown_text;
  unknown_text.text_result = E_FAIL;
  expect(external, unknown_text, true, "failed text-change lookup invalidates history");
  Record missing_ranges;
  missing_ranges.null_ranges = true;
  expect(external, missing_ranges, true, "a missing change enumerator invalidates history");
  Record unknown_ranges;
  unknown_ranges.ranges.skip_result = E_FAIL;
  expect(external, unknown_ranges, true, "failed range enumeration invalidates history");

  downstream_result = E_FAIL;
  expect(external, move, true, "history invalidation survives downstream composition failure");
  Check(wrong_client == 0, "edit ownership is checked for this TSF client");
  Check(unrelated_calls == 0 && requested_text == 0,
        "history invalidation neither reads text nor requests another edit session");
  return failures ? 1 : 0;
}
