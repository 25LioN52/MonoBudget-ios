# Політика безпеки / Security Policy

## Як повідомити про вразливість

**Не створюйте публічний issue.** Скористайтеся приватним каналом GitHub:
[Security → Report a vulnerability](https://github.com/25LioN52/MonoBudget-ios/security/advisories/new).

Опишіть проблему, як її відтворити і можливий вплив. **Не надсилайте свій токен Monobank чи справжні виписки** — для демонстрації достатньо синтетичних даних.

Я намагаюся відповідати протягом 7 днів. Виправлення публікуються в останній версії `MonoBudget.js`. Підтримується лише остання версія.

## Якщо ваш токен міг потрапити до сторонніх

1. Відкрийте [api.monobank.ua](https://api.monobank.ua/) і **відкличте токен** (створення нового скасовує попередній).
2. У MonoBudget натисніть «Видалити токен і кеш з телефону» і введіть новий токен.

Токен Monobank дає доступ **лише на читання** (виписки, баланси, IBAN, ім'я). Ним неможливо здійснити платіж, але він розкриває фінансову інформацію — бережіть його як пароль.

## Модель загроз (коротко)

| Ризик | Захист у MonoBudget |
|---|---|
| Витік токена з коду чи репозиторію | Токен не зберігається в коді; лише в iOS Keychain через Scriptable. Сканер секретів (локальний хук + CI + TruffleHog) і GitHub push protection |
| Інші скрипти Scriptable | Keychain Scriptable спільний для всіх скриптів у Scriptable. **Встановлюйте лише скрипти, яким довіряєте**, і перевіряйте їхній код |
| Синхронізація фінансових даних у хмару | Кеш лише локальний, у приватній папці Library (не iCloud Drive, не видно у Files). Як і всі дані додатків, входить у резервні копії пристрою (iCloud — зашифровані; Finder/iTunes — лише з увімкненим шифруванням) |
| Надлишкові дані | Кешуються лише дата, сума, MCC, опис і ознака власного переказу. Без балансів і полів з іменами/IBAN контрагентів. Опис — як у банку (у переказах може містити ім'я). IBAN власних рахунків — для розпізнавання власних переказів |
| Логи та помилки | Токен, IBAN та описи операцій не логуються; у помилках лише HTTP-статус |
| Сторонні сервери | Єдиний мережевий запит — `https://api.monobank.ua`, redirect заборонені (токен не піде на інший хост). Без аналітики, без автооновлення коду |
| Кілька процесів (додаток + віджети) | Перед кожним запитом слот ліміту фіксується на диску; відповідь після видалення кешу відкидається |
| Ланцюг постачання | Нуль залежностей npm; дії GitHub Actions закріплені за SHA, версія TruffleHog зафіксована |
| Екран блокування і StandBy | Їх видно без розблокування — `lockScreenShowAmounts: false` приховує суми на екрані блокування; не додавайте віджет у StandBy, якщо це небажано |
| Витік через git-історію | Сканер перевіряє кожен коміт і повідомлення коміту (хуки pre-commit, commit-msg, pre-push і CI), плюс незалежний TruffleHog і GitHub push protection |

---

## Reporting a vulnerability (English)

**Do not open a public issue.** Use GitHub's private
[Report a vulnerability](https://github.com/25LioN52/MonoBudget-ios/security/advisories/new) form.
Describe the issue, steps to reproduce and the impact. **Never send your Monobank token or real statements.**
I aim to reply within 7 days. Only the latest version of `MonoBudget.js` is supported.

If your token may have leaked, revoke it at [api.monobank.ua](https://api.monobank.ua/) (creating a new token revokes the old one),
then use "Delete token and cache from this phone" in MonoBudget and enter the new token.
