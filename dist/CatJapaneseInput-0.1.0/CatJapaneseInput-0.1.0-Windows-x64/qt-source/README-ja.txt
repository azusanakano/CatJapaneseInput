Qt Base 6.9.1 の対応ソース

配布した Qt6Core.dll、Qt6Gui.dll、Qt6Widgets.dll と platforms/qwindows.dll
に対応するソースです。Qt Base は GNU LGPL バージョン3で提供します。
著作権とライセンス本文は ../licenses/ を参照してください。

qtbase-everywhere-src-6.9.1.tar.xz は Qt の公式ソースです。
qtbase-6.9.1-mozc.patch はビルド時に Mozc が適用する変更です。
license-files/ には、同じ Qt タグで参照されるライセンス原文を収録しています。
ソースツリーに補う場合は、相対パスを保ってコピーできます。

ビルドするには x64 版の MSVC v143、Windows SDK、CMake、Ninja、
Python 3.12 以降を用意します。このディレクトリから、新しいビルド用
ディレクトリ名を指定して実行します。

python .\tools\build_qt.py --qt_archive_path .\qtbase-everywhere-src-6.9.1.tar.xz --qt_src_dir .\build-src --qt_host_dir .\build-host --qt_dest_dir .\build-out --release --confirm_license --target_arch=x64

スクリプトがアーカイブの展開と qyieldcpu.h の修正を行います。
ビルド時の構成は qt-build-options.txt で確認できます。
互換性のある変更版 Qt を使う場合は CatJapaneseInput の設定ツールを閉じ、
インストール先の Qt6Core.dll、Qt6Gui.dll、Qt6Widgets.dll および
platforms\qwindows.dll を、同じ x64 ビルドのファイルで置き換えます。
元のファイルの復元には MSI の再インストールを利用できます。

Qt のオープンソース配布条件
https://www.qt.io/development/open-source-lgpl-obligations
Qt Base 6.9.1 の公開ソース
https://download.qt.io/archive/qt/6.9/6.9.1/submodules/
変更を含む Mozc のビルドスクリプト
https://github.com/google/mozc/blob/a4541df29db443b49f81cf54665873b68fde9efa/src/build_tools/build_qt.py
