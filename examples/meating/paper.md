# 複数のテーマを適用する機能

vivliostyle.config.jsやパッケージテーマにおいて、<br>
複数のテーマを指定し適用する機能を提案します。

@AyumuTakai

# メリット

* 既存テーマに対してfork/clone不要でカスタマイズしやすい
* 既存テーマのバージョンアップに追随しやすい
* 部分的なテーマを組合せることで完結したテーマを作りやすい
* エントリーに合わせてテーマを付け外ししやすい
* 機能追加のためのプラグインへの布石

<small>このスライドも@vivliostyle/theme-slideをベースにカスタマイズCSSを追加して作成しています。</small>

# デメリット

* 構造の複雑化によって適用されるスタイルを想像しにくい
* テーマの相性問題が発生しやすくなる
* スタイルのデバッグが難しくなる
* CSSの適用優先順位の知識が必要になる

# 仕組み

CSSの結合などは行なわず、指定されたテーマの数だけ&lt;link rel="stylesheet"&gt;を書き出しているだけです。

MarkdownとHTMLの両方の原稿に対応しています。

# デモ その1

部分的なテーマを組みあわせて簡単にカスタマイズできます。

以下のテーマを順に適用します。<br>(将来SCSS変数が導入されると不要になるものも)

* A4書籍用ページレイアウト(ページ余白、ノンブル、柱の設定)
* 表紙(ページ背景を設定、ノンブルと柱を非表示)
* 開始ページ番号指定
* 2段組み

```javascript
{path:'cover.md', theme: ['A4book.css','cover.css'] },
{path:'bunko.md', theme: ['A4book.css','2column.css','startpage.css']},
{path:'yume.md', theme: ['A4book.css','2column.css']}
```

# デモ その2

スクリプトを含むテーマによりプラグイン的に機能追加できます。

以下のテーマを順に適用します。

* 指定文字置換1(VFMのリプレイス:猫→🐈)
* 指定文字置換2(VFMのリプレイス:掌→🖐)
* 常用漢字ルールを設定したTextLintによる校正(プリプロセス)
* 音声合成(プリプロセス)

<small>※プリプロセスはmarkdownファイル読み込み時にフィルタとしてスクリプトを実行する機能</small>

```javascript
theme: ['@vivliostyle/theme-bunko', 'emojicat',
    'emojihand', 'textlint', 'openJTalk']
```

# デモ その3(時間があれば)

[請求書発行システム試作](https://github.com/AyumuTakai/vivliostyle-invoice-sample)

```
@hassaku_63 : Vivliostyle のようなCSS組版のソフトウェアを使って、
例えば請求書などのようなバックオフィス業務で発生する帳票の類をいい感じ
に開発できないだろうか？？
```

Twitter(Slackの#twitter)で見掛けた上記の書き込みを切っ掛けに、自作のRuby+TeX製 請求書PDF作成プログラムをvivliostyle-cliに移行できないか試作してみました。

プリプロセス、リプレイス機能によるスクリプティングと複数テーマの組合せによって比較的効率的に開発を進めることができました。

# 設定書式

現在は、vivliostyle.config.jsの全体とエントリで
```javascript
theme: ["テーマ1","テーマ2"]
```
のように記述でき、エントリ>全体(排他で適用)、リスト内は右>左(CSSは上書き、スクリプトは先に処理)としています。

テーマパッケージ内とMarkdownのメタデータは未対応です。

全体に適用するテーマを設定したうえでエントリ毎に拡張またはカスタマイズするニーズもあるため設定書式を[Issue #143](https://github.com/vivliostyle/vivliostyle-cli/issues/143)で検討中です。
