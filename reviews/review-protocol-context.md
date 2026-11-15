# 文脈抽出・編集プロトコルのレビュー

対象: HEAD `dc716d6`、比較基点 `68a82a8`。2026-11-15 実施。製品コード・既存テストは変更していない。

## 結論

修正対象として P2 を1件確認した。文脈抽出では、今回の静的確認と追加プローブから再現できる不具合を確認していない。既存の対象18テストはすべて成功したが、Unicode公式適合試験や実アプリのTSF整合性を検証した結果ではない。

### PC-01 [P2] Apply完了時刻とAck期限の基点を同じ時刻にする

- 場所: `lib/edit-protocol.mjs:167-168`。対応するサーバー側制約は `74-75`。
- 確信度: 高。決定的な偽時計で再現済み。
- 条件: `prepareBy = 120`。Applyが119 msで成功する。167行目の時刻確認が119を読み、続くbinding照合やスレッドの実行待ちの間に121 msとなる。168行目が新しい時刻121を読み、`ackBy = 241`を作る。
- 結果: 121 msで送ったAckは自身の期限241 ms以内だが、サーバーは `ackBy <= prepareBy + timeoutMs`、すなわち240 ms以下を要求するため拒否する。クライアントは `recovery` に入り、その後の `begin()` も拒否する。Applyは1回成功しており、commitは0回となる。
- 影響: 準備期限内に成功した反映について、本来使用できる成功確認の時間が残っていても、アダプターが不要な復旧を要求する。設計3節の「準備と成功確認の待ち上限は各120 ms」と整合しない。現在のTSF試作にはこのアダプターが接続されていないため、この再現から実際のWindows入力欠落を主張しない。
- 修正案: Applyの完了時刻を一度取得し、その値を準備期限の確認とAck期限の算出の両方に用いる。binding確認を終えるまでに期限が進む場合の方針も明示する。少なくとも、クライアント自身がサーバー上限を超えるAck期限を発行しないことを保証する。
- テストの不足: `test/edit-protocol.test.mjs:164-179` は `step()` の間で120 msを進めるが、Apply完了後の2回の時計取得の間を進めない。通常のテストでは時計が0のままであり、この矛盾が発生しない。

リポジトリ直下から `node --input-type=module` に次のJavaScriptを渡すと再現する。`getBinding()` 内の時刻変更は、照合中に時間が経過した状況を決定的に模擬する。binding自体は変更しない。

```js
import { createEditClient, createEditServer } from './lib/edit-protocol.mjs';

const binding = {
  clientId: 'c', serverId: 's', sessionId: 'session',
  fieldId: 'f', focus: 1, document: 1, reading: 1,
  privacy: 'NORMAL', privacyGeneration: 1, composition: 1,
};
let time = 0;
let afterApply = false;
const events = [];
const getBinding = () => {
  if (afterApply) {
    afterApply = false;
    time = 121;
  }
  return binding;
};
const server = createEditServer({
  getBinding, now: () => time,
  prepare: input => ({ text: input }),
  commit: () => events.push('commit'),
});
const client = createEditClient({
  getBinding, now: () => time,
  send(verb, message) {
    const reply = server.receive(verb, message);
    events.push({ verb, time, ackBy: message.ackBy, status: reply.status });
    return reply;
  },
  apply() {
    events.push('apply');
    time = 119;
    afterApply = true;
    return 'applied';
  },
});
client.begin('probe');
console.log(client.step(), client.step(), client.step());
console.log(events);
```

観測結果: `pending pending recovery`。イベントは `prepare/prepared`、`apply`、`ack(time=121, ackBy=241)/rejected`、`abandon/recovery`。`commit` は呼ばれない。

## 全行読了の記録

次の範囲は空行・コメント・importを含め、各行を読んで分岐・呼出先・テストの対応を確認した。担当4ファイルは合計576行。

