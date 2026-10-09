# Як долучитися / Contributing

Дякую за інтерес до MonoBudget! Пропозиції та виправлення вітаються.

## Правила безпеки (головне)

1. **Жодних справжніх даних.** Ні токенів, ні виписок, ні IBAN, ні номерів карток, ні імен. Фікстури в `tests/fixtures` — синтетичні: IBAN мають контрольні цифри `00` (завжди недійсні), картки замасковані.
2. **Жодних залежностей.** Скрипт має вставлятися в Scriptable одним файлом; тести використовують вбудований `node:test`.
3. **Мережа — лише `https://api.monobank.ua`.** Без аналітики, телеметрії чи завантаження коду.
4. **Нічого не логувати.** Токен, IBAN і описи операцій не мають потрапляти в `console`, помилки чи кеш.

## Робочий процес

```bash
git config core.hooksPath .githooks   # один раз: сканер у pre-commit, commit-msg і pre-push
npm test                              # юніт-тести + smoke-тести Scriptable
npm run scan                          # сканер секретів по всьому репозиторію
node scripts/secret-scan.mjs --history --all   # кожен коміт і повідомлення в історії
```

Хибне спрацювання сканера можна дозволити лише для конкретного правила на конкретному рядку: `secret-scan:allow <rule-id>` (наприклад, `secret-scan:allow high-entropy-string`). Кожен такий рядок треба пояснити в PR.

- Гілка `main` захищена: зміни лише через pull request із зеленим CI (`test`, `secret-scan`).
- Логіку (дати, бюджет, категорії, синхронізацію) пишіть як **чисті функції** в розділі `CORE` файлу `MonoBudget.js` і покривайте тестами.
- Код, що використовує API Scriptable, — у розділі `SCRIPTABLE`. Smoke-тести (`tests/scriptable-smoke.test.js`) запускають його на строгих моках; якщо ви використовуєте новий API Scriptable, додайте його в `tests/scriptable-mock.js` відповідно до [документації](https://docs.scriptable.app/).
- Рядки інтерфейсу додавайте в обидві мови (`STRINGS.uk` і `STRINGS.en`) — тест це перевіряє.

---

**English:** synthetic test data only, zero dependencies, network calls only to `api.monobank.ua`, never log tokens or financial data.
Run `npm test` and `npm run scan`; enable the pre-commit hook with `git config core.hooksPath .githooks`. `main` only accepts PRs with green CI.
