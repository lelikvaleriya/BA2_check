// Код для n8n Code-узла ("Собрать исправленный .cha + отчёт")
// Режим: "Run Once for All Items"
// Вход: N items из узла "LLM: проверить и исправить подозрения" (по одному на файл,
// поле results — массив). Исходные тексты файлов лежат в items узла
// "Правила: найти подозрительные предложения" — сопоставляем по fileName.
//
// Выход: N items (по одному на файл), у каждого два поля (correctedCha, commentsMd) И
// два бинарных вложения (correctedFile, commentsFile) — можно скачать кнопкой "Download".

const sourceByName = new Map(
  $('Правила: найти подозрительные предложения').all().map((item) => [item.json.fileName, item.json])
);

const ANIMACY = new Set(["Anim", "Inan"]);

function splitMorToken(token) {
  if (!token.includes("|")) return null;
  const idx = token.indexOf("|");
  const pos = token.slice(0, idx);
  const rest = token.slice(idx + 1);
  const parts = rest.split("-");
  return { pos, lemma: parts[0], cats: parts.slice(1), raw: token };
}

// Детерминированная проверка согласованности (без LLM): LLM обрабатывает каждое
// предложение отдельным независимым запросом и не помнит, что решил для того же
// слова в другом предложении того же файла — из-за этого одно и то же слово
// (например повторяющееся имя) иногда получает одушевлённость, а иногда нет.
// Этот проход находит уже определённые соответствия лемма+часть речи -> Anim/Inan
// по всему файлу и подставляет их туда, где категория пропущена — гарантированно,
// без обращения к модели.
function enforceAnimacyConsistency(lines) {
  const morLineIdxs = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("%mor:")) morLineIdxs.push(i);
  }

  const known = new Map(); // `${pos}|${lemma_lowercase}` -> "Anim" | "Inan"
  for (const i of morLineIdxs) {
    const content = lines[i].slice(5).replace(/^[ \t]+/, "");
    for (const t of content.split(/\s+/).filter(Boolean)) {
      const parsed = splitMorToken(t);
      if (!parsed || (parsed.pos !== "noun" && parsed.pos !== "propn")) continue;
      const anim = parsed.cats.find((c) => ANIMACY.has(c));
      if (anim) {
        const key = `${parsed.pos}|${parsed.lemma.toLowerCase()}`;
        if (!known.has(key)) known.set(key, anim);
      }
    }
  }

  let filledCount = 0;
  for (const i of morLineIdxs) {
    const content = lines[i].slice(5).replace(/^[ \t]+/, "");
    const tokens = content.split(/\s+/).filter(Boolean);
    let changed = false;
    const newTokens = tokens.map((t) => {
      const parsed = splitMorToken(t);
      if (!parsed || (parsed.pos !== "noun" && parsed.pos !== "propn")) return t;
      if (parsed.cats.some((c) => ANIMACY.has(c))) return t;
      const known_anim = known.get(`${parsed.pos}|${parsed.lemma.toLowerCase()}`);
      if (!known_anim) return t;
      changed = true;
      filledCount++;
      return `${parsed.pos}|${[parsed.lemma, ...parsed.cats, known_anim].join("-")}`;
    });
    if (changed) lines[i] = "%mor:\t" + newTokens.join(" ");
  }
  return filledCount;
}

