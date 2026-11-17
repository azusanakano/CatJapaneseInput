#include <windows.h>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#include "base/system_util.h"
#include "base/version.h"
#include "client/client.h"
#include "data_manager/oss/oss_data_manager.h"
#include "engine/engine.h"
#include "ipc/ipc.h"
#include "protocol/commands.pb.h"
#include "protocol/config.pb.h"
#include "session/session_handler.h"

namespace {
using mozc::commands::Input;
using mozc::commands::KeyEvent;
using mozc::commands::Output;
using mozc::commands::Context;
class Harness;
class LoopClient : public mozc::IPCClientInterface {
 public:
  explicit LoopClient(Harness* harness) : harness_(harness), version_(mozc::Version::GetMozcVersion()) {}
  bool Connected() const override { return true; }
  bool Call(absl::string_view request, std::string* response, absl::Duration) override;
  uint32_t GetServerProtocolVersion() const override { return mozc::IPC_PROTOCOL_VERSION; }
  absl::string_view GetServerProductVersion() const override { return version_; }
  uint32_t GetServerProcessId() const override { return ::GetCurrentProcessId(); }
  mozc::IPCErrorType GetLastIPCError() const override { return mozc::IPC_NO_ERROR; }
 private:
  Harness* harness_;
  std::string version_;
};
class Launcher : public mozc::client::ServerLauncherInterface {
 public:
  bool StartServer(mozc::client::ClientInterface*) override { return true; }
  bool ForceTerminateServer(absl::string_view) override { return false; }
  bool WaitServer(uint32_t) override { return true; }
  void OnFatal(ServerErrorType type) override { throw std::runtime_error("Unexpected fatal " + std::to_string(type)); }
  std::string server_program() const override { return {}; }
  void set_suppress_error_dialog(bool) override {}
};
class Harness : public mozc::IPCClientFactoryInterface {
 public:
  explicit Harness(std::unique_ptr<mozc::Engine> engine) : handler_(std::move(engine)) {}
  std::unique_ptr<mozc::IPCClientInterface> NewClient(absl::string_view, absl::string_view) override { return std::make_unique<LoopClient>(this); }
  std::unique_ptr<mozc::IPCClientInterface> NewClient(absl::string_view name) override { return NewClient(name, ""); }
  bool Call(absl::string_view request, std::string* response) {
    mozc::commands::Command command;
    if (!command.mutable_input()->ParseFromString(request)) return false;
    const auto& input = command.input();
    if (input.type() == Input::SEND_KEY && input.key().special_key() == KeyEvent::SPACE) {
      space_snapshots.push_back(input.context().has_catj_preceding_utf16le());
    }
    if (!handler_.EvalCommand(&command)) return false;
    if (input.type() == Input::CREATE_SESSION) { last_id = command.output().id(); ++sessions_created; }
    return command.output().SerializeToString(response);
  }
  void LoseSession() {
    mozc::commands::Command command;
    command.mutable_input()->set_type(Input::DELETE_SESSION);
    command.mutable_input()->set_id(last_id);
    if (!handler_.EvalCommand(&command)) throw std::runtime_error("Delete test session failed");
  }
  uint64_t last_id = 0;
  int sessions_created = 0;
  std::vector<bool> space_snapshots;
 private:
  mozc::SessionHandler handler_;
};
bool LoopClient::Call(absl::string_view request, std::string* response, absl::Duration) {
  return harness_->Call(request, response);
}
std::string Preedit(const Output& output) {
  std::string text;
  for (const auto& segment : output.preedit().segment()) text += segment.value();
  return text;
}
void Require(bool value, const char* message) {
  if (!value) throw std::runtime_error(message);
}
struct Result { std::string displayed; std::string committed; bool test_had_preedit; int created; std::vector<bool> snapshots; };
Result Run(bool lose) {
  auto engine = mozc::Engine::CreateEngine(std::make_unique<const mozc::oss::OssDataManager>());
  Require(engine.ok(), "Engine init failed");
  Harness harness(std::move(*engine));
  mozc::client::Client client;
  client.SetIPCClientFactory(&harness);
  client.SetServerLauncher(std::make_unique<Launcher>());
  Require(client.EnsureSession(), "EnsureSession failed");
  mozc::config::Config config;
  config.set_history_learning_level(mozc::config::Config::NO_HISTORY);
  Require(client.SetConfig(config), "SetConfig failed");
  Context context;
  context.set_revision(0);
  auto send = [&](KeyEvent key, const Context& ctx) {
    Output output;
    key.set_activated(true);
    key.set_mode(mozc::commands::HIRAGANA);
    Require(client.SendKeyWithContext(key, ctx, &output), "SendKey failed");
    return output;
  };
  KeyEvent key;
  key.set_special_key(KeyEvent::ON);
  send(key, context);
  for (char ch : std::string("hashi")) {
    key.Clear(); key.set_key_code(ch); send(key, context);
  }
  Context snapshot = context;
  snapshot.set_input_field_type(Context::NORMAL);
  snapshot.set_catj_left_clipped(false);
  const std::u16string preceding = u"夕食のため、箸を探した。\r\n";
  snapshot.set_catj_preceding_utf16le(reinterpret_cast<const char*>(preceding.data()), preceding.size() * 2);
  key.Clear(); key.set_special_key(KeyEvent::SPACE);
  const std::string displayed = Preedit(send(key, snapshot));
  Require(displayed == "箸", "Model did not promote chopsticks; deadline or dictionary mismatch");
  if (lose) harness.LoseSession();
  key.Clear(); key.set_special_key(KeyEvent::ENTER);
  key.set_activated(true); key.set_mode(mozc::commands::HIRAGANA);
  Output test;
  Require(client.TestSendKeyWithContext(key, context, &test), "TestSendKey failed");
  Require(test.consumed(), "Enter not consumed");
  const Output output = send(key, context);
  return {displayed, output.result().value(), test.has_preedit(), harness.sessions_created, harness.space_snapshots};
}
}
int main(int argc, char** argv) {
  try {
    Require(argc == 2, "Expected isolated profile path");
    std::filesystem::create_directories(argv[1]);
    mozc::SystemUtil::SetUserProfileDirectory(argv[1]);
    for (bool lose : {false, true}) {
      const Result result = Run(lose);
      std::cout << "{\"lost_session\":" << (lose ? "true" : "false")
                << ",\"displayed\":\"" << result.displayed << "\",\"committed\":\"" << result.committed
                << "\",\"test_returned_preedit\":" << (result.test_had_preedit ? "true" : "false")
                << ",\"sessions_created\":" << result.created << ",\"space_snapshots\":[";
      for (size_t i = 0; i < result.snapshots.size(); ++i) std::cout << (i ? "," : "") << (result.snapshots[i] ? "true" : "false");
      std::cout << "],\"mismatch\":" << (result.displayed != result.committed ? "true" : "false") << "}" << std::endl;
      Require(lose ? result.committed == "橋" : result.committed == "箸", "Unexpected committed output");
    }
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << std::endl; return 1; }
}
