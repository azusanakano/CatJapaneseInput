# Mozc 採取・Windows 識別子パッチのレビュー

レビュー日: 2026-11-15。対象リポジトリ HEAD `dc716d6`。Mozc は `a4541df29db443b49f81cf54665873b68fde9efa` のローカルソースと、それに適用された `catj-brand.patch` を参照した。インストール、再ビルド、ソース・テストの変更はしていない。

## 確認した不具合

### N01 [P2] 日本語を含む Windows パスで候補採取が失敗する

- 対象: `tools/mozc/capture.mjs:184–190` および `205`。指摘を付ける最小範囲は `184–190`。
- 発生条件: Windows の ANSI コードページが UTF-8 ではなく、Mozc 辞書・`id.def`・一時プロファイルのいずれかのパスに日本語等を含む場合。日本語の Windows ユーザー名に由来する `%TEMP%` でも起きる。
- 実測: 既存の `converter_main.exe` に ASCII の辞書パスと、日本語名 `日本語 profile` を持つ新規一時プロファイルを渡すと、終了コードは **0** だが、起動出力のパスに CP932 バイトが入り、採取側と同じ `new TextDecoder('utf-8', { fatal: true }).decode(result.stdout)` が `The encoded data was not valid for encoding utf-8` で失敗した。ASCII パスの対照実験では変換・予測の計32応答を正常に解析できた。
- 別の実測: 同じ辞書を一時ディレクトリ内の `辞書.data` として渡すと、終了コード **3221226505** で異常終了した。辞書内容の変更はしていない。
- 原因の根拠: 固定 Mozc の `src/converter/converter_main.cc:595–600` は narrow `main(int, char**)` の引数を `InitMozc` へ渡す。`src/base/init_mozc.cc:95–115` は受け取った `argv` をそのままフラグ解析へ渡す。`converter_main.cc:622–625` はパスのバイト列をそのまま標準出力へ書き、候補本体は UTF-8 で出力する。`src/bazel/win32/win32_default.manifest` のソースには UTF-8 の `activeCodePage` 指定がない。埋め込み済みバイナリの manifest 自体は抽出していない。
- 影響: 日本語パスを普通に使う環境で README の採取手順が完了しない。出力全体を CP932 で読む修正では UTF-8 の候補本文を壊すため解決しない。
- 修正案: ネイティブ側のコマンドライン文字列を確実に UTF-8 として受け渡すか、ネイティブ側へ渡す全パスについて ASCII の別名・作業場所を保証する。一時プロファイルだけ、または辞書だけの対処では不十分。
- 確信度: 高。実バイナリによる再現あり。

プローブは `os.tmpdir()` 配下の `catj-review-native-*` に閉じ込めた。作成先と削除先の解決済み親ディレクトリを照合してから削除済み。既存のプロファイル・辞書・登録状態には変更を加えていない。

## 確認結果と制限

- `node --test tools/mozc/capture.test.mjs`: **6件成功、0件失敗**。
- 実 converter で16種類の読みを conversion / prediction の両方に流し、計32件を `makeRequests` と `parseCapture` で解析した。`はし`、`はしをとる`、`かいと`、カタカナ・半角カナ・ASCII、日付、コマンド候補、U+2028 を含む読みを含めた。
- `しーくれっともーど` の変換で `COMMAND_CANDIDATE` が保持され、`kind: protected` になることを実測した。予測で結果のない `123` も `candidateStatus: no-result` として残り、後続応答がずれなかった。
- 予測の全読み消費判定は、固定 Mozc の `src/converter/attribute.h:67–70` と `src/engine/engine_converter.cc:1458–1470` の規則に合う。`PARTIALLY_KEY_CONSUMED` がない予測は全消費する。採取側はさらに1文節・入力読みとの対応を要求しており、文字種が変わった場合は保守的に `unknown` にする。
- 変換候補の200件は探索オプションであり、rewriter 後の総数上限ではない。実測で202件、212件、247件になる応答があったが、採取側は全表示指定と報告件数照合で正常に保持している。これを不具合とは扱わない。
- 全文を再現可能な機械形式で取得しているわけではない。`converter_main.cc:141–167` は `Attribute` の全ビットを出力せず、`UNIGRAM`、`SUFFIX_DICTIONARY`、`KEY_EXPANDED_IN_DICTIONARY` 等が表示されない。`PrintCandidate:207–240` は `converted_segment_count` や具体的な `consumed_key_size` も出力しない。今回の既定 OSS / 新規プロファイル / 独立要求では、必須の保護5属性と部分消費属性は出力対象であり、それらの欠落による誤昇格は確認していない。将来、追加モデル・実履歴・複数文節をまたぐ候補へ範囲を広げる際は、この出力形式を完全な候補スナップショットとして扱えない。
- バイナリと辞書の SHA-256 は記録するが、任意に渡されたバイナリが検査済み checkout から作られたことまで検証する仕組みではない。今回、別版バイナリの混入は確認していない。
- 既存 MSI のインストール、更新、削除、他の Mozc との同時使用は実行していない。静的な識別子の整合性は、実アプリでの TSF 動作の証明にはならない。

