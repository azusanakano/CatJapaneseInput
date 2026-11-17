#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <msi.h>
#include <msiquery.h>
#include <objbase.h>
#include <propidl.h>
#include <msidefs.h>

#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>

void RequireMsi(UINT result, const char* operation) {
  if (result == ERROR_SUCCESS) return;
  std::cerr << operation << " failed: " << result << '\n';
  throw std::runtime_error(operation);
}

void Execute(MSIHANDLE db, const wchar_t* sql) {
  PMSIHANDLE view;
  RequireMsi(MsiDatabaseOpenViewW(db, sql, &view), "MsiDatabaseOpenViewW");
  RequireMsi(MsiViewExecute(view, 0), "MsiViewExecute");
  RequireMsi(MsiViewClose(view), "MsiViewClose");
}

void MakePackage(const wchar_t* path) {
  PMSIHANDLE db;
  RequireMsi(MsiOpenDatabaseW(path, MSIDBOPEN_CREATE, &db), "MsiOpenDatabaseW");
  Execute(db, L"CREATE TABLE `Property` (`Property` CHAR(72) NOT NULL, `Value` CHAR(0) LOCALIZABLE PRIMARY KEY `Property`)");
  Execute(db, L"INSERT INTO `Property` (`Property`, `Value`) VALUES ('ProductCode', '{645CF9C8-D608-4FA5-BC5E-210F03109C80}')");
  Execute(db, L"INSERT INTO `Property` (`Property`, `Value`) VALUES ('ProductName', 'Catj condition evaluation fixture')");
  Execute(db, L"INSERT INTO `Property` (`Property`, `Value`) VALUES ('ProductVersion', '1.0.0')");
  Execute(db, L"INSERT INTO `Property` (`Property`, `Value`) VALUES ('ProductLanguage', '1033')");
  Execute(db, L"INSERT INTO `Property` (`Property`, `Value`) VALUES ('Manufacturer', 'Local test only')");
  PMSIHANDLE summary;
  RequireMsi(MsiGetSummaryInformationW(db, nullptr, 4, &summary), "MsiGetSummaryInformationW");
  RequireMsi(MsiSummaryInfoSetPropertyW(summary, PID_TEMPLATE, VT_LPSTR, 0, nullptr, L"Intel;1033"), "Template");
  RequireMsi(MsiSummaryInfoSetPropertyW(summary, PID_REVNUMBER, VT_LPSTR, 0, nullptr,
      L"{91CC8F3B-34CF-43E9-84AB-9E3D46F68706}"), "PackageCode");
  RequireMsi(MsiSummaryInfoSetPropertyW(summary, PID_PAGECOUNT, VT_I4, 200, nullptr, nullptr), "PageCount");
  RequireMsi(MsiSummaryInfoSetPropertyW(summary, PID_WORDCOUNT, VT_I4, 0, nullptr, nullptr), "WordCount");
  RequireMsi(MsiSummaryInfoPersist(summary), "MsiSummaryInfoPersist");
  RequireMsi(MsiDatabaseCommit(db), "MsiDatabaseCommit");
}

void SetFlag(MSIHANDLE install, const wchar_t* name, bool value) {
  RequireMsi(MsiSetPropertyW(install, name, value ? L"1" : L""), "MsiSetPropertyW");
}

int wmain(int argc, wchar_t** argv) {
  if (argc < 2 || argc > 3) return 2;
  // The caller supplies a fresh filename under its own temporary workspace.
  if (std::filesystem::exists(argv[1])) {
    std::cerr << "Refusing to overwrite an existing database.\n";
    return 2;
  }
  const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  if (FAILED(initialized)) return 3;
  int failures = 0;
  try {
    MakePackage(argv[1]);
    PMSIHANDLE install;
    RequireMsi(MsiOpenPackageExW(argv[1], MSIOPENPACKAGEFLAGS_IGNOREMACHINESTATE, &install), "MsiOpenPackageExW");
    // This is a restricted read-only installation handle. No MsiDoAction,
    // MsiInstallProduct, executable custom action, or registry API is called.
    const wchar_t* condition = argc == 3 ? argv[2]
        : L"(NOT (REMOVE=\"ALL\")) AND (NOT Installed)";
    struct Case { const char* name; bool installed, upgrading, removing, upgrade_removal, expected; };
    for (const auto item : {
        Case{"fresh", false, false, false, false, true},
        Case{"major-upgrade", false, true, false, false, true},
        Case{"repair", true, false, false, false, false},
        Case{"uninstall", true, false, true, false, false},
        Case{"upgrade-old-removal", true, false, true, true, false}}) {
      SetFlag(install, L"Installed", item.installed);
      SetFlag(install, L"UPGRADING", item.upgrading);
      SetFlag(install, L"UPGRADINGPRODUCTCODE", item.upgrade_removal);
      RequireMsi(MsiSetPropertyW(install, L"REMOVE", item.removing ? L"ALL" : L""), "MsiSetPropertyW REMOVE");
      const auto result = MsiEvaluateConditionW(install, condition);
      const auto expected = item.expected ? MSICONDITION_TRUE : MSICONDITION_FALSE;
      std::cout << (result == expected ? "PASS " : "FAIL ") << item.name << " result=" << result << '\n';
      if (result != expected) ++failures;
    }
    std::cout << "Literal 1=" << MsiEvaluateConditionW(install, L"1") << '\n';
    std::cout << "Null handle literal 1=" << MsiEvaluateConditionW(0, L"1") << '\n';
    RequireMsi(MsiSetPropertyW(install, L"Installed", L"0"), "MsiSetPropertyW Installed=0");
    const auto zero_is_defined = MsiEvaluateConditionW(install, L"Installed");
    std::cout << "Installed property with string value 0=" << zero_is_defined << '\n';
    if (zero_is_defined != MSICONDITION_TRUE) ++failures;
  } catch (const std::exception&) {
    failures++;
  }
  CoUninitialize();
  return failures ? 1 : 0;
}
