// Код для n8n Code-узла ("Правила: найти подозрительные предложения")
// Язык: JavaScript, режим "Run Once for All Items"
// Вход: один item с binary-файлом .cha (или json.chaText — сырой текст файла)
// Выход: один item со всеми предложениями + списком подозрений на каждое
//
// Это прямой перенос протестированной логики из prototype/cha_parser.py
// (проверено на 576 файлах реального корпуса, 156k предложений, без ошибок парсинга).

const CASES = new Set(["Nom", "Gen", "Acc", "Dat", "Ins", "Loc", "Voc"]);
const GENDERS = new Set(["Masc", "Fem", "Neut"]);
const NUMBERS = new Set(["Sing", "Plur"]);
const NUM_PERSON_COMBO = /^[SP][123]$/;
const BARE_NUMBER = /^[SP]$/;
const QUANT_2_4 = new Set(["два", "две", "три", "четыре", "двадцать два", "двадцать две", "двадцать три", "двадцать четыре"]);
const INTERROGATIVE_RELATIVE_PRON = new Set(["что", "кто", "какой", "чей", "сколько", "который"]);
const NOM_ACC_DISTINCT_PRON = new Set(["ты", "он", "она", "я", "мы", "вы", "они", "кто", "который"]);
const ANIMACY = new Set(["Anim", "Inan"]);

// ВКЛЮЧАЕТ правило "noun_missing_animacy" (обогащение разметки — не ошибка, а задача
// "определи и добавь одушевлённость"). Одушевлённость сейчас проставлена лишь у ~2.5%
// существительных корпуса даже в проверенных файлах — включение резко увеличивает
// число подозрительных предложений (~x3 по объёму). Включено по решению автора проекта.
const ENRICH_ANIMACY = true;

// --- эмпирические списки допустимых тегов (посчитаны по всему корпусу, 576 файлов) ---
// см. docs/tag_frequency.txt. Порог включения: частота >= 50 (%gra) / >= 20 (%mor pos),
// плюс вручную добавлены редкие, но настоящие теги UD (DEP, COMPOUND, GOESWITH и их
// альтернативная нотация через ":" вместо "-").
const GRA_TAG_WHITELIST = new Set([
  "PUNCT", "ROOT", "NSUBJ", "ADVMOD", "CONJ", "DISCOURSE", "OBJ", "CASE", "CC",
  "OBL", "PARATAXIS", "DET", "AMOD", "VOCATIVE", "XCOMP", "IOBJ", "MARK", "CCOMP",
  "NMOD", "FLAT", "AUX", "CSUBJ", "FIXED", "APPOS", "COP", "NUMMOD-GOV", "ADVCL",
  "EXPL", "NUMMOD", "ORPHAN", "FLAT-NAME", "ACL-RELCL", "NSUBJ-PASS", "FLAT-FOREIGN",
  "INTJ", "REPARANDUM", "ACL", "NUMMOD-ENTITY", "DISLOCATED", "OBL-TMOD", "DEP",
  "COMPOUND",
  "DET-NUMGOV", "FLAT:FOREIGN", "NSUBJ:PASS", "AUX-PASS", "AUX:PASS", "OBL-FLOAT",
  "OBL:FLOAT", "GOESWITH", "NUMMOD:GOV", "FLAT:NAME", "ACL:RELCL", "CONJ-PASS",
]);
const MOR_POS_WHITELIST = new Set([
  "noun", "verb", "intj", "pron", "cm", "adv", "part", "adp", "cconj", "adj",
  "propn", "det", "num", "x", "sconj", "aux", "let", "o", "punct", "sym", "seng",
  "hyph", "c", "si", "sita",
]);

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a || !b) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = curr;
  }
  return prev[b.length];
}

function closestWhitelistMatch(tag, whitelist, maxDistance = 2) {
  let best = null;
  let bestDist = maxDistance + 1;
  for (const w of whitelist) {
    const d = levenshtein(tag, w);
    if (d < bestDist) {
      best = w;
      bestDist = d;
    }
  }
  return bestDist <= maxDistance ? best : null;
}

function splitMorToken(token) {
  if (!token.includes("|")) return null; // голая пунктуация: '.', '!', '?'
  const idx = token.indexOf("|");
  const pos = token.slice(0, idx);
  const rest = token.slice(idx + 1);
  const parts = rest.split("-");
  return { pos, lemma: parts[0], cats: parts.slice(1), raw: token };
}