実測に使用したファイル:

| 項目 | SHA-256 |
|---|---|
| `src/bazel-bin/converter/converter_main.exe` | `f83624eadf585802b57205feb1ce3e5315cc204c8a6c5f06a3ebd6b08a9303a4` |
| `src/bazel-bin/data_manager/oss/mozc.data` | `26d8d5391e37dba926df23e6f01e90158dd755af111712ce84f065a700a852b5` |

## Windows 識別子とビルドの追跡

21ファイルのパッチを全行読んだ。次の経路に、別製品の状態を直接使うと確認できる不整合は見つからなかった。

- TSF クラス・プロファイル: パッチの新 GUID と `base/system_util.cc` の `InprocServer32` 検索が一致する。`win32/base/tsf_registrar.cc:121,163,205–213,264,282–303` の登録・削除は `TsfProfile` を参照する。`custom_action/custom_action.cc:464–498` は同じ登録経路を使う。`uninstall_helper.cc:104–105,131–143` はそのクラス・プロファイルに対する操作である。
- 保存先: `base/system_util.cc:192–204` は Windows OSS のプロファイルを `%LOCALAPPDATA%/kProductNameInEnglish` にするため、新しい製品名で分離される。サーバーの導出先は `system_util.cc:281–333`、実行ファイル名の導出は `344–368`。
- IPC: `ipc/ipc_path_manager.cc:254–280` は新しい `kIPCPrefix` を使用する。`ipc/named_event.cc:87` は新しいイベント prefix、`ipc/win32_ipc.cc:106` は新しい mutex prefix を使用する。プロセスロックファイルは `base/process_mutex.cc` で製品ごとのプロファイル配下に置かれる。
- MSI: OSS 分岐の UpgradeCode、インストールディレクトリ、サービス名、SysProcs、Run 項目はそれぞれ分離されている。`installer_oss_64bit.wxs` を全385行読み、ファイル参照と `ServiceInstall` / `ServiceControl` の対応を確認した。
- 実行ファイルの rename: 5個の BUILD の `executable_name_map` と、`base/const.h`、MSI の `File Name`、対応するリソースの `ORIGINAL_FILENAME` が整合する。`build_defs.bzl:397–411,474–480` は引き続き同じ Bazel target 名から新しい executable 名を生成し、`installer/BUILD.bazel:82–124` は target の `location` を渡す。古いリソース/manifestのソースファイル名が残ること自体は実行ファイル名不一致ではない。
- `git apply --reverse --check --whitespace=error tools/mozc/catj-brand.patch` を適用済み Mozc checkout に対して実行し、成功した。パッチ適用・巻き戻しは実施していない。

GUI の名称は一部未変更。`src/gui/base/util.cc:130–136` は `GuiUtil::ProductName()` に依然 `Mozc` を返し、`140–164` で Qt ダイアログの見出し等に使う。TSF メニューから開いた設定・辞書・About の名称が Mozc になる。これは外観の未完了として分けて記録し、設定・履歴の混同や起動不能としては報告しない。`tip_ui_element_delegate.cc:112–132` の UIElement GUID も upstream と同じだが、TSF の主クラス登録と同じ意味の識別子ではなく、今回衝突による具体的な障害は確認していない。

## 要求と未検証項目

これは上記 N01 と別の、実装・受け入れの残件である。

- README `98–100` のとおり、ネイティブ TSF には INT8 採点、文脈抽出、編集トランザクションが接続されていない。今回のパッチは識別子変更であり、C++ に AI 機能を追加するものではない。
- 実際の固定版 OSS `SUGGESTION` で `かいと` を採取すると `回答 / 買取 / 解答` の3件で、`解凍` は候補集合にない。`config.proto:354` の suggestion 件数の既定値は3。この条件で「二行前の文脈から解凍へ昇格」の実証はできない。同梱の手製候補でその動作が成功しても、実辞書での候補到達率の証明にはならない。README は手製例であることを明記しているため、不正な成功報告とは扱わない。
- 実アプリの入力、切断・復旧、欄切替、保護欄、候補確定、更新・削除の試験は未実施。既存 MSI の存在と、単体試験の成功だけでは日常利用できる状態の根拠にならない。

