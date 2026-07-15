// Код для n8n Code-узла ("LLM: проверить и исправить подозрения")
// Режим: "Run Once for All Items"
// Вход: N items из узла "Правила: найти подозрительные предложения" — по одному на каждый
// .cha файл (при папочном вводе через "Читать файлы .cha" их может быть много).
// Делает по одному запросу к YandexGPT на каждое подозрительное предложение КАЖДОГО файла
// (не на весь файл целиком — дешевле и модель не отвлекается на текст без проблем),
// используя this.helpers.httpRequest — поддерживаемый способ ходить в интернет из Code-узла.
//
// Ключи берутся из узла "Ключи Yandex Cloud (НЕ публиковать в скриншотах!)" — см. BUILD_GUIDE.md.
// Модель — YandexGPT (Yandex Cloud Foundation Models), разрешённая курсом платформа.
// Выход: N items (по одному на файл) с results — массивом исправлений на файл.
// На большой папке это может занять несколько минут — вызовы идут последовательно,
// это нормально, не бага.

const RULE_CONTEXT = {
  infinitive_with_number: `У инфинитива (тег Inf) НЕ должно быть числа и лица. Частая ошибка —
оставлять "S" или "S2" у инфинитива. Правильно: verb|говорить-Inf-Imp (без числа).`,
  past_missing_gender: `Глаголы прошедшего времени (Past) согласуются по роду и числу, а не по лицу.
Если число не множественное (нет отдельного "P"), обязателен род (Masc/Fem/Neut).
Пример: "была" -> verb|быть-Fin-Imp-Ind-Past-Fem-S.`,
  interrogative_pronoun_has_number_person: `У вопросительных и относительных местоимений
(что, кто, какой, чей, сколько, который) число и лицо убираются (по FAQ разметчиков).
pron|что-IntRel-Nom-S1 — ошибка, правильно pron|что-IntRel-Nom.`,
  no_root: `В каждом предложении должен быть ровно один узел ROOT с вершиной 0.`,
  multiple_root: `В предложении должен быть только один ROOT. Если предикатов несколько:
однородные — первый ROOT, остальные CONJ; если один в придаточном — CCOMP/ADVCL.`,
  root_head_not_zero: `Вершина ROOT всегда 0 (например "3|0|ROOT"), а не "-" и не номер слова.
Частая причина — конструкции "давай + глагол": "давай" это AUX, а не ROOT, корень — второй глагол.`,
  noun_missing_category: `У существительных и имён собственных обязательны род, число и падеж.`,
  numeral_2_4_agreement: `После числительных два/две/три/четыре существительное должно
стоять в Sing-Gen, а не в Plur-Nom (частая ошибка — "две буквы" размечено как Plur-Nom).`,
  token_count_mismatch: `Число токенов в %mor должно совпадать с числом токенов в %gra.
Частая причина расхождения — пропущенный пробел между словом и следующим токеном
(например "неплоxоcm|cm" вместо "неплоxо" + отдельный токен "cm|cm").
ВАЖНО про формат при разделении токенов: запятая всегда оформляется как отдельный
токен "cm|cm" (лемма — буквально строка "cm", НЕ сам символ запятой). Точка/восклицательный/
вопросительный знак в конце предложения — это ГОЛЫЙ символ без части речи и без префикса
(просто "." или "!" или "?", НЕ "punct|." и не что-то ещё) — как в остальных токенах этого
корпуса. Не изобретай новые обозначения тегов, которых нет в остальном файле.
Другая частая причина — в %gra не хватает записи для последнего токена (обычно финальный
знак препинания). По статистике корпуса такой знак чаще всего крепится к ROOT (~73%) или
к последнему однородному сказуемому в цепочке ROOT+CONJ (ещё часть случаев) — но это не
жёсткое правило, ориентируйся на конкретную структуру именно этого предложения.`,
  tab_vs_space: `После %mor: и %gra: должен стоять таб, а не пробел.`,
  gra_tag_typo: `Синтаксический тег не входит в список реально используемых в этом корпусе —
похоже на опечатку (например "PARATXIS" вместо "PARATAXIS", "DSICOURSE" вместо "DISCOURSE").
Проверь, не опечатка ли это, и если да — исправь на правильное написание тега.`,
  mor_pos_typo: `Часть речи (тег до "|") не входит в список реально используемых в этом
корпусе — похоже на опечатку (например "ptopn" вместо "propn", "itnj" вместо "intj").
Проверь и исправь написание, не меняя саму часть речи по смыслу.`,
  verb_missing_tense: `У финитного глагола в изъявительном наклонении (тег Ind) обязательно
должно быть время: Pres (наст.), Fut (буд.) или Past (прош.). Пример: "соберёте" ->
verb|собрать-Fin-Perf-Ind-Fut-P2 (время Fut обязательно, не только число+лицо P2).`,
  det_missing_case: `У местоименных прилагательных (тег det, например "твой", "этот",
"такой") обязательно должен быть указан падеж (по FAQ разметчиков — да, нужно).`,
  vocative_should_be_voc: `Если слово (обычно имя) выступает как обращение (роль VOCATIVE
в %gra), падеж должен быть Voc (звательный), а не Nom. Пример: "Тося , молодец!" — если
"Тося" стоит в VOCATIVE, у него должен быть падеж Voc, а не Nom.`,
  case_role_mismatch: `Синтаксическая роль слова (в %gra) не согласуется с его падежом
(в %mor): подлежащее (NSUBJ) должно быть в Nom, а не в Acc; прямое дополнение (OBJ) обычно
в Acc или Gen, а не в Nom. ВАЖНО: это только КАНДИДАТ на проверку — у местоимений вроде
"что"/"это"/"всё" и у существительных среднего/неодушевлённого мужского рода формы Nom и
Acc совпадают по написанию, и это НЕ ошибка (падежный синкретизм русского языка) — в таких
случаях подтверждать ошибку не нужно, если слово реально может быть и Nom, и Acc по форме.`,
  noun_missing_animacy: `ЭТО НЕ ОШИБКА, А ЗАДАЧА ОБОГАЩЕНИЯ РАЗМЕТКИ: у существительного/имени
не указана одушевлённость (категория Anim — одушевлённое, или Inan — неодушевлённое).
Определи по смыслу слова, обозначает ли оно живое существо (человека, животное) — тогда
Anim, иначе Inan, и добавь эту категорию. Порядок категорий для сущ.: род-число-падеж-
одушевлённость (добавляется после падежа). Пример: noun|кошка-Fem-Sing-Nom-Anim (кошка —
живое существо), noun|стол-Masc-Sing-Nom-Inan (стол — неодушевлённый предмет).
hasRealIssue в этом случае означает "категория успешно добавлена", а не "была ошибка".`,
  noun_category_order: `Категории у существительных должны идти в порядке
род-число-падеж(-одушевлённость) — например noun|кошка-Fem-Sing-Nom-Anim, а не
noun|кошка-Nom-Fem-Sing-Anim. Переставь категории в правильный порядок, не меняя их значения.
Игнорируй сегменты, которые на самом деле часть дефисной леммы (например "чунга-чанга"),
а не отдельная категория — их трогать не нужно.`,
};

