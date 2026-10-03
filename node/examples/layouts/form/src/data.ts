export interface SupplyRequest {
  readonly id: number;
  readonly supplier: string;
  readonly item: string;
  readonly quantity: number;
  readonly deadline: string;
  readonly comment: string;
}

// Данные живут в памяти процесса: пример показывает экран, а не хранение.
// Для настоящих заявок — SQLite через appDataPath (см. examples/stateful).
// Память конечна, поэтому хранятся только последние MAX_REQUESTS заявок.
const MAX_REQUESTS = 100;
const requests: SupplyRequest[] = [
  {
    id: 1041,
    supplier: "ООО «Северный склад»",
    item: "Бумага офисная А4, коробка",
    quantity: 40,
    deadline: "2026-10-06",
    comment: "Доставка на склад № 2",
  },
];
let nextId = 1042;

export const suppliers = [
  "ООО «Северный склад»",
  "АО «ТехноСнаб»",
  "ИП Кравцова Н. А.",
  "ООО «Промтара»",
];

// Пределы длины полей: одни и те же числа уходят в maxlength разметки и в
// проверку на сервере — браузерный maxlength обходится любым запросом мимо формы.
export const LIMITS = { item: 200, quantity: 6, deadline: 10, comment: 500 } as const;

export interface FormValues {
  readonly supplier: string;
  readonly item: string;
  readonly quantity: string;
  readonly deadline: string;
  readonly comment: string;
}

export const FIELD_LABELS: Record<keyof typeof LIMITS, string> = {
  item: "Позиция",
  quantity: "Количество",
  deadline: "Срок поставки",
  comment: "Комментарий",
};

export const emptyValues: FormValues = {
  supplier: "",
  item: "",
  quantity: "",
  deadline: "",
  comment: "",
};

export function findRequest(id: string | undefined): SupplyRequest | undefined {
  return requests.find((item) => String(item.id) === id);
}
export function createRequest(values: FormValues, quantity: number): number {
  const id = nextId++;
  requests.push({ id, ...values, quantity });
  if (requests.length > MAX_REQUESTS) requests.splice(0, requests.length - MAX_REQUESTS);
  return id;
}
