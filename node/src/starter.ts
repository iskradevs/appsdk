/** Макеты экрана, из которых собирается приложение (`iskra-app init --layout`).
 *
 * Порядок — порядок плиток в конструкторе Искры.
 * См. docs/plans/2026-09-29-apps-ui-polish-design.md — «2. Макеты и стили в конструкторе».
 */
export const APP_LAYOUTS = ["form", "table", "dashboard", "master-detail", "sidebar", "wizard"] as const;

export type AppLayout = (typeof APP_LAYOUTS)[number];

/** Стили оформления: атрибут data-style на <html> поверх общего iskra.css. */
export const APP_STYLES = ["iskra", "strict", "showcase"] as const;

export type AppStyle = (typeof APP_STYLES)[number];

export function isAppLayout(value: string): value is AppLayout {
  return (APP_LAYOUTS as readonly string[]).includes(value);
}

export function isAppStyle(value: string): value is AppStyle {
  return (APP_STYLES as readonly string[]).includes(value);
}
