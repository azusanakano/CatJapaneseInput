#Requires -Version 7.0
param(
    [string] $VcVarsAll = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvarsall.bat",
    [string] $BrandPatch = (Join-Path $PSScriptRoot '../tools/mozc/catj-brand.patch')
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$vcvars = (Get-Item -LiteralPath $VcVarsAll).FullName
$patch = (Get-Item -LiteralPath $BrandPatch).FullName
$root = [IO.Directory]::CreateTempSubdirectory('catj-default-input-test-').FullName
try {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'fixtures/mozc-installer/src') -Destination $root -Recurse
    git -C $root apply --whitespace=error '--include=src/win32/custom_action/custom_action.cc' '--include=src/win32/installer/installer_oss_64bit.wxs' $patch
    if ($LASTEXITCODE -ne 0) { throw 'The branding patch did not apply to the pinned installer sources.' }

    $source = [IO.File]::ReadAllText((Join-Path $root 'src/win32/custom_action/custom_action.cc'))
    $function = [regex]::Match($source, '(?s)UINT __stdcall EnableTipProfile\(MSIHANDLE msi_handle\) \{.*?\n\}')
    if (!$function.Success) { throw 'EnableTipProfile was not found in the patched source.' }
    [xml] $wxs = [IO.File]::ReadAllText((Join-Path $root 'src/win32/installer/installer_oss_64bit.wxs'))
    $namespaces = [Xml.XmlNamespaceManager]::new($wxs.NameTable)
    $namespaces.AddNamespace('w', 'http://wixtoolset.org/schemas/v4/wxs')
    $action = $wxs.SelectSingleNode('//w:CustomAction[@Id="EnableTipProfile"]', $namespaces)
    $schedule = $wxs.SelectSingleNode('//w:InstallExecuteSequence/w:Custom[@Action="EnableTipProfile"]', $namespaces)
    if ($action.Execute -ne 'commit' -or $action.Impersonate -ne 'yes' -or $schedule.Before -ne 'InstallFinalize') {
        throw 'Default input configuration must run after successful installation in the installing user context.'
    }
    $condition = $schedule.Condition.Replace('\', '\\').Replace('"', '\"')
    $harness = @'
#include <windows.h>
#include <msi.h>
#include <msiquery.h>
#include <objbase.h>
#include <propidl.h>
#include <msidefs.h>
#include <filesystem>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>

constexpr DWORD ILOT_DEFPROFILE = 0x00000002;
bool service = false;
bool impersonating = false;
bool thread_service = false;
bool token_access_denied = false;
bool identity_known = true;
bool session_known = true;
DWORD process_session = 1;
DWORD thread_session = 1;
bool install_succeeds = true;
bool enabled = false;
bool is_default = false;
unsigned install_calls = 0;
DWORD last_flags = 0;
std::wstring installed_profile;
unsigned process_token_calls = 0;
unsigned open_tokens = 0;
unsigned logged_messages = 0;
INSTALLMESSAGE message_type = INSTALLMESSAGE_ERROR;
std::wstring message_text;

// Replace OS setting writes, token lookup, and the MSI message boundary.
// GUID serialization, MSI records, and condition evaluation use Windows APIs.
BOOL WINAPI TestOpenThreadToken(HANDLE, DWORD, BOOL, PHANDLE token) {
  if (token_access_denied || !impersonating) {
    SetLastError(token_access_denied ? ERROR_ACCESS_DENIED : ERROR_NO_TOKEN);
    return FALSE;
  }
  *token = reinterpret_cast<HANDLE>(1);
  ++open_tokens;
  return TRUE;
}
BOOL WINAPI TestOpenProcessToken(HANDLE, DWORD, PHANDLE token) {
  ++process_token_calls;
  if (token_access_denied) return FALSE;
  *token = reinterpret_cast<HANDLE>(2);
  ++open_tokens;
  return TRUE;
}
BOOL WINAPI TestCloseHandle(HANDLE) {
  --open_tokens;
  return TRUE;
}
BOOL WINAPI TestGetTokenInformation(HANDLE token, TOKEN_INFORMATION_CLASS type,
                                   LPVOID value, DWORD size, PDWORD returned) {
  if (!session_known || type != TokenSessionId || size < sizeof(DWORD)) return FALSE;
  *static_cast<DWORD*>(value) = token == reinterpret_cast<HANDLE>(1) ? thread_session : process_session;
  *returned = sizeof(DWORD);
  return TRUE;
}
int WINAPI TestMsiProcessMessage(MSIHANDLE, INSTALLMESSAGE type, MSIHANDLE record) {
  ++logged_messages;
  message_type = type;
  wchar_t text[512] = {};
  DWORD length = std::size(text);
  if (MsiRecordGetStringW(record, 0, text, &length) == ERROR_SUCCESS) {
    message_text = text;
  }
  return 0;
}
BOOL WINAPI InstallLayoutOrTip(LPCWSTR profile, DWORD flags) {
  ++install_calls;
  last_flags = flags;
  installed_profile = profile;
  if (!install_succeeds) return FALSE;
  enabled = true;
  is_default = (flags & 0x00000002) != 0;
  return TRUE;
}
namespace mozc {
struct WinUtil {
  static bool IsServiceAccount(bool* value) {
    *value = service;
    return identity_known;
  }
  static bool IsServiceUser(HANDLE token, bool* value) {
    *value = token == reinterpret_cast<HANDLE>(1) ? thread_service : service;
    return identity_known;
  }
};
namespace win32 {
struct TsfProfile {
  static const GUID& GetTextServiceGuid() {
    static const GUID guid = {0x663ed91c, 0xb893, 0x4159,
      {0xb0, 0xba, 0x1b, 0x78, 0x44, 0x3e, 0x0c, 0x42}};
    return guid;
  }
  static const GUID& GetProfileGuid() {
    static const GUID guid = {0xf12e2bb4, 0xefa5, 0x46b0,
      {0x81, 0x76, 0x1f, 0x06, 0xa1, 0x2b, 0xda, 0xc6}};
    return guid;
  }
};
std::wstring StrCatW(const wchar_t* a, const wchar_t* b, const wchar_t* c) {
  return std::wstring(a) + b + c;
}
}
}
#define OpenThreadToken TestOpenThreadToken
#define OpenProcessToken TestOpenProcessToken
#define CloseHandle TestCloseHandle
#define GetTokenInformation TestGetTokenInformation
#define MsiProcessMessage TestMsiProcessMessage
'@
    $harness += "`n" + $function.Value + "`n"
    $harness += "#undef OpenThreadToken`n#undef OpenProcessToken`n#undef CloseHandle`n#undef GetTokenInformation`n#undef MsiProcessMessage`n"
    $harness += 'const std::wstring schedule_condition = L"' + $condition + '";' + "`n"
    $harness += @'
unsigned failures = 0;
void Check(bool result, const char* name) {
  std::cout << (result ? "PASS " : "FAIL ") << name << '\n';
  if (!result) ++failures;
}
void RequireMsi(UINT result) {
  if (result != ERROR_SUCCESS) {
    throw std::runtime_error("MSI fixture setup failed: " + std::to_string(result));
  }
}
void MakeConditionPackage(const wchar_t* path) {
  PMSIHANDLE db;
  RequireMsi(MsiOpenDatabaseW(path, MSIDBOPEN_CREATE, &db));
  for (const auto sql : {
      L"CREATE TABLE `Property` (`Property` CHAR(72) NOT NULL, `Value` CHAR(0) LOCALIZABLE PRIMARY KEY `Property`)",
      L"INSERT INTO `Property` (`Property`, `Value`) VALUES ('ProductCode', '{645CF9C8-D608-4FA5-BC5E-210F03109C80}')",
      L"INSERT INTO `Property` (`Property`, `Value`) VALUES ('ProductName', 'Catj condition fixture')",
      L"INSERT INTO `Property` (`Property`, `Value`) VALUES ('ProductVersion', '1.0.0')",
      L"INSERT INTO `Property` (`Property`, `Value`) VALUES ('ProductLanguage', '1033')",
      L"INSERT INTO `Property` (`Property`, `Value`) VALUES ('Manufacturer', 'Test only')"}) {
    PMSIHANDLE view;
    RequireMsi(MsiDatabaseOpenViewW(db, sql, &view));
    RequireMsi(MsiViewExecute(view, 0));
  }
  PMSIHANDLE summary;
  RequireMsi(MsiGetSummaryInformationW(db, nullptr, 4, &summary));
  RequireMsi(MsiSummaryInfoSetPropertyW(summary, PID_TEMPLATE, VT_LPSTR, 0, nullptr, L"Intel;1033"));
  RequireMsi(MsiSummaryInfoSetPropertyW(summary, PID_REVNUMBER, VT_LPSTR, 0, nullptr,
      L"{91CC8F3B-34CF-43E9-84AB-9E3D46F68706}"));
  RequireMsi(MsiSummaryInfoSetPropertyW(summary, PID_PAGECOUNT, VT_I4, 200, nullptr, nullptr));
  RequireMsi(MsiSummaryInfoSetPropertyW(summary, PID_WORDCOUNT, VT_I4, 0, nullptr, nullptr));
  RequireMsi(MsiSummaryInfoPersist(summary));
  RequireMsi(MsiDatabaseCommit(db));
}
void CheckSchedule(MSIHANDLE session, const char* name, bool installed, bool upgrading,
                   bool removing, bool upgrade_removal, bool expected) {
  RequireMsi(MsiSetPropertyW(session, L"Installed", installed ? L"1" : L""));
  RequireMsi(MsiSetPropertyW(session, L"UPGRADING", upgrading ? L"1" : L""));
  RequireMsi(MsiSetPropertyW(session, L"UPGRADINGPRODUCTCODE", upgrade_removal ? L"1" : L""));
  RequireMsi(MsiSetPropertyW(session, L"REMOVE", removing ? L"ALL" : L""));
  const MSICONDITION result = MsiEvaluateConditionW(session, schedule_condition.c_str());
  Check(result == (expected ? MSICONDITION_TRUE : MSICONDITION_FALSE), name);
}
int main() {
  if (FAILED(CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED))) return 2;
  try {
  const UINT result = EnableTipProfile(0);
  Check(result == ERROR_SUCCESS && enabled && is_default,
        "installation enables CatJapaneseInput as the default input");
  Check(installed_profile == L"0x0411:{663ED91C-B893-4159-B0BA-1B78443E0C42}{F12E2BB4-EFA5-46B0-8176-1F06A12BDAC6}",
        "the current user's Japanese CatJapaneseInput profile is selected");
  Check((last_flags & (0x01 | 0x04 | 0x40 | 0x80)) == 0,
        "other input methods and the default-user template are retained");
  Check(logged_messages == 0, "successful preference setup has no failure message");
  service = true;
  process_session = 0;
  install_calls = 0;
  Check(EnableTipProfile(0) == ERROR_SUCCESS && install_calls == 0,
        "service installations do not alter user input settings");
  impersonating = true;
  process_token_calls = 0;
  install_calls = 0;
  Check(EnableTipProfile(0) == ERROR_SUCCESS && install_calls == 1 && process_token_calls == 0,
        "a service host configures the impersonated installing user's default");
  service = false;
  process_session = 1;
  thread_service = true;
  install_calls = 0;
  Check(EnableTipProfile(0) == ERROR_SUCCESS && install_calls == 0,
        "an impersonated service account does not change user input settings");
  thread_service = false;
  token_access_denied = true;
  process_token_calls = 0;
  install_calls = 0;
  Check(EnableTipProfile(0) == ERROR_SUCCESS && install_calls == 0 && process_token_calls == 0,
        "failed thread-token lookup does not fall back to a different identity");
  token_access_denied = false;
  impersonating = false;
  process_session = 0;
  install_calls = 0;
  Check(EnableTipProfile(0) == ERROR_SUCCESS && install_calls == 0,
        "a non-system service in session zero does not change user input settings");
  process_session = 1;
  session_known = false;
  install_calls = 0;
  Check(EnableTipProfile(0) == ERROR_SUCCESS && install_calls == 0,
        "unknown effective token session does not change user input settings");
  session_known = true;
  identity_known = false;
  install_calls = 0;
  Check(EnableTipProfile(0) == ERROR_SUCCESS && install_calls == 0,
        "failed account detection does not alter user input settings");
  identity_known = true;
  install_succeeds = false;
  enabled = is_default = false;
  Check(EnableTipProfile(0) == ERROR_SUCCESS && !enabled && !is_default,
        "an OS preference failure preserves the successful file installation");
  Check(logged_messages == 1 && message_type == INSTALLMESSAGE_INFO &&
        message_text.find(L"could not set the default input method") != std::wstring::npos &&
        message_text.find(L"Select CatJapaneseInput in Windows keyboard settings") != std::wstring::npos,
        "preference failure logs an informational message with manual setup instructions");
  Check(open_tokens == 0, "all opened identity tokens are closed");
  const auto package = std::filesystem::absolute(L"condition.msi").wstring();
  MakeConditionPackage(package.c_str());
  PMSIHANDLE session;
  // A restricted handle cannot change machine state. No install action is run.
  RequireMsi(MsiOpenPackageExW(package.c_str(), MSIOPENPACKAGEFLAGS_IGNOREMACHINESTATE, &session));
  CheckSchedule(session, "fresh install configures the default", false, false, false, false, true);
  CheckSchedule(session, "major upgrade configures the default", false, true, false, false, true);
  CheckSchedule(session, "repair preserves a later user selection", true, false, false, false, false);
  CheckSchedule(session, "uninstall does not enable the removed profile", true, false, true, false, false);
  CheckSchedule(session, "old-product removal during upgrade does not enable the removed profile", true, false, true, true, false);
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    ++failures;
  }
  CoUninitialize();
  return failures == 0 ? 0 : 1;
}
'@
    [IO.File]::WriteAllText((Join-Path $root 'default-input-test.cc'), $harness)
    $build = '@call "' + $vcvars + '" x64 >nul' + "`r`n" +
        '@if errorlevel 1 exit /b %errorlevel%' + "`r`n" +
        '@cl /nologo /EHsc /std:c++20 /utf-8 /DUNICODE /D_UNICODE default-input-test.cc /link ole32.lib msi.lib /out:default-input-test.exe' + "`r`n" +
        '@exit /b %errorlevel%' + "`r`n"
    [IO.File]::WriteAllText((Join-Path $root 'build.cmd'), $build)
    Push-Location $root
    try {
        & $env:ComSpec /d /c build.cmd
        if ($LASTEXITCODE -ne 0) { throw 'Failed to compile the actual patched installer function.' }
        & (Join-Path $root 'default-input-test.exe')
        if ($LASTEXITCODE -ne 0) { throw 'Default input behavior tests failed.' }
    } finally { Pop-Location }
} finally {
    $resolvedRoot = (Resolve-Path -LiteralPath $root).ProviderPath
    $tempParent = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath.TrimEnd('\') + '\'
    if ($resolvedRoot.StartsWith($tempParent, [StringComparison]::OrdinalIgnoreCase) -and
        [IO.Path]::GetFileName($resolvedRoot) -like 'catj-default-input-test-*') {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
