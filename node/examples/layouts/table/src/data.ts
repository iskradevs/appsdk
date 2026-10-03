export type InvoiceStatus = "new" | "review" | "paid" | "overdue";

export interface Invoice {
  readonly number: string;
  readonly date: string;
  readonly supplier: string;
  readonly amount: number;
  readonly status: InvoiceStatus;
}

// Данные живут в памяти процесса: пример показывает экран, а не хранение.
const invoices: readonly Invoice[] = [
  {
    number: "ТН-2026-0418",
    date: "2026-09-26",
    supplier: "ООО «Северный склад»",
    amount: 184_300,
    status: "new",
  },
  {
    number: "ТН-2026-0417",
    date: "2026-09-25",
    supplier: "АО «ТехноСнаб»",
    amount: 49_656.24,
    status: "review",
  },
  {
    number: "ТН-2026-0412",
    date: "2026-09-22",
    supplier: "ИП Кравцова Н. А.",
    amount: 12_800,
    status: "paid",
  },
  {
    number: "ТН-2026-0409",
    date: "2026-09-19",
    supplier: "ООО «Промтара»",
    amount: 97_150,
    status: "paid",
  },
  {
    number: "ТН-2026-0401",
    date: "2026-09-12",
    supplier: "АО «ТехноСнаб»",
    amount: 230_000,
    status: "overdue",
  },
  {
    number: "ТН-2026-0396",
    date: "2026-09-08",
    supplier: "ООО «Северный склад»",
    amount: 64_720.5,
    status: "paid",
  },
  {
    number: "ТН-2026-0388",
    date: "2026-09-02",
    supplier: "ООО «Промтара»",
    amount: 18_400,
    status: "overdue",
  },
];

export function findInvoices(query: string): readonly Invoice[] {
  const needle = query.toLocaleLowerCase("ru");
  return invoices.filter(
    (invoice) =>
      !needle ||
      invoice.number.toLocaleLowerCase("ru").includes(needle) ||
      invoice.supplier.toLocaleLowerCase("ru").includes(needle),
  );
}
export const invoiceCount = invoices.length;
