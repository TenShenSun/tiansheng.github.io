# BM25 算法深度解析：经典信息检索的工程实践

> BM25 是 30 年前的算法，却仍是今天 RAG、搜索引擎、候选召回的标配。理解它，是理解「如何高效找到相关文档」这个根本问题的起点。

---

## 一、从 TF-IDF 到 BM25：30 年演进脉络

### 信息检索的核心问题

给定查询 `q` 和文档集合 `D`，如何对每个文档 `d ∈ D` 打分，让最相关的文档排在最前面？

这个问题的核心是：**哪些词出现频率高，真的说明文档与查询相关？**

### TF-IDF 的思路与缺陷

**TF（词频）**：词 `t` 在文档 `d` 中出现越多次，`d` 可能越相关。

**IDF（逆文档频率）**：词 `t` 在越少的文档中出现，区分能力越强。

$$\text{TF-IDF}(t, d) = \text{TF}(t, d) \times \log\frac{N}{df(t)}$$

TF-IDF 的两个结构性缺陷：

1. **TF 无上界**：「苹果」在文档中出现 100 次 vs 10 次，得分线性 10 倍，但实际相关性提升远没有那么大
2. **不考虑文档长度**：1000 词的文档和 100 词的文档，相同词频的意义完全不同

### BM25 如何修复这两个问题

BM25（Best Matching 25）由 Robertson 和 Sparck Jones 在 1990 年代提出，是概率检索框架（BIM）的第 25 次迭代实验结果。

核心改进：
- **TF 饱和化**：用非线性函数限制 TF 的增长上界
- **文档长度归一化**：用实际长度与平均长度的比率修正 TF

---

## 二、BM25 公式完整拆解

### 核心公式

$$\text{BM25}(q, d) = \sum_{t \in q} \text{IDF}(t) \cdot \frac{\text{TF}(t, d) \cdot (k_1 + 1)}{\text{TF}(t, d) + k_1 \cdot \left(1 - b + b \cdot \frac{|d|}{\text{avgdl}}\right)}$$

其中：
- `TF(t, d)`：词 `t` 在文档 `d` 中的出现次数
- `|d|`：文档 `d` 的词数
- `avgdl`：语料库所有文档的平均词数
- `k1`、`b`：超参数（下面详解）
- `IDF(t)`：逆文档频率（Robertson 版本，见下）

### IDF 公式（Robertson 修正版）

$$\text{IDF}(t) = \log\frac{N - df(t) + 0.5}{df(t) + 0.5}$$

其中 `N` 是文档总数，`df(t)` 是包含词 `t` 的文档数。

分子加 0.5 是 Laplace 平滑，防止分母为零。当 `df(t) > N/2` 时 IDF 可能为负（高频词如「的、了」），实践中通常截断为 0。

### 超参数 k1：TF 饱和速度

`k1` 控制 TF 对得分的影响饱和速度：

- `k1 = 0`：完全忽略 TF，只看词是否出现（二元模型）
- `k1 = 1.2`：Elasticsearch 默认值，饱和较快
- `k1 = 2.0`：饱和较慢，对高频词仍给更高得分
- `k1 → ∞`：退化为线性 TF，等同 TF-IDF 行为

:::方法 可视化 TF 饱和效果
当 `k1=1.2`，TF 从 1→10 时，BM25 TF 分量从 ~0.55 增到 ~0.92（增幅 67%）；
而原始 TF-IDF 从 1→10，增幅 900%。
饱和机制有效防止「词语堆砌」攻击排名。
:::

### 超参数 b：文档长度归一化强度

`b ∈ [0, 1]` 控制文档长度对得分的影响：

- `b = 0`：完全不做长度归一化
- `b = 0.75`：Elasticsearch/Lucene 默认值，适合大多数场景
- `b = 1.0`：完全归一化，长文档和短文档等权

**如何选 b？** 取决于你的语料特征：
- 文档长度差异大（论文 vs 推文混合）→ `b` 偏大
- 文档长度均匀 → `b` 偏小

---

## 三、BM25 vs TF-IDF：数值对比

用一个具体例子说明差异。语料库平均文档长度 100 词，k1=1.2，b=0.75。

查询词「苹果」在文档 A（200 词）中出现 10 次，在文档 B（50 词）中出现 5 次。

**TF-IDF 得分**（假设 IDF=1 便于对比）：
- 文档 A：10 × 1 = **10.0**
- 文档 B：5 × 1 = **5.0**

**BM25 TF 分量**：

文档 A 的长度因子：`1 - 0.75 + 0.75 × (200/100)` = **1.75**