function parseCha(text) {
  const lines = text.split(/\r?\n/);
  const utterances = [];
  let current = null;
  let currentTier = null;
  let seenFirst = false;
  const headerLines = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    if (line.startsWith("*")) {
      seenFirst = true;
      const m = line.match(/^\*([A-Z0-9_]+):\t?(.*)$/);
      current = {
        speaker: m ? m[1] : "UNK",
        textLine: line,
        lineIdx: idx,
        textLineIndices: [idx],
        morRaw: "",
        morUsedSpace: false,
        morLineIndices: [],
        graRaw: "",
        graUsedSpace: false,
        graLineIndices: [],
      };
      utterances.push(current);
      currentTier = null;
      continue;
    }

    if (!seenFirst) {
      headerLines.push(line);
      continue;
    }

    if (/^%mor:[ \t]/.test(line) || line === "%mor:") {
      const usedSpace = line.startsWith("%mor: ") && !line.startsWith("%mor:\t");
      current.morRaw = line.slice(5).replace(/^[ \t]+/, "");
      current.morUsedSpace = usedSpace;
      current.morLineIndices = [idx];
      currentTier = "mor";
      continue;
    }

    if (/^%gra:[ \t]/.test(line) || line === "%gra:") {
      const usedSpace = line.startsWith("%gra: ") && !line.startsWith("%gra:\t");
      current.graRaw = line.slice(5).replace(/^[ \t]+/, "");
      current.graUsedSpace = usedSpace;
      current.graLineIndices = [idx];
      currentTier = "gra";
      continue;
    }

    if (line.startsWith("%")) {
      currentTier = "other";
      continue;
    }

    if (line.startsWith("\t") || (line.trim() === "" && currentTier)) {
      // строка-продолжение предыдущего тира (реплика/mor/gra переносятся на несколько
      // строк). Если ещё не видели %mor:/%gra: для этой реплики (currentTier === null) —
      // значит это продолжение самой реплики (текста), а не тира.
      const content = line.trim();
      if (!current) { headerLines.push(line); continue; }
      if (currentTier === "mor") {
        current.morRaw = (current.morRaw + " " + content).trim();
        current.morLineIndices.push(idx);
      } else if (currentTier === "gra") {
        current.graRaw = (current.graRaw + " " + content).trim();
        current.graLineIndices.push(idx);
      } else if (currentTier === null) {
        current.textLine = (current.textLine + " " + content).trim();
        current.textLineIndices.push(idx);
      }
      continue;
    }

    if (!current) headerLines.push(line);
  }

  return { headerLines, utterances };
}