const SYSTEM_PROMPT = `Ты помогаешь перепроверять морфологическую (%mor) и синтаксическую (%gra)
разметку детской речи в формате CHILDES/CHAT по конвенциям Universal Dependencies
(корпус Taiga для русского). Тебе присылают реплику, текущую разметку и список
конкретных подозрений от автоматической проверки правил, плюс релевантный кусок
инструкции.

Помимо конкретного подозрения, всегда дополнительно проверяй в этой же реплике:
1. ОПЕЧАТКИ РАСШИФРОВЩИКА в самом слове (не детское произношение!). Если очевидно, что
   человек, печатавший транскрипт, ошибся при наборе (пропустил/переставил букву,
   опечатался) — это нужно исправить. НЕ трогай настоящее произношение/выговор ребёнка
   (искажения вроде "сяс" вместо "сейчас", слова с @u/@c и т.п. — это нормальная детская
   речь, её сохраняем как есть, не "исправляем"). Разница: опечатка — это ошибка НАБОРА
   ТЕКСТА человеком (например "тйебя" вместо "тебя"), а не то, как ребёнок что-то произнёс.
   ВАЖНО: реплику НЕ перепечатывай целиком (в ней могут быть невидимые служебные символы
   привязки к видео/аудио, которые нельзя терять) — вместо этого укажи в поле "textFixes"
   массив точечных замен вида {"from": "тйебя", "to": "тебя"} (что именно заменить в тексте
   реплики). Если опечаток не нашлось — верни пустой массив.
   КРИТИЧЕСКИ ВАЖНО: если исправляешь опечатку — исправляй её ВЕЗДЕ СРАЗУ и одинаково:
   и в textFixes (сам текст реплики), И в лемме в %mor, И, если из-за опечатки слово
   получило неверную часть речи (например местоимение "тебя" по ошибке размечено как
   noun вместо pron с леммой "ты") — исправь часть речи и лемму тоже. Не оставляй
   слово наполовину исправленным (например лемма поправлена, а сама реплика — нет,
   или наоборот).
2. СКОБОЧНЫЕ ПОМЕТКИ [: X], [= X], [*] в реплике — по ним нужно определить, как разбирать
   слово: [: X] (фонетическая замена) и [= X] (глосса/пояснение значения) — это просто
   уточнение произношения/смысла, разбор делай ПО X (исправленному/поясняющему варианту).
   А вот [*] отдельно или вместе с [: X] помечает НАСТОЯЩУЮ ГРАММАТИЧЕСКУЮ ОШИБКУ ребёнка
   (не опечатку и не произношение) — например согласование рода/числа ("мама сделал" —
   ребёнок реально так сказал, спутав род). В этом случае разбор нужно делать по ИСХОДНОМУ
   слову, как ребёнок его реально произнёс/сказал, а не по "исправленному" — такие ошибки
   сами по себе ценные данные для исследования освоения языка, их нельзя "заглаживать".
3. КОРРЕКТНОСТЬ ЛЕММЫ в %mor. Лемма должна быть начальной (словарной) формой слова —
   инфинитив для глаголов (например "найти", а не спрягаемая форма "нашла"), именительный
   падеж единственного числа для существительных/прилагательных. Если лемма явно
   ошибочно указана как словоформа из текста, а не начальная форма — исправь её прямо в
   строке %mor (это часть correctedMor, отдельного поля для этого нет).

Для каждого подозрения и для найденных опечаток/лемм: (1) реши, реальная это ошибка или
ложное срабатывание правила; (2) если реальная — верни исправленную строку %mor и/или
%gra ЦЕЛИКОМ (все токены по порядку, не только исправленный), и/или textFixes для опечаток
в реплике; (3) напиши один короткий комментарий на русском, что изменено и почему. Если
ошибок нет вообще — верни исходные строки без изменений, пустой textFixes и пустой
комментарий. Отвечай СТРОГО в JSON без текста вне JSON:
{"hasRealIssue": bool, "correctedMor": string, "correctedGra": string,
"textFixes": [{"from": string, "to": string}], "comment": string}`;

