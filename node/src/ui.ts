import { createHash } from "node:crypto";

import { type AppStyle, APP_STYLES, isAppStyle } from "./starter.js";
import { appStylesheet } from "./styles.generated.js";

export { appStylesheet };

/** Путь стиля относительно корня приложения. */
export const APP_STYLESHEET_PATH = "iskra.css";

export const APP_STYLESHEET_CONTENT_TYPE = "text/css; charset=utf-8";

/** Политика содержимого экранов приложения.
 *
 * Приложение показывает данные, пришедшие из внешних систем, поэтому политика
 * нужна каждому экрану. Встроенные `<script>` и `<style>` она запрещает: код и
 * оформление отдаются отдельными маршрутами, как это делает
 * `appStylesheetResponse`. Кадр внутри экрана (просмотр вложения) требует своей
 * политики на своём маршруте — общая остаётся строгой.
 */
export const APP_CSP = "default-src 'self'; object-src 'none'; frame-ancestors 'none'";

const stylesheetETag = `"${createHash("sha256").update(appStylesheet).digest("base64url")}"`;

/** Носитель заголовков запроса: `Request` или любой объект с `headers.get`. */
export interface HeaderCarrier {
  readonly headers: { get(name: string): string | null };
}

/** Ответ маршрута со стилем приложения.
 *
 * Путь стиля один на все версии приложения, поэтому длинный кэш подсунул бы
 * новой версии оформление предыдущей. Кэш остаётся, но с обязательной сверкой:
 * браузер держит файл у себя и на каждом открытии спрашивает ETag, а обновление
 * приложения меняет его вместе с содержимым.
 */
export function appStylesheetResponse(request?: HeaderCarrier): Response {
  const headers = {
    "content-type": APP_STYLESHEET_CONTENT_TYPE,
    "cache-control": "no-cache",
    etag: stylesheetETag,
  };
  if (request?.headers.get("if-none-match") === stylesheetETag) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(appStylesheet, { status: 200, headers });
}

/** Заголовок, которым роутер Искры передаёт приложению его название. */
export const APP_TITLE_HEADER = "x-iskra-app-title";

/** Название приложения из заголовка роутера.
 *
 * Название живёт на платформе: владелец правит его в разделе приложений, а
 * роутер кладёт его в каждый запрос зрителя percent-encoded — правка доезжает
 * до экрана без пересборки и перезапуска. Запасное значение — имя из
 * манифеста: его видят проба узла и локальный запуск, которые идут мимо
 * роутера, и оно же остаётся при пустом или неразбираемом заголовке.
 */
export function appTitle(request: HeaderCarrier, fallback: string): string {
  const raw = request.headers.get(APP_TITLE_HEADER);
  if (!raw) return fallback;
  try {
    const title = decodeURIComponent(raw).trim();
    return title || fallback;
  } catch {
    return fallback;
  }
}

/** Заголовок, которым роутер Искры передаёт адрес раздела «Приложения». */
export const APP_HOME_URL_HEADER = "x-iskra-home-url";

/** Заголовок, которым роутер Искры передаёт отображаемое имя зрителя. */
export const APP_VIEWER_NAME_HEADER = "x-iskra-viewer-name";

/** Адрес раздела «Приложения» Искры из заголовка роутера либо null.
 *
 * Значение уходит в href бренда шапки, поэтому принимается только абсолютный
 * http(s) URL без userinfo: `javascript:`, протокол-относительный `//host` и
 * адрес с логином-паролем отбрасываются. Возвращается исходная строка, а не
 * `URL.href`: разбор дописал бы к `/apps` завершающий слэш, а SvelteKit отвечает
 * на `/apps/` редиректом. Проба узла и локальный запуск идут мимо роутера —
 * заголовка нет, и бренд рисуется текстом.
 * См. docs/plans/2026-09-29-apps-ui-polish-design.md — «1. Шапка открытого приложения».
 */
export function appHomeURL(request: HeaderCarrier): string | null {
  const raw = request.headers.get(APP_HOME_URL_HEADER)?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Имя зрителя из заголовка роутера либо null.
 *
 * Имя нужно только для показа в шапке: доступ и роли решает проверенный JWT
 * (`verifyViewerIdentity`). Анонимный зритель публичного приложения заголовка
 * не получает; пустое или неразбираемое значение — тоже null.
 */
export function appViewerName(request: HeaderCarrier): string | null {
  const raw = request.headers.get(APP_VIEWER_NAME_HEADER);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).trim() || null;
  } catch {
    return null;
  }
}

/** Инициалы для аватара: первые буквы первых двух слов имени. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => [...word][0]!.toUpperCase())
    .join("");
}

/* Знак — inline SVG: политика содержимого (default-src 'self') не пустила бы
   картинку с другого хоста, а файл в бандле ради знака не нужен. Цвета задают
   классы в iskra.css — атрибут style та же политика запрещает. */
const BRAND_LOGO =
  '<svg class="app-bar__logo" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">' +
  '<rect class="app-bar__logo-bg" width="24" height="24" rx="6"/>' +
  '<path class="app-bar__logo-spark" d="M12 5l1.7 4.9 4.9 1.7-4.9 1.7L12 18.2l-1.7-4.9-4.9-1.7 4.9-1.7z"/>' +
  "</svg>";

const BRAND_TEXT = `${BRAND_LOGO}<b>Iskra</b> Apps`;

