Please visit links below(Japanese).

https://protopedia.net/prototype/3491

https://qiita.com/SAKUA/items/9bd9dea3f1599ca6be45

https://sakua-portfolio.studio.site/chair-person

## お絵描き画像の保管機能

controller の「お絵描き画像を保管」ボタンは、`drawing-` で始まる画像を保管用バケットへ移動し、展示画面の画像一覧更新を要求します。

使用前に Supabase で `chair-person-archive` バケットを作成し、`storage.objects` に画像の移動で必要となる `SELECT`・`UPDATE` ポリシーを設定してください。

外部通信を行わない動作検証: `node --test tests/archive-drawings.test.cjs`
