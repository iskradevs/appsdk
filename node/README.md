# Искра Apps SDK

`@iskra/apps` — SDK и CLI для приложений, которые публикуются и работают в
Искре. Нужны **Node.js 24**, TypeScript и ESM. Приложение получает собственный
каталог `/data`, базовый URL path и доступ к API Искры от среды исполнения.

Preview **0.1.4** добавляет развёртывание внешним агентом: проверенный ZIP,
чтение статуса, смену доступа и структурированные ошибки. Проверенный
пакет распространяется через [GitHub Releases](https://github.com/iskradevs/appsdk/releases).
Публикация в npm оформляется отдельно.

## Установка и первое приложение

В каталоге разработки установите точный preview artifact:

```bash
npm init -y
npm install https://github.com/iskradevs/appsdk/releases/download/v0.1.4/iskra-apps-0.1.4.tgz
npx iskra-app init --name my-app --path ./my-app --layout form --style iskra
npx iskra-app check --path ./my-app
npx iskra-app pack --path ./my-app --output ./my-app.zip --closed
```

`--closed` собирает зависимости в публикуемый бандл. Итоговый ZIP можно
загрузить через интерфейс приложений или API. Команда `iskra-app publish`
собирает и публикует приложение обычным API-ключом с правом `apps:publish`.
Полный сценарий для внешнего агента — в [инструкции по развёртыванию](DEPLOYMENT.md).
`source-pack` создаёт отдельный исходный
архив; это формат для дальнейшего редактирования приложения.

CLI также предоставляет `build` и `publish`; допустимые аргументы выводятся
при вызове `iskra-app` без команды. Выбор макета: `form`, `table`, `dashboard`,
`master-detail`, `sidebar`, `wizard`; стиля: `iskra`, `strict`, `showcase`.

При создании приложения `app.json.access: "public"` выбирает внешнюю
публикацию напрямую по текущему праву владельца. Scope ключа `apps:publish`
и право внешней публикации проверяются отдельно; подготовка `private/org`
от этого права не зависит. CLI различает `ready`, `ready_not_active` и
`probing`: готовая версия с невыполненной запрошенной активацией сохраняется,
а после возврата права владелец активирует её явно. Exact status принятой
версии хранит исходный outcome даже после смены текущей версии и прунинга.

## Авторский проект и сборка

`init` создаёт модульный проект: `src/server.ts` запускает сервер и подключает
маршруты, `src/config.ts` задаёт имя и стиль, `routes.ts` содержит обработчики,
`views.ts` — HTML экранов. Данные и операции размещаются в отдельных модулях
по потребности. Браузерный JavaScript находится в `static/`; интерактивный
пример подключает `static/screen.js` внешним `script src`.

Редактируйте авторский `app.json`, `src/**` и `static/**`, затем повторяйте
`pack`. Команды `pack` и `publish` собирают runtime в собственном временном
каталоге и очищают его при успехе и ошибке. Результат — ZIP с `server.js`,
runtime-манифестом и браузерными файлами. Для локальной проверки распакуйте
именно этот ZIP во временный каталог и запускайте `node server.js` из него:
так относительные пути к `static/` совпадут с окружением публикации.

Явный `build` сохраняет результат в `.iskra-build` для ручной работы.
Программный `buildApp` принимает свой каталог через `outDir`. При следующем `pack` или `publish` SDK проверит прежнюю `.iskra-build`
и удалит её после готового ZIP, если это runtime того же приложения.
Неизвестные файлы, чужой манифест и symlinks сохраняются с диагностикой:
разберите их содержимое и переместите нужные файлы перед повторной сборкой.
Выходной ZIP выбирайте за пределами `.iskra-build`.

## Среда исполнения

| Значение | Источник и использование |
| --- | --- |
| `APP_ID` | UUID приложения; audience проверяемого viewer JWT |
| `APP_BASE_PATH` | `/` в subdomain-режиме, `/{slug}` в path-режиме; helper `appBasePath()` |
| `DATA_DIR` | Защищённый каталог данных; `appDataPath("notes.sqlite")` строит путь внутри него |
| `ISKRA_API_URL` | Явный служебный API URL от Apps runtime; в рабочем приложении `http://<ingressIPv4>:8091/__iskra` с адресом ingress в сети именно этого приложения |
| `X-Iskra-Identity` | Подписанный viewer JWT входящего запроса; его проверяет сервер приложения |

Сервер слушает порт **8080**, отвечает на `GET /healthz` и на корень приложения
с завершающим слэшем. `Hono({ strict: false })` поддерживает этот путь в обоих
режимах. SDK читает `ISKRA_API_URL` из среды как непрозрачное значение:
адрес не задаётся автором и не фиксируется в исходниках. Runtime добавляет
точный ingress IP в `NO_PROXY`; смена IP пересоздаёт app-контейнер с новым
окружением и тем же `/data`.

На candidate probe приложение получает отдельные пустые данные. В probe и
при отключённом входе зрителя ingress к сети не подключается: служебный URL
остаётся `http://iskra-api:8091/__iskra`, но alias недоступен. Статическая
страница кандидата должна открываться без проверки viewer identity.

SQLite хранится в `appDataPath(...)`. Каталог `/data` сохраняется при обновлении
и перезапуске приложения; bundle находится в `/app` только для чтения.
[Stateful example](examples/stateful/src/server.ts) показывает SQLite,
экранирование пользовательского текста и общий stylesheet.

## Проверка зрителя и API

Перед чтением или записью данных приватного маршрута проверьте identity:

```typescript
import { IskraClient, verifyViewerIdentity } from "@iskra/apps";

// token берётся сервером из входящего X-Iskra-Identity.
const viewer = await verifyViewerIdentity(token, {
  appId: process.env.APP_ID!,
  apiUrl: process.env.ISKRA_API_URL!,
});
const iskra = new IskraClient({
  apiUrl: process.env.ISKRA_API_URL!,
  token,
});
```

`verifyViewerIdentity` проверяет EdDSA, issuer, audience, срок действия и claims.
JWKS запрашивается через явный служебный API URL. Для инициализации страницы
кандидата используйте статический маршрут, которому viewer identity не нужен.
`viewer.profileId` определяет рабочий контекст запроса. Router перепроверяет
живой доступ к приложению, а backend повторно проверяет authority API-запросов.

`IskraAPIError` содержит HTTP status, machine code и message. Версия 0.1.2 также
сохраняет Problem metadata и response request ID/Retry-After; код приложения
принимает решение о повторе. `POST` автоматически не повторяется. Для повторяемых
операций используйте контрактный idempotency key.

## Анализ, генерация и документы

Приложение вызывает агента Искры от имени вошедшего зрителя. Для короткой
задачи используйте `iskra.run(body, { idempotencyKey })`; для длительной —
`iskra.startRun(body, { idempotencyKey })` и `iskra.getRun(runId)`.
`startRun` возвращает `runId`, пока агент продолжает работу. При `completed`
исходный ответ находится в `result.answer`, JSON по переданному
`response_format: { type: "json_schema", json_schema: schema }` — в
`result.output`. Сама схема передаётся без обёртки `{ name, schema }`;
нужные поля опишите и в `message`, поскольку форматирование идёт после агента.

Сервер использует `ISKRA_API_URL` из среды и JWT текущего HTTP-запроса.
JWT живёт до пяти минут, поэтому длительный опрос организуйте запросами
браузера к своему серверу: каждый запрос получает свежий `X-Iskra-Identity`.
`progress()` подходит для ожидания в пределах срока текущего токена;
запуск новых задач и чтение результатов требуют действующей сессии зрителя.

Для PDF есть multipart `POST /api/v1/chat/files` с частью `file` и именем
файла; SDK пока не содержит upload-helper. Ответ даёт `conversation_id` и
`files[].id`, которые передаются в chat/runs. Тот же JWT используется как
Bearer. Пример полного пути и таблица отказов — в короткой
[инструкции для ЭПС](INTELLIGENCE.md).

App API предоставляет chat/files/runs и точечное чтение слотов секретов
приложения. Каталоги навыков, Память, веб-поиск и OpenAI `/v1` через эту
границу недоступны. App-прогон работает с документами и навыками из
`APPS_HEADLESS_SKILL_ALLOWLIST` (точные `bundle@version`); возможности навыков
ограничены artifact/files/LLM/log/now/progress/random/run-files. Интеграции
и секреты чатового навыка автоматически не переходят в приложение.

До LLM-вызова проверяются баланс и квоты `daily_runs`, `daily_mt`,
`max_run_mt`, `max_concurrent_runs`. Открывающаяся страница и успешная
candidate probe сами по себе не подтверждают доступ к интеллекту:
проверьте реальный run из пользовательской сессии. Ошибку доступа к адресу
из `ISKRA_API_URL` диагностирует администратор Apps NODE; публичный адрес
контура не заменяет служебный маршрут с viewer JWT. Этот маршрут не зависит
от Docker DNS приложения. Отдельный дефект DNS egress-прокси может по-прежнему
блокировать внешние интеграции; успешный SDK-запрос их не проверяет.

Для внешнего сервиса с пользовательским ключом `isk_` применяется отдельный
[API SDK](https://github.com/iskradevs/apisdk), со своими scopes и каталогами.

## Исходник и проверки

Публичный исходник: [iskradevs/appsdk](https://github.com/iskradevs/appsdk).
Внутри него Node-пакет находится в `node/`; рядом `manifest/` со схемой и
контрактными fixtures. `SOURCE_REVISION` — полный SHA проверенного исходника.

```bash
cd node
npm ci
npm test
npm pack
```

[Авторские инструкции](authoring/INSTRUCTIONS.md), примеры и manifest schema входят
в пакет. MIT — [LICENSE](LICENSE).
