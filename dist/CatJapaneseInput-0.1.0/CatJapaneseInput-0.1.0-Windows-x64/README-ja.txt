CatJapaneseInput 0.1.0
Windows 11 x64（Intel / AMD）向け日本語入力
MSI 製品バージョン 3.35.6359.100

導入と日本語入力

1. ZIP を展開し、CatJapaneseInput-0.1.0-Windows-x64.msi を実行します。
   TSF への登録に Windows の管理者権限が必要です。
   旧版から更新する場合は、起動中のメモ帳などを先に閉じてください。
   Windows Installer が再起動を求めた場合は、作業を保存して再起動します。
2. タスクバーの入力方式アイコン、または Windows キー + Space から
   「日本語 CatJapaneseInput」を選択します。候補にない場合は
   ［設定］→［時刻と言語］→［言語と地域］で日本語の言語のオプションを開き、
   キーボードの一覧を確認します。
3. メモ帳を開き、入力モードをひらがなにします。
   n i h o n n g o を順に打ち、Space で「日本語」に変換し、Enter で確定します。

メモ帳の文脈変換を試す

1. 1行目に「川を渡るため、橋を探した。」と入れます。
2. 2行目で h a s h i と打って Space を1回押すと「橋」が第1候補になります。
   Enter で確定します。
3. 1行目を「夕食のため、箸を探した。」に替え、2行目を空にして同じ操作を
   行うと「箸」が第1候補になります。

文脈による並べ替えには動作確認用の INT8 モデルを使います。
機能の確認対象は Windows 11 x64 のパッケージ版メモ帳 11.2607.14.0 の本文欄です。
文脈を取得できない入力欄では、Mozc の辞書変換に戻ります。
文脈の処理は端末内で行います。設定、辞書、学習機能は CatJapaneseInput の
プロファイルで管理します。

削除

別の入力方式に切り替えた後、Windows の［設定］→［アプリ］→
［インストールされているアプリ］の CatJapaneseInput を選び、
アンインストールを実行します。

ファイルの照合

ZIP 内の SHA256SUMS.txt に各ファイルの SHA-256 が載っています。
展開先の PowerShell で MSI の SHA-256 を確認できます。

Get-FileHash -Algorithm SHA256 -LiteralPath .\CatJapaneseInput-0.1.0-Windows-x64.msi

ライセンス

変換器は Mozc を使用しています。付属の設定ツールは Qt Base 6.9.1 に
動的リンクしています。Qt Base は GNU LGPL バージョン3で提供します。
GPL v3 と LGPL v3 の全文、Mozc、辞書データ、utf8proc、Qt の第三者告知は
licenses/ にあります。Qt の対応ソースとビルド手順は qt-source/ にあります。
Microsoft Visual C++ ランタイムには Microsoft の配布条件が適用されます。

Windows の入力方式の設定
https://support.microsoft.com/en-us/windows/hardware/input-devices/manage-the-language-and-keyboard-input-layout-settings-in-windows
Windows アプリのアンインストール
https://support.microsoft.com/en-gb/windows/apps/uninstall-or-remove-apps-and-programs-in-windows
