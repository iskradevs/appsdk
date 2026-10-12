# Интеллект Искры для приложения ЭПС

Приложение может поручить Искре анализ текста или документа и получить текст,
файл либо JSON по своей схеме. Для приложения, опубликованного в Искре,
используйте `@iskra/apps` и сессию вошедшего пользователя. Установка SDK и
сборка приложения описаны в [README](README.md).
Для обычного анализа достаточно задания в `message`; отдельный навык не нужен.

## Запуск задачи

В серверном обработчике возьмите `request` входящего HTTP-запроса.
`actionKey` — UUID действия, созданный браузером один раз и сохранённый для
повтора того же запроса. Пользователь открывает приложение через Искру.

```ts
import { IskraClient, verifyViewerIdentity } from "@iskra/apps";

const apiUrl = process.env.ISKRA_API_URL;
const appId = process.env.APP_ID;
const token = request.headers.get("X-Iskra-Identity");
if (!apiUrl || !appId || !token) throw new Error("Нет среды или сессии Искры");
await verifyViewerIdentity(token, { appId, apiUrl });
const iskra = new IskraClient({ apiUrl, token });

const started = await iskra.startRun({
  message: "Проанализируй заявку: требуется заменить насос. Дай краткое резюме и следующие действия.",
  response_format: {
    type: "json_schema",
    json_schema: {
      type: "object",
      properties: { summary: { type: "string" }, actions: { type: "array", items: { type: "string" } } },
      required: ["summary", "actions"],
      additionalProperties: false,
    },
  },
}, { idempotencyKey: actionKey });
// Верните started.runId браузеру сразу; агент работает асинхронно.
```

При каждом запросе браузера о состоянии создавайте клиент с **новым входящим**
`X-Iskra-Identity` и вызывайте `iskra.getRun(runId)`. При `completed` JSON
находится в `result.output`, исходный ответ — в `result.answer`. Обрабатывайте
также `failed`, `cancelled`, `interaction_required` и `error`; `queued` и
`running` означают, что нужно опросить снова. JWT живёт до пяти минут: храните
`runId`, а токен используйте только на сервере в рамках текущего запроса.
Для короткой задачи есть синхронный `iskra.run(body, { idempotencyKey })`.

## Документы и навыки

PDF загрузите серверным multipart-запросом на
`${apiUrl}/api/v1/chat/files` с `Authorization: Bearer ${token}`; часть формы
называется `file` и содержит имя файла. В `startRun` передайте полученный
`conversation_id` и `files: [{ id: uploaded.files[0].id }]` вместе с заданием.
У `@iskra/apps` отдельного upload-метода пока нет. `json_schema` содержит саму
схему, без обёртки `{ name, schema }`. Нужные поля опишите также в задании:
приведение ответа к схеме выполняется после работы агента.

Так устроено распознавание в **приложении «Накладные ЦБО»**. Чатовый навык ЦБО
имеет отдельные интеграции и настройки. App-прогон получает работу с файлами
и документами; навыки доступны только по серверному allowlist точных версий
`APPS_HEADLESS_SKILL_ALLOWLIST`. Возможности навыка ограничены
artifact/files/LLM/log/now/progress/random/run-files. HTTP-интеграции и секреты
навыков, веб-поиск, Память и контекст проекта в app-прогон не входят.
Интеграции приложения выполняйте его серверным кодом с объявленными слотами
секретов и разрешёнными `egress_hosts`.

## Если вызов не работает

| Симптом | Следующий шаг |
| --- | --- |
| `ENOTFOUND` / `EAI_AGAIN` для `iskra-api`, отказ соединения | Администратору проверить сеть Apps NODE → ingress → CORE и `NO_PROXY`. Берите `ISKRA_API_URL` из среды; `/healthz` приложения не проверяет этот путь. |
| `401 app_unauthorized` | Проверить вход через Искру и свежий JWT текущего запроса. |
| `402 billing_reservation_denied`, `409 app_run_mt_exhausted`, `429 app_*_exhausted` | Проверить баланс профиля/организации и четыре квоты приложения: `daily_runs`, `daily_mt`, `max_run_mt`, `max_concurrent_runs`. |
| `404` на каталогах навыков, Памяти или `/v1` | Использовать разрешённые app-маршруты chat/files/runs; API зрителя ограничен. |
| `503 app_auth_unavailable` / `billing_unavailable` | Администратору проверить зависимости авторизации и биллинга. |

**Если ЭПС размещено вне Искры:** используйте
[API SDK](https://github.com/iskradevs/apisdk), публичный HTTPS-адрес контура
и пользовательский ключ `isk_` со scope `chat:run`; для навыков добавьте
`skills:run`, для файлов — `files:write`/`files:read`. Выбирайте доступный
настроенный навык через каталог и `iskra_exec.skills`, включая обязательные
bundles. Этот маршрут имеет другой контракт авторизации; служебный
`iskra-api` относится к приложениям внутри Искры.
