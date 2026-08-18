"""
反注水黄金对照集（anti-padding gold set）。

用途
----
给评测系统本身做「单元测试」。每条记录是**同一道题的一对答案**：
  - substantive：真正兑现要点的答案（应当高分）
  - padding    ：话说得漂亮但没有可核验内容的答案（应当低分 + padding_detected=True）

为什么需要它
------------
现有测试只验证「模型说注水了，我们能正确解析」，
但没有验证「注水答案**确实会**被判低分」——后者才是区分效度（discriminant validity）：
一个好的评测系统，不该被表面流畅度带偏。

两类答案在人类看来优劣一目了然。如果评测系统给不出显著分差，
说明它在测「文本流畅度」而不是「工种胜任力」，这是效度失败，必须被 CI 发现。

数据构造原则
------------
1. padding 答案**故意写得更长、更自信、术语更多**——正是要对抗冗长偏差与自信偏差。
2. padding 答案精确踩中该题 probes 声明的注水模式（空口承诺 / 答非所问 / 只给方向）。
3. substantive 答案**不追求文采**，只给可核验的具体内容——避免测成「谁文笔好」。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List


@dataclass(frozen=True)
class GoldPair:
    """同一道题的一对对照答案。"""

    task_id: str
    #: 兑现要点的答案（期望高分、padding_detected=False）
    substantive: str
    #: 注水答案（期望低分、padding_detected=True）
    padding: str
    #: 该注水答案精确踩中的注水模式，用于断言失败时的可读报错
    padding_pattern: str


GOLD_PAIRS: List[GoldPair] = [
    GoldPair(
        task_id="code_csv_merge",
        substantive=(
            "```python\n"
            "import csv\n"
            "from datetime import datetime\n\n"
            "def _to_float(v):\n"
            "    if v is None: return None\n"
            "    s = str(v).strip().replace(',', '').replace('￥', '').replace('¥', '')\n"
            "    if not s: return None\n"
            "    try: return float(s)\n"
            "    except ValueError: return None\n\n"
            "def _load(path):\n"
            "    with open(path, newline='', encoding='utf-8') as f:\n"
            "        return list(csv.DictReader(f))\n\n"
            "def merge_orders(path_a, path_b):\n"
            "    merged = {}\n"
            "    for row in _load(path_a) + _load(path_b):\n"
            "        oid = row['order_id']\n"
            "        row['amount'] = _to_float(row.get('amount'))\n"
            "        prev = merged.get(oid)\n"
            "        if prev is None or row.get('updated_at', '') > prev.get('updated_at', ''):\n"
            "            merged[oid] = row\n"
            "    return list(merged.values())\n"
            "```\n\n"
            "测试用例：\n"
            "1. 空文件：merge_orders('empty.csv','empty.csv') == []\n"
            "2. 单边缺失：A 有 order_id=1、B 无，结果保留 A 的那条\n"
            "3. 脏金额：'1,234.50'→1234.5、'￥88'→88.0、''→None、'abc'→None\n"
            "4. updated_at 较新覆盖较旧：同 order_id 取 updated_at 大的一条"
        ),
        padding=(
            "这个需求我非常熟悉，属于典型的数据清洗与实体归并场景。"
            "我会采用工业级的最佳实践来实现 merge_orders，确保代码具备高内聚低耦合的特性，"
            "并遵循 SOLID 设计原则。在架构层面，我会引入清晰的分层设计理念："
            "数据接入层负责 IO，转换层负责归一化，归并层负责冲突消解。"
            "对于金额字段的解析，我会设计一套健壮的、可扩展的解析策略，"
            "全面覆盖各类边界情况，保证系统的鲁棒性与容错能力。"
            "关于 updated_at 的冲突处理，我会采用业界成熟的方案确保数据一致性。"
            "该实现我已充分测试，覆盖了所有边界条件，测试覆盖率可以达到很高的水平，"
            "可以放心地在生产环境使用。整体方案兼顾了性能与可维护性，"
            "是一个经过深思熟虑的、专业的工程设计。"
        ),
        padding_pattern="题面明确要求「只给代码和测试，不要解释设计理念」，"
                        "该答案通篇务虚讲解且零代码；并声称「已充分测试」但未给任何用例",
    ),
    GoldPair(
        task_id="code_debug_race",
        substantive=(
            "(1) 根因：count += 1 不是原子操作，它是「读-改-写」三步。"
            "多线程下两个线程可能读到同一个旧值，各自加一后写回，导致丢失更新（lost update）。"
            "这与 GIL 无关——GIL 只保证字节码级别的原子性，而 += 会编译成多条字节码。\n\n"
            "(2) 两种修法及代价：\n"
            "  a) threading.Lock 保护自增：正确性最直接，代价是锁竞争，"
            "线程数越多吞吐下降越明显，高频计数时锁会成为瓶颈。\n"
            "  b) 每线程本地计数后归并：worker 内用局部变量累加，结束后一次性加总。"
            "代价是需要额外内存保存每线程中间结果，且归并逻辑增加了代码复杂度，"
            "实时性也变差（过程中读不到准确总数）。\n\n"
            "(3) 稳定复现测试：提高线程数（如 8–32）与每线程循环次数（如 10 万），"
            "放大竞争窗口；断言 count == 线程数 × 每线程有效项数，"
            "重复运行 20 次，只要有一次不等即判定存在竞争。"
        ),
        padding=(
            "这是一个非常经典的并发编程问题，充分体现了多线程环境下系统设计的复杂性，"
            "也是每一位后端工程师在职业生涯中都必然会遇到的经典挑战。"
            "根本原因在于并发环境中的线程安全问题，这是并发编程领域中需要重点关注的核心议题，"
            "涉及内存模型、可见性、有序性等多个层面的深层机制。"
            "解决方案方面，加锁即可解决，这是最直接有效的方案，业界普遍采用，成熟可靠。"
            "另外也可以考虑使用一些并发安全的数据结构，它们在设计之初就充分考虑了线程安全，"
            "能够在高并发场景下提供良好的性能表现与正确性保障。"
            "关于测试，我会编写完善的、覆盖全面的测试用例来严格验证修复效果，"
            "确保在各种复杂并发场景下都能稳定得到正确的结果，充分保证代码质量与系统可靠性。"
            "总的来说，处理好并发问题需要深入理解线程模型与底层实现原理，"
            "我在这方面积累了相当丰富的实战经验，能够游刃有余地应对各类并发难题。"
        ),
        padding_pattern="只说「加锁即可」而不谈代价（题面明确要求两种修法及各自代价）；"
                        "复现测试无任何具体手段",
    ),
    GoldPair(
        task_id="code_api_hardening",
        substantive=(
            "按优先级：\n"
            "1. 路径穿越（最高危）。改动：os.path.realpath 规范化后，"
            "断言结果以白名单根目录为前缀，否则 403；拒绝一切 .. 与绝对路径输入。"
            "验证：用 ?path=../../etc/passwd 与 ?path=/etc/passwd 请求，均应返回 403。\n"
            "2. 鉴权与限流。改动：接口加 Bearer token 校验；按 IP + token 做令牌桶限流。"
            "验证：无 token 请求返回 401；超频请求返回 429。\n"
            "3. 文件类型与大小白名单。改动：仅允许特定扩展名，"
            "读取前 os.stat 检查大小上限，超限返回 413。"
            "验证：请求 .env 或超大文件应被拒。\n"
            "4. 符号链接逃逸。改动：realpath 后再次校验前缀（软链可能指向白名单外）。"
            "验证：在白名单目录内建指向 /etc 的软链，请求应 403。\n"
            "5. 错误信息脱敏。改动：统一返回通用错误文案，不回显真实路径与堆栈。"
            "验证：构造不存在路径，响应体不应包含服务器目录结构。"
        ),
        padding=(
            "接口安全加固是一项复杂的系统工程，需要从架构层面建立完整的纵深防御体系，"
            "而不是简单地打几个补丁就能解决的问题。"
            "首先要做好输入校验，这是安全的第一道防线，任何来自用户侧的输入都绝不可信任，"
            "必须经过严格的合法性检查与清洗才能进入业务逻辑。"
            "其次要完善认证授权机制，确保只有经过身份验证的合法用户才能访问敏感资源，"
            "并遵循权限最小化的基本原则进行精细化管控。"
            "还需要建立完备的日志审计体系，对所有关键操作做到有据可查、可追溯、可回溯。"
            "此外，加密传输、定期安全扫描、依赖漏洞治理、安全基线检查，"
            "也都是保障系统整体安全水位不可或缺的重要环节。"
            "我会严格遵循 OWASP Top 10 的安全规范与业界安全最佳实践，全方位保障接口安全，"
            "打造一个坚不可摧的立体化安全防线，让系统即便暴露在公网环境下也能稳如磐石。"
            "在实施节奏上，我会按照风险等级由高到低推进，优先处理影响面最大的风险项，"
            "并在每一轮加固后进行充分的回归验证，确保加固措施不会影响既有业务的正常运行。"
            "整个过程我会保持与安全团队的紧密协作，共同守护系统的安全底线。"
        ),
        padding_pattern="通篇安全口号，未识别路径穿越这一具体漏洞，"
                        "也未给出任何代码改动要点与验证方法",
    ),
]


def get_pair(task_id: str) -> GoldPair:
    for p in GOLD_PAIRS:
        if p.task_id == task_id:
            return p
    raise KeyError(f"gold set 中无此题：{task_id}")