| ファイル | 連続した確認範囲 | 確認内容 |
|---|---|---|
| `lib/context.mjs` | 1–26 | 上限・Unicode版・左側の未読部分から独立した書記素開始点 |
| 同上 | 27–58 | 書記素単位の保持、NFC前後の上限、未取得と空行の区別 |
| 同上 | 59–81 | UTF-16読取上限、分断サロゲート、改行と3行の位置 |
| 同上 | 82–94 | 半角かな・カタカナとNFCの照合用正規化 |
| `lib/edit-protocol.mjs` | 1–53 | 所有ID、timeout検証、サーバー状態、失効、保存計画 |
| 同上 | 54–105 | 要求照合、再送、Ack、取消、操作番号、Prepare |
| 同上 | 106–124 | サーバー直列化、expire公開、transport/apply契約 |
| 同上 | 125–175 | クライアント状態、要求コピー、復旧、Applyと期限 |
| 同上 | 176–223 | 応答消失、照会・再送、完了、begin/step直列化 |
| `test/context.test.mjs` | 1–40 | fixture、行境界、取得状態、読取切詰め |
| 同上 | 41–80 | UTF-16、書記素、保持切詰め、NFC展開、かな統一 |
| `test/edit-protocol.test.mjs` | 1–40 | 共通binding/時計/transport、終了までの駆動 |
| 同上 | 41–87 | 初回/再送の逆順、保存計画、Ackの未着・応答消失 |
| 同上 | 88–129 | transport例外、取消後の遅着、世代・起動変更 |
| 同上 | 130–179 | 反映後の区分変更、無反映/部分失敗、期限切れ |

仕様は `local-japanese-ime-design.md:39-192`（2・3節全体）、`258-281`（T01–T17）を照合した。READMEの実装範囲と、`extractContext` / `normalizeReading` / 編集アダプターの全参照箇所も確認した。編集アダプターの利用元は現時点ではテストだけである。

## 検証の記録と限界

1. `node --test test/context.test.mjs test/edit-protocol.test.mjs`: Node v24.22.1、18件成功、失敗0件。
2. 上記PC-01の期限境界プローブ: 反映1回・commit0回・不要なrecoveryを再現。
3. 書記素の追加プローブ: 17種類の文字（ASCII、かな、結合記号、Indic子音/virama、ZWNJ/ZWJ、絵文字、地域指示記号、Prepend、SpacingMark、Hangul L/V/T、NUL）から、固定シードで前置文字列と切詰め後の行を5万組作成。保持結果をNFC前の接尾辞へ対応付け、その開始点が前置文字列を含む `Intl.Segmenter` の境界であるか確認。不正境界は0件。これは実装と同じICUを比較基準にした切詰め処理の確認であり、Unicode公式適合試験ではない。全Unicode文字・全並び・長さ上限との全組合せを網羅しない。
4. 機密区分の追加プローブ: NORMAL / UNKNOWN / PRIVATE を起点とする9方向について、Prepare後とApply後の2境界、計18ケースを確認。全件で旧操作がrecoveryとなり、commitは実行されない。PASSWORDを起点とする3方向については、各境界のfixtureを開始する前の `begin()` 拒否を計6回確認。PASSWORDに保留操作を作れないため、12方向の統合動作を完全に検証したという意味ではない。
5. サーバー失効: `prepareBy=120` の保留操作は時刻239で照会すると `expired`。時刻240で `server.expire()` を実行すると終端が `recovery` となり、新たなPrepareを拒否することを確認。

## T01–T14との対応

