export interface Operation {
  readonly date: string;
  readonly kind: "Получена накладная" | "Оплата" | "Возврат";
  readonly supplier: string;
  readonly amount: number;
  readonly overdue?: boolean;
}

// Данные живут в памяти процесса: пример показывает экран, а не хранение.
// Плитки считаются из тех же операций, что и таблица, — цифры не расходятся.
export const operations: readonly Operation[] = [
  {
    date: "2026-09-26",
    kind: "Получена накладная",
    supplier: "ООО «Северный склад»",
    amount: 184_300,
  },
  { date: "2026-09-25", kind: "Получена накладная", supplier: "АО «ТехноСнаб»", amount: 49_656.24 },
  { date: "2026-09-24", kind: "Оплата", supplier: "ИП Кравцова Н. А.", amount: 12_800 },
  { date: "2026-09-22", kind: "Оплата", supplier: "ООО «Промтара»", amount: 97_150 },
  { date: "2026-09-18", kind: "Возврат", supplier: "ООО «Промтара»", amount: 4_300 },
  {
    date: "2026-09-12",
    kind: "Получена накладная",
    supplier: "АО «ТехноСнаб»",
    amount: 230_000,
    overdue: true,
  },
];

export function metrics() {
  const received = operations.filter((operation) => operation.kind === "Получена накладная");
  const paid = operations.filter((operation) => operation.kind === "Оплата");
  const overdue = received.filter((operation) => operation.overdue);
  const sum = (list: readonly Operation[]): number =>
    list.reduce((total, item) => total + item.amount, 0);
  return { received: received.length, paid: sum(paid), overdue: sum(overdue) };
}