// Ключи Yandex Cloud берутся из узла "Ключи Yandex Cloud (НЕ публиковать в скриншотах!)"
const ykeys = $('Ключи Yandex Cloud (НЕ публиковать в скриншотах!)').first().json;
const apiKey = ykeys.apiKey;
const folderId = ykeys.folderId;

// вырезаем JSON из ответа модели на случай, если она обернула его в ```json ... ``` или добавила текст вокруг
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  return JSON.parse(candidate.slice(start, end + 1));
}

// --- Верификация: правда ли LLM решила именно то, что было заявлено в подозрении ---
// LLM иногда чинит часть проблем в предложении, а часть (особенно когда их несколько
// сразу) — молча пропускает. Вместо того чтобы доверять hasRealIssue вслепую, перепроверяем
// каждое конкретное исходное подозрение по факту на исправленном %mor/%gra — это чистый
// код, без обращения к модели, поэтому бесплатно и мгновенно.
const CASES = new Set(["Nom", "Gen", "Acc", "Dat", "Ins", "Loc", "Voc"]);
const GENDERS = new Set(["Masc", "Fem", "Neut"]);
const NUMBERS = new Set(["Sing", "Plur"]);
const ANIMACY = new Set(["Anim", "Inan"]);
const NUM_PERSON_COMBO = /^[SP][123]$/;
const BARE_NUMBER = /^[SP]$/;

function splitMorToken(token) {
  if (!token.includes("|")) return null;
  const idx = token.indexOf("|");
  const pos = token.slice(0, idx);
  const rest = token.slice(idx + 1);
  const parts = rest.split("-");
  return { pos, lemma: parts[0], cats: parts.slice(1) };
}

function parseGraInfo(graTokens) {
  let rootCount = 0;
  let rootHeadOk = true;
  for (const tok of graTokens) {
    const m = tok.match(/^(\d+)\|(\d+|-)\|([A-Za-z:_]+)$/);
    if (!m) continue;
    const [, , head, tag] = m;
    if (tag.toUpperCase() === "ROOT") {
      rootCount++;
      if (head !== "0") rootHeadOk = false;
    }
  }
  return { rootCount, rootHeadOk };
}