async function buildOne(fileName, llmResults) {
  const source = sourceByName.get(fileName);
  const originalLines = source.chaText.split(/\r?\n/);

  // Каждый тег %mor/%gra может занимать НЕСКОЛЬКО физических строк в исходном файле
  // (длинные предложения переносятся, продолжение — строка с табом в начале).
  // Заменяем весь диапазон строк тега на одну новую строку — поэтому собираем
  // все правки и применяем их с конца файла к началу: так более ранние splice()
  // не сдвигают индексы ещё не обработанных правок.
  const changes = []; // { line, comment }
  const edits = []; // { startIdx, count, newLine }
  // потенциально нерешённые вопросы — перепроверим ещё раз ПОСЛЕ прохода согласованности
  // одушевлённости (он может закрыть часть animacy-пунктов без участия LLM)
  const potentialReview = []; // { lineNumber, morLineIndices, issue }

  for (const r of llmResults) {
    for (const issue of r.unresolvedIssues || []) {
      potentialReview.push({ lineNumber: r.lineNumber, morLineIndices: r.morLineIndices, issue });
    }
    if (!r.hasRealIssue) continue;
    if (r.correctedMor && r.morLineIndices && r.morLineIndices.length) {
      edits.push({
        startIdx: r.morLineIndices[0],
        count: r.morLineIndices.length,
        newLine: "%mor:\t" + r.correctedMor,
      });
    }
    if (r.correctedGra && r.graLineIndices && r.graLineIndices.length) {
      edits.push({
        startIdx: r.graLineIndices[0],
        count: r.graLineIndices.length,
        newLine: "%gra:\t" + r.correctedGra,
      });
    }
    // Опечатки в самой реплике: точечная замена (from->to) в исходном тексте, а не
    // перепечатка строки целиком — так не теряются невидимые служебные символы
    // (например привязка к видео/аудио при @Options: bullets).
    if (r.textFixes && r.textFixes.length && r.textLineIndices && r.textLineIndices.length) {
      let joined = originalLines[r.textLineIndices[0]];
      for (let k = 1; k < r.textLineIndices.length; k++) {
        joined = (joined + " " + originalLines[r.textLineIndices[k]].trim()).trim();
      }
      for (const fix of r.textFixes) {
        if (fix && fix.from) joined = joined.replace(fix.from, fix.to || "");
      }
      edits.push({
        startIdx: r.textLineIndices[0],
        count: r.textLineIndices.length,
        newLine: joined,
      });
    }
    if (r.comment) {
      changes.push({ line: r.lineNumber, comment: r.comment });
    }
  }

  // Индексы в edits/potentialReview — это позиции в ИСХОДНОМ файле (до правок). Правки
  // применяются снизу вверх, поэтому сама вставка корректна, но после неё массив строк
  // короче (многострочные теги схлопываются в одну строку) — все индексы ПОСЛЕ места
  // правки съезжают. translateIndex переводит исходный номер строки в актуальный номер
  // в correctedLines — без этого сверка "решено ли на самом деле" смотрит не туда.
  const sortedEditsAsc = [...edits].sort((a, b) => a.startIdx - b.startIdx);
  function translateIndex(originalIdx) {
    let shift = 0;
    for (const e of sortedEditsAsc) {
      if (e.startIdx + e.count <= originalIdx) {
        shift += 1 - e.count; // правка целиком до originalIdx — учитываем изменение длины
      } else if (e.startIdx <= originalIdx) {
        return e.startIdx + shift; // originalIdx попадает внутрь этой правки
      } else {
        break;
      }
    }
    return originalIdx + shift;
  }

  const correctedLines = [...originalLines];
  edits
    .sort((a, b) => b.startIdx - a.startIdx) // с конца файла к началу
    .forEach((e) => correctedLines.splice(e.startIdx, e.count, e.newLine));

  // Проход согласованности ПОСЛЕ основных правок LLM — заполняет пропуски одушевлённости
  // там, где то же слово уже получило её в другом месте того же файла.
  const consistencyFilled = enforceAnimacyConsistency(correctedLines);

  // Финальная перепроверка "нерешённых" вопросов — часть animacy-пунктов могла как раз
  // закрыться проходом согласованности выше, без участия LLM.
  const needsReview = potentialReview.filter(({ morLineIndices, issue }) => {
    if (issue.rule !== "noun_missing_animacy" || !morLineIndices || !morLineIndices.length) return true;
    const line = correctedLines[translateIndex(morLineIndices[0])];
    if (!line || !line.startsWith("%mor:")) return true;
    const tokens = line.slice(5).replace(/^[ \t]+/, "").split(/\s+/).filter(Boolean);
    const tok = tokens[issue.wordNo - 1];
    if (!tok) return true;
    return !(tok.includes("-Anim") || tok.includes("-Inan"));
  });

  const correctedCha = correctedLines.join("\n");

  let commentsMd = `# Комментарии перепроверки: ${fileName}\n\n`;
  commentsMd += `Автоматическая перепроверка нашла и исправила ${changes.length} мест.\n\n`;
  for (const c of changes.sort((a, b) => a.line - b.line)) {
    commentsMd += `- [строка ${c.line}] ${c.comment}\n`;
  }
  if (changes.length === 0) {
    commentsMd += "Исправлений не потребовалось — все подозрения правил не подтвердились.\n";
  }
  if (consistencyFilled > 0) {
    commentsMd += `\nДополнительно (без LLM, по совпадению слов внутри файла): согласована ` +
      `одушевлённость ещё в ${consistencyFilled} местах, где то же слово уже получило ` +
      `её в другой реплике этого файла.\n`;
  }
  if (needsReview.length > 0) {
    commentsMd += `\n## Требует ручной проверки (${needsReview.length})\n` +
      `Автоматика нашла подозрение, но не смогла надёжно подтвердить исправление —` +
      ` проверьте эти места вручную перед публикацией:\n`;
    for (const nr of needsReview.sort((a, b) => a.lineNumber - b.lineNumber)) {
      commentsMd += `- [строка ${nr.lineNumber}] (${nr.issue.rule}) ${nr.issue.detail}\n`;
    }
  }

  const correctedFileName = fileName.replace(/\.cha$/i, "-rechecked.cha");
  const commentsFileName = fileName.replace(/\.cha$/i, "-comments.md");

  return {
    json: { fileName, correctedFileName, commentsFileName, correctedCha, commentsMd },
    binary: {
      correctedFile: await this.helpers.prepareBinaryData(
        Buffer.from(correctedCha, "utf-8"),
        correctedFileName,
        "text/plain"
      ),
      commentsFile: await this.helpers.prepareBinaryData(
        Buffer.from(commentsMd, "utf-8"),
        commentsFileName,
        "text/markdown"
      ),
    },
  };
}

const output = [];
for (const item of $input.all()) {
  output.push(await buildOne(item.json.fileName, item.json.results || []));
}

return output;