$$\text{TF}_{A} = \frac{10 \times 2.2}{10 + 1.2 \times 1.75} = \frac{22}{12.1} \approx 1.82$$

文档 B 的长度因子：`1 - 0.75 + 0.75 × (50/100)` = **0.625**

$$\text{TF}_{B} = \frac{5 \times 2.2}{5 + 1.2 \times 0.625} = \frac{11}{5.75} \approx 1.91$$

**BM25 结果**（乘以 IDF=1）：
- 文档 A：**1.82**（虽然绝对词频更高）
- 文档 B：**1.91**（短文档里出现相对密集，得分更高）

这正是 BM25 的直觉：**在短文档里频繁出现比在长文档里堆砌更有意义**。

---

## 四、从公式到代码：BM25 的最简实现

```python
import math
from collections import Counter

class BM25:
    def __init__(self, corpus: list[list[str]], k1: float = 1.2, b: float = 0.75):
        self.k1 = k1
        self.b = b
        self.corpus = corpus
        self.N = len(corpus)
        self.avgdl = sum(len(doc) for doc in corpus) / self.N
        
        # 预计算每个文档的词频
        self.tf = [Counter(doc) for doc in corpus]
        
        # 计算每个词的 df（文档频率）
        self.df: dict[str, int] = {}
        for doc in corpus:
            for word in set(doc):
                self.df[word] = self.df.get(word, 0) + 1
    
    def idf(self, term: str) -> float:
        df = self.df.get(term, 0)
        return math.log((self.N - df + 0.5) / (df + 0.5) + 1)
    
    def score(self, query: list[str], doc_idx: int) -> float:
        doc = self.corpus[doc_idx]
        doc_tf = self.tf[doc_idx]
        dl = len(doc)
        score = 0.0
        
        for term in query:
            if term not in doc_tf:
                continue
            tf = doc_tf[term]
            length_norm = 1 - self.b + self.b * (dl / self.avgdl)
            numerator = tf * (self.k1 + 1)
            denominator = tf + self.k1 * length_norm
            score += self.idf(term) * (numerator / denominator)
        
        return score
    
    def rank(self, query: list[str], top_k: int = 10) -> list[tuple[int, float]]:
        scores = [(i, self.score(query, i)) for i in range(self.N)]
        return sorted(scores, key=lambda x: x[1], reverse=True)[:top_k]
```

### 工程优化：倒排索引

上面的实现对每个查询都扫描全量文档，时间复杂度 O(N × |q|)。生产中必须用**倒排索引**：

```python
from collections import defaultdict

class BM25WithIndex:
    def __init__(self, corpus: list[list[str]], k1=1.2, b=0.75):
        self.k1 = k1
        self.b = b
        self.N = len(corpus)
        self.avgdl = sum(len(d) for d in corpus) / self.N
        self.dl = [len(d) for d in corpus]  # 每个文档的长度
        
        # 倒排索引：term → [(doc_id, tf), ...]
        self.inverted_index: dict[str, list[tuple[int, int]]] = defaultdict(list)
        self.df: dict[str, int] = {}
        
        for doc_id, doc in enumerate(corpus):
            tf = Counter(doc)
            for term, count in tf.items():
                self.inverted_index[term].append((doc_id, count))
                self.df[term] = self.df.get(term, 0) + 1
    
    def search(self, query: list[str], top_k: int = 10) -> list[tuple[int, float]]:
        scores: dict[int, float] = defaultdict(float)
        
        for term in query:
            if term not in self.inverted_index:
                continue
            
            df = self.df[term]
            idf = math.log((self.N - df + 0.5) / (df + 0.5) + 1)
            
            # 只遍历包含该词的文档（稀疏）
            for doc_id, tf in self.inverted_index[term]:
                length_norm = 1 - self.b + self.b * (self.dl[doc_id] / self.avgdl)
                tf_score = tf * (self.k1 + 1) / (tf + self.k1 * length_norm)
                scores[doc_id] += idf * tf_score
        
        return sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]
```

时间复杂度降为 O(Σ df(t))，即所有查询词的文档列表总长度，通常远小于 N。

---

## 五、BM25 在现代 RAG 系统中的角色

### 为什么 RAG 还需要 BM25？

大家以为 Embedding 向量搜索（ANN）已经足够好，BM25 只是历史遗留——这个认知是错的。

两者的失效模式完全不同：

