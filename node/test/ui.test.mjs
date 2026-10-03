import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_CSP,
  APP_HOME_URL_HEADER,
  APP_LAYOUTS,
  APP_STYLES,
  APP_VIEWER_NAME_HEADER,
  appHomeURL,
  appViewerName,
  isAppLayout,
  isAppStyle,
  APP_STYLESHEET_PATH,
  APP_TITLE_HEADER,
  appPage,
  appStylesheet,
  appStylesheetResponse,
  appTitle,
  escapeHTML,
} from "../dist/index.js";

function requestWith(ifNoneMatch) {
  return { headers: { get: (name) => (name === "if-none-match" ? ifNoneMatch : null) } };
}

test("стиль отдаётся с типом, ETag и обязательной сверкой кэша", async () => {
  const response = appStylesheetResponse();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-cache");
  assert.match(response.headers.get("etag") ?? "", /^"[\w-]+"$/);
  assert.equal(await response.text(), appStylesheet);
});

test("совпавший ETag отдаёт 304 без тела, чужой — полный ответ", async () => {
  const etag = appStylesheetResponse().headers.get("etag");
  const cached = appStylesheetResponse(requestWith(etag));
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  assert.equal(cached.headers.get("etag"), etag);
  assert.equal(appStylesheetResponse(requestWith('"чужой"')).status, 200);
});