| ID | この担当範囲で確認できた内容 | 残る確認 |
|---|---|---|
| T01 | 行位置、空行、CRLF、上限、UTF-16、代表的な書記素、NFC前後の上限 | Unicode 17.0.0の公式GraphemeBreakTest / NormalizationTest一式は未実行。C++/utf8procとの一致も未検証 |
| T02 | bindingのcomposition等が変われば一般照合で拒否可能 | 休止・再接続・30秒上限・遅い終了通知の実装/統合は担当アダプターにない |
| T03 | Prepare後のfocus/document/PASSWORD/serverId変更を既存テストで拒否 | 実TSFの置換範囲・composition所有・予定した自己変更の照合 |
| T04 | Prepare未着/応答消失、逆順再送、Ack未着/応答消失、遅いPrepare拒否、二重適用防止 | PC-01の期限直前成功。独立プロセス・非同期IPC・実際の待機時間を含む試験 |
| T05 | indeterminateでcommitせず停止し、模擬文書の部分反映を残す | 読み返し・所有確認・composition終了・アプリへの引渡し |
| T06 | document世代の変更で保留操作が失効 | 周辺文脈の再取得・再予測の予約はこのモジュールにない |
| T07 | 既存テストはNORMAL→PASSWORD（反映前）とNORMAL→PRIVATE（反映後）。追加プローブで上記18ケース確認 | 全12方向の欄状態遷移、読み取り/採点/表示の失効、復帰時の再取得。fixtureはprivacy世代を持たないため区分の往復を表現しない |
| T08 | bindingに含まれる値の変化を一般的に拒否する | モデル/辞書切替、予測再開、採点/表示の締切は担当範囲外 |
| T09 | 同一OpIdのapply/commitを一度に制限 | ViewId/CandidateId、Mozc消費位置、実Undoの照合はhost側 |
| T10 | 任意のbinding世代を一致比較できる | 候補再生成、文字種/カスタムキー等は担当範囲外 |
| T11 | serverId変更と旧Ack拒否を模擬 | 実切断・終了通知・復旧後の新セッションとcompositionの接続 |
| T12 | client/server/sessionの所有IDを照合 | 既存テストに別client/sessionの直試験なし。採点の全体キューは担当範囲外 |
| T13 | 担当2実装モジュールにはネットワーク/ファイル書込/本文ログの呼出しがない | アプリ全経路や外部callbackはこの確認だけでは保証できない |
| T14 | unchangedなら取消して次へ進む。indeterminateなら停止。反映後の区分変更で本文を維持 | 実Backspace/取消/SetText、失敗通知UI、実アプリでの再開 |

## 不具合と区別する実装・テスト上の限界

- READMEはICUによるオフライン文脈抽出、C++/utf8proc接続の未実装、TSFへの編集プロトコル接続と実アプリcomposition所有の未検証を明記している。これらを今回のコード不具合には数えない。
- `createEditServer` の期限到達処理は `receive()` 経由、Prepare直後、明示的な `expire()` でのみ動く（43–46、55、103、117行）。タイマーを内部登録しない。`createEditClient` も `step()` 駆動である。切断後も外部から駆動しなければ、保持した入力/計画は時間の経過だけで解放されない。READMEと関数コメントには、タイマー/切断時に誰が駆動するかを定めた具体的な契約はない。現在の手動駆動シミュレーションでは統合前提・文書化の残件とし、現在動作するIMEでの情報残留と断定しない。
- 既定時計は両アダプターとも `performance.now()`（5行）。期限はメッセージに絶対値として入り、相手側でそのまま比較する。テストは同じ変数を読む時計を共有している。別プロセスへの接続時に共通の単調時刻を使うか、期限を変換する契約と試験が必要であり、現状にその検証はない。
- bindingは全世代を含むことが25–27行の前提。ライブラリーは3つの所有IDだけを必須検証し、field/focus/document/reading/privacy/composition等の完全なスキーマを強制しない。特に機密区分が往復する場合は、hostが区分の世代を進める必要がある。既存テストのfixtureにはprivacy世代がなく、往復による旧操作失効を確かめられない。
- コールバックの実副作用はhostの責任。テストのprepare/commitはログへの追加であり、composer/Undo/学習の変更を本当に保留したり一度だけ適用したりするネイティブ実装を検証していない。
- `prepare` / `commit` / `apply` の例外と、取消通知自体の応答消失、明示的なサーバーexpire、別所有ID、区分の往復を恒久テストで増やす余地がある。これは当該分岐が壊れているとの主張ではない。