// Проверяет каждое исходно найденное подозрение по факту на исправленном тексте.
// Для части редких/сложных правил (case_role_mismatch, numeral_2_4_agreement,
// опечатки в тегах) точную перепроверку не делаем — это низкообъёмные и более
// контекстно-зависимые случаи, считаем их решёнными по слову модели, не блокируем.
function findUnresolvedIssues(issues, morTokensStr, graTokensStr) {
  const morTokens = morTokensStr ? morTokensStr.split(/\s+/).filter(Boolean) : [];
  const graTokens = graTokensStr ? graTokensStr.split(/\s+/).filter(Boolean) : [];
  const parsedMor = morTokens.map(splitMorToken);
  const graInfo = parseGraInfo(graTokens);

  return issues.filter((issue) => {
    const tok = issue.wordNo ? parsedMor[issue.wordNo - 1] : null;
    switch (issue.rule) {
      case "noun_missing_animacy":
        return !(tok && tok.cats.some((c) => ANIMACY.has(c)));
      case "noun_missing_category":
        return !(
          tok &&
          tok.cats.some((c) => GENDERS.has(c)) &&
          tok.cats.some((c) => NUMBERS.has(c)) &&
          tok.cats.some((c) => CASES.has(c))
        );
      case "det_missing_case":
        return !(tok && tok.cats.some((c) => CASES.has(c)));
      case "vocative_should_be_voc":
        return !(tok && tok.cats.includes("Voc"));
      case "verb_missing_tense":
        return !(tok && tok.cats.some((c) => ["Pres", "Fut", "Past"].includes(c)));
      case "past_missing_gender":
        return !(tok && (tok.cats.some((c) => GENDERS.has(c)) || tok.cats.includes("P") || tok.cats.includes("Plur")));
      case "infinitive_with_number":
        return !!(tok && tok.cats.some((c) => BARE_NUMBER.test(c) || NUM_PERSON_COMBO.test(c)));
      case "interrogative_pronoun_has_number_person":
        return !!(tok && tok.cats.some((c) => NUM_PERSON_COMBO.test(c) || BARE_NUMBER.test(c)));
      case "noun_category_order": {
        if (!tok) return true;
        const rank = { G: 0, N: 1, C: 2, A: 3 };
        const order = [];
        for (const c of tok.cats) {
          if (GENDERS.has(c)) order.push("G");
          else if (NUMBERS.has(c)) order.push("N");
          else if (CASES.has(c)) order.push("C");
          else if (ANIMACY.has(c)) order.push("A");
        }
        return order.join("") !== [...order].sort((a, b) => rank[a] - rank[b]).join("");
      }
      case "no_root":
        return graInfo.rootCount === 0;
      case "multiple_root":
        return graInfo.rootCount > 1;
      case "root_head_not_zero":
        return graInfo.rootCount >= 1 && !graInfo.rootHeadOk;
      case "token_count_mismatch":
        return morTokens.length !== graTokens.length;
      default:
        return false; // case_role_mismatch, numeral_2_4_agreement, *_typo, tab_vs_space — не перепроверяем
    }
  });
}

async function callYandexGPT(userPrompt, temperature = 0.1) {
  const response = await this.helpers.httpRequest({
    method: "POST",
    url: "https://llm.api.cloud.yandex.net/foundationModels/v1/completion",
    timeout: 30000, // 30 сек на один запрос — зависший запрос падает с ошибкой,
    // а не блокирует весь пакет файлов навсегда
    headers: {
      Authorization: `Api-Key ${apiKey}`,
      "x-folder-id": folderId,
      "Content-Type": "application/json",
    },
    body: {
      modelUri: `gpt://${folderId}/yandexgpt/latest`,
      completionOptions: { stream: false, temperature, maxTokens: "2000" },
      messages: [
        { role: "system", text: SYSTEM_PROMPT },
        { role: "user", text: userPrompt },
      ],
    },
    json: true,
  });
  return extractJson(response.result.alternatives[0].message.text);
}