| 场景 | BM25 | 向量搜索 |
|------|------|---------|
| 精确关键词匹配（产品型号「RTX 4090 Ti」） | ✅ 强 | ❌ 弱（易被稀释） |
| 语义相近但用词不同（「心情不好」→「情绪低落」） | ❌ 弱 | ✅ 强 |
| 生僻专有名词、代码片段 | ✅ 强 | ❌ 弱（OOV 问题） |
| 长查询的语义理解 | ❌ 弱 | ✅ 强 |
| 新出现的词（embedding 训练后的新词） | ✅ 不受影响 | ❌ 可能退化 |

### Hybrid Search：BM25 + 向量搜索

生产 RAG 系统几乎都采用混合检索：

```python
def hybrid_search(query: str, bm25_retriever, dense_retriever,
                  alpha: float = 0.5, top_k: int = 10):
    """
    alpha: BM25 权重，1-alpha 为向量搜索权重
    使用 RRF (Reciprocal Rank Fusion) 合并两路结果
    """
    bm25_results = bm25_retriever.search(query, top_k=top_k * 3)
    dense_results = dense_retriever.search(query, top_k=top_k * 3)
    
    # RRF 打分：rank_score = 1 / (k + rank)，k=60 是经验值
    k = 60
    scores: dict[str, float] = defaultdict(float)
    
    for rank, (doc_id, _) in enumerate(bm25_results):
        scores[doc_id] += alpha * (1 / (k + rank + 1))
    
    for rank, (doc_id, _) in enumerate(dense_results):
        scores[doc_id] += (1 - alpha) * (1 / (k + rank + 1))
    
    return sorted(scores.items(), key=lambda x: x[1], reverse=True)[:top_k]
```

:::方法 RRF vs 线性加权
线性加权需要对 BM25 和向量分数做归一化（两者量纲不同），而 RRF 直接基于排名合并，无需归一化，实践中鲁棒性更好。
:::

### Elasticsearch 的 BM25 实现细节

Elasticsearch 7.0+ 默认打分算法就是 BM25（之前是 TF-IDF）。几个工程细节：

**字段级别的独立 BM25**：ES 的 `avgdl` 是按字段独立计算的，标题字段和正文字段各有自己的平均长度。

**协调因子（旧版遗留）**：ES 5.x 以前有 coord factor（命中词数占查询词数的比例），6.0 后废弃。

**参数配置**：
```json
{
  "mappings": {
    "properties": {
      "content": {
        "type": "text",
        "similarity": "my_bm25"
      }
    }
  },
  "settings": {
    "similarity": {
      "my_bm25": {
        "type": "BM25",
        "k1": 1.2,
        "b": 0.75,
        "discount_overlaps": true
      }
    }
  }
}
```

---

## 六、BM25 的变体与扩展

### BM25+（防止极短文档过度惩罚）

标准 BM25 对极短文档（1-2 词）可能打分过低，BM25+ 增加一个下界 δ：

$$\text{TF}_{BM25+} = \delta + \frac{\text{TF} \cdot (k_1 + 1)}{\text{TF} + k_1 \cdot \text{norm}}$$

`δ` 通常取 1，防止 TF 分量被长度归一化压得过低。

### BM25F（域加权）

文档通常有多个字段（标题、正文、标签），BM25F 统一建模多字段权重：

$$\tilde{\text{TF}}(t, d) = \sum_f w_f \cdot \frac{\text{TF}(t, d, f)}{1 - b_f + b_f \cdot \frac{|d_f|}{\text{avgdl}_f}}$$

每个字段有独立的权重 `w_f` 和长度归一化参数 `b_f`。

典型配置：标题权重 3×，正文权重 1×，URL 锚文本权重 5×。

### BM25-Adpt（自适应参数）

`k1` 和 `b` 固定值在不同语料上效果差异大。BM25-Adpt 对每个词独立学习 `k1` 值，长词 `k1` 大（饱和慢），短词 `k1` 小（饱和快）。

---

## 七、常见工程陷阱

### 陷阱 1：分词器影响大于超参数

`k1=1.2` vs `k1=1.5` 的差距，远小于「用 jieba 分词」vs「用 BM25 内置空格分词」的差距。中文场景务必先接好分词器。

```python
import jieba

def tokenize_zh(text: str) -> list[str]:
    # 过滤单字停用词
    stopwords = {"的", "了", "是", "在", "我", "有", "和", "就", "都", "而"}
    tokens = jieba.cut(text)
    return [t for t in tokens if t.strip() and t not in stopwords]
```

### 陷阱 2：IDF 在小语料上失效

当语料库只有几百个文档时，IDF 噪声大（一个词出现 1 次 vs 2 次，IDF 差距悬殊）。此时可以考虑：
- 用外部大语料的 IDF 统计（wikipedia、Common Crawl）
- 降低 IDF 权重，增加 TF 权重

