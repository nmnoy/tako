#!/usr/bin/env bash
# 辞書の元データを tools/sources/ に取ってくる。生成物（dictionary.js）だけあればアプリは動くので、
# 元データはリポジトリに含めない（.gitignore 推奨）。
set -euo pipefail
cd "$(dirname "$0")/sources"

# 日本語WordNet（本命。動詞・形容詞・文学的な語が多い）
if [ ! -d wnja ]; then
  git clone --depth 1 https://github.com/bond-lab/wnja.git wnja
fi

# Sudachi 同義語辞書（補助。現代的な名詞・カタカナ語に強い）
if [ ! -d SudachiDict ]; then
  git clone --depth 1 --filter=blob:none --sparse https://github.com/WorksApplications/SudachiDict.git SudachiDict
  git -C SudachiDict sparse-checkout set --no-cone /LICENSE-2.0.txt /README.md /src/main/text/synonyms.txt
fi

# wordfreq の日本語頻度データ（候補を「よく使う順」に並べるためだけに使う。配布物には含めない）
if [ ! -d wordfreq ]; then
  git clone --depth 1 --filter=blob:none --sparse https://github.com/rspeer/wordfreq.git wordfreq
  git -C wordfreq sparse-checkout set --no-cone '/wordfreq/data/large_ja.msgpack.gz' /LICENSE.txt /README.md
fi

# Open English WordNet（連想の欄の「上位・下位・部分・全体」の関係。日本語WordNet と ILI でつなぐ）
if [ ! -d oewn ]; then
  git clone --depth 1 --filter=blob:none --sparse https://github.com/globalwordnet/english-wordnet.git oewn
  git -C oewn sparse-checkout set --no-cone /src/yaml/ /LICENSE.md /WNDB_License.txt /README.md
fi

echo "done: $(pwd)"
