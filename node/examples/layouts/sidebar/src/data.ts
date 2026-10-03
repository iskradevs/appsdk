export interface Invoice {
  readonly number: string;
  readonly date: string;
  readonly supplier: string;
  readonly amount: number;
  readonly paid: boolean;
}

// Данные живут в памяти процесса: пример показывает экран, а не хранение.
export const invoices: readonly Invoice[] = [
  {
    number: "ТН-2026-0418",
    date: "2026-09-26",
    supplier: "ООО «Северный склад»",
    amount: 184_300,
    paid: false,
  },
  {
    number: "ТН-2026-0417",
    date: "2026-09-25",
    supplier: "АО «ТехноСнаб»",
    amount: 49_656.24,
    paid: false,
  },
  {
    number: "ТН-2026-0412",
    date: "2026-09-22",
    supplier: "ИП Кравцова Н. А.",
    amount: 12_800,
    paid: true,
  },
  {
    number: "ТН-2026-0409",
    date: "2026-09-19",
    supplier: "ООО «Промтара»",
    amount: 97_150,
    paid: true,
  },
  {
    number: "ТН-2026-0401",
    date: "2026-09-12",
    supplier: "АО «ТехноСнаб»",
    amount: 230_000,
    paid: false,
  },
];
