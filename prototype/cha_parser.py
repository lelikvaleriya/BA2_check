"""
Парсер .cha файлов (формат CHILDES/CHAT) и детерминированные проверки
морфологической (%mor) и синтаксической (%gra) разметки.

Логика здесь — прототип для локального тестирования. Финальная версия
переносится в JS Code-узлы n8n (без внешних зависимостей, поэтому весь
код ниже сознательно не использует сторонние библиотеки).
"""
import re
from dataclasses import dataclass, field


CASES = {"Nom", "Gen", "Acc", "Dat", "Ins", "Loc", "Voc"}
GENDERS = {"Masc", "Fem", "Neut"}
NUMBERS = {"Sing", "Plur"}
NUM_PERSON_COMBO = re.compile(r"^[SP][123]$")  # напр. S2, P1
BARE_NUMBER = re.compile(r"^[SP]$")  # напр. S, P (без лица) — некорректно для финитных форм

# числительные 2-4 (и составные, оканчивающиеся на них), после которых
# существительное должно стоять в Sing-Gen, а не Plur-Nom
QUANT_2_4 = {
    "два", "две", "три", "четыре",
    "двадцать два", "двадцать две", "двадцать три", "двадцать четыре",
}

INTERROGATIVE_RELATIVE_PRON = {"что", "кто", "какой", "чей", "сколько", "который"}
ANIMACY = {"Anim", "Inan"}

# ВКЛЮЧАЕТ/ВЫКЛЮЧАЕТ правило "noun_missing_animacy" — сейчас одушевлённость проставлена
# только у ~2.5% существительных даже в уже проверенных файлах (см. docs/plan.md).
# Включение резко увеличивает число подозрительных предложений (почти каждое с
# существительным) — это уже не "точечная проверка", а "обогащение разметки".
# По умолчанию выключено, чтобы не увеличивать объём/стоимость обработки без явного решения.
ENRICH_ANIMACY = True

# --- эмпирические списки допустимых тегов (посчитаны по всему корпусу, 576 файлов) ---
# см. docs/tag_frequency.txt — частоты всех реально встречающихся тегов %gra и pos %mor.
# Порог включения — частота >= 50 (для %gra) / >= 20 (для %mor pos), плюс вручную
# добавлены редкие, но настоящие теги UD (DEP, COMPOUND, GOESWITH и т.п. и их
# альтернативные написания через ":" вместо "-").
GRA_TAG_WHITELIST = {
    "PUNCT", "ROOT", "NSUBJ", "ADVMOD", "CONJ", "DISCOURSE", "OBJ", "CASE", "CC",
    "OBL", "PARATAXIS", "DET", "AMOD", "VOCATIVE", "XCOMP", "IOBJ", "MARK", "CCOMP",
    "NMOD", "FLAT", "AUX", "CSUBJ", "FIXED", "APPOS", "COP", "NUMMOD-GOV", "ADVCL",
    "EXPL", "NUMMOD", "ORPHAN", "FLAT-NAME", "ACL-RELCL", "NSUBJ-PASS", "FLAT-FOREIGN",
    "INTJ", "REPARANDUM", "ACL", "NUMMOD-ENTITY", "DISLOCATED", "OBL-TMOD", "DEP",
    "COMPOUND",
    # редкие, но настоящие (в т.ч. альтернативная нотация через ":")
    "DET-NUMGOV", "FLAT:FOREIGN", "NSUBJ:PASS", "AUX-PASS", "AUX:PASS", "OBL-FLOAT",
    "OBL:FLOAT", "GOESWITH", "NUMMOD:GOV", "FLAT:NAME", "ACL:RELCL", "CONJ-PASS",
}
MOR_POS_WHITELIST = {
    "noun", "verb", "intj", "pron", "cm", "adv", "part", "adp", "cconj", "adj",
    "propn", "det", "num", "x", "sconj", "aux", "let", "o", "punct", "sym", "seng",
    "hyph", "c", "si", "sita",
}


def levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    if not a or not b:
        return max(len(a), len(b))
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            cost = 0 if ca == cb else 1
            curr[j] = min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
        prev = curr
    return prev[-1]


