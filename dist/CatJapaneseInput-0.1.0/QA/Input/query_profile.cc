#include <windows.h>
#include <msctf.h>
#include <cstdio>
#include <cwchar>

namespace {
void PrintGuid(const GUID& guid) {
  wchar_t text[40]{};
  StringFromGUID2(guid, text, ARRAYSIZE(text));
  std::wprintf(L"%ls", text);
}
}

int wmain(int argc, wchar_t* argv[]) {
  if (argc != 1 && (argc != 4 || std::wcscmp(argv[1], L"activate") != 0)) return 2;
  HRESULT hr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(hr)) return 3;
  ITfInputProcessorProfileMgr* profiles = nullptr;
  hr = CoCreateInstance(CLSID_TF_InputProcessorProfiles, nullptr,
                        CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&profiles));
  if (SUCCEEDED(hr) && argc == 4) {
    CLSID clsid{};
    GUID profile{};
    if (FAILED(CLSIDFromString(argv[2], &clsid)) ||
        FAILED(CLSIDFromString(argv[3], &profile))) {
      hr = E_INVALIDARG;
    } else {
      hr = profiles->ActivateProfile(TF_PROFILETYPE_INPUTPROCESSOR, 0x0411,
                                    clsid, profile, nullptr,
                                    TF_IPPMF_FORSESSION);
    }
  }
  if (SUCCEEDED(hr)) {
    TF_INPUTPROCESSORPROFILE active{};
    hr = profiles->GetActiveProfile(GUID_TFCAT_TIP_KEYBOARD, &active);
    if (hr == S_OK) {
      std::wprintf(L"Active TSF profile: type=%lu language=%04x ",
                    active.dwProfileType, active.langid);
      PrintGuid(active.clsid);
      std::wprintf(L" ");
      PrintGuid(active.guidProfile);
      std::wprintf(L" flags=%lx\n", active.dwFlags);
    }
  }
  if (profiles) profiles->Release();
  CoUninitialize();
  if (hr != S_OK) std::printf("TSF API returned 0x%08lx\n", static_cast<unsigned long>(hr));
  return hr == S_OK ? 0 : 4;
}