### 陷阱 3：不处理停用词导致噪声

「的」「a」「the」这类高频词 IDF 接近 0（甚至为负），但遍历它们的倒排列表会浪费大量计算。生产中要么过滤停用词，要么设置 IDF 最低阈值。

### 陷阱 4：BM25 对查询词顺序不敏感

「用户投诉产品质量」和「产品质量投诉用户」得分相同，BM25 是词袋模型（bag-of-words），没有位置信息。如果顺序很重要，需要配合 phrase query 或 span query。

---

## 八、BM25 在面试中的高频考点

:::提醒 面试必备
这部分是 NLP/搜索/RAG 工程师面试的高频知识点，建议能徒手推导公式。
:::

**Q：BM25 的两个超参数 k1 和 b 分别控制什么？**

A：`k1` 控制 TF 饱和速度，越大则词频对得分的边际增益越持久；`b` 控制文档长度归一化强度，越大则长文档惩罚越重。默认 k1=1.2，b=0.75。

**Q：为什么 BM25 比 TF-IDF 好？**

A：TF-IDF 的 TF 无上界（词语堆砌可无限提高得分）且不考虑文档长度。BM25 用非线性 TF 饱和函数解决第一个问题，用 avgdl 归一化解决第二个问题。

**Q：向量搜索已经很强了，为什么 RAG 还要用 BM25？**

A：两者失效模式互补。BM25 在精确关键词匹配、生僻专有名词、代码片段上更强；向量搜索在语义相似但用词不同的场景更强。生产 RAG 系统普遍采用 Hybrid Search（BM25 + 向量），用 RRF 合并两路结果。

**Q：BM25 的时间复杂度？如何优化？**

A：朴素实现 O(N × |q|)，使用倒排索引后降为 O(Σ df(t))，再加上 WAND（Weak AND）算法可进一步跳过低分文档，实现次线性搜索。

**Q：中文场景 BM25 最需要注意什么？**

A：分词器选型。中文没有天然词边界，分词质量直接决定 BM25 效果上限。一般用 jieba + 停用词过滤，细粒度场景可以考虑字粒度 tokenize。

---

## 九、主流库与工程选型

| 场景 | 推荐方案 |
|------|---------|
| Python 快速原型 | `rank_bm25`（纯 Python，API 简洁） |
| 生产搜索服务 | Elasticsearch / OpenSearch（Lucene BM25） |
| RAG 向量库内置 | LlamaIndex `BM25Retriever`、LangChain `BM25Retriever` |
| 高性能离线检索 | PyTerrier / Anserini（基于 Lucene，支持 WAND 优化） |
| 混合检索 | Weaviate / Qdrant 内置 hybrid search，自动合并 BM25 + 向量 |

```python
# rank_bm25 最简用法
from rank_bm25 import BM25Okapi

corpus = [
    "苹果手机 价格 评测".split(),
    "苹果 公司 股价 上涨".split(),
    "华为 手机 性价比".split(),
]

bm25 = BM25Okapi(corpus)
query = "苹果 手机".split()
scores = bm25.get_scores(query)
# [0.93, 0.41, 0.0]  → 第一篇文档最相关
```

---

## 十、小结

BM25 的设计哲学是**用最少的假设解决最核心的问题**：

1. 词频有用，但边际递减（`k1` 饱和）
2. 词在文档中的密度比绝对次数更重要（`b` 归一化）
3. 词的区分能力由语料统计决定（IDF）

这三条原则在 30 年后的今天依然成立。BM25 没有被向量搜索取代，而是成为混合检索的标配基础组件。理解 BM25，是理解现代搜索和 RAG 系统「第一层基础」的必要前提。

---

## 参考资料

1. Robertson, S. E., & Sparck Jones, K. (1976). Relevance weighting of search terms. *JASIS*.
2. Robertson, S., & Zaragoza, H. (2009). The Probabilistic Relevance Framework: BM25 and Beyond. *FnTIR*.
3. Lv, Y., & Zhai, C. (2011). Lower-bounding term frequency normalization. *CIKM*. [BM25+]
4. Robertson, S., Zaragoza, H., & Taylor, M. (2004). Simple BM25 extension to multiple weighted fields. *CIKM*. [BM25F]
5. Elasticsearch 官方文档：Similarity algorithms. [BM25 配置参考]
6. Ma, X. et al. (2021). A Replication Study of Dense Passage Retrieval. *arXiv*. [BM25 vs 向量检索对比]
