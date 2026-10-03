export interface Supplier {
  readonly id: string;
  readonly name: string;
  readonly inn: string;
  readonly city: string;
  readonly contact: string;
  readonly phone: string;
  readonly invoices: readonly { number: string; date: string; amount: number }[];
}

// Данные живут в памяти процесса: пример показывает экран, а не хранение.
export const suppliers: readonly Supplier[] = [
  {
    id: "sever",
    name: "ООО «Северный склад»",
    inn: "7810123456",
    city: "Санкт-Петербург",
    contact: "Андрей Смирнов",
    phone: "+7 812 555-01-20",
    invoices: [
      { number: "ТН-2026-0418", date: "2026-09-26", amount: 184_300 },
      { number: "ТН-2026-0396", date: "2026-09-08", amount: 64_720.5 },
    ],
  },
  {
    id: "technosnab",
    name: "АО «ТехноСнаб»",
    inn: "7705987654",
    city: "Москва",
    contact: "Елена Орлова",
    phone: "+7 495 555-17-44",
    invoices: [
      { number: "ТН-2026-0417", date: "2026-09-25", amount: 49_656.24 },
      { number: "ТН-2026-0401", date: "2026-09-12", amount: 230_000 },
    ],
  },
  {
    id: "kravtsova",
    name: "ИП Кравцова Н. А.",
    inn: "166012345678",
    city: "Казань",
    contact: "Наталья Кравцова",
    phone: "+7 843 555-66-10",
    invoices: [{ number: "ТН-2026-0412", date: "2026-09-22", amount: 12_800 }],
  },
  {
    id: "promtara",
    name: "ООО «Промтара»",
    inn: "5402765432",
    city: "Новосибирск",
    contact: "Игорь Белов",
    phone: "+7 383 555-32-08",
    invoices: [],
  },
];

export function selectedSupplier(requested: string | undefined): Supplier | undefined {
  return requested === undefined ? suppliers[0] : suppliers.find((item) => item.id === requested);
}
