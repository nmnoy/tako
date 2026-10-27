# サードパーティのライセンス表記

タコエディタ（開発中の名前は kotoba）の類語辞書（`dictionary.js`）は、以下のデータから `tools/build_dictionary.py` で生成している。
アプリを配布するときは、このファイルと `licenses/` フォルダを一緒に同梱し、アプリ内の「このアプリについて」等からも参照できるようにすること。

---

## 日本語WordNet（Japanese WordNet）

- 配布元: https://github.com/bond-lab/wnja
- 用途: 類語データ（主要な元データ）
- ライセンス: NICT による独自ライセンス（目的を問わず使用・複製・改変・配布可。著作権表示と以下の文言を全コピーに含めること）
- 全文: `licenses/Japanese-WordNet.txt`

```
Copyright: 2021-2024 Francis Bond, Takayuki Kuribayashi
Copyright: 2018-2020 Francis Bond	   
Copyright: 2016-2017 Francis Bond, Takayuki Kuribayashi
Copyright: 2012-2015 Francis Bond	   
Copyright: 2009-2011 NICT



Japanese WordNet

This software and database is being provided to you, the LICENSEE, by
the National Institute of Information and Communications Technology
under the following license.  By obtaining, using and/or copying this
software and database, you agree that you have read, understood, and
will comply with these terms and conditions:
  
  Permission to use, copy, modify and distribute this software and
  database and its documentation for any purpose and without fee or
  royalty is hereby granted, provided that you agree to comply with
  the following copyright notice and statements, including the
  disclaimer, and that the same appear on ALL copies of the software,
  database and documentation, including modifications that you make
  for internal use or for distribution.
  
 
THIS SOFTWARE AND DATABASE IS PROVIDED "AS IS" AND NICT MAKES NO
REPRESENTATIONS OR WARRANTIES, EXPRESS OR IMPLIED.  BY WAY OF EXAMPLE,
BUT NOT LIMITATION, NICT MAKES NO REPRESENTATIONS OR WARRANTIES OF
MERCHANTABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE
OF THE LICENSED SOFTWARE, DATABASE OR DOCUMENTATION WILL NOT INFRINGE
ANY THIRD PARTY PATENTS, COPYRIGHTS, TRADEMARKS OR OTHER RIGHTS.
  
The name of the National Institute of Information and Communications
Technology may not be used in advertising or publicity pertaining to
distribution of the software and/or database.  Title to copyright in
this software, database and any associated documentation shall at all
times remain with National Institute of Information and Communications
Technology and LICENSEE agrees to preserve same.
```

---

## Sudachi 同義語辞書（SudachiDict）

- 配布元: https://github.com/WorksApplications/SudachiDict
- 用途: 類語データ（補助。現代的な名詞・カタカナ語）
- ライセンス: Apache License 2.0
- 全文: `licenses/Apache-2.0.txt`

```
SudachiDict by Works Applications Co., Ltd. is licensed under the Apache License, Version 2.0

   Copyright (c) 2017-2023 Works Applications Co., Ltd.

This project includes UniDic and a part of NEologd.
```

---

## Open English WordNet

- 配布元: https://github.com/globalwordnet/english-wordnet
- 用途: 連想の欄（大きなくくり・具体的な言い方・部分・全体）の、意味どうしの関係。英語の語は使わず、日本語WordNet の語どうしを結ぶためだけに使用
- ライセンス: Creative Commons Attribution 4.0（CC BY 4.0）と WordNet License（Princeton WordNet をもとにしているため）
- 全文: `licenses/Open-English-WordNet.txt`

```
Open English Wordnet, Copyright by the Open English Wordnet team. Licensed under CC BY 4.0.
https://creativecommons.org/licenses/by/4.0/
This work is based on or incorporates elements of the Princeton University WordNet database.
WordNet 3.1 Copyright 2011 by Princeton University. All rights reserved.
```

> 注: 関係のデータは relations.js に加工して入っている（日本語の語に置き換えた形）。CC BY 4.0 は表示だけで継承義務はない

---

## wordfreq

- 配布元: https://github.com/rspeer/wordfreq
- 用途: 辞書の生成時に、候補を「よく使う順」に並べるためだけに使用。頻度の値そのものは `dictionary.js` に含めていない
- ライセンス: コードは Apache License 2.0、データは Creative Commons Attribution-ShareAlike 4.0
- Copyright 2022 Robyn Speer

> 注: 並び順にだけ使っていて頻度データ自体は配布していないが、念のためクレジットを残している。
> 販売前に、この使い方で CC BY-SA の継承義務が及ぶかどうかは一度確認しておくこと。