/** Служебные подписи шапки по языку документа. Подпись выбирается по
 *  основному тегу `lang` («en-US» → en); незнакомый язык получает русские
 *  подписи — язык Искры по умолчанию. */
const PAGE_STRINGS = {
  ru: { home: "Все приложения в Искре", sections: "Разделы" },
  en: { home: "All apps in Iskra", sections: "Sections" },
} as const;

function pageStrings(lang: string): (typeof PAGE_STRINGS)["ru"] | (typeof PAGE_STRINGS)["en"] {
  return lang.trim().toLowerCase().split("-")[0] === "en" ? PAGE_STRINGS.en : PAGE_STRINGS.ru;
}

export interface AppPageLink {
  readonly href: string;
  readonly label: string;
  /** Текущий раздел: ссылка получает aria-current="page" и выделяется. */
  readonly current?: boolean;
}

export interface AppPageOptions {
  /** Заголовок вкладки и шапки экрана; название с платформы даёт `appTitle`. */
  readonly title: string;
  /** Разметка содержимого. Вставляется как есть — данные экранирует автор. */
  readonly body: string;
  /** Ссылки навигации: в шапке или левым меню (`navPosition`). */
  readonly nav?: readonly AppPageLink[];
  /** Полоса содержимого во всю ширину окна: для широких таблиц. */
  readonly wide?: boolean;
  /** Дополнительные теги `<head>`: свой стиль или `<script src>` экрана. */
  readonly head?: string;
  /** Язык документа. */
  readonly lang?: string;
  /** Запрос зрителя: из него шапка берёт адрес Искры и имя зрителя. */
  readonly request?: HeaderCarrier;
  /** Стиль оформления. По умолчанию "iskra" — атрибут data-style не пишется. */
  readonly style?: AppStyle;
  /** Где показывать nav: в шапке (по умолчанию) или левым меню. */
  readonly navPosition?: "top" | "side";
}

/** Полный HTML экрана: шапка, полоса содержимого и подключённый общий стиль.
 *
 * Шапка — бренд «Iskra Apps» (ссылкой на раздел приложений Искры, когда роутер
 * передал адрес), название приложения и зритель. Ссылки навигации
 * относительные: узел отдаёт приложение и под собственным доменом
 * (APP_BASE_PATH=/), и под префиксом /{slug}, поэтому абсолютный путь был бы
 * верен ровно в одном из двух режимов.
 * См. docs/plans/2026-09-29-apps-ui-polish-design.md — «1. Шапка открытого приложения».
 */
export function appPage(options: AppPageOptions): string {
  const style = options.style ?? "iskra";
  if (!isAppStyle(style)) {
    throw new Error(`неизвестный стиль оформления ${JSON.stringify(style)}; допустимы: ${APP_STYLES.join(", ")}`);
  }
  const styleAttr = style === "iskra" ? "" : ` data-style="${style}"`;
  const lang = options.lang ?? "ru";
  const strings = pageStrings(lang);
  const links = (options.nav ?? [])
    .map(
      (link) =>
        `<a href="${escapeHTML(link.href)}"${link.current ? ' aria-current="page"' : ""}>${escapeHTML(link.label)}</a>`,
    )
    .join("");
  // Без ссылок меню слева пустое: сетка оболочки сжала бы содержимое в
  // колонку меню, поэтому раскладка включается только при непустом nav.
  const side = options.navPosition === "side" && links !== "";
  const title = escapeHTML(options.title);
  const homeURL = options.request ? appHomeURL(options.request) : null;
  const viewer = options.request ? appViewerName(options.request) : null;
  const brand = homeURL
    ? `<a class="app-bar__brand" href="${escapeHTML(homeURL)}" title="${escapeHTML(strings.home)}">${BRAND_TEXT}</a>`
    : `<span class="app-bar__brand">${BRAND_TEXT}</span>`;
  // На узкой ширине имя прячется визуально и остаётся аватар: имя доступно
  // подсказкой title и программе чтения экрана.
  const viewerBlock = viewer
    ? `<span class="app-bar__viewer" title="${escapeHTML(viewer)}"><span class="app-bar__avatar" aria-hidden="true">${escapeHTML(initials(viewer))}</span><span class="app-bar__viewer-name">${escapeHTML(viewer)}</span></span>`
    : "";
  const topNav = links && !side ? `<nav class="nav">${links}</nav>` : "";
  const sideNav = side ? `<nav class="side-nav" aria-label="${escapeHTML(strings.sections)}">${links}</nav>\n` : "";
  return `<!doctype html>
<html lang="${escapeHTML(lang)}"${styleAttr}>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<link rel="stylesheet" href="${APP_STYLESHEET_PATH}" />
${options.head ?? ""}
</head>
<body${side ? ' class="app-shell--side"' : ""}>
<header class="app-bar">
${brand}
<span class="app-bar__sep" aria-hidden="true">/</span>
<h1 class="app-bar__title">${title}</h1>
<span class="app-bar__spacer"></span>
${topNav}
${viewerBlock}
</header>
${sideNav}<main class="page${options.wide ? " page--wide" : ""}">
${options.body}
</main>
</body>
</html>
`;
}

/** Экранирование текста для вставки в разметку.
 *
 * Кавычки экранируются тоже: значение подставляют и в атрибут, а раздельные
 * функции для текста и атрибута рано или поздно перепутают местами.
 */
export function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
