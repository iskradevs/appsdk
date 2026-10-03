# Fixture сценария Apps Stage F

Это воспроизводимый fixture для dev-сценария `apps`. Публикуйте его из личного
профиля `user1@test.invalid`: этот пользователь должен остаться владельцем
приложения `stage-f-demo`, чтобы public-переход самоодобрялся немедленно.
Контур должен иметь включённые Apps runtime/viewer и разрешать popup для Искры.
Локально используйте именно destructive production-like запуск
`./local/run up --apps`: hot-reload `dev --apps` использует отдельный Vite/Caddy
overlay и HTTPS viewer-edge не обещает. Этот запуск поднимает
`https://apps.localhost`; импортируйте только для локальной разработки CA из
`local/.data/caddy/caddy/pki/authorities/local/root.crt` в trust store браузера
или ОС и убедитесь, что браузер открывает origin без TLS-предупреждения.

## Сборка и публикация

Из `services/apps/sdk` соберите три независимых closed-set архива:

```sh
npm run build
node dist/cli.js pack --closed --path examples/stage-f-scenario/1.0.0 --output /tmp/stage-f-demo-1.0.0.zip
node dist/cli.js pack --closed --path examples/stage-f-scenario/1.1.0 --output /tmp/stage-f-demo-1.1.0.zip
node dist/cli.js pack --closed --path examples/stage-f-scenario/9.9.9-bad --output /tmp/stage-f-demo-9.9.9-bad.zip
```

Публикуйте под владельцем `user1@test.invalid` строго в таком порядке:

1. `1.0.0` — создать `stage-f-demo`, дождаться `ready`, активировать.
2. `1.1.0` — опубликовать в тот же `app_id` без активации, дождаться `ready`.
3. `9.9.9-bad` — опубликовать в тот же `app_id` без активации; ожидаемый итог —
   отказ probe и видимый `probe_error`, а не `ready`.

Используйте штатный `publish_app` или `iskra-app publish` текущего контура и его
обычный защищённый способ аутентификации. Не записывайте учётные данные в этот
каталог. После подготовки должны существовать ровно две готовые версии
`1.0.0`/`1.1.0`; текущей может быть любая из них. Версия `9.9.9-bad` должна
сохранить диагностический отказ probe.

## Проверка и сброс

Откройте `/apps` под `user1@test.invalid`: карточка должна иметь slug
`stage-f-demo`, непубличный access и current `1.0.0` либо `1.1.0`. Сценарий сам
переключает current на другую готовую версию, временно делает приложение
публичным, открывает реальный viewer и через видимые UI-действия восстанавливает
исходную current version и исходный private/org access. Обычная ошибка, timeout
или штатная остановка runner ждут authoritative cleanup до завершения.

Только если процесс/окно браузера был аварийно убит и cleanup не мог
выполниться, вручную активируйте исходную ready-версию и верните исходный
private/org access через UI. Если остался pending approval, отмените запрос;
если fixture подготовлен не тем профилем, удалите локальное приложение штатным
способом и повторите публикацию от `user1@test.invalid`. Номера версий
неизменяемы. `./local/run down --apps` сбрасывает control-plane/dev seed и
compose-контейнеры узла, но не является полным node cleanup: созданные агентом
app containers/networks и bind-данные `local/.data/iskra-apps` очищаются
отдельно по точным label/path-командам из usage `./local/run`. После сброса
повторите рецепт. Разрешение popup включается для origin платформы, не для
посторонних сайтов.