def closest_whitelist_match(tag: str, whitelist, max_distance=2):
    """Возвращает ближайший тег из whitelist, если расстояние Левенштейна <= max_distance."""
    best, best_dist = None, max_distance + 1
    for w in whitelist:
        d = levenshtein(tag, w)
        if d < best_dist:
            best, best_dist = w, d
    return best if best_dist <= max_distance else None


@dataclass
class Utterance:
    speaker: str
    text_line: str  # исходная строка *SPK:	... (может дополняться строками-продолжениями)
    text_line_idx: int  # номер строки в файле (для отчёта)
    text_line_indices: list = field(default_factory=list)  # все физ. строки реплики (для замены при правке опечаток)
    mor_raw: str = ""
    mor_line_idx: int = -1
    mor_used_space: bool = False
    gra_raw: str = ""
    gra_line_idx: int = -1
    gra_used_space: bool = False
    other_tiers: list = field(default_factory=list)  # (label, text) прочие тиры, не трогаем

    @property
    def mor_tokens(self):
        return self.mor_raw.split() if self.mor_raw else []

    @property
    def gra_tokens(self):
        return self.gra_raw.split() if self.gra_raw else []


def parse_cha(text: str):
    """Разбивает .cha на список Utterance + сохраняет "шапку" файла отдельно."""
    lines = text.splitlines()
    header_lines = []
    utterances = []
    current = None
    current_tier_label = None  # 'mor' | 'gra' | 'other' — куда докручивать continuation-строки
    seen_first_utterance = False

    for idx, line in enumerate(lines):
        if line.startswith("*"):
            seen_first_utterance = True
            m = re.match(r"^\*([A-Z0-9_]+):\t?(.*)$", line)
            speaker = m.group(1) if m else "UNK"
            current = Utterance(speaker=speaker, text_line=line, text_line_idx=idx, text_line_indices=[idx])
            utterances.append(current)
            current_tier_label = None
            continue

        if not seen_first_utterance:
            header_lines.append(line)
            continue

        if line.startswith("%mor:") or line.startswith("%mor: ") or re.match(r"^%mor:[ \t]", line):
            used_space = line.startswith("%mor: ") and not line.startswith("%mor:\t")
            content = line[len("%mor:"):].lstrip(" \t")
            current.mor_raw = content
            current.mor_line_idx = idx
            current.mor_used_space = used_space
            current_tier_label = "mor"
            continue

        if line.startswith("%gra:") or re.match(r"^%gra:[ \t]", line):
            used_space = line.startswith("%gra: ") and not line.startswith("%gra:\t")
            content = line[len("%gra:"):].lstrip(" \t")
            current.gra_raw = content
            current.gra_line_idx = idx
            current.gra_used_space = used_space
            current_tier_label = "gra"
            continue

        if line.startswith("%"):
            # прочий тир (%com, %err, ...) — сохраняем как есть, не парсим
            label_match = re.match(r"^%([a-zA-Z0-9]+):\s*(.*)$", line)
            if current is not None:
                current.other_tiers.append((line, idx))
            current_tier_label = "other"
            continue

        if line.startswith("\t") or (line.strip() == "" and current_tier_label is not None):
            # строка-продолжение предыдущего тира (реплика/mor/gra переносятся на
            # несколько строк). Если ещё не видели %mor:/%gra: для этой реплики —
            # значит это продолжение самой реплики (текста), а не тира.
            content = line.strip()
            if current is None:
                header_lines.append(line)
                continue
            if current_tier_label == "mor":
                current.mor_raw = (current.mor_raw + " " + content).strip()
            elif current_tier_label == "gra":
                current.gra_raw = (current.gra_raw + " " + content).strip()
            elif current_tier_label is None:
                current.text_line = (current.text_line + " " + content).strip()
                current.text_line_indices.append(idx)
            continue

        # строки @End и прочие заголовочные/служебные после начала транскрипта
        if current is None:
            header_lines.append(line)
        else:
            current.other_tiers.append((line, idx))

    return header_lines, utterances