function checkUtterance(u) {
  const issues = [];
  if (u.morUsedSpace) issues.push({ rule: "tab_vs_space", tier: "%mor", detail: "После %mor: стоит пробел вместо таба" });
  if (u.graUsedSpace) issues.push({ rule: "tab_vs_space", tier: "%gra", detail: "После %gra: стоит пробел вместо таба" });

  const morTokens = u.morRaw ? u.morRaw.split(/\s+/).filter(Boolean) : [];
  const graTokens = u.graRaw ? u.graRaw.split(/\s+/).filter(Boolean) : [];

  if (morTokens.length && graTokens.length && morTokens.length !== graTokens.length) {
    issues.push({ rule: "token_count_mismatch", detail: `Число токенов %mor (${morTokens.length}) != число токенов %gra (${graTokens.length})` });
  }

  const parsedMor = morTokens.map(splitMorToken);
  const graWordRole = new Map(); // wordNo -> [head, TAG] — для кросс-проверок с %mor ниже

  if (morTokens.length || graTokens.length) {
    if (graTokens.length) {
      let rootCount = 0, rootHeadOk = true;
      for (const tok of graTokens) {
        const m = tok.match(/^(\d+)\|(\d+|-)\|([A-Za-z:_]+)$/);
        if (!m) continue;
        const [, num, head, tag] = m;
        const upperTag = tag.toUpperCase();
        graWordRole.set(Number(num), [head, upperTag]);
        if (upperTag === "ROOT") {
          rootCount++;
          if (head !== "0") rootHeadOk = false;
        } else if (!GRA_TAG_WHITELIST.has(upperTag)) {
          const suggestion = closestWhitelistMatch(upperTag, GRA_TAG_WHITELIST);
          if (suggestion) {
            issues.push({ rule: "gra_tag_typo", wordNo: Number(num), detail: `Синтаксический тег '${tag}' похож на опечатку — возможно, имелся в виду '${suggestion}'` });
          }
        }
      }
      if (rootCount === 0) issues.push({ rule: "no_root", detail: "В предложении не найден узел ROOT" });
      else if (rootCount > 1) issues.push({ rule: "multiple_root", detail: `В предложении ${rootCount} узлов ROOT (должен быть один)` });
      if (rootCount >= 1 && !rootHeadOk) issues.push({ rule: "root_head_not_zero", detail: "Вершина ROOT не равна 0 (возможно, использован '-' вместо '0')" });
    }
  }

  parsedMor.forEach((tok, i) => {
    if (!tok) return;
    const { pos, cats, lemma } = tok;
    const wordNo = i + 1;

    if (!MOR_POS_WHITELIST.has(pos)) {
      const suggestion = closestWhitelistMatch(pos, MOR_POS_WHITELIST);
      if (suggestion) {
        issues.push({ rule: "mor_pos_typo", wordNo, detail: `Часть речи '${pos}' похожа на опечатку — возможно, имелось в виду '${suggestion}'` });
      }
    }

    if (pos === "noun" || pos === "propn") {
      const hasGender = cats.some((c) => GENDERS.has(c));
      const hasNumber = cats.some((c) => NUMBERS.has(c));
      const hasCase = cats.some((c) => CASES.has(c));
      if (!(hasGender && hasNumber && hasCase)) {
        const missing = [];
        if (!hasGender) missing.push("род");
        if (!hasNumber) missing.push("число");
        if (!hasCase) missing.push("падеж");
        issues.push({ rule: "noun_missing_category", wordNo, detail: `У существительного/имени '${lemma}' не указано: ${missing.join(", ")}` });
      }

      // порядок категорий: род-число-падеж(-одушевлённость). Проверено на всём корпусе —
      // доминирующий порядок (63827 из ~70000 существительных). Неизвестные сегменты
      // (например часть дефисной леммы: "чунга-чанга") игнорируем — важен только
      // относительный порядок известных категорий.
      const RANK = { G: 0, N: 1, C: 2, A: 3 };
      const orderSeen = [];
      for (const c of cats) {
        if (GENDERS.has(c)) orderSeen.push("G");
        else if (NUMBERS.has(c)) orderSeen.push("N");
        else if (CASES.has(c)) orderSeen.push("C");
        else if (ANIMACY.has(c)) orderSeen.push("A");
      }
      const sortedOrder = [...orderSeen].sort((a, b) => RANK[a] - RANK[b]);
      if (orderSeen.join("") !== sortedOrder.join("")) {
        issues.push({ rule: "noun_category_order", wordNo, detail: `У существительного/имени '${lemma}' категории идут не в стандартном порядке род-число-падеж(-одушевлённость), сейчас: ${orderSeen.join("-")}` });
      }
    }

    if (pos === "det") {
      const hasCase = cats.some((c) => CASES.has(c));
      if (!hasCase) {
        issues.push({ rule: "det_missing_case", wordNo, detail: `У местоименного прилагательного '${lemma}' не указан падеж (по FAQ — нужен)` });
      }
    }

    if (ENRICH_ANIMACY && (pos === "noun" || pos === "propn")) {
      const hasAnimacy = cats.some((c) => ANIMACY.has(c));
      if (!hasAnimacy) {
        issues.push({ rule: "noun_missing_animacy", wordNo, detail: `У существительного/имени '${lemma}' не указана одушевлённость (Anim/Inan) — задача обогащения разметки, не ошибка` });
      }
    }

    const role = (graWordRole.get(wordNo) || [null, null])[1];

    // кросс-проверка с %gra: слово с ролью VOCATIVE должно стоять в Voc, а не Nom
    if ((pos === "noun" || pos === "propn") && role === "VOCATIVE") {
      if (cats.includes("Nom") && !cats.includes("Voc")) {
        issues.push({ rule: "vocative_should_be_voc", wordNo, detail: `'${lemma}' — обращение (VOCATIVE), но падеж Nom вместо Voc` });
      }
    }

    // кросс-проверка роль/падеж — только там, где Nom и Acc гарантированно различаются
    // по форме: личные местоимения, сущ. женского рода (Nom!=Acc всегда), одушевлённые
    // (Anim: Acc=Gen, отличается от Nom). У среднего рода и неодушевлённых (Inan) —
    // Nom==Acc по форме, это норма (падежный синкретизм), проверка там даёт ложные
    // срабатывания (см. docs/plan.md). Если Anim/Inan не проставлена — полагаемся на род.
    const caseReliable =
      (pos === "pron" && NOM_ACC_DISTINCT_PRON.has(lemma)) ||
      (["noun", "propn"].includes(pos) && cats.includes("Fem")) ||
      (["noun", "propn"].includes(pos) && cats.includes("Anim"));
    if (["noun", "propn", "pron"].includes(pos) && caseReliable) {
      if (role === "NSUBJ" && cats.includes("Acc")) {
        issues.push({ rule: "case_role_mismatch", wordNo, detail: `'${lemma}' — подлежащее (NSUBJ), но падеж Acc вместо Nom` });
      }
      if (role === "OBJ" && cats.includes("Nom")) {
        issues.push({ rule: "case_role_mismatch", wordNo, detail: `'${lemma}' — прямое дополнение (OBJ), но падеж Nom (обычно должен быть Acc/Gen)` });
      }
    }

    if (pos === "verb") {
      if (cats.includes("Inf")) {
        if (cats.some((c) => BARE_NUMBER.test(c) || NUM_PERSON_COMBO.test(c))) {
          issues.push({ rule: "infinitive_with_number", wordNo, detail: `У инфинитива '${lemma}' указано число/лицо (не должно быть)` });
        }
      }
      if (cats.includes("Past")) {
        const hasGender = cats.some((c) => GENDERS.has(c));
        const isPlural = cats.includes("P") || cats.includes("Plur");
        if (!hasGender && !isPlural) {
          issues.push({ rule: "past_missing_gender", wordNo, detail: `У глагола прош. времени '${lemma}' не указан род (и форма не мн. числа)` });
        }
      }
      if (cats.includes("Ind") && !cats.some((c) => ["Pres", "Fut", "Past"].includes(c))) {
        issues.push({ rule: "verb_missing_tense", wordNo, detail: `У глагола '${lemma}' в изъявительном наклонении (Ind) не указано время (Pres/Fut/Past)` });
      }
    }

    if (pos === "pron" && INTERROGATIVE_RELATIVE_PRON.has(lemma)) {
      if (cats.some((c) => NUM_PERSON_COMBO.test(c) || BARE_NUMBER.test(c))) {
        issues.push({ rule: "interrogative_pronoun_has_number_person", wordNo, detail: `У вопросительного/относительного местоимения '${lemma}' указаны число/лицо (по FAQ — убрать)` });
      }
    }
  });

  for (let i = 0; i < parsedMor.length; i++) {
    const tok = parsedMor[i];
    if (!tok) continue;
    if (QUANT_2_4.has(tok.lemma)) {
      const nxt = parsedMor[i + 1];
      if (nxt && (nxt.pos === "noun" || nxt.pos === "propn")) {
        if (nxt.cats.includes("Plur") && nxt.cats.includes("Nom")) {
          issues.push({ rule: "numeral_2_4_agreement", wordNo: i + 2, detail: `После числительного '${tok.lemma}' у '${nxt.lemma}' стоит Plur-Nom вместо Sing-Gen` });
        }
      }
    }
  }

  return issues;
}