// Политика содержимого приложения (default-src 'self') отменяет любой внешний
// запрос и пишет ошибку в консоль, а browser-гейт публикации на ошибке в
// консоли отклоняет версию. Шрифт с CDN в общем слое означал бы, что ни одно
// приложение не публикуется.
test("стиль не тянет ни одного внешнего ресурса", () => {
  assert.doesNotMatch(appStylesheet, /https?:\/\//);
  assert.doesNotMatch(appStylesheet, /@import/);
  for (const match of appStylesheet.matchAll(/url\(([^)]*)\)/g)) {
    assert.match(match[1] ?? "", /^["']?data:/, `внешний ресурс в url(): ${match[0]}`);
  }
});

test("стиль несёт токены обеих тем", () => {
  assert.match(appStylesheet, /--accent:/);
  assert.match(appStylesheet, /prefers-color-scheme: dark/);
  for (const component of [".app-bar", ".card", ".btn-primary", ".status", ".badge", ".spinner"]) {
    assert.ok(appStylesheet.includes(component), `нет компонента ${component}`);
  }
});

test("экран подключает общий стиль и не содержит встроенных блоков", () => {
  const html = appPage({ title: "Накладные", body: "<p>Список</p>" });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes(`<link rel="stylesheet" href="${APP_STYLESHEET_PATH}" />`));
  assert.ok(html.includes('<main class="page">'));
  assert.ok(html.includes("<p>Список</p>"));
  assert.doesNotMatch(html, /<style/);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(html, /\bstyle="/);
});

test("заголовок и ссылки навигации экранируются", () => {
  const html = appPage({
    title: 'Отчёт "О&О" <b>',
    body: "",
    nav: [{ href: 'a"b', label: "<Дашборд>" }],
    wide: true,
  });
  assert.ok(html.includes("<title>Отчёт &quot;О&amp;О&quot; &lt;b&gt;</title>"));
  assert.ok(html.includes('<a href="a&quot;b">&lt;Дашборд&gt;</a>'));
  assert.ok(html.includes('<main class="page page--wide">'));
  assert.doesNotMatch(html, /<b>(?!Iskra<\/b>)/);
});

test("свой head попадает в документ, навигация без ссылок не рисуется", () => {
  const html = appPage({ title: "X", body: "", head: '<script src="app.js" defer></script>' });
  assert.ok(html.includes('<script src="app.js" defer></script>'));
  assert.doesNotMatch(html, /<nav/);
});

test("escapeHTML закрывает и текст, и значение атрибута", () => {
  assert.equal(escapeHTML(`<a href='x' title="y">&`), "&lt;a href=&#39;x&#39; title=&quot;y&quot;&gt;&amp;");
});

test("политика содержимого запрещает внешние источники и встраивание", () => {
  assert.equal(APP_CSP, "default-src 'self'; object-src 'none'; frame-ancestors 'none'");
});

function requestWithTitle(value) {
  return new Request("http://app.invalid/", { headers: { "x-iskra-app-title": value } });
}

test("название приложения берётся из заголовка роутера и декодируется из percent-encoding", () => {
  assert.equal(APP_TITLE_HEADER, "x-iskra-app-title");
  assert.equal(appTitle(requestWithTitle("%D0%9D%D0%B0"), "fallback"), "На");
  assert.equal(appTitle(requestWithTitle("%D0%9D%D0%B0%D0%BA%D0%BB%D0%B0%D0%B4%D0%BD%D1%8B%D0%B5%20%D0%A6%D0%91%D0%9E"), "fallback"), "Накладные ЦБО");
});

test("подписи шапки следуют языку документа: en — английские, прочие — русские", () => {
  const request = requestWithHeaders({ "x-iskra-home-url": HOME });
  const nav = [{ href: "./", label: "A" }];
  for (const lang of ["en", "en-US"]) {
    const html = appPage({ title: "X", body: "", request, lang, nav, navPosition: "side" });
    assert.ok(html.includes(`<html lang="${lang}">`));
    assert.ok(html.includes(`<a class="app-bar__brand" href="${HOME}" title="All apps in Iskra">`));
    assert.ok(html.includes('<nav class="side-nav" aria-label="Sections">'));
  }
  for (const lang of [undefined, "ru", "de"]) {
    const html = appPage({ title: "X", body: "", request, lang, nav, navPosition: "side" });
    assert.ok(html.includes('title="Все приложения в Искре"'));
    assert.ok(html.includes('<nav class="side-nav" aria-label="Разделы">'));
  }
});

// Проба узла и локальный запуск идут мимо роутера: заголовка нет, и экран
// остаётся с именем из манифеста. Битый или пустой заголовок даёт то же
// запасное значение, а не исключение в обработчике.
test("без заголовка, с битой кодировкой или пустым значением — запасное название", () => {
  assert.equal(appTitle(new Request("http://app.invalid/"), "Из манифеста"), "Из манифеста");
  assert.equal(appTitle(requestWithTitle("%E0%A4%A"), "Из манифеста"), "Из манифеста");
  assert.equal(appTitle(requestWithTitle("%20%20"), "Из манифеста"), "Из манифеста");
  assert.equal(appTitle(requestWithTitle(""), "Из манифеста"), "Из манифеста");
});

// Кросс-языковой вектор с Go-стороной (router/proxy_test.go,
// TestEncodeAppTitleLiteralVector): символы, которые url.PathEscape оставляет
// литералами (+ & = @), и закодированный знак процента.
test("литералы PathEscape и %25 декодируются как в роутере", () => {
  assert.equal(appTitle(requestWithTitle("A+B%20&%20C=D%20@%20100%25"), "fallback"), "A+B & C=D @ 100%");
});

test("appTitle принимает любой объект с headers.get, как контекст Hono", () => {
  const carrier = { headers: { get: (name) => (name === "x-iskra-app-title" ? "Notes" : null) } };
  assert.equal(appTitle(carrier, "fallback"), "Notes");
});

test("название из заголовка попадает в <title> и шапку экранированным", () => {
  const html = appPage({ title: appTitle(requestWithTitle("%3Cb%3E%D0%9D%D0%B0"), "x"), body: "" });
  assert.ok(html.includes("<title>&lt;b&gt;На</title>"));
  assert.doesNotMatch(html, /<b>(?!Iskra<\/b>)/);
});

// ── Шапка Iskra Apps, стили и раскладки ─────────────────────────────────────

function requestWithHeaders(headers) {
  return new Request("http://app.invalid/", { headers });
}

const HOME = "https://iskra.example/apps";
const VIEWER = encodeURIComponent("Саша Морозова");

test("перечни макетов и стилей идут в порядке каталога", () => {
  assert.deepEqual([...APP_LAYOUTS], ["form", "table", "dashboard", "master-detail", "sidebar", "wizard"]);
  assert.deepEqual([...APP_STYLES], ["iskra", "strict", "showcase"]);
  assert.ok(isAppLayout("wizard"));
  assert.ok(!isAppLayout("grid"));
  assert.ok(isAppStyle("showcase"));
  assert.ok(!isAppStyle("dark"));
});

test("адрес Искры принимается только абсолютным http(s) без userinfo", () => {
  assert.equal(APP_HOME_URL_HEADER, "x-iskra-home-url");
  const home = (value) => appHomeURL(requestWithHeaders({ "x-iskra-home-url": value }));
  assert.equal(home(HOME), HOME);
  assert.equal(home("http://localhost/apps"), "http://localhost/apps");
  assert.equal(home("javascript:alert(1)"), null);
  assert.equal(home("//evil.example/apps"), null);
  assert.equal(home("https://u:p@x.example/apps/"), null);
  assert.equal(home("/apps"), null);
  assert.equal(home(""), null);
  assert.equal(appHomeURL(requestWithHeaders({})), null);
});

test("имя зрителя декодируется из percent-encoding, пустое и битое — null", () => {
  assert.equal(APP_VIEWER_NAME_HEADER, "x-iskra-viewer-name");
  const viewer = (value) => appViewerName(requestWithHeaders({ "x-iskra-viewer-name": value }));
  assert.equal(viewer(VIEWER), "Саша Морозова");
  assert.equal(viewer("%20%D0%9D%D0%B0%20"), "На");
  assert.equal(viewer("%20%20"), null);
  assert.equal(viewer("%E0%A4%A"), null);
  assert.equal(appViewerName(requestWithHeaders({})), null);
});

test("шапка с запросом роутера: бренд ссылкой на Искру, название и зритель с инициалами", () => {
  const request = requestWithHeaders({ "x-iskra-home-url": HOME, "x-iskra-viewer-name": VIEWER });
  const html = appPage({ title: "Накладные", body: "", request });
  assert.ok(html.includes(`<a class="app-bar__brand" href="${HOME}" title="Все приложения в Искре">`));
  assert.match(html, /<b>Iskra<\/b> Apps/);
  assert.match(html, /class="app-bar__sep" aria-hidden="true"/);
  assert.ok(html.includes('<h1 class="app-bar__title">Накладные</h1>'));
  assert.ok(
    html.includes(
      '<span class="app-bar__viewer" title="Саша Морозова"><span class="app-bar__avatar" aria-hidden="true">СМ</span><span class="app-bar__viewer-name">Саша Морозова</span></span>',
    ),
  );
  assert.doesNotMatch(html, /app-bar__mark/);
});

// Проба узла и локальный запуск идут мимо роутера: адреса Искры нет, и ссылка
// вела бы в никуда.
test("без запроса бренд — текст без ссылки, зрителя нет", () => {
  const html = appPage({ title: "Накладные", body: "" });
  assert.match(html, /<span class="app-bar__brand">/);
  assert.doesNotMatch(html, /<a class="app-bar__brand"/);
  assert.doesNotMatch(html, /app-bar__viewer/);
});

test("имя зрителя и адрес Искры экранируются", () => {
  const request = requestWithHeaders({
    "x-iskra-home-url": 'https://iskra.example/apps?q="x"',
    "x-iskra-viewer-name": encodeURIComponent("<img src=x onerror=alert(1)>"),
  });
  const html = appPage({ title: "X", body: "", request });
  assert.doesNotMatch(html, /<img/);
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(html.includes('href="https://iskra.example/apps?q=&quot;x&quot;"'));
});

test("стиль оформления ставится атрибутом data-style, неизвестный — ошибка", () => {
  assert.ok(appPage({ title: "X", body: "", style: "strict" }).includes('<html lang="ru" data-style="strict">'));
  assert.ok(appPage({ title: "X", body: "", style: "iskra" }).includes('<html lang="ru">'));
  assert.ok(appPage({ title: "X", body: "" }).includes('<html lang="ru">'));
  assert.throws(() => appPage({ title: "X", body: "", style: "neon" }), /стиль/);
});

test("меню слева выносит навигацию из шапки, по умолчанию она в шапке", () => {
  const nav = [
    { href: "./", label: "Сводка", current: true },
    { href: "./list", label: "Список" },
  ];
  const side = appPage({ title: "X", body: "", nav, navPosition: "side" });
  assert.ok(side.includes('<body class="app-shell--side">'));
  const header = side.slice(side.indexOf("<header"), side.indexOf("</header>"));
  assert.doesNotMatch(header, /<nav/);
  assert.match(side, /<\/header>\s*<nav class="side-nav" aria-label="Разделы">/);
  assert.ok(side.includes('<a href="./" aria-current="page">Сводка</a>'));
  assert.ok(side.includes('<a href="./list">Список</a>'));

  const top = appPage({ title: "X", body: "", nav });
  assert.ok(top.includes("<body>"));
  const topHeader = top.slice(top.indexOf("<header"), top.indexOf("</header>"));
  assert.match(topHeader, /<nav class="nav">/);
  assert.doesNotMatch(top, /side-nav/);
});

// Пустое меню слева сжало бы содержимое в колонку меню шириной 220px.
test("меню слева без ссылок не включает раскладку с колонкой", () => {
  for (const nav of [undefined, []]) {
    const html = appPage({ title: "X", body: "", nav, navPosition: "side" });
    assert.ok(html.includes("<body>"));
    assert.doesNotMatch(html, /app-shell--side|side-nav/);
  }
});

test("шапка со всеми частями не содержит встроенных стилей", () => {
  const request = requestWithHeaders({ "x-iskra-home-url": HOME, "x-iskra-viewer-name": VIEWER });
  for (const navPosition of ["top", "side"]) {
    const html = appPage({ title: "X", body: "", request, style: "showcase", nav: [{ href: "./", label: "A" }], navPosition });
    assert.doesNotMatch(html, /\sstyle=/);
    assert.doesNotMatch(html, /<style/);
  }
});

// Правила верхнего уровня и внутри @media собираются в пары «селектор → набор
// свойств». Разбор простой: в app.css нет вложенных фигурных скобок, кроме
// @media и @keyframes.
function customPropertySets(css, selector) {
  const light = new Set();
  const dark = new Set();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const collect = (block, target) => {
    for (const match of block.matchAll(/(--[\w-]+)\s*:/g)) target.add(match[1]);
  };
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let depth0 = stripped;
  for (const media of stripped.matchAll(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{((?:[^{}]*\{[^{}]*\})*[^{}]*)\}/g)) {
    for (const rule of media[1].matchAll(ruleRe)) {
      if (rule[1].trim() === selector) collect(rule[2], dark);
    }
    depth0 = depth0.replace(media[0], "");
  }
  for (const rule of depth0.matchAll(ruleRe)) {
    if (rule[1].trim() === selector) collect(rule[2], light);
  }
  return { light, dark };
}

// Селектор :root[data-style=…] сильнее тёмного :root в @media, поэтому токен,
// не переопределённый в тёмном блоке стиля, остался бы светлым на тёмном фоне.
test("каждый стиль переопределяет в тёмной теме все токены светлой", () => {
  for (const style of APP_STYLES.filter((id) => id !== "iskra")) {
    const { light, dark } = customPropertySets(appStylesheet, `:root[data-style="${style}"]`);
    assert.ok(light.size > 0, `нет светлого блока стиля ${style}`);
    assert.deepEqual([...dark].sort(), [...light].sort(), `токены тёмного блока ${style} расходятся со светлым`);
  }
});

test("стиль несёт бренд, зрителя, стили оформления и раскладки макетов", () => {
  for (const part of [
    '[data-style="strict"]',
    '[data-style="showcase"]',
    ".app-bar__brand",
    ".app-bar__viewer",
    ".app-bar__viewer-name",
    ".app-shell--side",
    ".side-nav",
    ".kpis",
    ".kpi",
    ".split",
    ".steps",
    ".list-select",
  ]) {
    assert.ok(appStylesheet.includes(part), `нет ${part}`);
  }
});
