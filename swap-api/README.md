# stas3-swap-api

STAS 3.0 ホルダー同士のオンチェーン交換(divisible swap)API。トランザクションはBIP-239 Extended Format(EF)で、自前BSV TestnetノードのARCにブロードキャストする。

仕様根拠: STAS 3.0 spec v0.2.1(stastech.org/docs/stas, /docs/swap)+ 同梱の公式ロッキングスクリプトテンプレート(`assets/stas3-template.txt`)。

## フロー

```
Maker                          API                            Chain (ARC → 自前ノード)
  │ POST /offers ───────────────▶ var2にスワップディスクリプタを
  │                               インストールするtxを構築・署名 ──▶ broadcast
  │                               オーダーブックに登録
  │
Taker
  │ GET /offers                  板の取得
  │ GET /offers/:id/quote        必要wanted量の見積り(rate = num/den, A' = A×num/den)
  │ POST /offers/:id/take ──────▶ txType=1スワップtx構築
  │   (部分テイク可)              ・in0 = Makerスワップ UTXO(署名抑制)
  │                               ・in1 = Takerトークン(Taker署名)
  │                               ・カウンターパーティ前tx再構成ピース付与 ──▶ broadcast
  │                               残量は同一ディスクリプタの新オファーとして再登録
  │
Maker
  │ POST /offers/:id/cancel ────▶ spendType=4でreceiveAddrへ返却 ──▶ broadcast
```

## セットアップ

```bash
npm install
cp .env.example .env   # ARC_URL を自前ノードのARCに向ける
npm run dev            # tsx 起動
npm test               # オフライン自己テスト(ビルダーE2E)
```

Node 22+(`node:sqlite`使用)。

## エンドポイント

### POST /offers — オファー作成(Maker)

```json
{
  "tokenUtxo": { "txid": "...", "vout": 0, "satoshis": "10000", "script": "<hex>", "sourceTxHex": "<hex>" },
  "ownerWif": "...",
  "fundingUtxo": { "txid": "...", "vout": 1, "satoshis": "50000", "script": "<hex>", "sourceTxHex": "<hex>" },
  "fundingWif": "...",
  "requestedTokenScriptHex": "<欲しいトークンの任意UTXOのロッキングスクリプトhex>",
  "receiveAddrHex": "<20バイトPKH/MPKH hex>",
  "rateNumerator": 39142,
  "rateDenominator": 100,
  "broadcast": true
}
```

- `requestedScriptHash` は `requestedTokenScriptHex` をパースし、var1/var2を除いた不変部(エンジン+OP_RETURN以降)のSHA256として自動算出。
- スワップUTXOのownerはデフォルトで `EMPTY_HASH160`(= HASH160(""), パーミッションレステイク)。アービトレータを要求する場合は `swapOwnerHex` を指定。
- `rateNumerator: 0` でレートチェック無効(NFT用)。
- キャンセル権は `receiveAddrHex` の鍵に紐づく(spendType=4)。

### GET /offers?status=open — 板取得
### GET /offers/:id/quote?takeAmount=700 — 必要wanted量
### POST /offers/:id/take — テイク(部分可)

```json
{
  "takerUtxo": { "...": "要求されているトークンのUTXO" },
  "takerWif": "...",
  "fundingUtxo": { "..." : "" },
  "fundingWif": "...",
  "takeAmount": "700",
  "broadcast": true
}
```

出力割当(仕様準拠): out0 = wanted資産→MakerのreceiveAddr / out1 = offered資産→Taker / out2 = Maker残量(owner・var2を継承し板に残る)/ out3 = Taker残量 / change。両レッグ分割可、最大4トークン出力。

### POST /offers/:id/cancel — キャンセル(spendType=4、receiveAddr署名)
### POST /inspect — 任意のSTASスクリプトの解析(owner / action / descriptor / persistentScriptHash / protoID)
### GET /tx/:txid — ARCステータス
### GET /health

## ARC

`POST {ARC_URL}/v1/tx` に `{ rawTx: <EF hex> }` を送信。EFは前出力(satoshis+script)を内包するため、ARCが他のインデクサに依存せず単独検証できる。`X-WaitFor` は既定 `SEEN_ON_NETWORK`。

## ⚠ 本番前に必ず検証すべき点

