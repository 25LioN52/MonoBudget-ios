## Що змінено / What changed

<!-- Коротко: що і навіщо. / Briefly: what and why. -->

## Перевірки / Checks

- [ ] `npm test` проходить / passes (`node --test`)
- [ ] `npm run scan` проходить / passes (`node scripts/secret-scan.mjs --all`)
- [ ] Нові або змінені функції в CORE покриті тестами / New or changed CORE functions are tested

## Безпека / Security (обов'язково / required)

- [ ] Немає токенів, справжніх виписок, IBAN, номерів карток, імен — лише синтетичні фікстури / No tokens, real statements, IBANs, card numbers or names — synthetic fixtures only
- [ ] Мережеві запити лише до `https://api.monobank.ua`; токен лише в заголовку `X-Token` / Network requests only to `https://api.monobank.ua`; token only in the `X-Token` header
- [ ] Токен і фінансові дані не логуються і не потрапляють у повідомлення про помилки / Token and financial data are never logged or shown in error messages
- [ ] Кеш лишається локальним (не iCloud), зберігаються лише потрібні поля / Cache stays local (not iCloud), only needed fields are stored
- [ ] Не додано сторонніх залежностей / No third-party dependencies added
- [ ] Зображення в `docs/` переглянуто вручну: на скриншотах немає реальних сум, описів, імен чи номерів / Images in `docs/` reviewed by hand: no real amounts, descriptions, names or numbers
- [ ] Ліміт Monobank (1 запит / 60 с, ≤ 31 день, ≤ 500 операцій) дотримано / Monobank limits respected
