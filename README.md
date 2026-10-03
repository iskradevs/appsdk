# Искра Apps SDK

SDK и CLI `@iskra/apps` для создания приложений Искры: Node.js 24, TypeScript,
проверка viewer identity, служебный API, SQLite-примеры, оформление и сборка ZIP.

Preview **0.1.1** относится к предстоящему облачному релизу Apps. Пакет и SHA256
доступны в [GitHub Releases](https://github.com/iskradevs/appsdk/releases).
Публикация в npm оформляется отдельно.

```bash
npm install https://github.com/iskradevs/appsdk/releases/download/v0.1.1/iskra-apps-0.1.1.tgz
npx iskra-app init --name my-app --path ./my-app --layout form --style iskra
npx iskra-app check --path ./my-app
npx iskra-app pack --path ./my-app --output ./my-app.zip --closed
```

Руководство по среде исполнения, авторизации и CLI — [node/README.md](node/README.md).
[Примеры](node/examples/) и [авторские инструкции](node/authoring/INSTRUCTIONS.md)
входят в пакет. [Manifest schema](manifest/schema.json) — контракт публикуемого
приложения.

Для проверки из исходника:

```bash
git clone https://github.com/iskradevs/appsdk.git
cd appsdk/node
npm ci
npm test
npm pack
```

Этот репозиторий содержит проверенную копию allowlisted SDK source. Разработка
ведётся в основном репозитории Искры; `SOURCE_REVISION` связывает публикацию с
полным committed source SHA. Срок rollout указан отдельно в релизе платформы.
MIT — [LICENSE](LICENSE).