## テストの盲点

- 現行6テストは合成した converter 出力だけを解析し、ネイティブプロセスを起動しない。起動引数の文字コード、一時プロファイル、実辞書の読み込み、Windows のパスは検証されない。
- CLI の clean checkout 検査、ハッシュ計算、子プロセス異常終了・タイムアウト、プロファイル削除、`--output` の既存ファイル拒否は単体試験対象外。
- 保護属性は現行テストで `NO_MODIFICATION` と meta 候補を扱う。今回の追加プローブで `COMMAND_CANDIDATE` は確認したが、ユーザー辞書・訂正候補の実サンプルを網羅していない。
- MSI / TSF の identifier 分離を検査するリポジトリ内テストはない。パッチ内の唯一の upstream テスト変更は version rewriter の Windows 名称期待値であり、同居・アンインストールの動作試験ではない。

## 全行読取の台帳

担当3ファイル、合計 **1,049行**。下表は連続した区間をすべて含み、省略行はない。

| ファイル | 読取区間 | 内容 |
|---|---|---|
| `tools/mozc/capture.mjs` | 1–39 | imports、固定版、保護属性、要求生成と読み検証 |
| 同上 | 40–122 | 文節・候補・属性・消費状態の解析 |
| 同上 | 123–156 | 起動行、独立応答、空・失敗応答、末尾の検査 |
| 同上 | 157–223 | checkout・ハッシュ・プロセス起動・provenance・一時ファイル削除 |
| 同上 | 224–253 | CLI、排他的出力、エラー処理 |
| `tools/mozc/capture.test.mjs` | 1–30 | 合成出力の fixture と helper |
| 同上 | 31–69 | 要求生成、入力拒否、文節・属性・表記・meta候補 |
| 同上 | 70–119 | 予測消費、応答対応、切断出力の拒否 |
| `tools/mozc/catj-brand.patch` | 1–677 | 直下の全21パッチ区間。1–3は説明と固定コミット |

パッチの各区間と対応ソース。対象上流ファイルを全行精読したという意味ではなく、パッチ内の全変更・文脈を読み、上記の関連 callsite を追跡した一覧。

| パッチ行 | 対応する Mozc ソース | 確認した変更 |
|---|---|---|
| 4–84 | `src/base/const.h` | 製品名、Windows 名称、IPC、サービス、レジストリ、ウィンドウクラス |
| 85–97 | `src/base/system_util.cc` | 新 TSF CLSID のインストール先検索 |
| 98–131 | `src/win32/base/tsf_profile.cc` | TSF クラスと profile GUID |
| 132–192 | `src/win32/tip/tip_text_service.cc` | preserved key と function provider GUID、task window |
| 193–226 | `src/win32/tip/tip_display_attributes.cc` | display attribute GUID |
| 227–298 | `src/win32/tip/tip_resource.rc` | 日本語・英語の TSF 表示文字列 |
| 299–311 | `src/win32/installer/BUILD.bazel` | MSI 成果物名 |
| 312–324 | `src/win32/installer/build_installer.py` | UpgradeCode |
| 325–458 | `src/win32/installer/installer_oss_64bit.wxs` | package、ファイル、サービス、保存先、ログオン起動 |
| 459–471 | `src/build_tools/mozc_win32_resource_template.rc` | Windows 製品リソース名 |
| 472–484 | `src/server/BUILD.bazel` | server の実行ファイル名 |
| 485–505 | `src/server/mozc_server.rc` | server の original filename と説明 |
| 506–518 | `src/renderer/win32/BUILD.bazel` | renderer の実行ファイル名 |
| 519–539 | `src/renderer/win32/mozc_renderer.rc` | renderer の original filename と説明 |
| 540–552 | `src/win32/broker/BUILD.bazel` | broker の実行ファイル名 |
| 553–573 | `src/win32/broker/mozc_broker.rc` | broker の original filename と説明 |
| 574–586 | `src/win32/cache_service/BUILD.bazel` | cache service の実行ファイル名 |
| 587–629 | `src/win32/cache_service/mozc_cache_service.rc` | cache service の original filename、説明、表示名 |
| 630–642 | `src/gui/tool/BUILD.bazel` | tool の実行ファイル名 |
| 643–663 | `src/gui/tool/mozc_tool.rc` | tool の original filename と説明 |
| 664–677 | `src/rewriter/version_rewriter_test.cc` | Windows の新 version prefix の期待値 |

関連仕様は README 全100行と設計書の採用構成、候補集合・保護規則、評価と受け入れ、実装順・保留事項を参照した。Web の最新情報には依存せず、固定されたローカル Mozc のソースを根拠とした。