1. **アンロッキングスクリプトのスタック順序** — `src/stas/unlock.ts` に一箇所集約してある。公開散文仕様の記述順(出力宣言 → note → change → funding vin → spendType → txType → [counterparty script, piece count, pieces] → preimage → sig → pubkey/redeem buffer)で実装しているが、20KBエンジンの正確な消費順序はテンプレートが正。自前ノードに対する `sendrawtransaction` で1スペンド検証し、不一致があれば `buildStasUnlock()` の `parts` 順序のみ修正すればよい。
2. **SIGHASHフラグ** — `SIGHASH_ALL | FORKID (0x41)` を既定にしている(`src/stas/constants.ts`)。preimageは全出力にコミットする必要があるためALL系は確定だが、ANYONECANPAYの有無は要確認。
3. **残量UTXOのvar2** — 仕様は「残量はowner・var2を継承」と「descriptorの`next`を残量にインストール」の両方を記述している。本実装は `next` 不在なら継承(板に残る)、`next` 指定時はそれを採用。
4. **WIFをHTTPで送る設計はtestnet開発用**。本番はprepare/sign二段(クライアント署名)に差し替えること(`buildOfferTx` 等はWIFを `PrivateKey` に変換して署名する箇所が分離されているので置換は容易)。
5. **P2MPKH** — unlock.tsは `multisigSignatures` + redeem buffer(`m ‖ (0x21‖pk)×n ‖ n`)に対応済みだが、APIエンドポイントはP2PKHのみ受け付ける。

## スループットベンチ(フロントエンド付き)

`npm run dev` 後、ブラウザで `http://localhost:3000/` を開く。

1. **WIF読み込み** — テストネットWIFを入力(127.0.0.1のベンチサーバーにのみ送信)
2. **STAS一覧→選択** — WIF配下の合成STASトークンセット(regtest式フィクスチャ)を表示
3. **高速swapテスト開始** — 件数/ワーカー数/スクリプトtailサイズを指定して実行。SSEでライブスループットをストリップチャート表示(10,000/s目標線付き)
4. **結果ビュー** — 判定・平均/ピーク・p50/p90/p99レイテンシ・署名スループット・生成txデータ量

計測対象は本番と同一の `buildTakeTx` 経路全体(スクリプト解析→ディスクリプタ検証→ピース再構成→preimage×2→ECDSA署名×2→アンロック構築→raw+EF直列化)。各スワップは独立オファーUTXOを消費する(L1オーダーブックの並列モデル。同一オファーの残量チェーンは逐次)。

### 実測値(このリポジトリ作成時、1 vCPUコンテナ)

| 条件 | スループット |
|---|---|
| tail 1KB・15,000件・1ワーカー | **平均 1,394 swaps/s、ピーク 1,754/s**(p50 544µs、EF出力 162MB) |
| tail 20KB(実テンプレート相当) | 225 swaps/s/core |

ワーカーはコア数に線形スケールするため、**10,000 swaps/s は tail 1KB なら8コア相当、20KB実サイズなら~45コア相当**(コア性能が本計測環境並みの場合。最近のデスクトップコアは2〜3倍速いため実際の必要コア数はその1/2〜1/3)。署名はネイティブlibsecp256k1(18,192 sig/s/core実測)、無い環境では@noble/secp256k1に自動フォールバック。

最適化履歴: @bsv/sdk純正経路 222/s → ネイティブ署名+node:crypto sha256+Buffer hex変換+sighash midstateキャッシュ+鍵素材キャッシュで 1,409/s(6.3倍)。

API: `POST /bench/wallet`(WIF→アドレス+トークン一覧)、`POST /bench/start`、`GET /bench/:id/events`(SSE)、`GET /bench/:id`。`broadcast: true` でARCへの実送信込み計測も可(スループットはARC/ノード律速になる)。

## 構成

```
src/
  server.ts          Express API
  arc.ts             ARCクライアント(EF送信/ステータス)
  orderbook.ts       node:sqlite オーダーブック
  tx.ts              最小txモデル(直列化・txid・EF・出力オフセット・pieces)
  sighash.ts         BIP143系preimage + ECDSA署名
  keys.ts            鍵・アドレスユーティリティ
  stas/
    constants.ts     EMPTY_HASH160, ACTION, SPEND_TYPE, TX_TYPE, SIGHASH
    script.ts        STASロッキングスクリプトのパース/再構築(全push符号化対応)
    descriptor.ts    スワップディスクリプタ(61バイト+next)エンコード/デコード
    unlock.ts        アンロッキングスクリプトビルダー(レイアウト一元化)
    swap.ts          オファー/テイク/キャンセルtxビルダー
  fastsign.ts        高速署名(native libsecp256k1 / noble fallback)
  bench/             ベンチ(fixtures / worker / runner)
  selftest.ts        オフラインE2Eテスト
public/index.html    ベンチフロントエンド
assets/stas3-template.txt   公式STAS 3.0テンプレート(参照用)
```