// --- n8n entry point ---
const items = $input.all();
const results = [];

for (let idx = 0; idx < items.length; idx++) {
  const item = items[idx];
  let chaText = item.json.chaText || "";
  if (!chaText && item.binary && item.binary.data) {
    // Правильный способ достать содержимое бинарного файла в Code-узле —
    // через this.helpers.getBinaryDataBuffer, а не читать item.binary.data.data
    // напрямую: в современных версиях n8n бинарные данные могут храниться не
    // инлайн, а на диске/в отдельном хранилище, и .data может отсутствовать.
    const buffer = await this.helpers.getBinaryDataBuffer(idx, "data");
    chaText = buffer.toString("utf-8");
  }
  const { headerLines, utterances } = parseCha(chaText);

  const flagged = [];
  utterances.forEach((u, idx) => {
    const issues = checkUtterance(u);
    if (issues.length) {
      flagged.push({
        utteranceIdx: idx,
        line: u.lineIdx + 1,
        speaker: u.speaker,
        textLine: u.textLine,
        textLineIndices: u.textLineIndices,
        morRaw: u.morRaw,
        graRaw: u.graRaw,
        morLineIndices: u.morLineIndices,
        graLineIndices: u.graLineIndices,
        issues,
      });
    }
  });

  results.push({
    json: {
      fileName: item.json.fileName || (item.binary && item.binary.data && item.binary.data.fileName) || "unknown.cha",
      chaText,
      totalUtterances: utterances.length,
      flaggedCount: flagged.length,
      flagged,
    },
  });
}

return results;
