# CatJapaneseInput ソース全体レビュー

対象は `5e43b97b965ada1a2213143775eb476d7ac36a55`。2026年11月16日、Asia/Tokyo。現行の自作実装、Mozcへの差分、テスト、辞書、配布手順を含む **46ファイル・6,915行**を、空行とコメントも含めて読んだ。差分だけのレビューではない。

**要修正のP2を2件、入力検証の整合性に関するP3を2件確認した。** P0・P1に相当する欠陥は確認していない。レビュー中に追加依頼のあった「グロック」は、AIサービスの **Grok** と解釈し、辞書ソースと変換試験に追加した。以下の4件のレビュー指摘は、まだ修正していない。

## 指摘

### R01 P2 同じ欄で入力位置が変わっても以前の短期履歴を使う

場所: [catj-context-tsf.patch 101行](/C:/Users/user/Desktop/CatJapaneseInput/tools/mozc/catj-context-tsf.patch:101)。旧 `preceding_text` の送信を削除した箇所は91–110行。固定版Mozcの受け手は [EngineConverter::OnStartComposition](https://github.com/google/mozc/blob/a4541df29db443b49f81cf54665873b68fde9efa/src/engine/engine_converter.cc#L1849-L1907)。

Space以外では新しい文脈取得を行わず、従来の `preceding_text` も渡さなくなった。一方、Mozcは `preceding_text` が欠落していてフォーカス世代が同じ場合、直前に確定した短期履歴を保持する。明示的な空文字なら履歴を消す。欄を離れずに文頭へ移動したり、確定文字列を削除したりしても、フォーカス世代だけでは現在位置との不連続を表せない。

再現では、新規プロファイルで個人履歴学習を無効にし、「東京」を確定した後、同じ `context.revision=0` で「と」を変換した。次の入力に `preceding_text` がない場合は **「都」**、`preceding_text=""` を明示した場合は **「と」** が先頭になった。独立した2回の実行で同じ差を確認した。単なるAI採点の誤差ではなく、基準となるMozc側の候補順位も変わる。

修正は、外部編集や入力位置の不連続を検出したとき、本文を送らずに短期履歴を無効化する情報を渡す方式が適切。文頭移動、確定文字列の削除、同じ長さの置換、連続追記を比較し、必要な履歴だけ維持する試験を追加する。

これは静的なTSF呼び出し経路と実セッション処理器のA/B試験による指摘。今回、メモ帳を直接操作した再現ではない。情報の外部送信や、別アプリへの漏洩を再現したという意味でもない。

### R02 P2 Windows PowerShell 5.1ではビルド準備が停止する

場所: [stage-context-ime.ps1 23行](/C:/Users/user/Desktop/CatJapaneseInput/tools/mozc/stage-context-ime.ps1:23)、関連する型参照は39–40行。[README 62行](/C:/Users/user/Desktop/CatJapaneseInput/README.md:62)と94行の手順には実行するPowerShellの版指定がない。

クリーンなWindows PowerShell 5.1では、未適用パッチに対する逆方向の `git apply --check --reverse ... 2>$null` が、`$ErrorActionPreference = 'Stop'` によって `NativeCommandError` を発生させる。意図した `$LASTEXITCODE` の確認と順方向適用へ進まない。さらに、この障害を避けても `[Microsoft.VisualBasic.Strings]` が未ロードで `TypeNotFound` になり、カタカナ辞書の生成が止まる。

読み取り専用のインデックスに対する逆適用チェックと単独のカナ変換を比較した結果:

| 実行環境 | 逆適用チェック | カナ変換 |
|---|---|---|
| Windows PowerShell 5.1.26100.9818、NoProfile | NativeCommandError | TypeNotFound |
| PowerShell 7.6.9、NoProfile | 終了コード1を取得して継続 | ヒラガナ |

検証済みPowerShell版をREADMEに明示し、スクリプト冒頭で必要な版を確認して、外部チェックアウトへ変更を始める前に停止させる。5.1も対応対象にするなら、標準エラーの扱いとVisualBasicアセンブリのロードを明示的に処理する。PowerShell 7の全版が同じ挙動とはみなさない。[Microsoftの互換性資料](https://learn.microsoft.com/en-us/powershell/scripting/whats-new/differences-from-windows-powershell)

### R03 P3 部分消費属性と全消費ラベルの矛盾を受け入れる

場所: [ranking.mjs 62行](/C:/Users/user/Desktop/CatJapaneseInput/lib/ranking.mjs:62)、[evaluate.mjs 47行](/C:/Users/user/Desktop/CatJapaneseInput/lib/evaluate.mjs:47)。入力検証は `ranking.mjs` 24–31行。

手製・外部JSONLの予測候補に `attributes: ["PARTIALLY_KEY_CONSUMED"]` と `consumption: "full"` を併記すると、現在の検証は両者の矛盾を拒否しない。採点と評価は後者だけを信頼し、部分消費候補を昇格可能・直接確定可能と数える。固定版Mozcでは、この属性は読みの一部だけを消費する意味を持つ。[属性の定義](https://github.com/google/mozc/blob/a4541df29db443b49f81cf54665873b68fde9efa/src/converter/attribute.h#L67-L70)

基準「橋」、部分消費属性のある候補「箸」、文脈・正解「箸」の入力で、矛盾した `full` を与えると、採点群1、直接確定到達1、再出現方式とoracleの先頭正解1になった。`partial` に直すと、採点群0、直接確定到達0、先頭正解0、表示候補としての到達だけ1となる。矛盾した候補は学習の正例にも入る。

標準の `capture.mjs` はこの属性を検出して `partial` を付けるため、通常の採取出力から発生するとは判断しない。修正は、入力検証時に矛盾を拒否するか、属性を含む共通の消費判定を採点・評価・学習で使用すること。

変換候補にもJavaScriptとC++の採点条件の差はあるが、固定版の通常変換では部分消費候補を生成する条件を確認できなかった。その差だけを別のP2には数えていない。

### R04 P3 学習だけが明示的なnullラベルを欠損として扱う

場所: [model.mjs 166行](/C:/Users/user/Desktop/CatJapaneseInput/lib/model.mjs:166)、[evaluate.mjs 5行](/C:/Users/user/Desktop/CatJapaneseInput/lib/evaluate.mjs:5)。

学習側の `sample.targets ?? []` と `sample.acceptedTexts ?? []` は、明示的な `null` を省略と同じように扱う。評価側は配列でない値を拒否する。正しい `acceptedTexts` と `targets: null` の予測レコードは学習に成功するが、同じレコードの評価は `each target must contain one non-empty string per segment` で失敗した。正しい `targets` と `acceptedTexts: null` の変換レコードも、学習だけ成功した。

READMEが保証するのはラベルの配列または省略であり、nullを有効と解釈する必要はない。学習開始前のラベル検証を評価と共通化し、仕様外の入力を早期に拒否するのが小さい修正になる。

## 実行した検証

| 対象 | 結果と根拠 |
|---|---|
| 全JavaScriptテスト | Node 24.22.1、ICU 78.3、Unicode 17.0。実Mozcと今回ビルドしたモデル検証器を指定して **57成功、0失敗、0スキップ** |
| C++文脈抽出 | 現行ソースをMSVC 14.44 x64、C++20、UTF-8で単体ビルド。`catj_context_test.cc` の実行は終了コード0 |
| C++モデル | 現行ソースからモデル検証器をビルド。両出力ヘッドと2種類の文脈でJavaScriptのINT8スコアと許容誤差1e-10以内で一致。上の57件に含まれる |
| Unicode書記素 | Unicode 17公式GraphemeBreakTest **766ケース**が一致。切り詰め後の境界も **1,724チェック**で不正な開始点なし |
| Unicode正規化 | 公式NormalizationTest **20,034行**から、NFCの5条件を各行で確認。**100,170チェック**で不一致0。文脈抽出を経た結果も同数確認 |
| 文脈のJSとC++比較 | 公式書記素データと各切断位置の2,863例、固定シードの長文・不正UTF-16等2,000例、合計 **4,863例**で状態・切詰めフラグ・文字列が一致 |
| C++再順位付け | 既存の `catj_reranker_test.exe` **5成功**。関連ソースと現行パッチの一致を確認 |
| TSF周辺テキスト | 既存の `tip_surrounding_text_test.exe` **4成功**。実アプリのCOM動作を全面的に保証する試験ではない |
| セッション処理 | 追加前の文脈用・英字変換用fixtureを独立した新規プロファイルで実行し、両方PASSED。既存バイナリの埋め込み辞書・モデルと照合済み |
| 配布スクリプト | `test/package-release.test.ps1` **5シナリオ成功**。署名やインストールは実施していない |
| Mozc差分 | 固定版のインデックスに対する6パッチの適用チェックがすべて成功。既存チェックアウトを変更せず確認 |
| 配布ZIP | 外部SHA-256と内部マニフェスト43件を照合、不一致0。アーカイブは44エントリ |
| 同梱utf8proc | コード・ヘッダー・生成データ・ライセンスの4ファイルが公式v2.11.3と全バイト一致 |

Unicodeの試験元は [GraphemeBreakTest](https://www.unicode.org/Public/17.0.0/ucd/auxiliary/GraphemeBreakTest.txt) と [NormalizationTest](https://www.unicode.org/Public/17.0.0/ucd/NormalizationTest.txt)。同梱ライブラリの照合元は [utf8proc v2.11.3](https://github.com/JuliaStrings/utf8proc/tree/v2.11.3)。これらの有限な試験は、すべての入力列や実アプリ動作の証明ではない。

## 全行確認の台帳

各行範囲は対象コミットの物理行。確認方法と全59追跡ファイルのGit blob SHA-256は [ファイル台帳](/C:/Users/user/Desktop/CatJapaneseInput/reviews/review-2026-11-16-full-files.json) に保存した。レビュー中のGrok追加は末尾に別記する。

| ファイル | 確認した行 | 主な確認内容 |
|---|---:|---|
| README.md | 1–146 | 実装範囲、採取・学習・ビルド・配布の手順 |
| local-japanese-ime-design.md | 1–338 | 文脈、機密区分、編集整合性、期限、評価、T01–T17 |
| lib/candidate.mjs | 1–10 | 保護属性とkindの共通判定 |
| lib/context.mjs | 1–94 | UTF-16、行位置、書記素、切断端、NFC、かな統一 |
| lib/edit-protocol.mjs | 1–224 | 所有ID、操作番号、Prepare/Apply/Ack、再送、取消、期限、復旧 |
| lib/evaluate.mjs | 1–178 | 許容表記、操作数DP、直接確定、全件分母、oracle |
| lib/model.mjs | 1–289 | 特徴、学習群、順伝播・逆伝播、INT8、形式・辞書検証 |
| lib/ranking.mjs | 1–149 | 入力検証、4文節・8枠、保護・消費条件、安定昇格、閾値 |
| tools/evaluate.mjs | 1–94 | CLI引数、UTF-8、辞書・モデルサイズ、閾値、ファイル解放 |
| tools/samples.mjs | 1–17 | 厳密UTF-8、JSON、行番号、空入力 |
| tools/train.mjs | 1–48 | 学習引数、辞書一致、出典ハッシュ、排他的出力 |
| tools/mozc/capture.mjs | 1–260 | 固定版、状態初期化、属性・消費、解析、flagfile、後片付け |
| tools/mozc/capture.test.mjs | 1–170 | 不正応答、予測、候補の保持、実Windows日本語パス |
| tools/mozc/export-model.mjs | 1–42 | ネイティブ形式、ヘッダー、尺度、重み順 |
| tools/mozc/export-model.test.mjs | 1–63 | バイナリ検証、破損拒否、C++とのスコア比較 |
| tools/mozc/stage-context-ime.ps1 | 1–67 | 固定版照合、差分適用、かな辞書生成、配置 |
| tools/mozc/catj-brand.patch | 1–677 | TSF・MSI・IPC・サービス・保存先・実行ファイルの識別子 |
| tools/mozc/catj-context-licenses.patch | 1–105 | 配布するライセンスの参照と配置 |
| tools/mozc/catj-context-package.patch | 1–12 | パッケージ版の変更 |
| tools/mozc/catj-context-server.patch | 1–759 | 一回限りの文脈、履歴・ログ、モデルの寿命、候補移動、期限 |
| tools/mozc/catj-context-tsf.patch | 1–710 | フォーカス、composition所有、InputScope、対象アプリ、読取範囲 |
| tools/mozc/catj-english-dictionary.patch | 1–38 | 英字辞書入力、かな正規化、半角読みの保持 |
| native/mozc/BUILD.bazel | 1–59 | 依存、静的utf8proc、埋め込みモデル、テスト |
| native/mozc/catj_context.cc | 1–175 | UTF-16LE、検証、行分割、書記素、NFC、上限 |
| native/mozc/catj_context.h | 1–35 | 所有する文字列とビューの寿命 |
| native/mozc/catj_context_model.cc | 1–343 | バイナリ境界、ハッシュ・寸法、特徴、INT8推論 |
| native/mozc/catj_context_model.h | 1–75 | 型、入力上限、モデルAPI、所有権 |
| native/mozc/catj_context_model_test.cc | 1–104 | モデル読み込み・異常系・スコアプローブ |
| native/mozc/catj_context_test.cc | 1–84 | 行位置、空行、切断端、NFC前後の上限 |
| native/mozc/catj_packaged_model.cc | 1–57 | BCrypt、辞書SHA-256、モデル読み込み、資源解放 |
| native/mozc/catj_packaged_model.h | 1–17 | モデルの共有所有権とAPI |
| native/mozc/english-dictionary.tsv | 1–256 | 全行の読み・5列・品詞ID・コスト・重複 |
| native/mozc/smoke-training-input.jsonl | 1–6 | 文脈、読み、正例の対応 |
| test/context.test.mjs | 1–80 | Unicodeと切詰めの期待値 |
| test/edit-protocol.test.mjs | 1–232 | 応答消失、順序反転、旧binding、部分反映、時刻境界 |
| test/evaluate.test.mjs | 1–147 | 訂正操作、相関した正解、未達、部分消費、固定・保護候補 |
| test/model.test.mjs | 1–86 | 両ヘッド、INT8往復、複数正例、破損、未学習モード |
| test/ranking.test.mjs | 1–210 | 保護属性、枠数、採点不能先頭、閾値、ID、コスト |
| test/package-release.test.ps1 | 1–178 | 署名ツール検出、証明書・署名異常、生成と整理 |
| test/fixtures/candidates.jsonl | 1–3 | 手製候補・正解・読み・文脈の対応 |
| test/fixtures/mozc-context-smoke.tsv | 1–45 | 文脈変換と確定、プライベート動作 |
| test/fixtures/mozc-english-conversion.tsv | 1–44 | 3種類のかな、別読み、文中の英字変換・確定 |
| dist/.gitignore | 1–9 | 配布物と署名済み出力の扱い |
| dist/CatJapaneseInput-0.1.0/package-release.ps1 | 1–127 | 入力パス、ZIP展開、署名・検証、ハッシュ、出力の整理 |
| dist/CatJapaneseInput-0.1.0/署名と公開-ja.txt | 1–52 | 対象成果物と署名・公開手順 |
| dist/CatJapaneseInput-0.1.0/*.zip.sha256 | 1 | 配布ZIPの外部ハッシュ |

第三者の `utf8proc.c` 838行、`utf8proc.h` 800行、`LICENSE.md` 93行も読み、利用側のメモリ管理とAPI契約を照合した。`utf8proc_data.c` **17,141行**は生成数表として全バイトを公式版と比較した。数値の一つ一つを手作業でUnicode仕様から導出し直したという主張はしない。Mozc本体全体はこのリポジトリに含まれず、差分の呼び出し先・関連する固定版ソースを追跡した範囲である。

既存の `reviews/` 8ファイルは過去の証拠として扱った。再現用コード2ファイルは全行読んだ。以前のレビューにある3件は、現行の回帰試験を確認し、今回の未修正所見へ重複計上していない。

## レビュー判断の点検

1. **過去の結論への依存を避けた。** 初回は担当ごとに現在のソースを独立して読み、その後で過去のレビューと照合した。
2. **共有実装による共通の見落としを確認した。** 学習と評価が同じ採点群抽出を使っていても、候補属性との矛盾を同時に受け入れれば両方のテストが通る。R03は属性定義という別の根拠と比較した。
3. **実行環境の前提を変えた。** 普段使うPowerShell 7の成功をWindows PowerShell 5.1へ一般化せず、クリーンな両セッションで実行した。
4. **入力変更とフォーカス変更を区別した。** R01では、同じ欄のまま位置・文書が変わる条件を固定し、短期履歴の有無だけを比較した。個人学習は無効にした。
5. **優先度を抑制した。** 標準採取が作らない矛盾したJSONLと、仕様外のnullはP3。通常変換で発生を示せない候補条件差、旧パッチ適用済み作業ツリーの拒否、記載どおりの旧配布ZIPを独立したP2にしていない。
6. **合格の範囲を限定した。** ソース確認、単体試験、既存バイナリの試験、実アプリ操作を区別した。C++部品は現行ソースからビルドしたが、Mozc全体のクリーンビルド、メモ帳での実打鍵、MSIの署名・更新・削除、独立データでの精度・遅延・常駐量は今回の合格項目ではない。

READMEが未実装範囲と明記する非同期予測、実TSFへのPrepare/Apply/Ack接続などは、隠れた新規バグとして数えていない。部品テストの成功を設計書T01–T17全体の合格とは扱わない。

## 追加依頼への対応

「グロック」はGrokと解釈し、[英字辞書](/C:/Users/user/Desktop/CatJapaneseInput/native/mozc/english-dictionary.tsv:100) に `ぐろっく / 1920 / 1920 / 4600 / Grok` を追加した。既存の生成処理が全角・半角カタカナの読みを作る。元の256行は257行になった。

[英字変換fixture](/C:/Users/user/Desktop/CatJapaneseInput/test/fixtures/mozc-english-conversion.tsv:45) に、ひらがな・全角カタカナ・半角カタカナからGrokを選んで確定する3ケースを追加した。追加前の辞書では、その3ケースのGrok選択・確定だけが失敗することを確認した。

追加後は、既存チェックアウトとBazelキャッシュを読み取り専用の入力にして、隔離先へ辞書を再生成した。変換器で `ぐろっく → Grok (ID 0)`、`グロック → Grok (ID 1)`、`ｸﾞﾛｯｸ → Grok (ID 1)` を確認した。新しい辞書のSHA-256は `e9de225e4c406e0f79843b7c6ab7544c222731738e75ac47c0ac29c6ffc6639a`。

辞書埋め込み用オブジェクトだけを再コンパイルし、既存オブジェクトとリンクした検証用セッション実行ファイルでも、追加後の英字変換fixture全体がPASSED、終了コード0だった。別の新規プロファイルで全体レビュー側が再実行して同じ結果を確認した。ソース変更後の `node --test` も実行環境を指定して57成功、0失敗、0スキップ。`git diff --check` は終了コード0。

検証用の新辞書では既存モデルの辞書ハッシュが一致しないため、文脈モデルを使わず辞書変換へ退避する。これはGrokの辞書変換・確定を確認した試験であり、新辞書用の文脈モデルを検証した結果ではない。配布時にはREADMEの手順に従ってモデルを学習・出力し直す必要がある。

変更した製品データは辞書の1行、既存fixtureへの追加は23行。モデルの再学習、MSIの再ビルド、インストールは実施していない。インストール済みIMEと配布ZIPにはまだ反映されていない。
