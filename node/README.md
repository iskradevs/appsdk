# Искра Apps SDK

`@iskra/apps` — SDK и CLI для приложений, которые публикуются и работают в
Искре. Нужны **Node.js 24**, TypeScript и ESM. Приложение получает собственный
каталог `/data`, базовый URL path и доступ к API Искры от среды исполнения.

Preview **0.1.2** готовится для предстоящего облачного релиза Apps. Проверенный
пакет распространяется через [GitHub Releases](https://github.com/iskradevs/appsdk/releases).
Публикация в npm оформляется отдельно.

## Установка и первое приложение

В каталоге разработки установите точный preview artifact:

```bash
npm init -y
npm install https://github.com/iskradevs/appsdk/releases/download/v0.1.2/iskra-apps-0.1.2.tgz
npx iskra-app init --name my-app --path ./my-app --layout form --style iskra
npx iskra-app check --path ./my-app
npx iskra-app pack --path ./my-app --output ./my-app.zip --closed
```

`--closed` собирает зависимости в публикуемый бандл. Итоговый ZIP загружается
через интерфейс приложений Искры. `source-pack` создаёт отдельный исходный
архив; это формат для дальнейшего редактирования приложения.

CLI также предоставляет `build` и `publish`; допустимые аргументы выводятся
при вызове `iskra-app` без команды. Выбор макета: `form`, `table`, `dashboard`,
`master-detail`, `sidebar`, `wizard`; стиля: `iskra`, `strict`, `showcase`.

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
| `ISKRA_API_URL` | Явный служебный API origin, например `http://iskra-api:8091/__iskra` |
| `X-Iskra-Identity` | Подписанный viewer JWT входящего запроса; его проверяет сервер приложения |

Сервер слушает порт **8080**, отвечает на `GET /healthz` и на корень приложения
с завершающим слэшем. `Hono({ strict: false })` поддерживает этот путь в обоих
режимах. На candidate probe приложение получает отдельные пустые данные;
служебный ingress alias в probe-сети отсутствует.

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
