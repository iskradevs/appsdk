# Развёртывание приложения внешним агентом

Эта инструкция — вход в Apps SDK для агента, который работает вне чата Искры.
Команда `iskra-app publish` создаёт или обновляет приложение через API и
ожидает результат проверки. Автору достаточно обычного API-ключа с
`apps:publish`; роль администратора не требуется.

## Подготовка

Нужны Node.js 24, `@iskra/apps` версии 0.1.4 или новее и установка Искры
с API развёртывания приложений. Установите preview-пакет из релиза:

```bash
npm init -y
npm install https://github.com/iskradevs/appsdk/releases/download/v0.1.4/iskra-apps-0.1.4.tgz
```

Публичные пакеты и SHA256 доступны в
[GitHub Releases](https://github.com/iskradevs/appsdk/releases).
Выберите релиз с поддержкой `publish --bundle`, `status` и `access`.

В Искре пользователь выбирает личный профиль или профиль организации,
открывает **Настройки → API-ключи** и явно включает `apps:publish`.
Можно выдать ключ только с этим правом или вместе с другими правами Искры.
Токен показывается один раз. Операции выполняются в профиле ключа с его
текущими правами; владельцем нового приложения становится этот профиль.

Передайте окружению агента:

| Переменная | Значение |
|---|---|
| `ISKRA_API_URL` | Публичный URL установки, например `https://iskra.example`, без `/api/v1` |
| `ISKRA_API_KEY` | Токен `isk_…` с правом `apps:publish` |

Платформа должна включать Apps runtime и headless API и разрешать
`apps:publish`. Для режима public применяется текущее право внешней
публикации профиля. Ключ подчиняется этому праву.

Сохраняйте авторский ключ в окружении разработчика. Работающее приложение
использует identity зрителя и объявленные слоты секретов. Служебный
`ISKRA_API_URL` внутри runtime имеет другое назначение: это адрес API для
самого приложения.

## Создать приложение

Начните с готового примера и общего
[контракта разработки](authoring/INSTRUCTIONS.md). Во внешней среде
используйте CLI и HTTP; инструменты авторинга чата доступны внутри Искры.

```bash
npx iskra-app init --name my-app --path ./my-app --layout form --style iskra
npx iskra-app check --path ./my-app
npx iskra-app publish --closed --path ./my-app
```

Перед публикацией выберите `access` в `my-app/app.json`: `private` для
владельца, `org` для организации или `public` для внешнего доступа.
Для личного профиля org при создании приводится к private.

`publish --closed` собирает runtime и отправляет ZIP в
`POST /api/v1/apps?activate=true`. После успешной пробы и активации CLI
выдаёт JSON:

```json
{
  "appId": "UUID приложения",
  "version": "0.1.0",
  "state": "ready",
  "currentVersion": "0.1.0",
  "activated": true,
  "viewerBaseUrl": "https://my-app.apps.example/"
}
```

Сохраните `appId` и `version`. Поле `viewerBaseUrl` присутствует, когда
установка настроила вход зрителя; используйте этот адрес для открытия
приложения. Карточка управления находится в Искре по пути `/apps/<appId>`.

## Отправить именно проверенный ZIP

Обычный `publish --path` собирает проект заново. Чтобы проверить и отправить
один и тот же артефакт, сначала соберите ZIP:

```bash
npx iskra-app pack --closed --path ./my-app --output ./my-app.zip
```

Распакуйте ZIP во временный каталог и запустите `node server.js` из этого
каталога. Задайте APP_BASE_PATH и DATA_DIR для локального сценария.
Проверьте `/healthz`, корень приложения со слэшем, static и основной
пользовательский путь. После проверки остановите процесс и отправьте тот
же файл:

```bash
npx iskra-app publish --bundle ./my-app.zip
```

`--bundle` загружает байты файла без пересборки и сочетается с `--app-id`,
`--no-activate` и `--api-url`. Выберите либо `--bundle`, либо сборку проекта
через `--path`, `--output`, `--closed`.

## Обновить приложение

Измените авторские `src/**`, `static/**` и увеличьте `version` в `app.json`.
Передайте прежний UUID:

```bash
npx iskra-app publish --closed --path ./my-app --app-id "$APP_ID"
# Или после отдельной проверки ZIP:
npx iskra-app publish --bundle ./my-app.zip --app-id "$APP_ID"
```

CLI использует `POST /api/v1/apps/<id>/versions?activate=true`. После
успешной пробы новая версия становится текущей. UUID и данные в `/data`
сохраняются. Цель обновления определяется UUID, даже если адрес переименован.

Версии неизменяемы: занятый номер возвращает `409 version_exists`.
Исправление кода отправляйте следующим номером в то же приложение.
Для подготовки без переключения добавьте `--no-activate`; готовую версию
можно позднее активировать в карточке приложения.

## Изменить доступ

Режим существующего приложения меняется отдельной операцией:

```bash
npx iskra-app access --app-id "$APP_ID" --access private
npx iskra-app access --app-id "$APP_ID" --access org
npx iskra-app access --app-id "$APP_ID" --access public
```

Команда делает `PATCH /api/v1/apps/<id>/access` с JSON
`{"access":"private|org|public"}` и возвращает HTTP DTO с `id`, `access`
и текущей версией, если она есть. API доступен владельцу приложения.
Для org нужен профиль организации; для public — разрешённая внешняя
публикация и готовая текущая версия. Изменение `access` в ZIP при обновлении
не меняет режим реестра: используйте эту команду.

## Дождаться конкретного результата

При включённом runtime POST возвращает `202` и `state=probing`: ZIP принят,
проверка ещё выполняется. `publish` опрашивает точную принятую версию.
Для продолжения проверки или разового чтения используйте:

```bash
npx iskra-app status --app-id "$APP_ID" --version "$APP_VERSION"
```

`status` делает один GET и возвращает HTTP DTO без переименования полей:

| Поле ответа | Действие агента |
|---|---|
| `publication.state=pending`, probe_error отсутствует | Продолжить ограниченный по времени опрос с паузой |
| `publication.probe_error` заполнен | Показать причину, исправить приложение, отправить следующий номер |
| `publication.state=ready` или `pruned` | Прочитать сохранённый `publication.outcome` |
| `outcome=activated` | Запрошенная публикация была активирована |
| `outcome=not_requested` | Версия подготовлена без запроса активации |
| `outcome=not_activated` | Версия готова, запрошенная активация не выполнена |

При истечении ожидания после 202 `publish` возвращает `state=probing`,
appId и version. Продолжайте `status`, сохранив эти идентификаторы.
`ready_not_active` означает готовую версию с невыполненной запрошенной
активацией, например после отзыва права public во время подготовки.
После восстановления права пользователь может активировать её в карточке.

Outcome относится к конкретной публикации. `current_version` показывает
нынешний указатель, который мог измениться другой публикацией.
`viewer_base_url` содержит настроенный адрес зрителя. Поле `status=active`
описывает реестр; состояние рабочего контейнера и его логи в ответ не входят.

## Использовать HTTP напрямую

Команды SDK используют те же публичные маршруты. Для создания:

```bash
curl --fail-with-body --silent --show-error \
  "$ISKRA_API_URL/api/v1/apps?activate=true" \
  --header "Authorization: Bearer $ISKRA_API_KEY" \
  --form "bundle=@./my-app.zip" \
  --form "title=Моё приложение"
```

Для обновления используйте `/api/v1/apps/$APP_ID/versions?activate=true`
с тем же multipart `bundle`. Content-Type с boundary выставляет HTTP-клиент.
`activate=true` применяется и при отсутствии query-параметра.
HTTP-ответ использует `id`, успешный ответ CLI `publish` — `appId`.

```bash
curl --fail-with-body --silent --show-error \
  "$ISKRA_API_URL/api/v1/apps/$APP_ID?version=$APP_VERSION" \
  --header "Authorization: Bearer $ISKRA_API_KEY"

curl --fail-with-body --silent --show-error --request PATCH \
  "$ISKRA_API_URL/api/v1/apps/$APP_ID/access" \
  --header "Authorization: Bearer $ISKRA_API_KEY" \
  --header "Content-Type: application/json" \
  --data '{"access":"private"}'
```

## Обработать отказ

HTTP возвращает стандартный Problem с `status`, `code`, `action`,
`request_id` и `params`. `detail` остаётся пустым. Для ошибок ZIP и
манифеста читайте безопасные `params.reason`, `path`, `field`, `message`;
поля присутствуют, когда их удалось определить. Для синтаксической ошибки JSON
`params.offset` указывает позицию в байтах. Пример:

```json
{
  "status": 422,
  "code": "bundle_invalid",
  "detail": "",
  "request_id": "идентификатор запроса",
  "params": {
    "reason": "manifest_field_invalid",
    "path": "app.json",
    "field": "entry",
    "message": "Укажите server.js в поле entry файла app.json."
  }
}
```

| Код/статус | Действие |
|---|---|
| `401 unauthorized` | Получить действующий ключ выбранного профиля |
| `403 scope_not_granted` | Выдать ключу apps:publish; required_scope приходит в params |
| `403 app_forbidden` | Проверить владение и UUID |
| `403 external_sharing_denied` | Восстановить право public либо выбрать внутренний режим |
| `409 slug_taken` | Выбрать другой адрес нового приложения |
| `409 version_exists` | Проверить прежний результат; для нового кода увеличить версию |
| `413` | Уменьшить объём; bundle-отказ содержит известные лимиты в params |
| `422 bundle_invalid` | Исправить нарушение по reason/path/field/message |
| `422 access_requires_org` | Выбрать private/public либо профиль организации |
| `429` | Соблюсти лимит и Retry-After, если предоставлен |
| `503 bundle_storage_unavailable` | Проверить фактический исход и сообщить о недоступности хранения |

CLI возвращает ненулевой exit code и JSON в stdout: `app_api_error` для
HTTP-отказа, `app_publication_failed` для отказа принятой публикации.
В JSON сохраняются доступные `status`, `code`, `params`, `request_id`,
`detail`, `app_id` и `version`. stderr содержит краткое пояснение.
Ключ и заголовок Authorization в вывод не попадают.

При потере ответа на POST или неразбираемом успешном ответе CLI выдаёт
`app_publication_unknown`. Он сохраняет только известные идентификаторы
и автоматически не повторяет upload. Проверьте результат через `status`,
если UUID и версия известны; при первом создании UUID можно найти в разделе
«Приложения» Искры. После 202 продолжайте чтение уже принятой версии.

## Что передать пользователю

Сообщите UUID, версию, результат пробы и активации, режим доступа и ссылку
из `viewerBaseUrl`/`viewer_base_url`. При незавершённой проверке сохраните
идентификаторы для продолжения. При отказе приведите code, диагностические
params или probe_error и конкретный следующий шаг исправления.
