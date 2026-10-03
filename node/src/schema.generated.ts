/* Сгенерировано из services/apps/manifest/schema.json. Не редактировать вручную. */
export const manifestSchema = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Искра — манифест приложения (app.json)",
  "description": "Единица публикации бандла приложения (Apps фаза 1, этап A). См. docs/superpowers/specs/2026-07-26-iskra-apps-design.md — «Единица публикации».",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "name",
    "version",
    "entry",
    "health",
    "access",
    "storage"
  ],
  "properties": {
    "name": {
      "description": "Slug приложения (RFC 1123 label). Доменные отказы (xn-- префикс, \"--\" в позициях 3–4, резервный список) проверяет manifest.go — схема выражает только грамматику.",
      "type": "string",
      "pattern": "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$",
      "maxLength": 63
    },
    "version": {
      "description": "Semver без build-метаданных, строчные буквы в prerelease. Подстрока \"..\" отдельно запрещена manifest.go.",
      "type": "string",
      "pattern": "^\\d+\\.\\d+\\.\\d+(-[0-9a-z][0-9a-z.-]{0,30})?$",
      "maxLength": 48
    },
    "entry": {
      "description": "Путь входа сервера. Фиксирован платформой — автором не задаётся.",
      "type": "string",
      "const": "server.js"
    },
    "health": {
      "description": "Путь проверки живости фиксирован платформой; манифест только подтверждает поддержку.",
      "type": "boolean",
      "const": true
    },
    "access": {
      "description": "Режим доступа. \"public\" допустим (губернанс v2): самоодобряющий владелец (приватный профиль или админ организации) создаёт публичное приложение сразу; рядовому владельцу организации httpapi отвечает public_requires_approval. Решение «public требует самоодобрения» принимает httpapi — он знает актора, а схема нет.",
      "type": "string",
      "enum": [
        "private",
        "org",
        "public"
      ]
    },
    "storage": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "kind"
      ],
      "properties": {
        "kind": {
          "type": "string",
          "enum": [
            "sqlite"
          ]
        }
      }
    },
    "secrets": {
      "description": "Декларация секретных слотов приложения.",
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "slot",
          "scope"
        ],
        "properties": {
          "slot": {
            "type": "string",
            "pattern": "^[a-z0-9_]{1,64}$"
          },
          "scope": {
            "description": "app — общий слот, значение задаёт владелец; viewer — личный слот каждого зрителя.",
            "type": "string",
            "enum": [
              "app",
              "viewer"
            ]
          }
        }
      }
    }
  }
} as const;