function buildUserPrompt(fileName, f, issuesSubset, morRaw, graRaw) {
  const contextChunks = [...new Set(issuesSubset.map((i) => i.rule))]
    .map((rule) => RULE_CONTEXT[rule])
    .filter(Boolean)
    .join("\n\n");
  return `Файл: ${fileName}
Строка: ${f.line}
Реплика: ${f.textLine}
Текущий %mor: ${morRaw}
Текущий %gra: ${graRaw}

Подозрения от правил:
${issuesSubset.map((i) => `- (${i.rule}) ${i.detail}`).join("\n")}

Релевантные правила разметки:
${contextChunks}

Верни JSON по описанной схеме.`;
}

async function checkOne(f, fileName) {
  let parsed = { hasRealIssue: false, correctedMor: f.morRaw, correctedGra: f.graRaw, textFixes: [], comment: "" };
  let debugError = null;
  try {
    parsed = await callYandexGPT(buildUserPrompt(fileName, f, f.issues, f.morRaw, f.graRaw));
  } catch (e) {
    // ВРЕМЕННО (для отладки): не глушим ошибку молча, а записываем её в debugError,
    // чтобы было видно в выводе узла, что именно пошло не так.
    debugError = e.message || String(e);
  }

  let correctedMor = parsed.correctedMor || f.morRaw;
  let correctedGra = parsed.correctedGra || f.graRaw;
  let textFixes = Array.isArray(parsed.textFixes) ? parsed.textFixes : [];
  let comment = parsed.comment || "";

  // Верификация + один точечный повторный запрос, если что-то из заявленного не решено
  let unresolved = debugError ? f.issues : findUnresolvedIssues(f.issues, correctedMor, correctedGra);
  if (unresolved.length && !debugError) {
    try {
      const retryParsed = await callYandexGPT(buildUserPrompt(fileName, f, unresolved, correctedMor, correctedGra), 0);
      const retryMor = retryParsed.correctedMor || correctedMor;
      const retryGra = retryParsed.correctedGra || correctedGra;
      const stillUnresolved = findUnresolvedIssues(unresolved, retryMor, retryGra);
      if (stillUnresolved.length < unresolved.length) {
        // повтор реально что-то улучшил — принимаем его результат
        correctedMor = retryMor;
        correctedGra = retryGra;
        if (Array.isArray(retryParsed.textFixes)) textFixes = textFixes.concat(retryParsed.textFixes);
        if (retryParsed.comment) comment = comment ? `${comment}; ${retryParsed.comment}` : retryParsed.comment;
      }
      unresolved = findUnresolvedIssues(f.issues, correctedMor, correctedGra);
    } catch (e) {
      // повтор не удался — остаток так и останется в unresolved, попадёт в отчёт для человека
    }
  }

  return {
    lineNumber: f.line,
    morLineIndices: f.morLineIndices,
    graLineIndices: f.graLineIndices,
    textLineIndices: f.textLineIndices,
    hasRealIssue: !!parsed.hasRealIssue || correctedMor !== f.morRaw || correctedGra !== f.graRaw || textFixes.length > 0,
    correctedMor,
    correctedGra,
    textFixes,
    comment,
    unresolvedIssues: unresolved, // { rule, wordNo, detail } — полные объекты, не только имя правила
    debugError,
  };
}

// Запросы к YandexGPT идут с ограниченным параллелизмом (не по одному, но и не все
// сразу — чтобы не упереться в rate limit API). CONCURRENCY можно уменьшить, если
// начнут появляться debugError про превышение лимита запросов.
const CONCURRENCY = 5;

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runNext() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await worker(items[i]);
    }
  }
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, runNext);
  await Promise.all(workers);
  return results;
}

// собираем ВСЕ подозрительные предложения со ВСЕХ файлов в один плоский список задач —
// так параллелизм работает по всему батчу сразу, а не по одному файлу за раз
const tasks = [];
for (const item of $input.all()) {
  const source = item.json;
  for (const f of source.flagged || []) {
    tasks.push({ fileName: source.fileName, f });
  }
}

const flatResults = tasks.length
  ? await mapWithConcurrency(tasks, CONCURRENCY, async (t) => ({
      fileName: t.fileName,
      result: await checkOne(t.f, t.fileName),
    }))
  : [];

const resultsByFile = new Map();
for (const item of $input.all()) resultsByFile.set(item.json.fileName, []);
for (const fr of flatResults) resultsByFile.get(fr.fileName).push(fr.result);

return $input.all().map((item) => ({
  json: { fileName: item.json.fileName, results: resultsByFile.get(item.json.fileName) },
}));
