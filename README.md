# CatJapaneseInput

[設計書 v0.4](local-japanese-ime-design.md)に沿った Windows 11 x64 向けローカル日本語入力の試作です。現在は Mozc の候補採取、固定候補での文脈比較、小型モデルの学習と推論、編集プロトコルの故障注入を実行できます。

## すぐに試す

Unicode 17.0 データを含む Node.js が必要です。Node.js 24.22.1（ICU 78.3）で検証しています。

```powershell
node --test
node tools/evaluate.mjs test/fixtures/candidates.jsonl
```

同梱の3件は手製の候補です。「回答／解凍」は二行前だけが異なり、3行の再出現スコアで基準の1/2件から2/2件になります。「橋／箸」は候補を1位に移した場合に下キー1回が減ることを確認します。

## 固定版 Mozc から候補を採る

Mozc を別のディレクトリに取得し、設計書指定の `a4541df29db443b49f81cf54665873b68fde9efa` をチェックアウトします。Windows の依存関係を準備して、Mozc の `src` から下記を実行します。[固定版 Mozc の Windows ビルド手順](https://github.com/google/mozc/blob/a4541df29db443b49f81cf54665873b68fde9efa/docs/build_mozc_in_windows.md)

```powershell
bazelisk build --config release_build --platforms=//:windows-x86_64 //converter:converter_main //data_manager/oss:mozc.data
```

評価用の読みと許容表記を、UTF-8 の `samples.jsonl` に1行1件で書きます。`context` は確定済みの左側テキストです。省略すると未取得として扱います。取得範囲の左端が途中で切れている場合は `leftClipped: true` を指定します。

```jsonl
{"id":"chopsticks","mode":"conversion","reading":"はし","context":"箸を用意します。","acceptedTexts":["箸"]}
{"id":"thaw","mode":"prediction","reading":"かいと","context":"肉を解凍します。\n作業は明日進めます。\n","acceptedTexts":["解凍"]}
```

このリポジトリから実行します。例では Mozc を隣の `mozc` に置いています。出力パスには新しいファイル名を指定します。

```powershell
$mozcCheckout = '..\mozc'
node tools/mozc/capture.mjs $mozcCheckout "$mozcCheckout\src\bazel-bin\converter\converter_main.exe" "$mozcCheckout\src\bazel-bin\data_manager\oss\mozc.data" samples.jsonl --output capture.jsonl
node tools/evaluate.mjs capture.jsonl
```

採取では変換に `CONVERSION`、予測に `SUGGESTION` を使い、1件ずつ入力状態を初期化します。一時プロファイルと一時ログディレクトリを作り、履歴学習を無効にします。出力には候補ID、文節、順位、属性、辞書とバイナリの SHA-256 が入ります。読みには ASCII の空白と制御文字を使えません。失敗した変換要求は `candidateStatus: "no-result"` として残します。[固定版 Mozc の converter_main](https://github.com/google/mozc/blob/a4541df29db443b49f81cf54665873b68fde9efa/src/converter/converter_main.cc)

## Windows x64 用の TSF 試作パッケージ

固定版の原本から候補を採取した後、別の TSF プロファイルを持つ CatJapaneseInput としてビルドできます。パッチで TSF のクラスとプロファイル、MSI のアップグレード識別子、IPC、サービス、設定と学習データの保存場所を分けます。

MSVC v143、x86/x64 の ATL、Windows 11 SDK、CMake、Python 3.12 以上、.NET SDK、Bazelisk を用意します。次の例は、このリポジトリの隣に未改修の Mozc がある場合です。

```powershell
$mozcCheckout = (Resolve-Path '..\mozc').Path
$identityPatch = (Resolve-Path 'tools/mozc/catj-brand.patch').Path
if ((git -C $mozcCheckout rev-parse HEAD) -ne 'a4541df29db443b49f81cf54665873b68fde9efa') {
    throw 'Mozc のコミットが設計書と一致しません'
}
git -C $mozcCheckout apply --check --index --whitespace=error $identityPatch
if ($LASTEXITCODE -ne 0) { throw 'CatJapaneseInput のパッチ適用前チェックに失敗しました' }
git -C $mozcCheckout apply $identityPatch
if ($LASTEXITCODE -ne 0) { throw 'CatJapaneseInput のパッチ適用に失敗しました' }

Push-Location (Join-Path $mozcCheckout 'src')
try {
    python build_tools/update_deps.py
    if ($LASTEXITCODE -ne 0) { throw '依存関係の準備に失敗しました' }
    python build_tools/build_qt.py --release --confirm_license --target_arch=x64
    if ($LASTEXITCODE -ne 0) { throw 'Qt のビルドに失敗しました' }
    bazelisk build package --config release_build --platforms=//:windows-x86_64
    if ($LASTEXITCODE -ne 0) { throw 'Windows パッケージのビルドに失敗しました' }
} finally {
    Pop-Location
}
```

成果物は Mozc の `src/bazel-bin/win32/installer/CatJapaneseInput64.msi` です。TSF 登録には管理者権限を使います。メモ帳で CatJapaneseInput とひらがなモードを選び、`n i h o n n g o` を個別に押し、`にほんご` が未確定入力として出ることを確認します。Space で `日本語` に変換し、Enter で確定します。

Bazel がシンボリックリンク作成権限で停止する場合は、起動オプションの `--nowindows_enable_symlinks` を `build` の前に付けます。Bazel 9.0.2 はこの設定で対象ファイルのコピーを使います。

## 候補を評価する

`baseline` は採取順です。`currentLine` と `threeLines` は、現在行だけ、または最大3行で候補表記が再出現した行数を使います。最大4文節、各文節の元の通常候補上位8枠、昇格は最大1回です。予測で採点するのは全読みを消費し、読みの先頭が一致する候補です。`oracle` は許される昇格を列挙し、指標ごとの最良値を求めます。

全件の正解率は `cases` を分母にします。採取時の通常候補列で許容表記を作れる件数は `displayedTargetReachable`、直接確定できる件数は `allCandidateReachable` です。部分消費や消費不明の予測は元の順位と分母に残ります。採点群の到達率は `reachableScoringGroups / scoringGroupsWithGold` で求めます。

採取前は全文の `acceptedTexts` を付けておけば、分割が予想と異なる結果も評価できます。採取後、対応が確認できた変換例にだけ `"targets":[["箸","を","取る"]]` のように文節順のラベルを付けます。許容する文節列が複数あれば、それぞれを配列として並べます。

訂正操作は、採取した通常候補列を使って、下キー相当の候補移動、右キー相当の文節移動、確定を数える試算です。未達の操作数には `--operation-limit`（既定40）を計上します。実際の TSF では、予測の確定キー、同一表記の扱い、文字種候補の表示に別の規則があるため、実アプリのキー操作数を測るには打鍵試験が必要です。

## 小型モデルを学習する

同じ辞書で採取した学習用と評価用のデータを用意します。変換の学習用レコードには `targets`、予測には `acceptedTexts` または `targets` が必要です。学習から外した候補群も、評価ファイルに含めれば評価の分母に残ります。精度を判断する際は、出典と利用条件を確認し、同じ文書・テンプレートと近似重複が分割をまたがないよう、先に学習・調整・最終評価へ分けてください。

```powershell
node tools/train.mjs train-capture.jsonl model.json --epochs 5 --seed 42
node tools/evaluate.mjs evaluation-capture.jsonl --model model.json
```

モデルは文字1〜3-gramのハッシュ埋め込みと、64・32次元の中間層、変換・予測それぞれの出力を持ちます。INT8 で保存し、読み込み時に辞書のハッシュと重みの形式を検証します。学習されたモードは `trainedModes` に入り、それ以外では基準候補を使います。`modelCurrentLine` と `modelThreeLines` は同じ重みで比較します。昇格閾値は `--conversion-min-lead`、`--conversion-min-gain`、`--prediction-min-lead`、`--prediction-min-gain` で指定できます。

## 現在の実装範囲

- 文脈抽出のオフライン試作は ICU の Unicode 17.0 を使います。Mozc 組み込み時の C++ と utf8proc v2.11.3 への接続は未実装です。
- 編集プロトコルの試験は、Prepare の未着・応答消失、Ack の応答消失、書き込みの部分失敗、欄と機密区分の変更を模擬します。実アプリでの composition の所有と書き込みは未検証です。
- TSF 試作パッケージは Mozc の辞書変換を使います。INT8 採点と編集プロトコルの実行時接続、実アプリでの遅延・精度測定、配布用 MSI の署名は今後の実装範囲です。
