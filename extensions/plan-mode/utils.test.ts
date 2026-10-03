import assert from "node:assert/strict";
import test from "node:test";
import { extractTodoItems } from "./utils.ts";

test("retains indented substeps and wrapped conditions without creating extra todos", () => {
  const items = extractTodoItems(`Plan:
1. Проверить доступные модели.
2. Параллельно запустить два агента:
   - **Фоновый**: проверить дату и часовой пояс.
   - Переднего плана: проверить \`git status\`.
     1. Не изменять файлы.
     2. Не использовать Spark.
   Сохранить оба результата.

3. Собрать итоговый отчёт.

Пояснение вне плана.
1. Это не новый шаг плана.
`);
  assert.deepEqual(items.map(item => item.text), [
    "Проверить доступные модели.",
    "Параллельно запустить два агента: - Фоновый: проверить дату и часовой пояс. - Переднего плана: проверить git status. 1. Не изменять файлы. 2. Не использовать Spark. Сохранить оба результата.",
    "Собрать итоговый отчёт.",
  ]);
  assert.deepEqual(items.map(item => item.step), [1, 2, 3]);
});

test("supports indented plans and does not cut a step at inline Markdown", () => {
  assert.deepEqual(extractTodoItems(`**Plan:**
  1. Проверить **все** условия и \`код\` шага.
\t- Сохранить вложенное условие.
  2. Представить полный отчёт.
`).map(item => item.text), [
    "Проверить все условия и код шага. - Сохранить вложенное условие.",
    "Представить полный отчёт.",
  ]);
});