def split_mor_token(token: str):
    """
    'noun|собака-Masc-Nom' -> pos='noun', lemma='собака', cats=['Masc','Nom']
    Категории — сегменты после леммы, начинающиеся с заглавной латинской буквы.
    Пунктуация (cm|cm, ! ? . и т.п.) обрабатывается отдельно вызывающим кодом.
    """
    if "|" not in token:
        return None  # знак пунктуации без POS (голый '.', '!', '?')
    pos, rest = token.split("|", 1)
    parts = rest.split("-")
    lemma = parts[0]
    cats = parts[1:]
    return {"pos": pos, "lemma": lemma, "cats": cats, "raw": token}


def check_utterance(u: Utterance, index_in_file: int):
    """Возвращает список найденных проблем (dict: rule, detail, severity)."""
    issues = []

    if u.mor_used_space:
        issues.append({"rule": "tab_vs_space", "tier": "%mor",
                        "detail": "После %mor: стоит пробел вместо таба"})
    if u.gra_used_space:
        issues.append({"rule": "tab_vs_space", "tier": "%gra",
                        "detail": "После %gra: стоит пробел вместо таба"})

    mor_tokens_raw = u.mor_tokens
    gra_tokens_raw = u.gra_tokens

    if len(mor_tokens_raw) != len(gra_tokens_raw) and mor_tokens_raw and gra_tokens_raw:
        issues.append({
            "rule": "token_count_mismatch",
            "detail": f"Число токенов %mor ({len(mor_tokens_raw)}) != число токенов %gra ({len(gra_tokens_raw)})",
        })

    parsed_mor = [split_mor_token(t) for t in mor_tokens_raw]

    # --- проверка %gra: ровно один ROOT, вершина ROOT == 0, теги из белого списка ---
    # утеранс без разметки (www/xxx/yyy — неразборчивая/нерасшифрованная речь по CHAT)
    # пропускаем: для них %mor/%gra отсутствуют по конвенции, это не ошибка
    has_annotation = bool(mor_tokens_raw) or bool(gra_tokens_raw)
    gra_word_role = {}  # word_no -> (head, tag) — для кросс-проверок с %mor ниже
    if has_annotation and gra_tokens_raw:
        root_count = 0
        root_head_ok = True
        for tok in gra_tokens_raw:
            m = re.match(r"^(\d+)\|(\d+|-)\|([A-Za-z:_]+)$", tok)
            if not m:
                continue
            num, head, tag = m.groups()
            gra_word_role[int(num)] = (head, tag.upper())
            if tag.upper() == "ROOT":
                root_count += 1
                if head != "0":
                    root_head_ok = False
            elif tag.upper() not in GRA_TAG_WHITELIST:
                suggestion = closest_whitelist_match(tag.upper(), GRA_TAG_WHITELIST)
                if suggestion:
                    issues.append({
                        "rule": "gra_tag_typo", "word_no": int(num),
                        "detail": f"Синтаксический тег '{tag}' похож на опечатку — возможно, имелся в виду '{suggestion}'",
                    })
        if root_count == 0:
            issues.append({"rule": "no_root", "detail": "В предложении не найден узел ROOT"})
        elif root_count > 1:
            issues.append({"rule": "multiple_root",
                            "detail": f"В предложении {root_count} узлов ROOT (должен быть один)"})
        if root_count >= 1 and not root_head_ok:
            issues.append({"rule": "root_head_not_zero",
                            "detail": "Вершина ROOT не равна 0 (возможно, использован '-' вместо '0')"})

    # --- морфологические проверки по каждому слову ---
    for i, tok in enumerate(parsed_mor):
        if tok is None:
            continue
        pos, cats = tok["pos"], tok["cats"]
        word_no = i + 1

        if pos not in MOR_POS_WHITELIST:
            suggestion = closest_whitelist_match(pos, MOR_POS_WHITELIST, max_distance=2)
            if suggestion:
                issues.append({
                    "rule": "mor_pos_typo", "word_no": word_no,
                    "detail": f"Часть речи '{pos}' похожа на опечатку — возможно, имелось в виду '{suggestion}'",
                })

        if pos == "det":
            has_case = any(c in CASES for c in cats)
            if not has_case:
                issues.append({
                    "rule": "det_missing_case", "word_no": word_no,
                    "detail": f"У местоименного прилагательного '{tok['lemma']}' не указан падеж (по FAQ — нужен)",
                })

        if ENRICH_ANIMACY and pos in ("noun", "propn"):
            has_animacy = any(c in ANIMACY for c in cats)
            if not has_animacy:
                issues.append({
                    "rule": "noun_missing_animacy", "word_no": word_no,
                    "detail": f"У существительного/имени '{tok['lemma']}' не указана одушевлённость (Anim/Inan) — задача обогащения разметки, не ошибка",
                })

        # кросс-проверка с %gra: слово с ролью VOCATIVE должно стоять в Voc, а не Nom
        if pos in ("noun", "propn") and gra_word_role.get(word_no, (None, None))[1] == "VOCATIVE":
            if "Nom" in cats and "Voc" not in cats:
                issues.append({
                    "rule": "vocative_should_be_voc", "word_no": word_no,
                    "detail": f"'{tok['lemma']}' — обращение (VOCATIVE), но падеж Nom вместо Voc",
                })

        # кросс-проверка с %gra: явно неправильное сочетание синтаксической роли и падежа.
        # Флагуем ТОЛЬКО там, где Nom и Acc гарантированно различаются по форме:
        # у личных/некоторых местоимений, у существительных женского рода (Nom!=Acc всегда),
        # и у одушевлённых (Anim: Acc=Gen, отличается от Nom). У среднего рода и у
        # НЕодушевлённых (Inan) — Nom==Acc по форме, это норма (падежный синкретизм),
        # проверка там даёт ложные срабатывания (проверено на корпусе). Если Anim/Inan
        # не проставлена (как в большинстве случаев сейчас) — полагаемся на род.
        role = gra_word_role.get(word_no, (None, None))[1]
        NOM_ACC_DISTINCT_PRON = {"ты", "он", "она", "я", "мы", "вы", "они", "кто", "который"}
        case_reliable = (
            (pos == "pron" and tok["lemma"] in NOM_ACC_DISTINCT_PRON)
            or (pos in ("noun", "propn") and "Fem" in cats)
            or (pos in ("noun", "propn") and "Anim" in cats)
        )
        if pos in ("noun", "propn", "pron") and case_reliable:
            if role == "NSUBJ" and "Acc" in cats:
                issues.append({
                    "rule": "case_role_mismatch", "word_no": word_no,
                    "detail": f"'{tok['lemma']}' — подлежащее (NSUBJ), но падеж Acc вместо Nom",
                })
            if role == "OBJ" and "Nom" in cats:
                issues.append({
                    "rule": "case_role_mismatch", "word_no": word_no,
                    "detail": f"'{tok['lemma']}' — прямое дополнение (OBJ), но падеж Nom (обычно должен быть Acc/Gen)",
                })

        if pos in ("noun", "propn"):
            has_gender = any(c in GENDERS for c in cats)
            has_number = any(c in NUMBERS for c in cats)
            has_case = any(c in CASES for c in cats)
            if not (has_gender and has_number and has_case):
                missing = []
                if not has_gender:
                    missing.append("род")
                if not has_number:
                    missing.append("число")
                if not has_case:
                    missing.append("падеж")
                issues.append({
                    "rule": "noun_missing_category", "word_no": word_no,
                    "detail": f"У существительного/имени '{tok['lemma']}' не указано: {', '.join(missing)}",
                })

            # порядок категорий: род-число-падеж(-одушевлённость). Проверено на всём
            # корпусе — это доминирующий порядок (63827 из ~70000 существительных).
            # Неизвестные сегменты (например часть дефисной леммы: "чунга-чанга")
            # игнорируем — важен только относительный порядок известных категорий.
            rank = {"G": 0, "N": 1, "C": 2, "A": 3}
            order_seen = []
            for c in cats:
                if c in GENDERS:
                    order_seen.append("G")
                elif c in NUMBERS:
                    order_seen.append("N")
                elif c in CASES:
                    order_seen.append("C")
                elif c in ANIMACY:
                    order_seen.append("A")
            if order_seen != sorted(order_seen, key=lambda x: rank[x]):
                issues.append({
                    "rule": "noun_category_order", "word_no": word_no,
                    "detail": f"У существительного/имени '{tok['lemma']}' категории идут не в стандартном порядке "
                              f"род-число-падеж(-одушевлённость), сейчас: {'-'.join(order_seen)}",
                })

        if pos == "verb":
            if "Inf" in cats:
                if any(BARE_NUMBER.match(c) or NUM_PERSON_COMBO.match(c) for c in cats):
                    issues.append({
                        "rule": "infinitive_with_number", "word_no": word_no,
                        "detail": f"У инфинитива '{tok['lemma']}' указано число/лицо (не должно быть)",
                    })
            if "Past" in cats:
                # у глаголов число обозначается голыми S/P (не Sing/Plur, как у существительных)
                has_gender = any(c in GENDERS for c in cats)
                is_plural = "P" in cats or "Plur" in cats
                if not has_gender and not is_plural:
                    issues.append({
                        "rule": "past_missing_gender", "word_no": word_no,
                        "detail": f"У глагола прош. времени '{tok['lemma']}' не указан род (и форма не мн. числа)",
                    })

            # "Ind" однозначно обозначает изъявительное наклонение (не встречается как
            # обозначение вида) — для него обязательно должно быть время Pres/Fut/Past
            if "Ind" in cats and not any(c in ("Pres", "Fut", "Past") for c in cats):
                issues.append({
                    "rule": "verb_missing_tense", "word_no": word_no,
                    "detail": f"У глагола '{tok['lemma']}' в изъявительном наклонении (Ind) не указано время (Pres/Fut/Past)",
                })

        if pos == "pron" and tok["lemma"] in INTERROGATIVE_RELATIVE_PRON:
            has_number_person = any(NUM_PERSON_COMBO.match(c) or BARE_NUMBER.match(c) for c in cats)
            if has_number_person:
                issues.append({
                    "rule": "interrogative_pronoun_has_number_person", "word_no": word_no,
                    "detail": f"У вопросительного/относительного местоимения '{tok['lemma']}' указаны число/лицо (по FAQ — убрать)",
                })

    # --- числительные 2-4: следующее существительное должно быть Sing-Gen ---
    for i, tok in enumerate(parsed_mor):
        if tok is None:
            continue
        if tok["lemma"] in QUANT_2_4 or (tok["pos"] == "num" and tok["lemma"] in {"два", "две", "три", "четыре"}):
            if i + 1 < len(parsed_mor) and parsed_mor[i + 1] and parsed_mor[i + 1]["pos"] in ("noun", "propn"):
                nxt = parsed_mor[i + 1]
                if "Plur" in nxt["cats"] and "Nom" in nxt["cats"]:
                    issues.append({
                        "rule": "numeral_2_4_agreement", "word_no": i + 2,
                        "detail": f"После числительного '{tok['lemma']}' у '{nxt['lemma']}' стоит Plur-Nom вместо Sing-Gen",
                    })

    return issues


def check_file(path: str):
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    header, utterances = parse_cha(text)
    report = []
    for idx, u in enumerate(utterances):
        issues = check_utterance(u, idx)
        if issues:
            report.append({"utterance_idx": idx, "line": u.text_line_idx + 1,
                             "speaker": u.speaker, "text": u.text_line, "issues": issues})
    return header, utterances, report


if __name__ == "__main__":
    import sys
    import json
    path = sys.argv[1]
    header, utterances, report = check_file(path)
    print(f"Файл: {path}")
    print(f"Предложений: {len(utterances)}, предложений с проблемами: {len(report)}")
    for r in report:
        print(f"\n[строка {r['line']}] {r['text']}")
        for issue in r["issues"]:
            print(f"  - ({issue['rule']}) {issue['detail']}")
