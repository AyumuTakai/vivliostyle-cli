# 自家用 vivliostyle-cli

[本家 vivliostyle-cli](https://github.com/vivliostyle/vivliostyle-cli)

## こんなことができたら良いな

| 機能                                                     | 状態                          |
| -------------------------------------------------------- | ----------------------------- |
| 既存テーマのスタイルのカスタマイズ(スタイルの上書き)     | 試験実装済み 設定方法を検討中 |
| コンテンツの置換(VFM のリプレイス機能)                   | 試験実装済み 設定方法を検討中 |
| md ファイル->HTML 変換に対する前処理                     | 試験実装済み 設定方法を検討中 |
| 出力された PDF や EPUB への後処理                        | 仕様検討中                    |
| SCSS トランスパイル                                      | 試験実装済み 設定方法を検討中 |
| SCSS 変数の config.js での設定                           | 試験実装済み 設定方法を検討中 |
| SCSS とスクリプトで設定値の共有                          | 仕様検討中                    |
| 独自タグの追加(リプレイスでは不可能な複数行にわたるもの) | 前処理で実現可能か            |

## 機能詳細

### 既存テーマのスタイルのカスタマイズ(スタイルの上書き)

複数のテーマを読み込むことで公式テーマなどを簡単にカスタマイズできるようになる。

設定方法については本家の Issue として検討中 [Issue143](https://github.com/vivliostyle/vivliostyle-cli/issues/143#issuecomment-786669335)

### コンテンツの置換(VFM のリプレイス機能)

コンテンツの置換ルールを JavaScript で記述し、Markdown から HTML に変換する際に実行する。

[置換ルールの記述方法(VFM)](https://vivliostyle.github.io/vfm/#/hooks)

```javascript
exports.replaces = [
  {
    test: /猫/g,
    match: ([], h) => {
      return h('span', '🐈');
    },
  },
];
```

### md ファイル->HTML 変換に対する前処理

Markdown から HTML に変換する前にファイル全体に対する処理を行なう。

#### 想定される用途

- 自動校正(TextLint 利用)
- 音声合成(OpenJTalk 利用)
- コンテンツを元にした画像ファイル作成(PlantUML 利用)
- 複数行にわたる独自タグ

#### 現在の設定方法

```javascript
exports.preprocess = [
  (filepath, contents) => {
    // contentsに関する処理
    return contents;
  },
];
```

### 出力された PDF や EPUB への後処理

#### 想定される用途

- 生成されたファイルのアップロード
- 自動入稿
- 生成物チェック

#### 想定される設定方法

```javascript
exports.postprocess = [
  (filepath) => {
    // PDFやWebPubに対する処理
  },
];
```

### SCSS トランスパイル

テーマを workspace にコピーする際に SCSS から CSS にトランスパイルする。

#### 想定される用途

- テーマのカスタマイズ

### SCSS 変数の config.js での設定

テーマに含まれている SCSS の変数値を vivliostyle.config.js に設定した値で上書きする。

#### 想定される用途

- テーマのカスタマイズ
- レイアウト確認用枠線などの ON/OFF

### SCSS とスクリプトで設定値の共有

SCSS と replace,preprocess,postprocess で変数を共有する。

なにかおもしろいことができるのでは。

### 独自タグの追加(リプレイスでは不可能な複数行にわたるもの)

preprocess 機能で実現できそう。
